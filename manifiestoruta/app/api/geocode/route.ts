import { NextRequest, NextResponse } from "next/server";
import { analyzeCatalogAddress, bestStreetMatch, normalizeText } from "@/lib/street-catalog";
import { locationByKey } from "@/lib/supported-locations";

type Point = { lat: number; lon: number };
type Precision = "exact" | "parallel" | "street" | "missing";
type Result = {
  lat?: number;
  lon?: number;
  precision: Precision;
  source: "georef" | "nominatim" | "photon" | "overpass" | "none";
  reason: string;
  normalizedAddress: string;
  locality: string;
  corrections?: unknown[];
};

type PhotonHit = Point & {
  name: string;
  street: string;
  city: string;
  district: string;
  postcode: string;
  housenumber: string;
};

type NominatimHit = Point & {
  displayName: string;
  road: string;
  houseNumber: string;
  city: string;
  county: string;
  postcode: string;
  type: string;
};

const ua = {
  "User-Agent": "RutaEnvios/1.9 (delivery route planner; contact via application owner)",
  "Accept-Language": "es-AR,es;q=0.9,en;q=0.4",
};

let lastNominatimRequest = 0;
const nominatimCache = new Map<string, unknown>();

async function fetchNominatim(qs: URLSearchParams) {
  const key = qs.toString();
  if (nominatimCache.has(key)) return nominatimCache.get(key);
  const elapsed = Date.now() - lastNominatimRequest;
  if (elapsed < 1050) await new Promise((resolve) => setTimeout(resolve, 1050 - elapsed));
  lastNominatimRequest = Date.now();
  const data = await fetchNominatim(qs);
  nominatimCache.set(key, data);
  if (nominatimCache.size > 200) nominatimCache.delete(nominatimCache.keys().next().value as string);
  return data;
}

async function fetchJson(url: string, init?: RequestInit, timeout = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { ...ua, ...(init?.headers || {}) },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function localityMatches(value: string, locationKey: string) {
  if (!value) return false;
  const loc = locationByKey(locationKey);
  const haystack = normalizeText(value);
  const locality = normalizeText(loc.locality ?? "");
  const department = normalizeText(loc.department);
  if (locality && haystack.includes(locality)) return true;
  return haystack.includes(department);
}

async function georefQuery(address: string, locationKey: string, mode: "locality" | "department" | "loose"): Promise<Point | null> {
  const loc = locationByKey(locationKey);
  const qs = new URLSearchParams({ direccion: address, provincia: "Buenos Aires", max: "3", campos: "completo" });
  if (mode !== "loose") qs.set("departamento", loc.department);
  if (mode === "locality" && loc.locality) {
    if (loc.localityId) qs.set("localidad_censal", loc.locality);
    else qs.set("localidad", loc.locality);
  }
  const data = await fetchJson(`https://apis.datos.gob.ar/georef/api/direcciones?${qs}`);
  const hits = Array.isArray(data?.direcciones) ? data.direcciones : [];
  for (const item of hits) {
    const point = item?.ubicacion;
    if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon)) continue;
    const label = [item?.localidad_censal?.nombre, item?.localidad?.nombre, item?.departamento?.nombre].filter(Boolean).join(" ");
    if (mode === "loose" && label && !localityMatches(label, locationKey)) continue;
    return { lat: Number(point.lat), lon: Number(point.lon) };
  }
  return null;
}

async function georef(addresses: string[], locationKey: string): Promise<{ point: Point; query: string } | null> {
  const variants = unique(addresses);
  for (const address of variants) {
    const local = await georefQuery(address, locationKey, "locality");
    if (local) return { point: local, query: address };
    const department = await georefQuery(address, locationKey, "department");
    if (department) return { point: department, query: address };
  }
  // Último intento sin sobre-restringir el filtro. Se valida localidad/partido en la respuesta.
  for (const address of variants.slice(0, 2)) {
    const loose = await georefQuery(address, locationKey, "loose");
    if (loose) return { point: loose, query: address };
  }
  return null;
}

