"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { analyzeCatalogAddress } from "@/lib/street-catalog";
import { locationByKey, SUPPORTED_LOCATIONS } from "@/lib/supported-locations";
import { parseManifestPdf } from "@/lib/manifest-pdf";
import { isRouteTransferPayload, ROUTE_TRANSFER_KEY, type RouteTransferPayload } from "@/lib/route-transfer";

type Kind = "parcel" | "letter";
type Status = "pending" | "delivered" | "failed";
type Precision = "exact" | "parallel" | "street" | "missing";

type Stop = {
  id: string;
  loadOrder: number;
  packageNo: number;
  shipmentCode?: string;
  recipient?: string;
  rawAddress: string;
  address: string;
  locationKey: string;
  kind: Kind;
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

const STORAGE = "ruta-postal:v2";
const LEGACY_STORAGE = "ruta-postal:v1";
const cityLabel = (stop: Stop) => `${locationByKey(stop.locationKey).label}, Buenos Aires`;

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
        const oldDistance = distance(a, b) + distance(c, d);
        const newDistance = distance(a, c) + distance(b, d);
        if (newDistance + 0.05 < oldDistance) {
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
        shipmentCode: row.shipmentCode,
        recipient: row.recipient,
        rawAddress: row.address,
        address: analysis.correctedAddress,
        locationKey: row.locationKey,
        kind: "parcel" as Kind,
        status: "pending" as Status,
        corrections: analysis.corrections,
        sourceManifest: payload.manifestNumber,
        sourceRowId: row.sourceRowId,
      } satisfies Stop;
    });
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
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(map);

      const points: [number, number][] = [];
      stops.forEach((stop, index) => {
        if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)) return;
        const approximate = stop.precision !== "exact";
        const icon = L.divIcon({
          className: "route-marker-wrap",
          html: `<div class="route-marker ${approximate ? "approx" : ""}"><span>${index + 1}</span></div>`,
          iconSize: [34, 34],
          iconAnchor: [17, 17],
        });
        L.marker([stop.lat!, stop.lon!], { icon })
          .addTo(map!)
          .bindPopup(`<strong>${index + 1}. ${stop.address}</strong><br>${cityLabel(stop)}<br>${stop.reason ?? ""}`);
        points.push([stop.lat!, stop.lon!]);
      });

      if (origin) {
        L.circleMarker([origin.lat, origin.lon], { radius: 8 }).addTo(map).bindPopup("Inicio");
        points.push([origin.lat, origin.lon]);
      }

      const mapped = stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));
      if (mapped.length > 1) {
        L.polyline(mapped.map((stop) => [stop.lat!, stop.lon!] as [number, number]), { weight: 4, opacity: 0.6 }).addTo(map);
      }

      if (points.length) map.fitBounds(points, { padding: [34, 34], maxZoom: 15 });
      else map.setView([-34.59, -60.95], 13);
    })();

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [stops, origin]);

  return <div className="map" ref={ref} />;
}

