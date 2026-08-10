"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { InstallPwa, ThemeToggle } from "./pwa-controls";
import { analyzeCatalogAddress } from "@/lib/street-catalog";
import { canonicalizeLocation, locationByKey, SUPPORTED_LOCATIONS } from "@/lib/supported-locations";
import { parseManifestPdf } from "@/lib/manifest-pdf";
import { parseManualAddresses } from "@/lib/manual-address";
import { clearSourceFiles, getSourceFile, saveSourceFile, type StoredSource } from "@/lib/source-store";
import {
  buildRouteTransfer,
  LEGACY_ROUTE_TRANSFER_KEY,
  normalizeRouteTransferPayload,
  ROUTE_TRANSFER_KEY,
  type RouteTransferPayload,
} from "@/lib/route-transfer";
import { APP_VERSION } from "@/lib/app-version";

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
  sourceKind?: "image" | "pdf";
  sourceId?: string;
  sourcePage?: number;
  sourceRow?: number;
  sourceTop?: number;
  sourceBottom?: number;
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
  sourceTop?: number;
  sourceBottom?: number;
  status: "verified" | "review";
  note?: string;
 };

 type OcrResult = {
  manifestNumber: string;
  pages: number;
  rows: OcrRow[];
  persisted?: boolean;
 };

 type OcrModeChoice = "fast" | "intense";
 type OcrProgressState = {
  percent: number;
  label: string;
  elapsedMs: number;
  mode: OcrModeChoice;
 };

 type OcrStreamEvent = {
  type: "progress" | "heartbeat" | "result" | "error";
  percent?: number;
  message?: string;
  elapsedMs?: number;
  mode?: "fast" | "maximum";
  result?: OcrResult;
  error?: string;
 };

 const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

 const STORAGE = "ruta-postal:v3";
 const LEGACY_STORAGES = ["ruta-postal:v2", "ruta-postal:v1"];
 const ALL_LOCATIONS_KEY = "__all__";

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
    const canonical = canonicalizeLocation(locality, postalCode);
    return [{
      packageNo: Number(packageText.replace(/\D/g, "")) || index + 1,
      name: name.trim(),
      address: address.trim(),
      locality: canonical.locality,
      postalCode: canonical.postalCode,
      locationKey: canonical.locationKey,
    }];
  });
 }

 function migrateStored(value: unknown): Stop[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const canonical = canonicalizeLocation(String(item.locality ?? ""), String(item.postalCode ?? ""), String(item.locationKey ?? ""));
    const locationKey = canonical.locationKey;
    const address = String(item.address ?? item.rawAddress ?? "").trim();
    if (!address) return [];
    return [{
      id: String(item.id ?? crypto.randomUUID()),
      loadOrder: Number(item.loadOrder ?? index + 1),
      packageNo: Number(item.packageNo ?? index + 1),
      name: String(item.name ?? item.recipient ?? "").trim(),
      rawAddress: String(item.rawAddress ?? address),
      address,
      locality: canonical.locality,
      postalCode: canonical.postalCode,
      locationKey,
      status: (["pending", "delivered", "failed"].includes(String(item.status)) ? item.status : "pending") as Status,
      lat: Number.isFinite(Number(item.lat)) ? Number(item.lat) : undefined,
      lon: Number.isFinite(Number(item.lon)) ? Number(item.lon) : undefined,
      precision: item.precision as Precision | undefined,
      reason: item.reason ? String(item.reason) : undefined,
      corrections: Array.isArray(item.corrections) ? item.corrections as Stop["corrections"] : undefined,
      sourceManifest: item.sourceManifest ? String(item.sourceManifest) : undefined,
      sourceRowId: item.sourceRowId ? String(item.sourceRowId) : undefined,
      sourceKind: item.sourceKind === "image" || item.sourceKind === "pdf" ? item.sourceKind : undefined,
      sourceId: item.sourceId ? String(item.sourceId) : undefined,
      sourcePage: Number.isFinite(Number(item.sourcePage)) ? Number(item.sourcePage) : undefined,
      sourceRow: Number.isFinite(Number(item.sourceRow)) ? Number(item.sourceRow) : undefined,
      sourceTop: Number.isFinite(Number(item.sourceTop)) ? Number(item.sourceTop) : undefined,
      sourceBottom: Number.isFinite(Number(item.sourceBottom)) ? Number(item.sourceBottom) : undefined,
    }];
  });
 }

 function transferToStops(payload: RouteTransferPayload, existing: Stop[]) {
  const known = new Set(existing.filter((stop) => stop.sourceManifest && stop.sourceRowId).map((stop) => `${stop.sourceManifest}|${stop.sourceRowId}`));
  const start = Math.max(0, ...existing.map((stop) => stop.loadOrder));
  return payload.rows
    .filter((row) => !known.has(`${payload.manifestNumber}|${row.sourceRowId}`))
    .map((row, index) => {
      const canonical = canonicalizeLocation(row.locality, row.postalCode, row.locationKey);
      const analysis = analyzeCatalogAddress(row.address, canonical.locationKey);
      return {
        id: crypto.randomUUID(),
        loadOrder: start + index + 1,
        packageNo: row.packageNo,
        name: row.name,
        rawAddress: row.address,
        address: analysis.correctedAddress,
        locality: canonical.locality,
        postalCode: canonical.postalCode,
        locationKey: canonical.locationKey,
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
  const loc = locationByKey(stop.locationKey);
  const query = [stop.rawAddress || stop.address, stop.locality, stop.postalCode, loc.province, "Argentina"].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
 }

 async function readOcrResponse(response: Response, mode: OcrModeChoice, onProgress: (progress: OcrProgressState) => void) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok && contentType.includes("application/json")) {
    const body = await response.json() as { error?: string };
    throw new Error(body.error || "No se pudo procesar el manifiesto con OCR.");
  }
  if (!response.body || !contentType.includes("application/x-ndjson")) {
    const body = await response.json() as OcrResult & { error?: string };
    if (!response.ok || body.error) throw new Error(body.error || "No se pudo procesar el manifiesto con OCR.");
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: OcrResult | null = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line) as OcrStreamEvent;
      if (event.type === "error") throw new Error(event.error || "No se pudo procesar el manifiesto con OCR.");
      if (event.type === "result" && event.result) result = event.result;
      if (event.type === "progress" || event.type === "heartbeat") {
        onProgress({
          percent: Math.max(1, Math.min(99, event.percent ?? 1)),
          label: event.message || "Procesando OCR…",
          elapsedMs: event.elapsedMs ?? 0,
          mode,
        });
      }
    }
    if (done) break;
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer) as OcrStreamEvent;
    if (event.type === "error") throw new Error(event.error || "No se pudo procesar el manifiesto con OCR.");
    if (event.type === "result" && event.result) result = event.result;
  }
  if (!result) throw new Error("El OCR terminó sin devolver un resultado utilizable.");
  return result;
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


 function PdfSourcePage({ source, stop, scale }: { source: StoredSource; stop: Stop; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const importExternal = new Function("url", "return import(url)") as (url: string) => Promise<any>;
        const pdfjs: any = await importExternal("https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs";
        const bytes = new Uint8Array(await source.blob.arrayBuffer());
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        const pageNumber = Math.max(1, Math.min(stop.sourcePage ?? 1, pdf.numPages));
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.6 });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("No se pudo preparar la vista del PDF.");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
        if (!cancelled && Number.isFinite(stop.sourceTop) && Number.isFinite(stop.sourceBottom)) {
          requestAnimationFrame(() => highlightRef.current?.scrollIntoView({ behavior: "auto", block: "center" }));
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "No se pudo abrir la página del PDF.");
      }
    })();
    return () => { cancelled = true; };
  }, [source, stop.sourcePage]);

  return <div className="source-viewport"><div className="source-zoom-content" style={{ width: `${scale * 100}%` }}>
    <div className="source-page-frame"><canvas ref={canvasRef} className="source-pdf-canvas" />
    {Number.isFinite(stop.sourceTop) && Number.isFinite(stop.sourceBottom) && <div
      ref={highlightRef}
      className="source-row-highlight"
      style={{ top: `${Math.max(0, stop.sourceTop!) * 100}%`, height: `${Math.max(0.025, stop.sourceBottom! - stop.sourceTop!) * 100}%` }}
    />}
    {error && <p className="source-error">{error}</p>}
    </div>
  </div></div>;
 }

 function SourceViewer({ stop, onClose }: { stop: Stop; onClose: () => void }) {
  const [source, setSource] = useState<StoredSource | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [scale, setScale] = useState(1);
  const imageHighlightRef = useRef<HTMLDivElement>(null);
  const zoomIn = () => setScale((value) => Math.min(4, Math.round((value + 0.5) * 10) / 10));
  const zoomOut = () => setScale((value) => Math.max(1, Math.round((value - 0.5) * 10) / 10));

  useEffect(() => {
    setScale(1);
    let active = true;
    let url = "";
    void (async () => {
      try {
        if (!stop.sourceId) throw new Error("La fuente original no está asociada a esta parada.");
        const stored = await getSourceFile(stop.sourceId);
        if (!stored) throw new Error("La fuente original ya no está disponible en este dispositivo.");
        if (!active) return;
        setSource(stored);
        if (stored.kind === "image") {
          url = URL.createObjectURL(stored.blob);
          setImageUrl(url);
          if (Number.isFinite(stop.sourceTop) && Number.isFinite(stop.sourceBottom)) {
            requestAnimationFrame(() => requestAnimationFrame(() => imageHighlightRef.current?.scrollIntoView({ behavior: "auto", block: "center" })));
          }
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "No se pudo abrir la fuente.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [stop.sourceId]);

  return <div className="source-backdrop" role="presentation" onClick={onClose}>
    <section className="source-sheet" role="dialog" aria-modal="true" aria-labelledby="source-title" onClick={(event) => event.stopPropagation()}>
      <button className="sheet-close" type="button" aria-label="Cerrar" onClick={onClose}>×</button>
      <div className="source-title-row">
        <div><h2 id="source-title">Fuente original</h2><p>{source?.name ?? "Documento"}{stop.sourcePage ? ` · página ${stop.sourcePage}` : ""}{stop.sourceRow ? ` · fila visual ${stop.sourceRow}` : ""}</p></div>
        <div className="source-zoom-controls" aria-label="Zoom de la fuente">
          <button type="button" onClick={zoomOut} disabled={scale <= 1} aria-label="Alejar">−</button>
          <button type="button" className="zoom-value" onClick={() => setScale(1)} aria-label="Restablecer zoom">{Math.round(scale * 100)}%</button>
          <button type="button" onClick={zoomIn} disabled={scale >= 4} aria-label="Acercar">＋</button>
        </div>
      </div>
      {loading && <div className="source-loading">Abriendo…</div>}
      {error && <div className="source-error">{error}</div>}
      {source?.kind === "image" && imageUrl && <div className="source-viewport"><div className="source-zoom-content" style={{ width: `${scale * 100}%` }}>
        <div className="source-image-frame"><img src={imageUrl} alt={`Fuente de ${stop.address}`} />
        {Number.isFinite(stop.sourceTop) && Number.isFinite(stop.sourceBottom) && <div
          ref={imageHighlightRef}
          className="source-row-highlight"
          style={{ top: `${Math.max(0, stop.sourceTop!) * 100}%`, height: `${Math.max(0.025, stop.sourceBottom! - stop.sourceTop!) * 100}%` }}
        />}
        </div>
      </div></div>}
      {source?.kind === "pdf" && <PdfSourcePage source={source} stop={stop} scale={scale} />}
    </section>
  </div>;
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
  const [ocrMode, setOcrMode] = useState<OcrModeChoice>("fast");
  const [ocrProgress, setOcrProgress] = useState<OcrProgressState | null>(null);
  const [origin, setOrigin] = useState<{ lat: number; lon: number }>();
  const [activeLocationKey, setActiveLocationKey] = useState(ALL_LOCATIONS_KEY);
  const [message, setMessage] = useState("");
  const [coordinateStopId, setCoordinateStopId] = useState<string | null>(null);
  const [coordinateText, setCoordinateText] = useState("");
  const [editStopId, setEditStopId] = useState<string | null>(null);
  const [editAddress, setEditAddress] = useState("");
  const [editLocationKey, setEditLocationKey] = useState("junin-6000");
  const [sourceStopId, setSourceStopId] = useState<string | null>(null);

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
    if (!localityGroups.length) { setActiveLocationKey(ALL_LOCATIONS_KEY); return; }
    if (activeLocationKey !== ALL_LOCATIONS_KEY && !localityGroups.some((group) => group.key === activeLocationKey)) setActiveLocationKey(ALL_LOCATIONS_KEY);
  }, [localityGroups, activeLocationKey]);

  async function geocode(list: Stop[]) {
    const pending = list.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
    if (!pending.length) return;
    setBusy(true);
    const locationCount = new Set(pending.map((stop) => stop.locationKey)).size;
    setMessage(locationCount === 1
      ? `Ubicando ${pending.length} dirección${pending.length === 1 ? "" : "es"} de ${locationByKey(pending[0].locationKey).label}…`
      : `Ubicando ${pending.length} direcciones de ${locationCount} ciudades…`);
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
      setMessage(locationCount === 1 ? `${locationByKey(pending[0].locationKey).label}: ubicación terminada.` : `${locationCount} ciudades unificadas: ubicación terminada.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron ubicar las direcciones.");
    } finally { setBusy(false); }
  }

  async function activateLocation(key: string, rows?: Stop[]) {
    setActiveLocationKey(key);
    const list = rows ?? (key === ALL_LOCATIONS_KEY ? stops : stops.filter((stop) => stop.locationKey === key));
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
      setActiveLocationKey(ALL_LOCATIONS_KEY);
      const cityCount = new Set(created.map((row) => row.locationKey)).size;
      setMessage(`${created.length} envíos importados desde OCR. ${cityCount} ciudad${cityCount === 1 ? "" : "es"} unificada${cityCount === 1 ? "" : "s"} en una sola ruta.`);
      void geocode(created);
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
    setActiveLocationKey(ALL_LOCATIONS_KEY);
    const groups = new Set(created.map((row) => row.locationKey)).size;
    setMessage(`${created.length} envíos cargados desde ${sourceLabel}. ${groups} ciudad${groups === 1 ? "" : "es"} en una sola ruta.`);
    await geocode(created);
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
      const canonical = canonicalizeLocation(row.locality, row.postalCode, row.locationKey);
      const analysis = analyzeCatalogAddress(row.address, canonical.locationKey);
      return {
        id: crypto.randomUUID(), loadOrder: start + index + 1, packageNo: row.packageNo || start + index + 1, name: row.name,
        rawAddress: row.address, address: analysis.correctedAddress, locality: canonical.locality, postalCode: canonical.postalCode,
        locationKey: canonical.locationKey, status: "pending" as Status, corrections: analysis.corrections,
      } satisfies Stop;
    });
    setText("");
    await importRows(created, tableRows.length ? "tabla pegada" : "direcciones manuales");
  }

  function approximateOcrBand(rows: OcrRow[], row: OcrRow) {
    const pageRows = rows.filter((item) => item.page === row.page);
    const index = Math.max(0, pageRows.findIndex((item) => item.id === row.id));
    if (Number.isFinite(row.sourceTop) && Number.isFinite(row.sourceBottom) && row.sourceBottom! > row.sourceTop!) {
      return { top: row.sourceTop! / 1000, bottom: row.sourceBottom! / 1000, visualRow: index + 1 };
    }
    // Último recurso: mantener el orden visual, nunca el número leído/circulado.
    const count = Math.max(1, pageRows.length);
    const usableTop = 0.08;
    const usableBottom = 0.94;
    const band = (usableBottom - usableTop) / count;
    return { top: usableTop + index * band, bottom: usableTop + (index + 1) * band, visualRow: index + 1 };
  }

  async function estimateImageBands(file: File, pageRows: OcrRow[]) {
    const fallback = new Map(pageRows.map((row) => [row.id, approximateOcrBand(pageRows, row)]));
    if (!pageRows.length || typeof createImageBitmap !== "function") return fallback;
    try {
      const bitmap = await createImageBitmap(file);
      const targetWidth = Math.min(640, bitmap.width);
      const scale = targetWidth / bitmap.width;
      const targetHeight = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = targetHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) { bitmap.close(); return fallback; }
      context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
      bitmap.close();
      const pixels = context.getImageData(0, 0, targetWidth, targetHeight).data;
      const x0 = Math.floor(targetWidth * 0.05);
      const x1 = Math.ceil(targetWidth * 0.95);
      const width = Math.max(1, x1 - x0);
      const darkFraction = new Float32Array(targetHeight);
      for (let y = 0; y < Math.min(targetHeight, Math.ceil(targetHeight * 0.45)); y++) {
        let dark = 0;
        for (let x = x0; x < x1; x += 2) {
          const offset = (y * targetWidth + x) * 4;
          const lum = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
          if (lum < 100) dark++;
        }
        darkFraction[y] = dark / Math.ceil(width / 2);
      }

      // El encabezado negro del manifiesto es la última banda oscura ancha antes de las filas.
      const groups: Array<{ start: number; end: number; peak: number }> = [];
      let start = -1;
      let peak = 0;
      const topLimit = Math.min(targetHeight, Math.ceil(targetHeight * 0.45));
      for (let y = 0; y < topLimit; y++) {
        const active = darkFraction[y] >= 0.28;
        if (active && start < 0) { start = y; peak = darkFraction[y]; }
        else if (active) peak = Math.max(peak, darkFraction[y]);
        else if (start >= 0) {
          if (y - start >= 5 && peak >= 0.62) groups.push({ start, end: y - 1, peak });
          start = -1; peak = 0;
        }
      }
      if (start >= 0 && topLimit - start >= 5 && peak >= 0.62) groups.push({ start, end: topLimit - 1, peak });
      const header = groups.at(-1);
      if (!header) return fallback;

      // Las líneas horizontales se repiten con una separación casi constante. Usarlas sólo
      // para estimar la altura física de una fila; así funciona aun si faltan algunas líneas.
      const coverage = new Float32Array(targetHeight);
      for (let y = Math.min(targetHeight - 1, header.end + 4); y < Math.floor(targetHeight * 0.86); y++) {
        let covered = 0;
        for (let x = x0; x < x1; x += 2) {
          let isDark = false;
          for (let dy = -2; dy <= 2 && !isDark; dy++) {
            const yy = Math.max(0, Math.min(targetHeight - 1, y + dy));
            const offset = (yy * targetWidth + x) * 4;
            const lum = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
            isDark = lum < 150;
          }
          if (isDark) covered++;
        }
        coverage[y] = covered / Math.ceil(width / 2);
      }
      const peaks: number[] = [];
      for (let y = header.end + 8; y < Math.floor(targetHeight * 0.84); y++) {
        if (coverage[y] < 0.5 || coverage[y] < coverage[y - 1] || coverage[y] < coverage[y + 1]) continue;
        if (!peaks.length || y - peaks.at(-1)! >= 6) peaks.push(y);
        else if (coverage[y] > coverage[peaks.at(-1)!]) peaks[peaks.length - 1] = y;
      }
      const gaps = peaks.slice(1).map((value, index) => value - peaks[index]).filter((gap) => gap >= 20 && gap <= 56).sort((a, b) => a - b);
      const aspectFallback = Math.max(24, Math.min(60, targetWidth * 0.074));
      const rowHeight = gaps.length >= 2 ? gaps[Math.floor(gaps.length / 2)] : aspectFallback;
      const firstTop = Math.min(targetHeight - 1, header.end + Math.max(2, targetHeight * 0.003));
      const bands = new Map<string, { top: number; bottom: number; visualRow: number }>();
      pageRows.forEach((row, index) => {
        const top = Math.max(0, Math.min(0.985, (firstTop + index * rowHeight) / targetHeight));
        const bottom = Math.max(top + 0.018, Math.min(0.995, (firstTop + (index + 1) * rowHeight) / targetHeight));
        bands.set(row.id, { top, bottom, visualRow: index + 1 });
      });
      return bands;
    } catch {
      return fallback;
    }
  }

  function openSource(stop: Stop) {
    if (!stop.sourceId) return;
    setSourceStopId(stop.id);
  }

  async function importPdf(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("Leyendo PDF…");
    try {
      const parsed = await parseManifestPdf(file);
      if (!parsed.rows.length) {
        const diagnostic = parsed.diagnostics ? ` Texto: ${parsed.diagnostics.textItems} bloques; localidades detectadas: ${parsed.diagnostics.localityMarkers}; estrategia: ${parsed.diagnostics.strategy}.` : "";
        throw new Error(`${parsed.warnings.join(" ") || "No se pudieron reconstruir envíos desde el PDF."}${diagnostic}`);
      }
      const sourceId = await saveSourceFile(file, "pdf");
      const startOrder = Math.max(0, ...stops.map((stop) => stop.loadOrder));
      const manifest = parsed.manifestNumber ?? "";
      const rows = parsed.rows.map((row, index) => {
        const canonical = canonicalizeLocation(row.locality, row.postalCode, row.locationKey);
        const analysis = analyzeCatalogAddress(row.address, canonical.locationKey);
        const sourceRowId = `${row.packageNo}:${row.sourceCode ?? row.name}:${row.address}`;
        return {
          id: crypto.randomUUID(), loadOrder: startOrder + index + 1, packageNo: row.packageNo, name: row.name,
          rawAddress: row.address, address: analysis.correctedAddress, locality: canonical.locality, postalCode: canonical.postalCode,
          locationKey: canonical.locationKey, status: "pending" as Status, corrections: analysis.corrections,
          sourceManifest: manifest, sourceRowId,
          sourceKind: "pdf" as const, sourceId, sourcePage: row.sourcePage, sourceRow: row.packageNo,
          sourceTop: row.sourceTop, sourceBottom: row.sourceBottom,
        } satisfies Stop;
      });

      const existingKeys = new Set(stops.filter((stop) => stop.sourceRowId).map((stop) => `${stop.sourceManifest ?? ""}|${stop.sourceRowId}`));
      const sourceByKey = new Map(rows.map((row) => [`${row.sourceManifest ?? ""}|${row.sourceRowId}`, row]));
      let relinked = 0;
      setStops((previous) => previous.map((stop) => {
        if (!stop.sourceRowId) return stop;
        const source = sourceByKey.get(`${stop.sourceManifest ?? ""}|${stop.sourceRowId}`);
        if (!source) return stop;
        relinked++;
        return { ...stop, sourceKind: "pdf", sourceId, sourcePage: source.sourcePage, sourceRow: source.sourceRow, sourceTop: source.sourceTop, sourceBottom: source.sourceBottom };
      }));

      const created = rows.filter((row) => !existingKeys.has(`${row.sourceManifest ?? ""}|${row.sourceRowId}`));
      if (created.length) await importRows(created, manifest ? `PDF · manifiesto ${manifest}` : "PDF");
      else setMessage(`PDF asociado a ${relinked || rows.length} parada${(relinked || rows.length) === 1 ? "" : "s"}. Usá el botón de vista para abrir la fila original.`);
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
    setOcrProgress({ percent: 2, label: "Preparando imágenes originales…", elapsedMs: 0, mode: ocrMode });
    setMessage(ocrMode === "fast"
      ? `Análisis rápido: leyendo ${images.length} imagen${images.length === 1 ? "" : "es"}…`
      : `Análisis intenso: revisando ${images.length} imagen${images.length === 1 ? "" : "es"} con comprobaciones adicionales…`);
    try {
      setOcrProgress({ percent: 4, label: "Enviando imágenes originales al OCR…", elapsedMs: 0, mode: ocrMode });
      const form = new FormData();
      images.forEach((file) => form.append("images", file, file.name));
      form.append("mode", ocrMode === "intense" ? "maximum" : "fast");
      const response = await fetch("/api/scan", { method: "POST", body: form });
      const result = await readOcrResponse(response, ocrMode, setOcrProgress);
      if (!result.rows.length) throw new Error("El OCR no encontró filas de envío en las imágenes.");
      setOcrProgress({ percent: 98, label: "Preparando paradas y fuentes originales…", elapsedMs: 0, mode: ocrMode });

      const sourceIds = await Promise.all(images.map((file) => saveSourceFile(file, "image")));
      const payload = buildRouteTransfer(result);
      const ocrBySourceRow = new Map(result.rows.map((row) => [
        `${row.page}:${row.rowNumber}:${row.barcode || `${row.name}|${row.address}`}`,
        row,
      ]));
      const bandsByPage = new Map<number, Map<string, { top: number; bottom: number; visualRow: number }>>();
      for (let page = 1; page <= images.length; page++) {
        const pageRows = result.rows.filter((row) => row.page === page);
        bandsByPage.set(page, await estimateImageBands(images[page - 1], pageRows));
      }
      const sourceMeta = new Map(result.rows.map((row) => {
        const sourceRowId = `${row.page}:${row.rowNumber}:${row.barcode || `${row.name}|${row.address}`}`;
        const band = bandsByPage.get(row.page)?.get(row.id) ?? approximateOcrBand(result.rows, row);
        return [sourceRowId, {
          sourceKind: "image" as const,
          sourceId: sourceIds[row.page - 1],
          sourcePage: row.page,
          sourceRow: band.visualRow,
          sourceTop: band.top,
          sourceBottom: band.bottom,
        }];
      }));
      let relinked = 0;
      setStops((previous) => previous.map((stop) => {
        if (!stop.sourceRowId || (stop.sourceManifest ?? "") !== payload.manifestNumber) return stop;
        const meta = sourceMeta.get(stop.sourceRowId);
        if (!meta) return stop;
        relinked++;
        return { ...stop, ...meta };
      }));
      const created = transferToStops(payload, stops).map((stop) => {
        const meta = stop.sourceRowId ? sourceMeta.get(stop.sourceRowId) : undefined;
        return meta ? { ...stop, ...meta } : stop;
      });
      if (!created.length) {
        setMessage(`Imágenes asociadas a ${relinked || result.rows.length} parada${(relinked || result.rows.length) === 1 ? "" : "s"}. Usá el botón de vista para abrir la fila original.`);
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
      window.setTimeout(() => setOcrProgress(null), 1200);
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
      setActiveLocationKey(ALL_LOCATIONS_KEY);
      setMessage("");
      void clearSourceFiles().catch(() => undefined);
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
  const showingAllLocations = activeLocationKey === ALL_LOCATIONS_KEY;
  const activeStops = showingAllLocations ? stops : activeGroup?.rows ?? [];
  const activeMapped = activeStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  const activeMissing = activeStops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
  const optimized = useMemo(() => optimize(activeStops, origin), [activeStops, origin]);
  const display = [...optimized, ...activeMissing];

  function exportRoute() {
    const rows = [["Nº de paquete", "Nombre", "Dirección", "Localidad", "CP", "Parada", "Estado", "Precisión", "Lat", "Lon"].map(csv).join(";")];
    const ordered = optimize(stops, origin);
    const missing = stops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
    [...ordered, ...missing].forEach((stop, index) => rows.push([
      stop.packageNo, stop.name, stop.address, stop.locality, stop.postalCode,
      Number.isFinite(stop.lat) ? index + 1 : "", stop.status, stop.precision, stop.lat, stop.lon,
    ].map(csv).join(";")));
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "ruta-postal.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const coordinateStop = coordinateStopId ? stops.find((stop) => stop.id === coordinateStopId) : undefined;
  const sourceStop = sourceStopId ? stops.find((stop) => stop.id === sourceStopId) : undefined;

  return <main className="ruta-postal">
    <nav className="app-bar" aria-label="Ruta Envíos">
      <div className="brand-lockup">
        <span className="brand-mark" aria-hidden="true">R</span>
        <span className="brand-copy">
          <strong>Ruta Envíos</strong>
          <small className="app-version">v{APP_VERSION}</small>
        </span>
      </div>
      <div className="top-actions">
        <InstallPwa />
        <ThemeToggle />
        <button className="icon-action" type="button" onClick={locate} title="Usar mi ubicación" aria-label="Usar mi ubicación">⌖</button>
        <button className="clear-action" type="button" disabled={!stops.length} onClick={clearAll}>Limpiar</button>
      </div>
    </nav>

    <section className="workspace">
      <section className="panel input-panel" id="cargar">
        <div className="section-title"><h1>Cargar</h1><b className="route-count">{stops.length}</b></div>

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
          <strong>PDF o imágenes</strong>
        </div>
        <input ref={universalPicker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => { void importFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />

        <div className="ocr-mode-row" aria-label="Modo de análisis OCR">
          <span>Análisis OCR</span>
          <div className="ocr-mode-toggle" role="group" aria-label="Intensidad del OCR">
            <button type="button" className={ocrMode === "fast" ? "active" : ""} disabled={busy} onClick={() => setOcrMode("fast")}>Rápido</button>
            <button type="button" className={ocrMode === "intense" ? "active" : ""} disabled={busy} onClick={() => setOcrMode("intense")}>Intenso</button>
          </div>
        </div>

        <div className="file-actions">
          <label className="secondary-action">PDF<input type="file" accept="application/pdf" hidden disabled={busy} onChange={(event) => { void importPdf(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
          <button className="secondary-action" type="button" disabled={busy} onClick={() => imagePicker.current?.click()}>Imágenes</button>
          <input ref={imagePicker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => void importImages(Array.from(event.target.files ?? []))} />
        </div>
        {ocrProgress && <div className="ocr-progress" aria-live="polite" aria-busy={busy}>
          <div className="ocr-progress-head"><span><b>{ocrProgress.mode === "fast" ? "Rápido" : "Intenso"}</b> · {ocrProgress.label}</span><strong>{Math.round(ocrProgress.percent)}%</strong></div>
          <div className="ocr-progress-track"><i style={{ width: `${ocrProgress.percent}%` }} /></div>
          <small>{busy ? `Activo · ${Math.floor(ocrProgress.elapsedMs / 60000).toString().padStart(2, "0")}:${Math.floor((ocrProgress.elapsedMs % 60000) / 1000).toString().padStart(2, "0")} transcurrido` : "Completado"}</small>
        </div>}
        {message && <p className="message" aria-live="polite">{message}</p>}
      </section>

      <section className="panel map-panel" id="mapa">
        <div className="map-toolbar">
          <h2>{showingAllLocations ? "Todas las ciudades" : activeGroup ? activeGroup.location.label : "Mapa"}</h2>
          <div className="map-meta">
            <span><b>{activeMapped.length}</b> ubicadas</span>
            <span><b>{activeMissing.length}</b> pendientes</span>
          </div>
        </div>
        <MapView stops={optimized} origin={origin} />
      </section>
    </section>

    {localityGroups.length > 0 && <section className="locality-strip" aria-label="Ciudades de la ruta">
      <button className={`locality-chip unified ${showingAllLocations ? "active" : ""}`} disabled={busy && !showingAllLocations} onClick={() => void activateLocation(ALL_LOCATIONS_KEY)}>
        <span>∞</span><b>Todas</b><small>{stops.length} · ruta unificada</small>
      </button>
      {localityGroups.map((group, index) => {
        const active = group.key === activeLocationKey;
        const mappedCount = group.rows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)).length;
        return <button key={group.key} className={`locality-chip ${active ? "active" : ""}`} disabled={busy && !active} onClick={() => void activateLocation(group.key)}>
          <span>{String(index + 1).padStart(2, "0")}</span>
          <b>{group.location.label}</b>
          <small>{group.rows.length} · {active ? "filtro" : mappedCount === group.rows.length && mappedCount > 0 ? "lista" : "pendiente"}</small>
        </button>;
      })}
    </section>}

    <section className="panel route-panel" id="paradas">
      <div className="route-toolbar">
        <h2>{showingAllLocations ? "Ruta unificada" : activeGroup ? activeGroup.location.label : "Paradas"}</h2>
        <div className="route-actions">
          <span>{display.length} paradas</span>
          <button className="secondary-action compact-action" onClick={exportRoute}>CSV</button>
        </div>
      </div>
      <div className="stops">
        {display.map((stop, index) => <article className={`stop-card ${stop.precision && stop.precision !== "exact" && stop.precision !== "manual" ? "approx" : ""}`} key={stop.id}>
          <div className="stop-number">{Number.isFinite(stop.lat) ? index + 1 : "!"}</div>
          <div className="stop-main">
            <div className="stop-heading"><span className="stop-address">{stop.address}</span>{stop.sourceId && <button
              className="source-eye"
              type="button"
              title="Ver fila original"
              aria-label={`Ver fila original de ${stop.address}`}
              onClick={() => openSource(stop)}
            ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.2 12s3.5-6 9.8-6 9.8 6 9.8 6-3.5 6-9.8 6-9.8-6-9.8-6Zm9.8 3.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Zm0-1.7A1.55 1.55 0 1 1 12 10.45a1.55 1.55 0 0 1 0 3.1Z"/></svg></button>}<button className="edit-address-link" type="button" onClick={() => openAddressEditor(stop)} aria-label={`Editar dirección ${stop.address}`}>Editar</button><span>{stop.locality || locationByKey(stop.locationKey).label} · {stop.postalCode}</span></div>
            {(stop.name || stop.packageNo) && <div className="stop-subline">{stop.packageNo && <span>#{stop.packageNo}</span>}{stop.name && <span>{stop.name}</span>}</div>}
            {stop.reason && stop.precision !== "exact" && stop.precision !== "manual" && <p className={`reason ${stop.precision ?? "missing"}`}>{stop.reason}</p>}
            {(!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) && <div className="location-fallback"><button type="button" disabled={busy} onClick={() => void geocode([stop])}>Reintentar</button><button type="button" onClick={() => openAddressEditor(stop)}>Corregir dirección</button><a href={googleMapsSearch(stop)} target="_blank" rel="noreferrer">Google Maps</a><button type="button" onClick={() => openCoordinateEditor(stop)}>Pegar coordenadas</button></div>}
          </div>
          <div className="stop-controls">
            <select aria-label={`Estado de ${stop.address}`} value={stop.status} onChange={(event) => setStops((previous) => previous.map((item) => item.id === stop.id ? { ...item, status: event.target.value as Status } : item))}><option value="pending">Pendiente</option><option value="delivered">Entregado</option><option value="failed">No entregado</option></select>
            <button type="button" onClick={() => openAddressEditor(stop)}>Editar dirección</button>
          </div>
        </article>)}
        {!display.length && <div className="empty-state"><span aria-hidden="true">⌖</span><b>Sin paradas</b></div>}
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

    {sourceStop && <SourceViewer stop={sourceStop} onClose={() => setSourceStopId(null)} />}

    <nav className="mobile-dock" aria-label="Secciones">
      <a href="#cargar"><span>＋</span>Cargar</a>
      <a href="#mapa"><span>⌖</span>Mapa</a>
      <a href="#paradas"><span>≡</span>Paradas</a>
    </nav>
  </main>;
 }