async function photon(query: string, locationKey: string, limit = 6): Promise<PhotonHit[]> {
  const loc = locationByKey(locationKey);
  const place = loc.locality ?? loc.department;
  const qs = new URLSearchParams({ q: `${query}, ${place}, Buenos Aires, Argentina`, limit: String(limit), lang: "es" });
  const data = await fetchJson(`https://photon.komoot.io/api/?${qs}`, undefined, 10000);
  return (data?.features ?? []).map((feature: any) => ({
    lat: Number(feature.geometry?.coordinates?.[1]),
    lon: Number(feature.geometry?.coordinates?.[0]),
    name: String(feature.properties?.name ?? ""),
    street: String(feature.properties?.street ?? ""),
    city: String(feature.properties?.city ?? feature.properties?.locality ?? feature.properties?.town ?? feature.properties?.village ?? ""),
    district: String(feature.properties?.district ?? feature.properties?.county ?? ""),
    postcode: String(feature.properties?.postcode ?? ""),
    housenumber: String(feature.properties?.housenumber ?? ""),
  })).filter((point: PhotonHit) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
}

function pickPhotonHit(hits: PhotonHit[], locationKey: string, street: string, height?: number) {
  const streetNorm = normalizeText(street).replace(/^AV /, "");
  const loc = locationByKey(locationKey);
  return hits.map((hit) => {
    const placeText = `${hit.city} ${hit.district}`;
    let score = localityMatches(placeText, locationKey) ? 3 : -3;
    const hitStreet = normalizeText(`${hit.street} ${hit.name}`).replace(/^AV /, "");
    if (hitStreet === streetNorm || hitStreet.includes(streetNorm) || streetNorm.includes(hitStreet)) score += 4;
    if (height) {
      if (hit.housenumber === String(height)) score += 5;
      else if (normalizeText(`${hit.name} ${hit.street}`).includes(String(height))) score += 2;
    }
    if (hit.postcode && hit.postcode === loc.postalCode) score += 2;
    return { hit, score };
  }).sort((a, b) => b.score - a.score)[0];
}

async function nominatim(address: string, street: string, height: number | undefined, locationKey: string): Promise<NominatimHit | null> {
  const loc = locationByKey(locationKey);
  const candidates: URLSearchParams[] = [];
  const structured = new URLSearchParams({
    format: "jsonv2",
    addressdetails: "1",
    limit: "5",
    countrycodes: "ar",
    street: `${street}${height ? ` ${height}` : ""}`,
    state: "Buenos Aires",
  });
  if (loc.locality) structured.set("city", loc.locality);
  if (loc.postalCode) structured.set("postalcode", loc.postalCode);
  candidates.push(structured);
  candidates.push(new URLSearchParams({
    format: "jsonv2",
    addressdetails: "1",
    limit: "5",
    countrycodes: "ar",
    q: `${address}, ${loc.locality ?? loc.department}, Buenos Aires, Argentina`,
  }));

  for (const qs of candidates) {
    const data = await fetchNominatim(qs);
    if (!Array.isArray(data)) continue;
    const scored = data.map((item: any) => {
      const addr = item?.address ?? {};
      const hit: NominatimHit = {
        lat: Number(item?.lat),
        lon: Number(item?.lon),
        displayName: String(item?.display_name ?? ""),
        road: String(addr.road ?? addr.pedestrian ?? addr.residential ?? ""),
        houseNumber: String(addr.house_number ?? ""),
        city: String(addr.city ?? addr.town ?? addr.village ?? addr.municipality ?? addr.hamlet ?? ""),
        county: String(addr.county ?? addr.state_district ?? ""),
        postcode: String(addr.postcode ?? ""),
        type: String(item?.type ?? ""),
      };
      const placeText = `${hit.city} ${hit.county} ${hit.displayName}`;
      let score = localityMatches(placeText, locationKey) ? 4 : -6;
      const wantedStreet = normalizeText(street).replace(/^AV /, "");
      const foundStreet = normalizeText(hit.road).replace(/^AV /, "");
      if (foundStreet && (foundStreet === wantedStreet || foundStreet.includes(wantedStreet) || wantedStreet.includes(foundStreet))) score += 5;
      if (height) {
        if (hit.houseNumber === String(height)) score += 6;
        else if (normalizeText(hit.displayName).includes(String(height))) score += 2;
      }
      if (hit.postcode && hit.postcode === loc.postalCode) score += 2;
      if (["house", "building", "residential"].includes(hit.type)) score += 1;
      return { hit, score };
    }).filter((row: any) => Number.isFinite(row.hit.lat) && Number.isFinite(row.hit.lon)).sort((a: any, b: any) => b.score - a.score);
    if (scored[0]?.score >= (height ? 7 : 5)) return scored[0].hit;
  }
  return null;
}

function distance(a: Point, b: Point) { const y = (a.lat - b.lat) * 111000, x = (a.lon - b.lon) * 111000 * Math.cos(a.lat * Math.PI / 180); return Math.hypot(x, y); }
function bearing(a: Point, b: Point) { return Math.atan2((b.lon - a.lon) * Math.cos((a.lat + b.lat) * Math.PI / 360), b.lat - a.lat); }
function angleDiff(a: number, b: number) { const d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); }
function projectOnSegment(p: Point, a: Point, b: Point): Point {
  const k = Math.cos(p.lat * Math.PI / 180), ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const dx = bx - ax, dy = by - ay, den = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / den));
  return { lat: ay + t * dy, lon: (ax + t * dx) / k };
}