export default function RutaPostalPage() {
  const [stops, setStops] = useState<Stop[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [text, setText] = useState("");
  const [locationKey, setLocationKey] = useState("junin-6000");
  const [kind, setKind] = useState<Kind>("parcel");
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState<{ lat: number; lon: number }>();
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [message, setMessage] = useState("");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE) ?? localStorage.getItem(LEGACY_STORAGE);
      if (stored) setStops(JSON.parse(stored) as Stop[]);
    } catch {
      setMessage("No se pudo recuperar la ruta guardada.");
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE, JSON.stringify(stops));
    } catch {
      // El navegador puede bloquear almacenamiento privado; la ruta sigue funcionando en memoria.
    }
  }, [hydrated, stops]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const raw = localStorage.getItem(ROUTE_TRANSFER_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      localStorage.removeItem(ROUTE_TRANSFER_KEY);
      if (!isRouteTransferPayload(parsed)) {
        setMessage("La transferencia del manifiesto no tenía un formato válido.");
        return;
      }
      const created = transferToStops(parsed, stops);
      if (!created.length) {
        setMessage(`El manifiesto ${parsed.manifestNumber || "sin número"} ya estaba incorporado a la ruta.`);
        return;
      }
      setStops((previous) => [...previous, ...created]);
      setMessage(`${created.length} envíos importados desde Manifiesto OCR${parsed.manifestNumber ? ` · manifiesto ${parsed.manifestNumber}` : ""}.`);
      void geocode(created);
    } catch {
      localStorage.removeItem(ROUTE_TRANSFER_KEY);
      setMessage("No se pudo importar el manifiesto enviado por OCR.");
    }
    // Procesamos una única transferencia al hidratar la sesión.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const mapped = useMemo(() => stops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)), [stops]);
  const optimized = useMemo(() => optimize(stops.filter((stop) => filter === "all" || stop.kind === filter), origin), [stops, origin, filter]);
  const missing = useMemo(() => stops.filter((stop) => !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon)), [stops]);

  async function geocode(list: Stop[]) {
    if (!list.length) return;
    setBusy(true);
    setMessage(`Ubicando ${list.length} dirección${list.length === 1 ? "" : "es"}…`);
    try {
      const response = await fetch("/api/geocode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direcciones: list.map((stop) => ({ direccion: stop.address, locationKey: stop.locationKey })) }),
      });
      if (!response.ok) throw new Error("No respondió el servicio de geocodificación.");
      const data = await response.json() as { results: GeoResult[] };
      const byId = new Map(list.map((stop, index) => [stop.id, data.results[index]]));
      setStops((previous) => previous.map((stop) => {
        const geo = byId.get(stop.id);
        return geo ? {
          ...stop,
          address: geo.normalizedAddress || stop.address,
          lat: geo.lat,
          lon: geo.lon,
          precision: geo.precision,
          reason: geo.reason,
          corrections: geo.corrections,
        } : stop;
      }));
      setMessage("Ubicación terminada.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudieron ubicar las direcciones.");
    } finally {
      setBusy(false);
    }
  }

  async function addManual() {
    const lines = text.split(/\n+/).map((value) => value.trim()).filter(Boolean);
    if (!lines.length) return;
    const start = Math.max(0, ...stops.map((stop) => stop.loadOrder));
    const created = lines.map((line, index) => {
      const analysis = analyzeCatalogAddress(line, locationKey);
      return {
        id: crypto.randomUUID(),
        loadOrder: start + index + 1,
        packageNo: start + index + 1,
        rawAddress: line,
        address: analysis.correctedAddress,
        locationKey,
        kind,
        status: "pending" as Status,
        corrections: analysis.corrections,
      } satisfies Stop;
    });
    setStops((previous) => [...previous, ...created]);
    setText("");
    await geocode(created);
  }

  async function importPdf(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage("Leyendo manifiesto PDF…");
    try {
      const parsed = await parseManifestPdf(file);
      const start = Math.max(0, ...stops.map((stop) => stop.loadOrder));
      const created = parsed.rows.map((row, index) => {
        const analysis = analyzeCatalogAddress(row.address, row.locationKey);
        return {
          id: crypto.randomUUID(),
          loadOrder: start + index + 1,
          packageNo: row.packageNo,
          shipmentCode: row.shipmentCode,
          recipient: row.recipient,
          rawAddress: row.address,
          address: analysis.correctedAddress,
          locationKey: row.locationKey,
          kind: "parcel" as Kind,
          status: "pending" as Status,
          corrections: analysis.corrections,
          sourceManifest: parsed.manifestNumber,
          sourceRowId: `${row.packageNo}:${row.shipmentCode}`,
        } satisfies Stop;
      });
      setStops((previous) => [...previous, ...created]);
      setMessage(`${created.length} envíos leídos${parsed.manifestNumber ? ` · manifiesto ${parsed.manifestNumber}` : ""}. ${parsed.warnings.join(" ")}`);
      await geocode(created);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No se pudo leer el PDF.");
    } finally {
      setBusy(false);
    }
  }

  async function editStop(stop: Stop) {
    const value = prompt("Editar dirección", stop.rawAddress || stop.address);
    if (!value?.trim()) return;
    const currentLocation = locationByKey(stop.locationKey);
    const city = prompt(`Localidad (${SUPPORTED_LOCATIONS.map((item) => item.label).join(", ")})`, currentLocation.label) ?? currentLocation.label;
    const chosen = SUPPORTED_LOCATIONS.find((item) => item.label.toLowerCase() === city.trim().toLowerCase()) ?? currentLocation;
    const analysis = analyzeCatalogAddress(value.trim(), chosen.key);
    const edited: Stop = {
      ...stop,
      rawAddress: value.trim(),
      address: analysis.correctedAddress,
      locationKey: chosen.key,
      lat: undefined,
      lon: undefined,
      precision: undefined,
      reason: undefined,
      corrections: analysis.corrections,
    };
    setStops((previous) => previous.map((item) => item.id === stop.id ? edited : item));
    await geocode([edited]);
  }

  function locate() {
    navigator.geolocation?.getCurrentPosition(
      (position) => setOrigin({ lat: position.coords.latitude, lon: position.coords.longitude }),
      () => setMessage("No se pudo acceder a tu ubicación."),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  function exportRoute() {
    const ordered = [...optimized, ...missing.filter((stop) => filter === "all" || stop.kind === filter)];
    const rows = [["Parada", "Orden de carga", "Paquete", "Código de envío", "Tipo", "Destinatario", "Dirección", "Localidad", "Precisión", "Motivo", "Estado", "Lat", "Lon"].map(csv).join(";")];
    ordered.forEach((stop, index) => rows.push([
      stop.lat ? index + 1 : "",
      stop.loadOrder,
      stop.packageNo,
      stop.shipmentCode,
      stop.kind === "parcel" ? "Encomienda" : "Correspondencia",
      stop.recipient,
      stop.address,
      cityLabel(stop),
      stop.precision,
      stop.reason,
      stop.status,
      stop.lat,
      stop.lon,
    ].map(csv).join(";")));
    const blob = new Blob(["\ufeff" + rows.join("\n")], { type: "text/csv;charset=utf-8" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = "ruta-postal.csv";
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const display = [...optimized, ...missing.filter((stop) => filter === "all" || stop.kind === filter)];

  return <main className="ruta-postal">
    <nav className="suite-nav" aria-label="Herramientas de manifiestos">
      <a href="/">← Manifiesto OCR</a>
      <strong>Ruta Postal</strong>
    </nav>

    <header>
      <div>
        <p className="eyebrow">RUTA POSTAL · MÓDULO UNIFICADO</p>
        <h1>Tu reparto, ordenado.</h1>
        <p>Recibe filas verificadas desde Manifiesto OCR, importa PDFs, corrige calles y ordena las paradas por cercanía.</p>
      </div>
      <button className="icon-btn" onClick={locate} title="Usar mi ubicación" aria-label="Usar mi ubicación"><span aria-hidden="true">⌖</span></button>
    </header>

    <section className="stats">
      <div><b>{stops.length}</b><span>envíos</span></div>
      <div><b>{mapped.length}</b><span>en mapa</span></div>
      <div><b>{missing.length}</b><span>sin ubicar</span></div>
    </section>

    <section className="grid">
      <div className="panel input-panel">
        <h2>Cargar direcciones</h2>
        <div className="row">
          <select value={locationKey} onChange={(event) => setLocationKey(event.target.value)}>
            {SUPPORTED_LOCATIONS.map((location) => <option value={location.key} key={location.key}>{location.label} {location.postalCode}</option>)}
          </select>
          <select value={kind} onChange={(event) => setKind(event.target.value as Kind)}>
            <option value="parcel">Encomienda</option>
            <option value="letter">Correspondencia</option>
          </select>
        </div>
        <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={'Una dirección por línea\nSalta 330 entre Italia y Sarmiento\nRivadavia 600'} />
        <div className="actions">
          <button className="primary" disabled={busy || !text.trim()} onClick={addManual}><span aria-hidden="true">⌕</span> Ubicar direcciones</button>
          <label className="button"><span aria-hidden="true">↑</span> Importar manifiesto PDF<input type="file" accept="application/pdf" hidden onChange={(event) => importPdf(event.target.files?.[0])} /></label>
          <a className="button" href="/api/calles"><span aria-hidden="true">↓</span> Descargar callejeros</a>
        </div>
        {message && <p className="message" aria-live="polite">{message}</p>}
        <p className="helper">Las referencias “entre X e Y” se conservan como calles perpendiculares. Si no existe la altura exacta, se intenta estimarla con paralelas y se informa el método.</p>
      </div>

      <div className="panel map-panel">
        <div className="panel-head">
          <div><h2>Mapa</h2><span>{optimized.length} paradas ordenadas</span></div>
          <div className="tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todos</button>
            <button className={filter === "parcel" ? "active" : ""} onClick={() => setFilter("parcel")}>Encomiendas</button>
            <button className={filter === "letter" ? "active" : ""} onClick={() => setFilter("letter")}>Correspondencia</button>
          </div>
        </div>
        <MapView stops={optimized} origin={origin} />
      </div>
    </section>

    <section className="panel route-panel">
      <div className="panel-head">
        <div><h2>Recorrido</h2><span>El número grande es la parada; debajo se mantiene el número de paquete del manifiesto.</span></div>
        <div className="actions compact">
          <button className="button" onClick={exportRoute}><span aria-hidden="true">↓</span> CSV</button>
          <button className="button danger" onClick={() => { if (confirm("¿Borrar toda la ruta?")) setStops([]); }}><span aria-hidden="true">×</span> Limpiar</button>
        </div>
      </div>
      <div className="stops">
        {display.map((stop, index) => <article className={`stop ${stop.precision && stop.precision !== "exact" ? "approx" : ""}`} key={stop.id}>
          <div className="number"><strong>{stop.lat ? index + 1 : "!"}</strong><span>paq. {stop.packageNo}</span></div>
          <div className="stop-body">
            <div className="stop-title">
              <h3>{stop.address}</h3>
              <span className={`pill ${stop.kind}`}>{stop.kind === "parcel" ? <span aria-hidden="true">□</span> : <span aria-hidden="true">•</span>} {stop.kind === "parcel" ? "Encomienda" : "Correspondencia"}</span>
            </div>
            <p>{cityLabel(stop)}{stop.recipient ? ` · ${stop.recipient}` : ""}</p>
            {stop.shipmentCode && <code>{stop.shipmentCode}</code>}
            {stop.sourceManifest && <p className="source">Manifiesto {stop.sourceManifest}</p>}
            {stop.corrections?.length ? <p className="correction">Corregido: {stop.corrections.map((correction) => `${correction.original} → ${correction.corrected}`).join(" · ")}</p> : null}
            <p className={`reason ${stop.precision ?? "missing"}`}>{stop.reason ?? "Pendiente de ubicación"}</p>
            <div className="stop-actions">
              <button onClick={() => editStop(stop)}><span aria-hidden="true">✎</span> Editar</button>
              {(!stop.lat || stop.precision !== "exact") && <button onClick={() => geocode([stop])}><span aria-hidden="true">↻</span> Reintentar</button>}
              <select value={stop.status} onChange={(event) => setStops((previous) => previous.map((item) => item.id === stop.id ? { ...item, status: event.target.value as Status } : item))}>
                <option value="pending">Pendiente</option>
                <option value="delivered">Entregado</option>
                <option value="failed">No entregado</option>
              </select>
            </div>
          </div>
        </article>)}
        {!display.length && <div className="empty">Todavía no hay envíos cargados. Podés enviarlos desde Manifiesto OCR o importar un PDF.</div>}
      </div>
    </section>

    <footer>Suite Manifiestos · OCR + Ruta Postal · Georef Argentina + OpenStreetMap/Photon/Overpass · Datos de ruta guardados localmente.</footer>
  </main>;
}
