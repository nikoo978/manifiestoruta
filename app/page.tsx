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
        body: JSON.stringify({ direcciones: pending.map((stop) => ({ direccion: stop.address, locationKey: stop.locationKey })) }),
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

  async function editStop(stop: Stop) {
    const packageText = prompt("Nº de paquete", String(stop.packageNo));
    if (packageText === null) return;
    const name = prompt("Nombre", stop.name) ?? stop.name;
    const address = prompt("Dirección", stop.rawAddress || stop.address) ?? stop.rawAddress;
    const locality = prompt("Localidad", stop.locality) ?? stop.locality;
    const postalCode = prompt("CP", stop.postalCode) ?? stop.postalCode;
    const inferred = inferLocation(locality, postalCode);
    const analysis = analyzeCatalogAddress(address.trim(), inferred.key);
    const edited: Stop = {
      ...stop, packageNo: Number(packageText.replace(/\D/g, "")) || stop.packageNo, name: name.trim(), rawAddress: address.trim(),
      address: analysis.correctedAddress, locality: locality.trim() || inferred.label, postalCode: postalCode.replace(/\D/g, "").slice(0, 4) || inferred.postalCode,
      locationKey: inferred.key, lat: undefined, lon: undefined, precision: undefined, reason: undefined, corrections: analysis.corrections,
    };
    setStops((previous) => previous.map((item) => item.id === stop.id ? edited : item));
    setActiveLocationKey(edited.locationKey);
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
    <nav className="suite-nav" aria-label="Herramientas">
      <strong>Ruta Envíos</strong>
      <div className="top-actions">
        <InstallPwa />
        <button className="button danger clear-top" type="button" disabled={!stops.length} onClick={clearAll}><span aria-hidden="true">×</span> Limpiar</button>
      </div>
    </nav>

    <header className="app-header">
      <div>
        <h1>Planificar reparto</h1>
        <p>Direcciones, PDF o imágenes.</p>
      </div>
      <button className="icon-btn" onClick={locate} title="Usar mi ubicación" aria-label="Usar mi ubicación"><span aria-hidden="true">⌖</span></button>
    </header>

    <section className="stats">
      <div><b>{stops.length}</b><span>envíos totales</span></div>
      <div><b>{activeStops.length}</b><span>{activeGroup ? `en ${activeGroup.location.label}` : "localidad activa"}</span></div>
      <div><b>{waitingCount}</b><span>en espera</span></div>
    </section>

    <section className="panel locality-panel">
      <div className="panel-head"><div><h2>Localidades</h2><span>Una localidad por mapa.</span></div></div>
      <div className="locality-queue">
        {localityGroups.map((group, index) => {
          const active = group.key === activeLocationKey;
          const mappedCount = group.rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)).length;
          return <button key={group.key} className={`locality-card ${active ? "active" : ""}`} disabled={busy && !active} onClick={() => void activateLocation(group.key)}>
            <span className="queue-index">{String(index + 1).padStart(2, "0")}</span>
            <span><b>{group.location.label}</b><small>{group.rows.length} envíos · CP {group.location.postalCode}</small></span>
            <em>{active ? "Mapa activo" : mappedCount === group.rows.length && mappedCount > 0 ? "Listo · en espera" : "En espera"}</em>
          </button>;
        })}
        {!localityGroups.length && <p className="queue-empty">Las localidades aparecerán acá cuando cargues envíos.</p>}
      </div>
    </section>

    <section className="grid">
      <div className="panel input-panel">
        <h2>Cargar direcciones</h2>
        <div className="manual-location">
          <label htmlFor="manual-location">Localidad por defecto</label>
          <select id="manual-location" value={manualLocationKey} onChange={(event) => setManualLocationKey(event.target.value)}>
            {SUPPORTED_LOCATIONS.filter((location) => location.locality).map((location) => <option value={location.key} key={location.key}>{location.label} · CP {location.postalCode}</option>)}
          </select>
        </div>
        <p className="helper top">Una dirección por línea. La localidad dentro de la línea es opcional.</p>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={'Rivadavia 40 Junín\nSalta 32 Junín\nArias entre Cabrera y Quintana Junín\nSan Martín 248 Ferré'} />
        <button className="primary manual-submit" disabled={busy || !text.trim()} onClick={addManual}><span aria-hidden="true">⌖</span> Ubicar direcciones</button>

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
          <strong>Soltá PDF o imágenes</strong>
          <span>o tocá para elegir archivos</span>
        </div>
        <input ref={universalPicker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />

        <div className="actions file-actions">
          <label className="button"><span aria-hidden="true">↑</span> PDF<input type="file" accept="application/pdf" hidden disabled={busy} onChange={(event) => { void importPdf(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <button className="button ocr-button" type="button" disabled={busy} onClick={() => imagePicker.current?.click()}><span aria-hidden="true">◎</span> Imágenes</button>
          <input ref={imagePicker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => void importImages(Array.from(event.target.files ?? []))} />
        </div>
        {message && <p className="message" aria-live="polite">{message}</p>}
      </div>

      <div className="panel map-panel">
        <div className="panel-head">
          <div><h2>{activeGroup ? `Mapa · ${activeGroup.location.label}` : "Mapa"}</h2><span>{activeGroup ? `${activeMapped.length} ubicadas · ${activeMissing.length} pendientes` : "Cargá envíos para iniciar"}</span></div>
          {nextGroup && <button className="button next-location" disabled={busy} onClick={() => void activateLocation(nextGroup.key)}>Siguiente: {nextGroup.location.label} →</button>}
        </div>
        <MapView stops={optimized} origin={origin} />
      </div>
    </section>

    <section className="panel route-panel">
      <div className="panel-head">
        <div><h2>{activeGroup ? `Envíos · ${activeGroup.location.label}` : "Envíos"}</h2><span>{display.length} paradas</span></div>
        <div className="actions compact">
          <button className="button" onClick={exportRoute}><span aria-hidden="true">↓</span> CSV</button>
          <button className="button danger" onClick={clearAll}><span aria-hidden="true">×</span> Limpiar</button>
        </div>
      </div>
      <div className="data-head"><span>Parada</span><span>Nº paquete</span><span>Nombre</span><span>Dirección</span><span>Localidad</span><span>CP</span><span>Estado</span></div>
      <div className="stops">
        {display.map((stop, index) => <article className={`stop stop-v2 ${stop.precision && stop.precision !== "exact" && stop.precision !== "manual" ? "approx" : ""}`} key={stop.id}>
          <div className="number"><strong>{Number.isFinite(stop.lat) ? index + 1 : "!"}</strong></div>
          <div className="package-cell"><small>Nº paquete</small><b>{stop.packageNo}</b></div>
          <div className="person-cell"><small>Nombre</small><b>{stop.name || "—"}</b></div>
          <div className="address-cell"><small>Dirección</small><b>{stop.address}</b>{stop.reason && <span className={`reason ${stop.precision ?? "missing"}`}>{stop.reason}</span>}{(!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) && <div className="location-fallback"><a href={googleMapsSearch(stop)} target="_blank" rel="noreferrer">Google Maps</a><button type="button" onClick={() => openCoordinateEditor(stop)}>Pegar coordenadas</button></div>}</div>
          <div className="location-cell"><small>Localidad</small><b>{stop.locality || locationByKey(stop.locationKey).label}</b></div>
          <div className="cp-cell"><small>CP</small><b>{stop.postalCode}</b></div>
          <div className="status-cell"><small>Estado</small><select value={stop.status} onChange={(event) => setStops((previous) => previous.map((item) => item.id === stop.id ? { ...item, status: event.target.value as Status } : item))}><option value="pending">Pendiente</option><option value="delivered">Entregado</option><option value="failed">No entregado</option></select><button onClick={() => void editStop(stop)}>Editar</button></div>
        </article>)}
        {!display.length && <div className="empty">Todavía no hay envíos.</div>}
      </div>
    </section>

    {coordinateStop && <div className="coordinate-backdrop" role="presentation" onClick={() => setCoordinateStopId(null)}>
      <section className="coordinate-sheet" role="dialog" aria-modal="true" aria-labelledby="coordinate-title" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <button className="sheet-close" type="button" aria-label="Cerrar" onClick={() => setCoordinateStopId(null)}>×</button>
        <h2 id="coordinate-title">Ubicar manualmente</h2>
        <p>{coordinateStop.rawAddress || coordinateStop.address} · {coordinateStop.locality}</p>
        <input autoFocus value={coordinateText} onChange={(event) => setCoordinateText(event.target.value)} placeholder="-34.585, -60.949 o URL de Google Maps" />
        <div className="coordinate-actions">
          <a className="button" href={googleMapsSearch(coordinateStop)} target="_blank" rel="noreferrer">Buscar en Google Maps</a>
          <button className="primary" type="button" onClick={saveCoordinates}>Usar coordenadas</button>
        </div>
      </section>
    </div>}

    <footer>Ruta Envíos</footer>
  </main>;
 }