async function overpassWays(anchor: Point, radius = 500) {
  const query = `[out:json][timeout:10];way(around:${radius},${anchor.lat},${anchor.lon})["highway"]["name"];out tags geom;`;
  for (const endpoint of ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"]) {
    const data = await fetchJson(endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ data: query }) }, 12000);
    if (data?.elements?.length) return data.elements;
  }
  return [];
}

function nearestSegment(way: any, p: Point) {
  let best: any = null;
  const geometry = way.geometry ?? [];
  for (let i = 1; i < geometry.length; i++) {
    const a = { lat: geometry[i - 1].lat, lon: geometry[i - 1].lon }, b = { lat: geometry[i].lat, lon: geometry[i].lon };
    const q = projectOnSegment(p, a, b), d = distance(p, q);
    if (!best || d < best.d) best = { a, b, q, d };
  }
  return best;
}

async function parallelFallback(street: string, height: number, locationKey: string): Promise<{ point: Point; reason: string } | null> {
  const streetHits = await photon(street, locationKey, 4);
  if (!streetHits[0]) return null;
  const anchor = streetHits[0];
  const ways = await overpassWays(anchor);
  if (!ways.length) return null;
  const targetNorm = normalizeText(street);
  const targetWays = ways.filter((way: any) => normalizeText(way.tags?.name ?? "") === targetNorm || normalizeText(way.tags?.name ?? "").includes(targetNorm.replace(/^AV /, "")));
  const target = targetWays.map((way: any) => ({ way, segment: nearestSegment(way, anchor) })).filter((row: any) => row.segment).sort((a: any, b: any) => a.segment.d - b.segment.d)[0];
  if (!target) return null;
  const targetAngle = bearing(target.segment.a, target.segment.b);
  const candidates = ways.map((way: any) => ({ way, segment: nearestSegment(way, anchor) })).filter((row: any) => row.segment && normalizeText(row.way.tags?.name ?? "") !== targetNorm && row.segment.d < 420 && angleDiff(targetAngle, bearing(row.segment.a, row.segment.b)) < 0.28).sort((a: any, b: any) => a.segment.d - b.segment.d).slice(0, 8);
  for (const candidate of candidates) {
    const name = String(candidate.way.tags?.name ?? "");
    const match = bestStreetMatch(name, locationKey);
    const queryName = match?.street?.name ?? name;
    const exact = await georef([`${queryName} ${height}`], locationKey);
    if (!exact) continue;
    const projected = nearestSegment(target.way, exact.point);
    if (projected && projected.d < 650) return { point: projected.q, reason: `Altura ${height} estimada con ${name} y proyectada sobre ${street}.` };
  }
  return null;
}

