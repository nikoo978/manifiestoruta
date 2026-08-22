"use client";

import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { useEffect, useMemo, useRef, useState } from "react";

export type GoogleRouteStop = {
  id: string;
  packageNo: number;
  name: string;
  address: string;
  locality: string;
  postalCode: string;
  status: "pending" | "delivered" | "failed";
  precision?: "exact" | "manual" | "parallel" | "street" | "missing";
  lat?: number;
  lon?: number;
};

type RouteSummary = {
  distanceKm?: number;
  durationMinutes?: number;
  kind: "google" | "estimate";
};

type MapArtifacts = {
  markers: google.maps.marker.AdvancedMarkerElement[];
  polylines: google.maps.Polyline[];
  infoWindow?: google.maps.InfoWindow;
};

const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ?? "";
const GOOGLE_MAPS_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID?.trim() || "DEMO_MAP_ID";
const GOOGLE_ROUTES_ENABLED = process.env.NEXT_PUBLIC_GOOGLE_MAPS_ROUTES_ENABLED !== "false";
const DEFAULT_CENTER = { lat: -34.59, lng: -60.95 };

declare global {
  // Evita configurar dos veces el loader durante Fast Refresh o navegaciones internas.
  var __rutaEnviosGoogleMapsConfigured: boolean | undefined;
}

function configureGoogleMaps() {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("Falta configurar NEXT_PUBLIC_GOOGLE_MAPS_API_KEY en Vercel.");
  if (globalThis.__rutaEnviosGoogleMapsConfigured) return;
  setOptions({
    key: GOOGLE_MAPS_API_KEY,
    v: "weekly",
    language: "es",
    region: "AR",
    authReferrerPolicy: "origin",
    mapIds: [GOOGLE_MAPS_MAP_ID],
  });
  globalThis.__rutaEnviosGoogleMapsConfigured = true;
}

function navigationUrl(stop: GoogleRouteStop, origin?: { lat: number; lon: number }) {
  const parameters = new URLSearchParams({
    api: "1",
    destination: `${stop.lat},${stop.lon}`,
    travelmode: "driving",
    dir_action: "navigate",
  });
  if (origin) parameters.set("origin", `${origin.lat},${origin.lon}`);
  return `https://www.google.com/maps/dir/?${parameters.toString()}`;
}

function clearArtifacts(artifacts: MapArtifacts) {
  artifacts.infoWindow?.close();
  artifacts.markers.forEach((marker) => { marker.map = null; });
  artifacts.polylines.forEach((polyline) => polyline.setMap(null));
  artifacts.markers = [];
  artifacts.polylines = [];
}

function markerColors(stop: GoogleRouteStop) {
  if (stop.status === "delivered") return { background: "#087c55", border: "#075e43" };
  if (stop.status === "failed") return { background: "#b64242", border: "#8d3030" };
  if (stop.precision !== "exact" && stop.precision !== "manual") return { background: "#b7791f", border: "#895710" };
  return { background: "#123f31", border: "#0b2b21" };
}

function infoContent(stop: GoogleRouteStop, index: number, origin?: { lat: number; lon: number }) {
  const card = document.createElement("article");
  card.className = "google-info";

  const eyebrow = document.createElement("small");
  eyebrow.textContent = `PARADA ${String(index + 1).padStart(2, "0")} · PAQUETE ${stop.packageNo}`;
  card.append(eyebrow);

  const title = document.createElement("strong");
  title.textContent = stop.address;
  card.append(title);

  const detail = document.createElement("span");
  detail.textContent = [stop.name, stop.locality, stop.postalCode].filter(Boolean).join(" · ");
  card.append(detail);

  const link = document.createElement("a");
  link.href = navigationUrl(stop, origin);
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Iniciar navegación";
  card.append(link);
  return card;
}

