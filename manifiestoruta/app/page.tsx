"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { InstallPwa } from "./pwa-controls";
import { analyzeCatalogAddress } from "@/lib/street-catalog";
import { inferLocation, locationByKey, SUPPORTED_LOCATIONS } from "@/lib/supported-locations";
import { parseManifestPdf } from "@/lib/manifest-pdf";
import { parseManualAddresses } from "@/lib/manual-address";
import {
  buildRouteTransfer,
  LEGACY_ROUTE_TRANSFER_KEY,
  normalizeRouteTransferPayload,
  ROUTE_TRANSFER_KEY,
  type RouteTransferPayload,
} from "@/lib/route-transfer";

 type Status = "pending" | "delivered" | "failed";
 type Precision = "exact" | "manual" | "parallel" | "street" | "missing";

 type Stop = {
  id: string;
  loadOrder: number;
  packageNo: number;
  name: string;
  rawAddress: string;
  address: string;
  locality: string;
  postalCode: string;
  locationKey: string;
  status: Status;
  lat?: number;
  lon?: number;
  precision?: Precision;
  reason?: string;
  corrections?: Array<{ original: string; corrected: string; score: number }>;
  sourceManifest?: string;
  sourceRowId?: string;
 };

 type GeoResult = {
  lat?: number;
  lon?: number;
  precision: Precision;
  source: string;
  reason: string;
  normalizedAddress: string;
  locality: string;
  corrections?: Stop["corrections"];
 };

 type OcrRow = {
  id: string;
  page: number;
  rowNumber: number;
  name: string;
  address: string;
  locality: string;
  postalCode: string;
  barcode: string;
  confidence: number;
  status: "verified" | "review";
  note?: string;
 };

 type OcrResult = {
  manifestNumber: string;
  pages: number;
  rows: OcrRow[];
  persisted?: boolean;
 };

 const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

 const STORAGE = "ruta-postal:v3";
 const LEGACY_STORAGES = ["ruta-postal:v2", "ruta-postal:v1"];

 function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const y = (a.lat - b.lat) * 111;
  const x = (a.lon - b.lon) * 111 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(x, y);
 }

 function optimize(stops: Stop[], origin?: { lat: number; lon: number }) {
  const mapped = stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  if (mapped.length < 2) return mapped;
  let current = origin ?? { lat: mapped[0].lat!, lon: mapped[0].lon! };
  const rest = [...mapped];
  const route: Stop[] = [];

  while (rest.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    rest.forEach((stop, index) => {
      const candidate = distance(current, { lat: stop.lat!, lon: stop.lon! });
      if (candidate < bestDistance) {
        bestDistance = candidate;
        bestIndex = index;
      }
    });
    const [next] = rest.splice(bestIndex, 1);
    route.push(next);
    current = { lat: next.lat!, lon: next.lon! };
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < route.length - 2; i++) {
      for (let j = i + 1; j < route.length - 1; j++) {
        const a = { lat: route[i - 1].lat!, lon: route[i - 1].lon! };
        const b = { lat: route[i].lat!, lon: route[i].lon! };
        const c = { lat: route[j].lat!, lon: route[j].lon! };
        const d = { lat: route[j + 1].lat!, lon: route[j + 1].lon! };
        if (distance(a, c) + distance(b, d) + 0.05 < distance(a, b) + distance(c, d)) {
          const reversed = route.slice(i, j + 1).reverse();
          route.splice(i, reversed.length, ...reversed);
        }
      }
    }
  }
  return route;
 }

 function csv(value: string | number | undefined) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
 }

 function parseDelimitedLine(line: string) {
  const delimiter = line.includes("\t") ? "\t" : line.includes(";") ? ";" : "|";
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { current += '"'; index++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(current.trim());
      current = "";
    } else current += char;
  }
  values.push(current.trim());
  return values;
 }

 function bulkRows(text: string) {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).flatMap((line, index) => {
    const columns = parseDelimitedLine(line);
    if (columns.length < 5) return [];
    if (index === 0 && /paquete|n[º°o]/i.test(columns[0]) && /nombre/i.test(columns[1])) return [];
    const [packageText, name, address, locality, postalCode] = columns;
    if (!address) return [];
    const inferred = inferLocation(locality, postalCode);
    return [{
      packageNo: Number(packageText.replace(/\D/g, "")) || index + 1,
      name: name.trim(),
      address: address.trim(),
      locality: locality.trim() || inferred.label,
      postalCode: postalCode.replace(/\D/g, "").slice(0, 4) || inferred.postalCode,
      locationKey: inferred.key,
    }];
  });
 }

 function migrateStored(value: unknown): Stop[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const locationKey = String(item.locationKey ?? inferLocation(String(item.locality ?? ""), String(item.postalCode ?? "")).key);
    const location = locationByKey(locationKey);
    const address = String(item.address ?? item.rawAddress ?? "").trim();
    if (!address) return [];
    return [{
      id: String(item.id ?? crypto.randomUUID()),
      loadOrder: Number(item.loadOrder ?? index + 1),
      packageNo: Number(item.packageNo ?? index + 1),
      name: String(item.name ?? item.recipient ?? "").trim(),
      rawAddress: String(item.rawAddress ?? address),
      address,
      locality: String(item.locality ?? location.label),
      postalCode: String(item.postalCode ?? location.postalCode),
      locationKey,
      status: (["pending", "delivered", "failed"].includes(String(item.status)) ? item.status : "pending") as Status,
      lat: Number.isFinite(Number(item.lat)) ? Number(item.lat) : undefined,
      lon: Number.isFinite(Number(item.lon)) ? Number(item.lon) : undefined,
      precision: item.precision as Precision | undefined,
      reason: item.reason ? String(item.reason) : undefined,
      corrections: Array.isArray(item.corrections) ? item.corrections as Stop["corrections"] : undefined,
      sourceManifest: item.sourceManifest ? String(item.sourceManifest) : undefined,
      sourceRowId: item.sourceRowId ? String(item.sourceRowId) : undefined,
    }];
  });
 }

 function transferToStops(payload: RouteTransferPayload, existing: Stop[]) {
  const known = new Set(existing.filter((stop) => stop.sourceManifest && stop.sourceRowId).map((stop) => `${stop.sourceManifest}|${stop.sourceRowId}`));
  const start = Math.max(0, ...existing.map((stop) => stop.loadOrder));
  return payload.rows
    .filter((row) => !known.has(`${payload.manifestNumber}|${row.sourceRowId}`))
    .map((row, index) => {
      const analysis = analyzeCatalogAddress(row.address, row.locationKey);
      return {
        id: crypto.randomUUID(),
        loadOrder: start + index + 1,
        packageNo: row.packageNo,
        name: row.name,
        rawAddress: row.address,
        address: analysis.correctedAddress,
        locality: row.locality || locationByKey(row.locationKey).label,
        postalCode: row.postalCode || locationByKey(row.locationKey).postalCode,
        locationKey: row.locationKey,
        status: "pending" as Status,
        corrections: analysis.corrections,
        sourceManifest: payload.manifestNumber,
        sourceRowId: row.sourceRowId,
      } satisfies Stop;
    });
 }


 function parseCoordinates(value: string) {
  const source = value.trim();
  if (!source) return null;
  let decoded = source;
  try { decoded = decodeURIComponent(source); } catch { /* URL parcial */ }
  const number = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const patterns = [
    new RegExp(`@${number},${number}`),
    new RegExp(`!3d${number}!4d${number}`),
    new RegExp(`[?&](?:q|query|ll)=${number}(?:,|%2C|\\s)+${number}`, "i"),
    new RegExp(`^\\s*${number}\\s*[,;]\\s*${number}\\s*$`),
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon };
  }
  return null;
 }

 function googleMapsSearch(stop: Stop) {
  const query = [stop.rawAddress || stop.address, stop.locality, stop.postalCode, "Buenos Aires", "Argentina"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
 }

 function MapView({ stops, origin }: { stops: Stop[]; origin?: { lat: number; lon: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let map: any;
    let cancelled = false;
    void (async () => {
      if (!ref.current) return;
      if (!document.querySelector("link[data-leaflet-css]")) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css";
        link.dataset.leafletCss = "true";
        document.head.appendChild(link);
      }
      const importExternal = new Function("url", "return import(url)") as (url: string) => Promise<any>;
      const L = await importExternal("https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet-src.esm.js");
      if (cancelled || !ref.current) return;
      map = L.map(ref.current, { zoomControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap contributors", maxZoom: 19 }).addTo(map);
      const points: [number, number][] = [];
      stops.forEach((stop, index) => {
        if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
        const approximate = stop.precision !== "exact" && stop.precision !== "manual";
        const icon = L.divIcon({
          className: "route-marker-wrap",
          html: `<div class="route-marker ${approximate ? "approx" : ""}"><span>${index + 1}</span></div>`,
          iconSize: [34, 34], iconAnchor: [17, 17],
        });
        L.marker([stop.lat!, stop.lon!], { icon }).addTo(map).bindPopup(`<strong>${index + 1}. ${stop.address}</strong><br>${stop.name || "Sin nombre"}<br>Paquete ${stop.packageNo}`);
        points.push([stop.lat!, stop.lon!]);
      });
      if (origin) {
        L.circleMarker([origin.lat, origin.lon], { radius: 8 }).addTo(map).bindPopup("Inicio");
        points.push([origin.lat, origin.lon]);
      }
      const mapped = stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
      if (mapped.length > 1) L.polyline(mapped.map((stop) => [stop.lat!, stop.lon!] as [number, number]), { weight: 4, opacity: 0.6 }).addTo(map);
      if (points.length) map.fitBounds(points, { padding: [34, 34], maxZoom: 15 });
      else map.setView([-34.59, -60.95], 12);
    })();
    return () => { cancelled = true; map?.remove(); };
  }, [stops, origin]);
  return <div className="map" ref={ref} />;
 }

 export default function RutaPostalHome() {
  const imagePicker = useRef<HTMLInputElement>(null);
  const universalPicker = useRef<HTMLInputElement>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [text, setText] = useState("");
  const [manualLocationKey, setManualLocationKey] = useState("junin-6000");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<{ lat: number; lon: number }>();
  const [activeLocationKey, setActiveLocationKey] = useState("");
  const [message, setMessage] = useState("");
  const [coordinateStopId, setCoordinateStopId] = useState<string | null>(null);
  const [coordinateText, setCoordinateText] = useState("");
  const [editStopId, setEditStopId] = useState<string | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editLocationKey, setEditLocationKey] = useState("junin-6000");

  useEffect(() => {
    try {
      let raw = localStorage.getItem(STORAGE);
      if (!raw) for (const key of LEGACY_STORAGES) { raw = localStorage.getItem(key); if (raw) break; }
      if (raw) setStops(migrateStored(JSON.parse(raw)));
    } catch {
      setMessage("No se pudo recuperar la ruta guardada.");
    } finally { setHydrated(true); }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE, JSON.stringify(stops)); } catch { /* memoria solamente */ }
  }, [hydrated, stops]);

  const localityGroups = useMemo(() => {
    const map = new Map<string, Stop[]>();
    for (const stop of [...stops].sort((a, b) => a.loadOrder - b.loadOrder)) {
      const group = map.get(stop.locationKey) ?? [];
      group.push(stop);
      map.set(stop.locationKey, group);
    }
    return [...map.entries()].map(([key, rows]) => ({ key, location: locationByKey(key), rows }));
  }, [stops]);

  useEffect(() => {
    if (!localityGroups.length) { setActiveLocationKey(""); return; }
    if (!localityGroups.some((group) => group.key === activeLocationKey)) setActiveLocationKey(localityGroups[0].key);
  }, [localityGroups, activeLocationKey]);

  async function geocode(list: Stop[]) {
    const pending = list.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
    if (!pending.length) return;
    setBusy(true);
    setMessage(`Ubicando ${pending.length} dirección${pending.length === 1 ? "" : "es"} de ${locationByKey(pending[0].locationKey).label}…`);
    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direcciones: pending.map((stop) => ({ direccion: stop.rawAddress || stop.address, locationKey: stop.locationKey })) }),
      });
      if (!response.ok) throw new Error("No respondió el servicio de geocodificación.");
      const data = await response.json() as { results: GeoResult[] };
      const byId = new Map(pending.map((stop, index) => [stop.id, data.results[index]]));
      setStops((previous) => previous.map((stop) => {
        const geo = byId.get(stop.id);
        return geo ? { ...stop, address: geo.normalizedAddress || stop.address, lat: geo.lat, lon: geo.lon, precision: geo.precision, reason: geo.reason, corrections: geo.corrections } : stop;
      }));
      setMessage(`${locationByKey(pending[0].locationKey).label}: ubicación terminada.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron ubicar las direcciones.");
    } finally { setBusy(false); }
  }

  async function activateLocation(key: string, rows?: Stop[]) {
    setActiveLocationKey(key);
    const list = rows ?? stops.filter((stop) => stop.locationKey === key);
    await geocode(list);
  }

  useEffect(() => {
    if (!hydrated) return;
    try {
      const raw = localStorage.getItem(ROUTE_TRANSFER_KEY) ?? localStorage.getItem(LEGACY_ROUTE_TRANSFER_KEY);
      if (!raw) return;
      const parsed = normalizeRouteTransferPayload(JSON.parse(raw));
      localStorage.removeItem(ROUTE_TRANSFER_KEY);
      localStorage.removeItem(LEGACY_ROUTE_TRANSFER_KEY);
      if (!parsed) { setMessage("La transferencia del OCR no tenía un formato válido."); return; }
      const created = transferToStops(parsed, stops);
      if (!created.length) { setMessage(`El manifiesto ${parsed.manifestNumber || "sin número"} ya estaba incorporado.`); return; }
      setStops((previous) => [...previous, ...created]);
      const firstKey = created[0].locationKey;
      setActiveLocationKey(firstKey);
      setMessage(`${created.length} envíos importados desde OCR. ${new Set(created.map((row) => row.locationKey)).size} localidad(es) detectadas.`);
      void geocode(created.filter((row) => row.locationKey === firstKey));
    } catch {
      localStorage.removeItem(ROUTE_TRANSFER_KEY);
      localStorage.removeItem(LEGACY_ROUTE_TRANSFER_KEY);
      setMessage("No se pudo importar el manifiesto enviado por OCR.");
    }
    // Una transferencia por carga de la aplicación.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  async function importRows(created: Stop[], sourceLabel: string) {
    if (!created.length) return;
    setStops((previous) => [...previous, ...created]);
    const firstKey = created[0].locationKey;
    setActiveLocationKey(firstKey);
    const groups = new Set(created.map((row) => row.locationKey)).size;
    setMessage(`${created.length} envíos cargados desde ${sourceLabel}. ${groups} localidad${groups === 1 ? "" : "es"}; sólo se carga el primer mapa.`);
    await geocode(created.filter((row) => row.locationKey === firstKey));
  }

  async function addManual() {
    const tableRows = bulkRows(text);
    const freeRows = tableRows.length ? [] : parseManualAddresses(text, manualLocationKey);
    if (!tableRows.length && !freeRows.length) {
      setMessage("No se reconocieron direcciones. Escribí una por línea, por ejemplo: Rivadavia 40 Junín; también podés usar 'Arias entre Cabrera y Quintana Junín'.");
      return;
    }
    const start = Math.max(0, ...stops.map((stop) => stop.loadOrder));
    const sourceRows = tableRows.length
      ? tableRows
      : freeRows.map((row, index) => ({ ...row, packageNo: start + index + 1, name: "" }));
    const created = sourceRows.map((row, index) => {
      const analysis = analyzeCatalogAddress(row.address, row.locationKey);
      return {
        id: crypto.randomUUID(), loadOrder: start + index + 1, packageNo: row.packageNo || start + index + 1, name: row.name,
        rawAddress: row.address, address: analysis.correctedAddress, locality: row.locality, postalCode: row.postalCode,
        locationKey: row.locationKey, status: "pending" as Status, corrections: analysis.corrections,
      } satisfies Stop;
    });
    setText("");
    await importRows(created, tableRows.length ? "tabla pegada" : "direcciones manuales");
  }

  async function importPdf(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("Leyendo manifiesto PDF y normalizando sus columnas…");
    try {
      const parsed = await parseManifestPdf(file);
      const start = Math.max(0, ...stops.map((stop) => stop.loadOrder));
      const created = parsed.rows.map((row, index) => {
        const analysis = analyzeCatalogAddress(row.address, row.locationKey);
        return {
          id: crypto.randomUUID(), loadOrder: start + index + 1, packageNo: row.packageNo, name: row.name,
          rawAddress: row.address, address: analysis.correctedAddress, locality: row.locality, postalCode: row.postalCode,
          locationKey: row.locationKey, status: "pending" as Status, corrections: analysis.corrections,
          sourceManifest: parsed.manifestNumber, sourceRowId: `${row.packageNo}:${row.sourceCode ?? row.name}:${row.address}`,
        } satisfies Stop;
      });
      if (!created.length) {
        const diagnostic = parsed.diagnostics ? ` Texto: ${parsed.diagnostics.textItems} bloques; localidades detectadas: ${parsed.diagnostics.localityMarkers}; estrategia: ${parsed.diagnostics.strategy}.` : "";
        throw new Error(`${parsed.warnings.join(" ") || "No se pudieron reconstruir envíos desde el PDF."}${diagnostic}`);
      }
      await importRows(created, parsed.manifestNumber ? `PDF · manifiesto ${parsed.manifestNumber}` : "PDF");
      if (parsed.warnings.length) setMessage((current) => `${current} ${parsed.warnings.join(" ")}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo leer el PDF.");
    } finally { setBusy(false); }
  }

  async function importImages(files: File[]) {
    const images = files.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type)).slice(0, 8);
    if (!images.length) {
      setMessage("Seleccioná imágenes JPG, PNG, WEBP, HEIC o HEIF.");
      return;
    }
    const totalBytes = images.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > 24 * 1024 * 1024) {
      setMessage("Las imágenes superan el máximo total de 24 MB.");
      return;
    }

    setBusy(true);
    setMessage(`Leyendo ${images.length} imagen${images.length === 1 ? "" : "es"} con OCR y preparando la ruta…`);
    try {
      const form = new FormData();
      images.forEach((file) => form.append("images", file, file.name));
      form.append("mode", "maximum");
      const response = await fetch("/api/scan", { method: "POST", body: form });
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) throw new Error("El servicio OCR devolvió una respuesta inválida.");
      const result = await response.json() as OcrResult & { error?: string };
      if (!response.ok) throw new Error(result.error || "No se pudo procesar el manifiesto con OCR.");
      if (!result.rows.length) throw new Error("El OCR no encontró filas de envío en las imágenes.");

      const payload = buildRouteTransfer(result);
      const created = transferToStops(payload, stops);
      if (!created.length) {
        setMessage(`El manifiesto ${result.manifestNumber || "sin número"} ya estaba incorporado.`);
        return;
      }
      const reviewCount = result.rows.filter((row) => row.status === "review").length;
      await importRows(created, result.manifestNumber ? `imágenes OCR · manifiesto ${result.manifestNumber}` : "imágenes OCR");
      if (reviewCount) {
        setMessage((current) => `${current} ${reviewCount} fila${reviewCount === 1 ? " quedó" : "s quedaron"} con advertencias de lectura; revisá nombre/dirección en la tabla antes de repartir.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron leer las imágenes.");
    } finally {
      setBusy(false);
      if (imagePicker.current) imagePicker.current.value = "";
    }
  }


  async function importFiles(files: File[]) {
    const usable = files.filter((file) => file.type === "application/pdf" || ACCEPTED_IMAGE_TYPES.has(file.type));
    if (!usable.length) {
      setMessage("Arrastrá un PDF o imágenes JPG, PNG, WEBP, HEIC o HEIF.");
      return;
    }
    const pdfs = usable.filter((file) => file.type === "application/pdf");
    const images = usable.filter((file) => ACCEPTED_IMAGE_TYPES.has(file.type));
    if (pdfs.length && images.length) {
      setMessage("Para evitar mezclar procesos, cargá el PDF o las imágenes en una operación separada.");
      return;
    }
    if (pdfs.length) {
      await importPdf(pdfs[0]);
      return;
    }
    await importImages(images);
  }

  function openAddressEditor(stop: Stop) {
    setEditStopId(stop.id);
    setEditAddress(stop.rawAddress || stop.address);
    setEditLocationKey(stop.locationKey);
  }

  async function saveAddressEdit() {
    if (!editStopId || !editAddress.trim()) return;
    const current = stops.find((stop) => stop.id === editStopId);
    if (!current) return;
    const location = locationByKey(editLocationKey);
    const analysis = analyzeCatalogAddress(editAddress.trim(), editLocationKey);
    const edited: Stop = {
      ...current,
      rawAddress: editAddress.trim(),
      address: analysis.correctedAddress,
      locality: location.label,
      postalCode: location.postalCode,
      locationKey: editLocationKey,
      lat: undefined,
      lon: undefined,
      precision: undefined,
      reason: undefined,
      corrections: analysis.corrections,
    };
    setStops((previous) => previous.map((item) => item.id === current.id ? edited : item));
    setEditStopId(null);
    setEditAddress("");
    setActiveLocationKey(editLocationKey);
    await geocode([edited]);
  }

  function clearAll() {
    if (!stops.length || confirm("¿Borrar todos los envíos y mapas?")) {
      setStops([]);
      setActiveLocationKey("");
      setMessage("");
    }
  }

  function openCoordinateEditor(stop: Stop) {
    setCoordinateStopId(stop.id);
    setCoordinateText(Number.isFinite(stop.lat) && Number.isFinite(stop.lon) ? `${stop.lat}, ${stop.lon}` : "");
  }

  function saveCoordinates() {
    if (!coordinateStopId) return;
    const coordinates = parseCoordinates(coordinateText);
    if (!coordinates) {
      setMessage("Pegá coordenadas como -34.585, -60.949 o una URL de Google Maps que las contenga.");
      return;
    }
    setStops((previous) => previous.map((stop) => stop.id === coordinateStopId ? {
      ...stop,
      lat: coordinates.lat,
      lon: coordinates.lon,
      precision: "manual",
      reason: "Ubicación confirmada con coordenadas manuales.",
    } : stop));
    setCoordinateStopId(null);
    setCoordinateText("");
    setMessage("Coordenadas guardadas.");
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setOrigin({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => setMessage("No se pudo acceder a tu ubicación."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const activeGroup = localityGroups.find((group) => group.key === activeLocationKey);
  const activeStops = activeGroup?.rows ?? [];
  const activeMapped = activeStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  const activeMissing = activeStops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
  const optimized = useMemo(() => optimize(activeStops, origin), [activeStops, origin]);
  const display = [...optimized, ...activeMissing];
  const waitingCount = stops.length - activeStops.length;

  function exportRoute() {
    const rows = [["Nº de paquete", "Nombre", "Dirección", "Localidad", "CP", "Parada", "Estado", "Precisión", "Lat", "Lon"].map(csv).join(";")];
    for (const group of localityGroups) {
      const ordered = optimize(group.rows, origin);
      const missing = group.rows.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
      [...ordered, ...missing].forEach((stop, index) => rows.push([
        stop.packageNo, stop.name, stop.address, stop.locality, stop.postalCode,
        Number.isFinite(stop.lat) ? index + 1 : "", stop.status, stop.precision, stop.lat, stop.lon,
      ].map(csv).join(";")));
    }
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "ruta-postal.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const nextGroup = localityGroups.find((group) => group.key !== activeLocationKey && group.rows.some((row) => row.status === "pending"));

  const coordinateStop = coordinateStopId ? stops.find((stop) => stop.id === coordinateStopId) : undefined;

  return <main className="ruta-postal">
    <nav className="app-bar" aria-label="Ruta Envíos">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">R</span>
        <span><strong>Ruta Envíos</strong><small>Planificador de reparto</small></span>
      </div>
      <div className="top-actions">
        <InstallPwa />
        <button className="icon-action" type="button" onClick={locate} title="Usar mi ubicación" aria-label="Usar mi ubicación">⌖</button>
        <button className="clear-action" type="button" disabled={!stops.length} onClick={clearAll}>Limpiar</button>
      </div>
    </nav>

    <section className="workspace">
      <section className="panel input-panel" id="cargar">
        <div className="section-title">
          <div><span className="section-kicker">NUEVA RUTA</span><h1>Cargar paradas</h1></div>
          <b className="route-count">{stops.length}</b>
        </div>

        <div className="manual-location">
          <label htmlFor="manual-location">Localidad por defecto</label>
          <select id="manual-location" value={manualLocationKey} onChange={(event) => setManualLocationKey(event.target.value)}>
            {SUPPORTED_LOCATIONS.filter((location) => location.locality).map((location) => <option value={location.key} key={location.key}>{location.label} · {location.postalCode}</option>)}
          </select>
        </div>

        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={'Rivadavia 40 Junín\nSalta 32 Junín\nArias entre Cabrera y Quintana Junín'} />
        <button className="primary manual-submit" disabled={busy || !text.trim()} onClick={addManual}>Ubicar direcciones</button>

        <div className="separator"><span>o</span></div>

        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}
          onClick={() => !busy && universalPicker.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy) universalPicker.current?.click(); }}
        >
          <span className="drop-icon" aria-hidden="true">＋</span>
          <strong>Soltá archivos acá</strong>
          <small>PDF o imágenes</small>
        </div>
        <input ref={universalPicker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />

        <div className="file-actions">
          <label className="secondary-action">PDF<input type="file" accept="application/pdf" hidden disabled={busy} onChange={(event) => { void importPdf(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <button className="secondary-action" type="button" disabled={busy} onClick={() => imagePicker.current?.click()}>Imágenes</button>
          <input ref={imagePicker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => void importImages(Array.from(event.target.files ?? []))} />
        </div>
        {message && <p className="message" aria-live="polite">{message}</p>}
      </section>

      <section className="panel map-panel" id="mapa">
        <div className="map-toolbar">
          <div>
            <span className="section-kicker">MAPA</span>
            <h2>{activeGroup ? activeGroup.location.label : "Sin localidad activa"}</h2>
          </div>
          <div className="map-meta">
            <span><b>{activeMapped.length}</b> ubicadas</span>
            <span><b>{activeMissing.length}</b> pendientes</span>
          </div>
        </div>
        <MapView stops={optimized} origin={origin} />
        {nextGroup && <button className="next-location" disabled={busy} onClick={() => void activateLocation(nextGroup.key)}>Siguiente localidad · {nextGroup.location.label} →</button>}
      </section>
    </section>

    {localityGroups.length > 0 && <section className="locality-strip" aria-label="Localidades">
      {localityGroups.map((group, index) => {
        const active = group.key === activeLocationKey;
        const mappedCount = group.rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)).length;
        return <button key={group.key} className={`locality-chip ${active ? "active" : ""}`} disabled={busy && !active} onClick={() => void activateLocation(group.key)}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <b>{group.location.label}</b>
          <small>{group.rows.length} · {active ? "activo" : mappedCount === group.rows.length && mappedCount > 0 ? "listo" : "espera"}</small>
        </button>;
      })}
    </section>}

    <section className="panel route-panel" id="paradas">
      <div className="route-toolbar">
        <div><span className="section-kicker">PARADAS</span><h2>{activeGroup ? activeGroup.location.label : "Envíos"}</h2></div>
        <div className="route-actions">
          <span>{display.length} paradas</span>
          <button className="secondary-action compact-action" onClick={exportRoute}>CSV</button>
        </div>
      </div>
      <div className="stops">
        {display.map((stop, index) => <article className={`stop-card ${stop.precision && stop.precision !== "exact" && stop.precision !== "manual" ? "approx" : ""}`} key={stop.id}>
          <div className="stop-number">{Number.isFinite(stop.lat) ? index + 1 : "!"}</div>
          <div className="stop-main">
            <div className="stop-heading"><b>{stop.address}</b><button className="edit-address-link" type="button" onClick={() => openAddressEditor(stop)} aria-label={`Editar dirección ${stop.address}`}>Editar</button><span>{stop.locality || locationByKey(stop.locationKey).label} · {stop.postalCode}</span></div>
            {(stop.name || stop.packageNo) && <div className="stop-subline">{stop.packageNo && <span>#{stop.packageNo}</span>}{stop.name && <span>{stop.name}</span>}</div>}
            {stop.reason && <p className={`reason ${stop.precision ?? "missing"}`}>{stop.reason}</p>}
            {(!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) && <div className="location-fallback"><button type="button" disabled={busy} onClick={() => void geocode([stop])}>Reintentar</button><button type="button" onClick={() => openAddressEditor(stop)}>Corregir dirección</button><a href={googleMapsSearch(stop)} target="_blank" rel="noreferrer">Google Maps</a><button type="button" onClick={() => openCoordinateEditor(stop)}>Pegar coordenadas</button></div>}
          </div>
          <div className="stop-controls">
            <select aria-label={`Estado de ${stop.address}`} value={stop.status} onChange={(event) => setStops((previous) => previous.map((item) => item.id === stop.id ? { ...item, status: event.target.value as Status } : item))}><option value="pending">Pendiente</option><option value="delivered">Entregado</option><option value="failed">No entregado</option></select>
            <button type="button" onClick={() => openAddressEditor(stop)}>Editar dirección</button>
          </div>
        </article>)}
        {!display.length && <div className="empty-state"><span aria-hidden="true">⌖</span><b>Sin paradas todavía</b><small>Cargá direcciones, un PDF o imágenes.</small></div>}
      </div>
    </section>

    {editStopId && <div className="coordinate-backdrop" role="presentation" onClick={() => setEditStopId(null)}>
      <section className="coordinate-sheet edit-address-sheet" role="dialog" aria-modal="true" aria-labelledby="edit-address-title" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <button className="sheet-close" type="button" aria-label="Cerrar" onClick={() => setEditStopId(null)}>×</button>
        <h2 id="edit-address-title">Editar dirección</h2>
        <label className="sheet-field">
          <span>Dirección</span>
          <input autoFocus value={editAddress} onChange={(event) => setEditAddress(event.target.value)} placeholder="Rivadavia 40" onKeyDown={(event) => { if (event.key === "Enter") void saveAddressEdit(); }} />
        </label>
        <label className="sheet-field">
          <span>Localidad</span>
          <select value={editLocationKey} onChange={(event) => setEditLocationKey(event.target.value)}>
            {SUPPORTED_LOCATIONS.filter((location) => location.locality).map((location) => <option value={location.key} key={location.key}>{location.label} · {location.postalCode}</option>)}
          </select>
        </label>
        <button className="primary sheet-save" type="button" disabled={busy || !editAddress.trim()} onClick={() => void saveAddressEdit()}>Guardar y volver a ubicar</button>
      </section>
    </div>}

    {coordinateStop && <div className="coordinate-backdrop" role="presentation" onClick={() => setCoordinateStopId(null)}>
      <section className="coordinate-sheet" role="dialog" aria-modal="true" aria-labelledby="coordinate-title" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <button className="sheet-close" type="button" aria-label="Cerrar" onClick={() => setCoordinateStopId(null)}>×</button>
        <h2 id="coordinate-title">Ubicar manualmente</h2>
        <p>{coordinateStop.rawAddress || coordinateStop.address} · {coordinateStop.locality}</p>
        <input autoFocus value={coordinateText} onChange={(event) => setCoordinateText(event.target.value)} placeholder="-34.585, -60.949 o URL de Google Maps" />
        <div className="coordinate-actions">
          <a className="secondary-action" href={googleMapsSearch(coordinateStop)} target="_blank" rel="noreferrer">Google Maps</a>
          <button className="primary" type="button" onClick={saveCoordinates}>Usar coordenadas</button>
        </div>
      </section>
    </div>}

    <nav className="mobile-dock" aria-label="Secciones">
      <a href="#cargar"><span>＋</span>Cargar</a>
      <a href="#mapa"><span>⌖</span>Mapa</a>
      <a href="#paradas"><span>≡</span>Paradas</a>
    </nav>
  </main>;
 }