function canonicalWayName(name: string, locationKey: string) {
  const match = bestStreetMatch(name, locationKey);
  return normalizeText(match?.street && match.score >= 0.52 ? match.street.name : name);
}
function geometryPoints(way: any): Point[] { return (way?.geometry ?? []).map((point: any) => ({ lat: Number(point.lat), lon: Number(point.lon) })).filter((point: Point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)); }
function intersectWays(aWays: any[], bWays: any[]): Point | null {
  let best: { point: Point; d: number } | null = null;
  for (const aWay of aWays) for (const bWay of bWays) for (const a of geometryPoints(aWay)) for (const b of geometryPoints(bWay)) {
    const d = distance(a, b);
    if (d <= 18 && (!best || d < best.d)) best = { point: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, d };
  }
  return best?.point ?? null;
}
async function crossPoint(mainStreet: string, crossStreet: string, locationKey: string): Promise<Point | null> {
  const anchors = await photon(crossStreet, locationKey, 4);
  const mainNorm = normalizeText(mainStreet), crossNorm = normalizeText(crossStreet);
  for (const anchor of anchors) {
    const ways = await overpassWays(anchor, 2200);
    if (!ways.length) continue;
    const mainWays = ways.filter((way: any) => { const canonical = canonicalWayName(String(way.tags?.name ?? ""), locationKey); return canonical === mainNorm || canonical.includes(mainNorm) || mainNorm.includes(canonical); });
    if (!mainWays.length) continue;
    const crossWays = ways.filter((way: any) => { const canonical = canonicalWayName(String(way.tags?.name ?? ""), locationKey); return canonical === crossNorm || canonical.includes(crossNorm) || crossNorm.includes(canonical); });
    const intersection = intersectWays(mainWays, crossWays);
    if (intersection) return intersection;
    const projected = mainWays.map((way: any) => nearestSegment(way, anchor)).filter(Boolean).sort((a: any, b: any) => a.d - b.d)[0];
    if (projected && projected.d < 1200) return projected.q;
  }
  return null;
}
async function betweenFallback(mainStreet: string, between: string[], locationKey: string): Promise<{ point: Point; reason: string } | null> {
  if (between.length !== 2) return null;
  const first = await crossPoint(mainStreet, between[0], locationKey);
  const second = await crossPoint(mainStreet, between[1], locationKey);
  if (first && second) return { point: { lat: (first.lat + second.lat) / 2, lon: (first.lon + second.lon) / 2 }, reason: `Punto medio de ${mainStreet} entre ${between[0]} y ${between[1]}.` };
  if (first || second) return { point: first ?? second!, reason: `Se ubicó ${mainStreet} en una de las entrecalles; la segunda no pudo resolverse con precisión.` };
  return null;
}

function rawStreetVariant(raw: string, height?: number) {
  const clean = raw.replace(/\s+(?:entre|e\/|e\.)\s+.+$/i, "").trim();
  if (!height) return clean;
  const idx = clean.search(/\b\d{1,6}\b/);
  return idx >= 0 ? clean.slice(0, idx).trim() : clean;
}

