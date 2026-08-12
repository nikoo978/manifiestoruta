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

 type ActivityState = {
  title: string;
  detail: string;
  percent?: number;
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

  const improvementPasses = route.length > 80 ? 1 : 2;
  for (let pass = 0; pass < improvementPasses; pass++) {
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

 function escapePopup(value: string | number) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] ?? char));
 }

 function yieldToMainThread() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
 }

 function MapView({ stops, origin }: { stops: Stop[]; origin?: { lat: number; lon: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const leafletRef = useRef<any>(null);
  const routeLayerRef = useRef<any>(null);
  const latestDataRef = useRef({ stops, origin });
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const geometrySignature = stops.map((stop) => `${stop.id}:${stop.lat ?? ""}:${stop.lon ?? ""}:${stop.precision ?? ""}:${stop.address}:${stop.name}:${stop.packageNo}`).join("|");
  const originSignature = origin ? `${origin.lat}:${origin.lon}` : "";

  function drawRoute() {
    const L = leafletRef.current;
    const map = mapRef.current;
    if (!L || !map) return;
    routeLayerRef.current?.remove();
    const layer = L.layerGroup().addTo(map);
    routeLayerRef.current = layer;
    const points: [number, number][] = [];
    const data = latestDataRef.current;

    data.stops.forEach((stop, index) => {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
      const approximate = stop.precision !== "exact" && stop.precision !== "manual";
      const icon = L.divIcon({
        className: "route-marker-wrap",
        html: `<div class="route-marker ${approximate ? "approx" : ""}"><span>${index + 1}</span></div>`,
        iconSize: [34, 34], iconAnchor: [17, 17],
      });
      L.marker([stop.lat!, stop.lon!], { icon }).addTo(layer).bindPopup(
        `<strong>${index + 1}. ${escapePopup(stop.address)}</strong><br>${escapePopup(stop.name || "Sin nombre")}<br>Paquete ${escapePopup(stop.packageNo)}`,
      );
      points.push([stop.lat!, stop.lon!]);
    });
    if (data.origin) {
      L.circleMarker([data.origin.lat, data.origin.lon], { radius: 8 }).addTo(layer).bindPopup("Inicio");
      points.push([data.origin.lat, data.origin.lon]);
    }
    const mapped = data.stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
    if (mapped.length > 1) {
      L.polyline(mapped.map((stop) => [stop.lat!, stop.lon!] as [number, number]), { weight: 4, opacity: 0.6 }).addTo(layer);
    }
    if (points.length) map.fitBounds(points, { padding: [28, 28], maxZoom: 15, animate: false });
    else map.setView([-34.59, -60.95], 12, { animate: false });
  }

  useEffect(() => {
    latestDataRef.current = { stops, origin };
    if (!mapRef.current) return;
    const frame = window.requestAnimationFrame(drawRoute);
    return () => window.cancelAnimationFrame(frame);
    // La firma contiene exactamente los datos geométricos que dibuja el mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometrySignature, originSignature]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
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
        const lowPower = window.matchMedia("(max-width: 820px)").matches || (navigator.hardwareConcurrency || 8) <= 4;
        leafletRef.current = L;
        mapRef.current = L.map(ref.current, {
          zoomControl: true,
          preferCanvas: true,
          zoomAnimation: !lowPower,
          fadeAnimation: false,
          markerZoomAnimation: !lowPower,
        });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "&copy; OpenStreetMap contributors",
          maxZoom: 19,
          updateWhenIdle: true,
          updateWhenZooming: false,
          keepBuffer: lowPower ? 1 : 2,
        }).addTo(mapRef.current);
        drawRoute();
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      routeLayerRef.current?.remove();
      mapRef.current?.remove();
      routeLayerRef.current = null;
      mapRef.current = null;
      leafletRef.current = null;
    };
    // El mapa base se crea una sola vez; las paradas se actualizan en el efecto anterior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="map-shell">
    <div className="map" ref={ref} />
    {phase === "loading" && <div className="map-loading" role="status"><i/><span>Cargando mapa…</span></div>}
    {phase === "error" && <div className="map-loading error" role="status"><span>No se pudo cargar el mapa. La lista de paradas sigue disponible.</span></div>}
  </div>;
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
        const lowPower = window.matchMedia("(max-width: 820px)").matches || (navigator.hardwareConcurrency || 8) <= 4;
        const viewport = page.getViewport({ scale: lowPower ? 1.2 : 1.6 });
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
        <div className="source-image-frame"><img src={imageUrl} alt={`Fuente de ${stop.address}`} decoding="async" />
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
  const cameraPicker = useRef<HTMLInputElement>(null);
  const galleryPicker = useRef<HTMLInputElement>(null);
  const documentPicker = useRef<HTMLInputElement>(null);
  const browsePicker = useRef<HTMLInputElement>(null);
  const [stops, setStops] = useState<Stop[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [text, setText] = useState("");
  const [manualLocationKey, setManualLocationKey] = useState("junin-6000");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<ActivityState | null>(null);
  const [ocrMode, setOcrMode] = useState<OcrModeChoice>("intense");
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
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);

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
    const save = () => {
      try { localStorage.setItem(STORAGE, JSON.stringify(stops)); } catch { /* memoria solamente */ }
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(save, { timeout: 900 });
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(save, 280);
    return () => window.clearTimeout(handle);
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
    setActivity({ title: "Ubicando direcciones", detail: `Preparando ${pending.length} parada${pending.length === 1 ? "" : "s"}…`, percent: 12 });
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
      setActivity({ title: "Ubicando direcciones", detail: "Validando calles y coordenadas…", percent: 82 });
      const data = await response.json() as { results: GeoResult[] };
      const byId = new Map(pending.map((stop, index) => [stop.id, data.results[index]]));
      const locatedAny = data.results.some((geo) => Number.isFinite(geo?.lat) && Number.isFinite(geo?.lon));
      setStops((previous) => previous.map((stop) => {
        const geo = byId.get(stop.id);
        return geo ? { ...stop, address: geo.normalizedAddress || stop.address, lat: geo.lat, lon: geo.lon, precision: geo.precision, reason: geo.reason, corrections: geo.corrections } : stop;
      }));
      setActivity({ title: "Ubicando direcciones", detail: locatedAny ? "Ordenando la ruta y habilitando el mapa…" : "Finalizando validación de direcciones…", percent: 96 });
      if (locatedAny) setMapOpen(true);
      await yieldToMainThread();
      setMessage(locationCount === 1 ? `${locationByKey(pending[0].locationKey).label}: ubicación terminada.` : `${locationCount} ciudades unificadas: ubicación terminada.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron ubicar las direcciones.");
    } finally { setBusy(false); setActivity(null); }
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
      const lowPower = window.matchMedia("(max-width: 820px)").matches || (navigator.hardwareConcurrency || 8) <= 4;
      const targetWidth = Math.min(lowPower ? 384 : 520, bitmap.width);
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
      const sampleStep = lowPower ? 4 : 3;
      const sampledWidth = Math.ceil(width / sampleStep);
      await yieldToMainThread();
      for (let y = 0; y < Math.min(targetHeight, Math.ceil(targetHeight * 0.45)); y++) {
        if (y > 0 && y % 96 === 0) await yieldToMainThread();
        let dark = 0;
        for (let x = x0; x < x1; x += sampleStep) {
          const offset = (y * targetWidth + x) * 4;
          const lum = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
          if (lum < 100) dark++;
        }
        darkFraction[y] = dark / sampledWidth;
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
        if (y > header.end + 4 && y % 96 === 0) await yieldToMainThread();
        let covered = 0;
        for (let x = x0; x < x1; x += sampleStep) {
          let isDark = false;
          for (let dy = -2; dy <= 2 && !isDark; dy++) {
            const yy = Math.max(0, Math.min(targetHeight - 1, y + dy));
            const offset = (yy * targetWidth + x) * 4;
            const lum = pixels[offset] * 0.299 + pixels[offset + 1] * 0.587 + pixels[offset + 2] * 0.114;
            isDark = lum < 150;
          }
          if (isDark) covered++;
        }
        coverage[y] = covered / sampledWidth;
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
    setActivity({ title: "Procesando PDF", detail: "Leyendo páginas y reconstruyendo filas…", percent: 18 });
    setMessage("Leyendo PDF…");
    try {
      await yieldToMainThread();
      const parsed = await parseManifestPdf(file);
      setActivity({ title: "Procesando PDF", detail: "Validando direcciones y guardando la fuente…", percent: 62 });
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
    } finally { setBusy(false); setActivity(null); }
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
    setActivity({ title: "Procesando imágenes", detail: "Preparando archivos para OCR…", percent: 2 });
    setOcrProgress({ percent: 2, label: "Preparando imágenes originales…", elapsedMs: 0, mode: ocrMode });
    setMessage(ocrMode === "fast"
      ? `Análisis rápido: doble lectura y conciliación de ${images.length} imagen${images.length === 1 ? "" : "es"}…`
      : `Análisis intenso: triple lectura, auditoría y conciliación de ${images.length} imagen${images.length === 1 ? "" : "es"}…`);
    try {
      setOcrProgress({ percent: 4, label: "Enviando imágenes originales al OCR…", elapsedMs: 0, mode: ocrMode });
      setActivity({ title: "Procesando imágenes", detail: "Enviando originales al OCR…", percent: 4 });
      const form = new FormData();
      images.forEach((file) => form.append("images", file, file.name));
      form.append("mode", ocrMode === "intense" ? "maximum" : "fast");
      const response = await fetch("/api/scan", { method: "POST", body: form });
      const result = await readOcrResponse(response, ocrMode, (progress) => {
        setOcrProgress(progress);
        setActivity({ title: "Procesando imágenes", detail: progress.label, percent: progress.percent });
      });
      if (!result.rows.length) throw new Error("El OCR no encontró filas de envío en las imágenes.");
      setOcrProgress({ percent: 98, label: "Preparando paradas y fuentes originales…", elapsedMs: 0, mode: ocrMode });
      setActivity({ title: "Finalizando OCR", detail: "Preparando paradas y fuentes originales…", percent: 98 });

      const sourceIds = await Promise.all(images.map((file) => saveSourceFile(file, "image")));
      const payload = buildRouteTransfer(result);
      const ocrBySourceRow = new Map(result.rows.map((row) => [
        `${row.page}:${row.rowNumber}:${row.barcode || `${row.name}|${row.address}`}`,
        row,
      ]));
      const bandsByPage = new Map<number, Map<string, { top: number; bottom: number; visualRow: number }>>();
      for (let page = 1; page <= images.length; page++) {
        const pageRows = result.rows.filter((row) => row.page === page);
        setActivity({ title: "Finalizando OCR", detail: `Preparando vista de imagen ${page} de ${images.length}…`, percent: Math.min(99, 98 + page / Math.max(1, images.length)) });
        await yieldToMainThread();
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
      setActivity(null);
      window.setTimeout(() => setOcrProgress(null), 1200);
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
      setMapOpen(false);
      setFilePickerOpen(false);
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
    setMapOpen(true);
    setMessage("Coordenadas guardadas.");
  }

  function locate() {
    if (!navigator.geolocation) { setMessage("Este dispositivo no ofrece geolocalización."); return; }
    setBusy(true);
    setActivity({ title: "Buscando tu ubicación", detail: "Esperando una posición precisa del GPS…" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOrigin({ lat: position.coords.latitude, lon: position.coords.longitude });
        setBusy(false);
        setActivity(null);
      },
      () => {
        setMessage("No se pudo acceder a tu ubicación.");
        setBusy(false);
        setActivity(null);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }

  const activeGroup = localityGroups.find((group) => group.key === activeLocationKey);
  const showingAllLocations = activeLocationKey === ALL_LOCATIONS_KEY;
  const activeStops = showingAllLocations ? stops : activeGroup?.rows ?? [];
  const activeMapped = activeStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
  const activeMissing = activeStops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
  const routeGeometrySignature = activeStops.map((stop) => `${stop.id}:${stop.lat ?? ""}:${stop.lon ?? ""}`).join("|");
  const optimizedIds = useMemo(() => optimize(activeStops, origin).map((stop) => stop.id),
    // La firma evita recalcular el algoritmo O(n²) al cambiar sólo estado/nombre/notas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routeGeometrySignature, origin?.lat, origin?.lon]);
  const activeById = new Map(activeStops.map((stop) => [stop.id, stop]));
  const optimized = optimizedIds.flatMap((id) => { const stop = activeById.get(id); return stop ? [stop] : []; });
  const display = [...optimized, ...activeMissing];

  async function exportRoute() {
    setBusy(true);
    setActivity({ title: "Preparando CSV", detail: "Ordenando paradas para exportar…", percent: 25 });
    try {
      await yieldToMainThread();
      const rows = [["Nº de paquete", "Nombre", "Dirección", "Localidad", "CP", "Parada", "Estado", "Precisión", "Lat", "Lon"].map(csv).join(";")];
      const ordered = optimize(stops, origin);
      const missing = stops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon));
      setActivity({ title: "Preparando CSV", detail: "Generando archivo…", percent: 82 });
      await yieldToMainThread();
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
    } finally {
      setBusy(false);
      setActivity(null);
    }
  }

  const coordinateStop = coordinateStopId ? stops.find((stop) => stop.id === coordinateStopId) : undefined;
  const sourceStop = sourceStopId ? stops.find((stop) => stop.id === sourceStopId) : undefined;

  const loadingVisible = !hydrated || busy;
  const loadingState: ActivityState = !hydrated
    ? { title: "Abriendo Ruta Envíos", detail: "Recuperando la ruta guardada en este dispositivo…" }
    : activity ?? { title: "Procesando", detail: "La app sigue trabajando. No está tildada." };

  return <main className="ruta-postal">
    {loadingVisible && <div className="app-working" role="status" aria-live="polite" aria-busy="true">
      <span className="working-spinner" aria-hidden="true" />
      <span className="working-copy"><strong>{loadingState.title}</strong><small>{loadingState.detail}</small></span>
      {typeof loadingState.percent === "number" && <b>{Math.round(loadingState.percent)}%</b>}
      <span className={`working-track ${typeof loadingState.percent === "number" ? "determinate" : "indeterminate"}`} aria-hidden="true">
        <i style={typeof loadingState.percent === "number" ? { width: `${Math.max(2, Math.min(100, loadingState.percent))}%` } : undefined} />
      </span>
    </div>}
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

        <textarea className="manual-address-input" rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="Escriba dirección, ejemplo: Calle Falsa 123, localidad" />
        <button className="primary manual-submit" disabled={busy || !text.trim()} onClick={addManual}>Ubicar direcciones</button>

        <div className="separator"><span>o</span></div>

        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragging(true); }}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void importFiles(Array.from(event.dataTransfer.files)); }}
          onClick={() => !busy && setFilePickerOpen(true)}
          role="button"
          tabIndex={0}
          aria-haspopup="dialog"
          onKeyDown={(event) => { if ((event.key === "Enter" || event.key === " ") && !busy) setFilePickerOpen(true); }}
        >
          <span className="drop-icon" aria-hidden="true">＋</span>
          <strong>Cargar PDF o imagen</strong>
          <small>Tocá para elegir cámara, galería, archivo o examinar</small>
        </div>
        <input ref={cameraPicker} type="file" accept="image/*" capture="environment" hidden onChange={(event) => { setFilePickerOpen(false); void importImages(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <input ref={galleryPicker} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => { setFilePickerOpen(false); void importImages(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />
        <input ref={documentPicker} type="file" accept="application/pdf,.pdf" hidden onChange={(event) => { setFilePickerOpen(false); void importPdf(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        <input ref={browsePicker} type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" multiple hidden onChange={(event) => { setFilePickerOpen(false); void importFiles(Array.from(event.target.files ?? [])); event.currentTarget.value = ""; }} />

        <div className="ocr-mode-row" aria-label="Modo de análisis OCR">
          <span>Análisis OCR</span>
          <div className="ocr-mode-toggle" role="group" aria-label="Intensidad del OCR">
            <button type="button" className={ocrMode === "intense" ? "active" : ""} disabled={busy} onClick={() => setOcrMode("intense")}>Intenso</button>
            <button type="button" className={ocrMode === "fast" ? "active" : ""} disabled={busy} onClick={() => setOcrMode("fast")}>Rápido</button>
          </div>
          <small className="ocr-mode-help">{ocrMode === "intense" ? "Triple lectura independiente + auditoría y conciliación." : "Doble lectura + conciliación (equivale al Intenso anterior)."}</small>
        </div>
        {ocrProgress && <div className="ocr-progress" aria-live="polite" aria-busy={busy}>
          <div className="ocr-progress-head"><span><b>{ocrProgress.mode === "fast" ? "Rápido" : "Intenso"}</b> · {ocrProgress.label}</span><strong>{Math.round(ocrProgress.percent)}%</strong></div>
          <div className="ocr-progress-track"><i style={{ width: `${ocrProgress.percent}%` }} /></div>
          <small>{busy ? `Activo · ${Math.floor(ocrProgress.elapsedMs / 60000).toString().padStart(2, "0")}:${Math.floor((ocrProgress.elapsedMs % 60000) / 1000).toString().padStart(2, "0")} transcurrido` : "Completado"}</small>
        </div>}
        {message && <p className="message" aria-live="polite">{message}</p>}
      </section>

      <section className={`panel map-panel lazy-map-panel ${mapOpen ? "open" : "collapsed"}`} id="mapa">
        <button
          className="map-disclosure"
          type="button"
          aria-expanded={mapOpen}
          aria-controls="route-map-body"
          disabled={!activeMapped.length && !mapOpen}
          onClick={() => setMapOpen((open) => !open)}
        >
          <span className="map-disclosure-title"><b>{showingAllLocations ? "Todas las ciudades" : activeGroup ? activeGroup.location.label : "Mapa"}</b><small>{activeMapped.length ? (mapOpen ? "Plegar mapa y liberar recursos" : "Desplegar mapa") : "Se habilita al ubicar una dirección"}</small></span>
          <span className="map-meta">
            <span><b>{activeMapped.length}</b> ubicadas</span>
            <span><b>{activeMissing.length}</b> pendientes</span>
          </span>
          <span className={`map-chevron ${mapOpen ? "open" : ""}`} aria-hidden="true">⌄</span>
        </button>
        {mapOpen && activeMapped.length > 0 && <div className="lazy-map-body" id="route-map-body"><MapView stops={optimized} origin={origin} /></div>}
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
          <button className="secondary-action compact-action" disabled={busy} onClick={() => void exportRoute()}>CSV</button>
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

    {filePickerOpen && <div className="file-picker-backdrop" role="presentation" onClick={() => setFilePickerOpen(false)}>
      <section className="file-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="file-picker-title" onClick={(event) => event.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        <button className="sheet-close" type="button" aria-label="Cerrar" onClick={() => setFilePickerOpen(false)}>×</button>
        <small>Cargar manifiesto</small>
        <h2 id="file-picker-title">¿Desde dónde querés cargar?</h2>
        <div className="file-picker-grid">
          <button type="button" onClick={() => cameraPicker.current?.click()}><span aria-hidden="true">◉</span><b>Cámara</b><small>Tomar una foto ahora</small></button>
          <button type="button" onClick={() => galleryPicker.current?.click()}><span aria-hidden="true">▧</span><b>Galería</b><small>Elegir una o varias fotos</small></button>
          <button type="button" onClick={() => documentPicker.current?.click()}><span aria-hidden="true">▤</span><b>Archivo</b><small>Seleccionar un PDF</small></button>
          <button type="button" onClick={() => browsePicker.current?.click()}><span aria-hidden="true">…</span><b>Examinar</b><small>Buscar PDF o imágenes</small></button>
        </div>
      </section>
    </div>}

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