function formatDuration(minutes?: number) {
  if (!Number.isFinite(minutes)) return "";
  const rounded = Math.max(1, Math.round(minutes!));
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function routeChunks(points: google.maps.LatLngLiteral[]) {
  const chunks: google.maps.LatLngLiteral[][] = [];
  // 10 intermedias como máximo mantiene Compute Routes en Essentials.
  // Google admite 25, pero desde 11 el pedido pasa a la categoría Pro.
  const maxPoints = 12; // origen + 10 intermedias + destino.
  for (let index = 0; index < points.length - 1; index += maxPoints - 1) {
    const chunk = points.slice(index, index + maxPoints);
    if (chunk.length > 1) chunks.push(chunk);
  }
  return chunks;
}

export function GoogleRouteMap({ stops, origin }: { stops: GoogleRouteStop[]; origin?: { lat: number; lon: number } }) {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const artifactsRef = useRef<MapArtifacts>({ markers: [], polylines: [] });
  const [mapReady, setMapReady] = useState(false);
  const [phase, setPhase] = useState<"loading" | "ready" | "missing-key" | "error">(
    GOOGLE_MAPS_API_KEY ? "loading" : "missing-key",
  );
  const [routeSummary, setRouteSummary] = useState<RouteSummary>({ kind: "estimate" });

  const geometrySignature = useMemo(
    () => stops.map((stop) => [stop.id, stop.lat, stop.lon, stop.precision, stop.address, stop.name, stop.packageNo, stop.locality, stop.postalCode].join(":"))
      .join("|"),
    [stops],
  );
  // El padre reconstruye el array al renderizar. La firma evita redibujar Google Maps
  // cuando cambia un control que no modifica la ruta.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableStops = useMemo(() => stops, [geometrySignature]);
  const firstStop = stableStops.find((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));

  useEffect(() => {
    if (!GOOGLE_MAPS_API_KEY) return;
    let cancelled = false;
    void (async () => {
      try {
        configureGoogleMaps();
        const { Map } = await importLibrary("maps") as google.maps.MapsLibrary;
        if (cancelled || !mapElementRef.current) return;
        const standalone = window.matchMedia("(display-mode: standalone)").matches;
        const compact = window.matchMedia("(max-width: 820px)").matches;
        mapRef.current = new Map(mapElementRef.current, {
          center: DEFAULT_CENTER,
          zoom: 12,
          mapId: GOOGLE_MAPS_MAP_ID,
          backgroundColor: "#dce7e0",
          clickableIcons: false,
          controlSize: compact ? 34 : 40,
          disableDefaultUI: true,
          zoomControl: true,
          fullscreenControl: !compact,
          streetViewControl: false,
          mapTypeControl: false,
          cameraControl: false,
          keyboardShortcuts: true,
          gestureHandling: standalone ? "greedy" : "cooperative",
          renderingType: google.maps.RenderingType.VECTOR,
        });
        setMapReady(true);
        setPhase("ready");
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    let cancelled = false;
    const map = mapRef.current;
    const artifacts = artifactsRef.current;

    void (async () => {
      clearArtifacts(artifacts);
      setRouteSummary({ kind: "estimate" });
      try {
        const [{ AdvancedMarkerElement, PinElement }, { InfoWindow, Polyline }] = await Promise.all([
          importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
          importLibrary("maps") as Promise<google.maps.MapsLibrary>,
        ]);
        if (cancelled) return;

        const bounds = new google.maps.LatLngBounds();
        const infoWindow = new InfoWindow({ maxWidth: 290 });
        artifacts.infoWindow = infoWindow;
        const mappedStops = stableStops.filter((stop) => Number.isFinite(stop.lat) && Number.isFinite(stop.lon));

        mappedStops.forEach((stop, index) => {
          const position = { lat: stop.lat!, lng: stop.lon! };
          const colors = markerColors(stop);
          const pin = new PinElement({
            glyphText: String(index + 1),
            glyphColor: "#ffffff",
            background: colors.background,
            borderColor: colors.border,
            scale: 1.14,
          });
          const marker = new AdvancedMarkerElement({
            map,
            position,
            title: `${index + 1}. ${stop.address} · ${stop.name || `Paquete ${stop.packageNo}`}`,
            gmpClickable: true,
            zIndex: mappedStops.length - index,
          });
          marker.append(pin);
          marker.addEventListener("gmp-click", () => {
            infoWindow.close();
            infoWindow.setContent(infoContent(stop, index, origin));
            infoWindow.open({ map, anchor: marker, shouldFocus: false });
          });
          artifacts.markers.push(marker);
          bounds.extend(position);
        });

        if (origin) {
          const originPosition = { lat: origin.lat, lng: origin.lon };
          const originPin = new PinElement({
            glyphText: "●",
            glyphColor: "#ffffff",
            background: "#1769e0",
            borderColor: "#0f4faa",
            scale: 1.1,
          });
          const originMarker = new AdvancedMarkerElement({
            map,
            position: originPosition,
            title: "Tu ubicación · inicio",
            gmpClickable: true,
            zIndex: mappedStops.length + 10,
          });
          originMarker.append(originPin);
          originMarker.addEventListener("gmp-click", () => {
            infoWindow.close();
            infoWindow.setContent("Tu ubicación · inicio de la ruta");
            infoWindow.open({ map, anchor: originMarker, shouldFocus: false });
          });
          artifacts.markers.push(originMarker);
          bounds.extend(originPosition);
        }

        const routePoints: google.maps.LatLngLiteral[] = [
          ...(origin ? [{ lat: origin.lat, lng: origin.lon }] : []),
          ...mappedStops.map((stop) => ({ lat: stop.lat!, lng: stop.lon! })),
        ];

        let googleRouteDrawn = false;
        if (GOOGLE_ROUTES_ENABLED && routePoints.length > 1) {
          try {
            const { Route } = await importLibrary("routes") as google.maps.RoutesLibrary;
            let distanceMeters = 0;
            let durationMillis = 0;
            for (const points of routeChunks(routePoints)) {
              const { routes } = await Route.computeRoutes({
                origin: points[0],
                destination: points[points.length - 1],
                intermediates: points.slice(1, -1).map((location) => ({ location })),
                travelMode: "DRIVING",
                polylineQuality: "HIGH_QUALITY",
                fields: ["path", "distanceMeters", "durationMillis"],
              });
              if (cancelled) return;
              const route = routes?.[0];
              if (!route?.path?.length) throw new Error("Google Routes no devolvió una geometría.");
              const shadow = new Polyline({
                map,
                path: route.path,
                strokeColor: "#082c21",
                strokeOpacity: 0.16,
                strokeWeight: 10,
                clickable: false,
                zIndex: 8,
              });
              const line = new Polyline({
                map,
                path: route.path,
                strokeColor: "#0c6c4b",
                strokeOpacity: 0.94,
                strokeWeight: 5,
                clickable: false,
                zIndex: 9,
              });
              artifacts.polylines.push(shadow, line);
              distanceMeters += route.distanceMeters ?? 0;
              durationMillis += route.durationMillis ?? 0;
            }
            googleRouteDrawn = true;
            setRouteSummary({
              kind: "google",
              distanceKm: distanceMeters > 0 ? distanceMeters / 1000 : undefined,
              durationMinutes: durationMillis > 0 ? durationMillis / 60_000 : undefined,
            });
          } catch {
            googleRouteDrawn = false;
          }
        }

        if (!googleRouteDrawn && routePoints.length > 1) {
          const shadow = new Polyline({
            map,
            path: routePoints,
            geodesic: true,
            strokeColor: "#082c21",
            strokeOpacity: 0.12,
            strokeWeight: 9,
            clickable: false,
            zIndex: 8,
          });
          const line = new Polyline({
            map,
            path: routePoints,
            geodesic: true,
            strokeColor: "#9b6b1d",
            strokeOpacity: 0.8,
            strokeWeight: 4,
            clickable: false,
            zIndex: 9,
          });
          artifacts.polylines.push(shadow, line);
          setRouteSummary({ kind: "estimate" });
        }

        if (!bounds.isEmpty()) {
          const compact = window.matchMedia("(max-width: 820px)").matches;
          map.fitBounds(bounds, compact
            ? { top: 72, right: 28, bottom: 106, left: 28 }
            : { top: 74, right: 42, bottom: 92, left: 42 });
          google.maps.event.addListenerOnce(map, "idle", () => {
            if ((map.getZoom() ?? 0) > 16) map.setZoom(16);
          });
        } else {
          map.setCenter(DEFAULT_CENTER);
          map.setZoom(12);
        }
      } catch {
        if (!cancelled) setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      clearArtifacts(artifacts);
    };
  }, [mapReady, origin, stableStops]);

  if (phase === "missing-key") {
    return <div className="map-shell google-map-shell configuration-needed">
      <div className="google-map-config" role="status">
        <span aria-hidden="true">G</span>
        <small>GOOGLE MAPS</small>
        <strong>Integración preparada</strong>
        <p>Falta agregar la clave pública restringida en Vercel para activar el mapa interactivo.</p>
        {firstStop && <a href={navigationUrl(firstStop, origin)} target="_blank" rel="noreferrer">Abrir próxima parada en Google Maps</a>}
      </div>
    </div>;
  }

  return <div className="map-shell google-map-shell">
    <div className="map" ref={mapElementRef} role="region" aria-label={`Mapa de Google con ${stableStops.length} paradas`} />
    {phase === "ready" && <div className="google-map-hud" aria-live="polite">
      <span className="google-provider"><i aria-hidden="true">G</i><b>Google Maps</b><small>{routeSummary.kind === "google" ? "Ruta vial" : "Vista estimada"}</small></span>
      <span className="google-route-stats">
        <b>{stableStops.length}</b><small>paradas</small>
        {routeSummary.distanceKm && <><b>{routeSummary.distanceKm.toFixed(routeSummary.distanceKm >= 100 ? 0 : 1)} km</b><small>distancia</small></>}
        {routeSummary.durationMinutes && <><b>{formatDuration(routeSummary.durationMinutes)}</b><small>estimado</small></>}
      </span>
    </div>}
    {phase === "ready" && firstStop && <a className="google-start-route" href={navigationUrl(firstStop, origin)} target="_blank" rel="noreferrer">
      <span aria-hidden="true">➜</span><b>Navegar a la parada 1</b><small>Se abre en Google Maps</small>
    </a>}
    {phase === "loading" && <div className="map-loading" role="status"><i/><span>Conectando con Google Maps…</span></div>}
    {phase === "error" && <div className="map-loading error" role="status"><span>No se pudo iniciar Google Maps. Verificá la clave, las restricciones y que Maps JavaScript API esté habilitada.</span></div>}
  </div>;
}