async function resolveOne(raw: string, locationKey: string): Promise<Result> {
  const loc = locationByKey(locationKey);
  const analysis = analyzeCatalogAddress(raw, locationKey);
  if (analysis.between.length === 2) {
    const between = await betweenFallback(analysis.mainStreet, analysis.between, locationKey);
    if (between) return { ...between.point, precision: "street", source: "overpass", reason: between.reason, normalizedAddress: analysis.correctedAddress, locality: loc.label, corrections: analysis.corrections };
  }

  const correctedBase = analysis.correctedAddress.replace(/\s+entre\s+.+$/i, "");
  const rawStreet = rawStreetVariant(raw, analysis.height);
  const addressVariants = unique([
    correctedBase,
    `${analysis.streetInput}${analysis.height ? ` ${analysis.height}` : ""}`,
    `${rawStreet}${analysis.height ? ` ${analysis.height}` : ""}`,
    raw.replace(/\s+entre\s+.+$/i, ""),
  ]);

  const exact = await georef(addressVariants, locationKey);
  if (exact) return { ...exact.point, precision: "exact", source: "georef", reason: "Domicilio localizado por Georef Argentina.", normalizedAddress: analysis.correctedAddress, locality: loc.label, corrections: analysis.corrections };

  for (const query of addressVariants.slice(0, 3)) {
    const hits = await photon(query, locationKey, 8);
    const best = pickPhotonHit(hits, locationKey, analysis.mainStreet || analysis.streetInput, analysis.height);
    if (best?.hit && best.score >= (analysis.height ? 7 : 5)) {
      const exactHeight = !analysis.height || best.hit.housenumber === String(analysis.height) || normalizeText(`${best.hit.name} ${best.hit.street}`).includes(String(analysis.height));
      return {
        lat: best.hit.lat,
        lon: best.hit.lon,
        precision: exactHeight ? "exact" : "street",
        source: "photon",
        reason: exactHeight ? "Domicilio localizado por OpenStreetMap/Photon." : `Se encontró ${analysis.mainStreet}; la altura queda aproximada.`,
        normalizedAddress: analysis.correctedAddress,
        locality: loc.label,
        corrections: analysis.corrections,
      };
    }
  }

  const nominatimHit = await nominatim(addressVariants[0] ?? raw, analysis.mainStreet || analysis.streetInput, analysis.height, locationKey);
  if (nominatimHit) {
    const exactHeight = !analysis.height || nominatimHit.houseNumber === String(analysis.height) || normalizeText(nominatimHit.displayName).includes(String(analysis.height));
    return {
      lat: nominatimHit.lat,
      lon: nominatimHit.lon,
      precision: exactHeight ? "exact" : "street",
      source: "nominatim",
      reason: exactHeight ? "Domicilio localizado por OpenStreetMap/Nominatim." : `Se encontró ${analysis.mainStreet}; la altura queda aproximada.`,
      normalizedAddress: analysis.correctedAddress,
      locality: loc.label,
      corrections: analysis.corrections,
    };
  }

  if (analysis.height) {
    const parallel = await parallelFallback(analysis.mainStreet, analysis.height, locationKey);
    if (parallel) return { ...parallel.point, precision: "parallel", source: "overpass", reason: parallel.reason, normalizedAddress: analysis.correctedAddress, locality: loc.label, corrections: analysis.corrections };
  }

  const streetQueries = unique([analysis.mainStreet, analysis.streetInput, rawStreet]);
  for (const streetQuery of streetQueries) {
    const streetHits = await photon(streetQuery, locationKey, 6);
    const best = pickPhotonHit(streetHits, locationKey, analysis.mainStreet || streetQuery);
    if (best?.hit && best.score >= 4) return {
      lat: best.hit.lat,
      lon: best.hit.lon,
      precision: "street",
      source: "photon",
      reason: analysis.height ? `No se encontró la altura ${analysis.height}; se marcó un punto aproximado sobre ${analysis.mainStreet}.` : `Se encontró ${analysis.mainStreet || streetQuery}.`,
      normalizedAddress: analysis.correctedAddress,
      locality: loc.label,
      corrections: analysis.corrections,
    };
  }

  return { precision: "missing", source: "none", reason: "No se pudo ubicar automáticamente. Podés corregir la dirección o pegar coordenadas.", normalizedAddress: analysis.correctedAddress, locality: loc.label, corrections: analysis.corrections };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const items = Array.isArray(body?.direcciones) ? body.direcciones : [];
  if (!items.length) return NextResponse.json({ error: "Faltan direcciones." }, { status: 400 });
  const results: Result[] = [];
  for (const item of items.slice(0, 100)) results.push(await resolveOne(String(item.direccion ?? ""), String(item.locationKey ?? "junin-6000")));
  return NextResponse.json({ results });
}
