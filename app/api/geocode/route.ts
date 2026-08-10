import { NextRequest, NextResponse } from "next/server";
import { analyzeCatalogAddress, bestStreetMatch, normalizeText } from "@/lib/street-catalog";
import { locationByKey } from "@/lib/supported-locations";

type Point = { lat: number; lon: number };
type Precision = "exact" | "parallel" | "street" | "missing";
type Result = {
  lat?: number;
  lon?: number;
  precision: Precision;
  source: "georef" | "photon" | "nominatim" | "overpass" | "catalog" | "none";
  reason: string;
  normalizedAddress: string;
  locality: string;
  corrections?: unknown[];
};

type SearchHit = Point & {
  road: string;
  place: string;
  postcode: string;
  houseNumber: string;
  label: string;
};

type OsmWay = {
  id?: number;
  tags?: { name?: string };
  nodes?: number[];
  geometry?: Array<{ lat: number; lon: number }>;
};

const HEADERS = {
  "User-Agent": "RutaEnvios/2.5.2 (delivery route planner)",
  "Accept-Language": "es-AR,es;q=0.9,en;q=0.4",
};

async function fetchJson(url: string, init?: RequestInit, timeout = 12000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      headers: { ...HEADERS, ...(init?.headers ?? {}) },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];
}

function samePlace(value: string, locationKey: string) {
  const loc = locationByKey(locationKey);
  const haystack = normalizeText(value);
  const locality = normalizeText(loc.locality ?? "");
  const department = normalizeText(loc.department);
  return Boolean((locality && haystack.includes(locality)) || (department && haystack.includes(department)));
}

function sameStreet(found: string, wanted: string) {
  const a = normalizeText(found).replace(/^AV /, "").trim();
  const b = normalizeText(wanted).replace(/^AV /, "").trim();
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

async function georefOne(address: string, locationKey: string, scope: "locality" | "department" | "loose"): Promise<Point | null> {
  const loc = locationByKey(locationKey);
  const qs = new URLSearchParams({ direccion: address, provincia: loc.province, max: "5", campos: "completo" });
  if (scope !== "loose") qs.set("departamento", loc.department);
  if (scope === "locality" && loc.locality) {
    if (loc.localityId) qs.set("localidad_censal", loc.locality);
    else qs.set("localidad", loc.locality);
  }
  const data = await fetchJson(`https://apis.datos.gob.ar/georef/api/direcciones?${qs}`);
  const rows = Array.isArray(data?.direcciones) ? data.direcciones : [];
  for (const row of rows) {
    const lat = Number(row?.ubicacion?.lat);
    const lon = Number(row?.ubicacion?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const place = [row?.localidad_censal?.nombre, row?.localidad?.nombre, row?.departamento?.nombre].filter(Boolean).join(" ");
    if (scope === "loose" && place && !samePlace(place, locationKey)) continue;
    return { lat, lon };
  }
  return null;
}

async function georef(addresses: string[], locationKey: string): Promise<Point | null> {
  const variants = unique(addresses);
  for (const address of variants) {
    const local = await georefOne(address, locationKey, "locality");
    if (local) return local;
    const department = await georefOne(address, locationKey, "department");
    if (department) return department;
  }
  for (const address of variants.slice(0, 3)) {
    const loose = await georefOne(address, locationKey, "loose");
    if (loose) return loose;
  }
  return null;
}

async function photon(query: string, locationKey: string, limit = 8): Promise<SearchHit[]> {
  const loc = locationByKey(locationKey);
  const place = loc.locality ?? loc.department;
  const qs = new URLSearchParams({ q: `${query}, ${place}, ${loc.province}, Argentina`, limit: String(limit), lang: "es" });
  const data = await fetchJson(`https://photon.komoot.io/api/?${qs}`, undefined, 11000);
  return (Array.isArray(data?.features) ? data.features : []).map((feature: any) => {
    const p = feature?.properties ?? {};
    return {
      lat: Number(feature?.geometry?.coordinates?.[1]),
      lon: Number(feature?.geometry?.coordinates?.[0]),
      road: String(p.street ?? p.name ?? ""),
      place: String(p.city ?? p.locality ?? p.town ?? p.village ?? p.district ?? p.county ?? ""),
      postcode: String(p.postcode ?? ""),
      houseNumber: String(p.housenumber ?? ""),
      label: [p.name, p.street, p.city, p.locality, p.county].filter(Boolean).join(" "),
    } satisfies SearchHit;
  }).filter((hit: SearchHit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lon));
}

function bestHit(hits: SearchHit[], locationKey: string, street: string, height?: number) {
  const loc = locationByKey(locationKey);
  return hits.map((hit) => {
    let score = samePlace(`${hit.place} ${hit.label}`, locationKey) ? 5 : -8;
    if (sameStreet(`${hit.road} ${hit.label}`, street)) score += 5;
    if (height) {
      if (hit.houseNumber === String(height)) score += 7;
      else if (normalizeText(hit.label).includes(String(height))) score += 2;
    }
    if (hit.postcode && hit.postcode.startsWith(loc.postalCode)) score += 2;
    return { hit, score };
  }).sort((a, b) => b.score - a.score)[0];
}

let lastNominatim = 0;
const nominatimCache = new Map<string, SearchHit[]>();

async function nominatimQuery(qs: URLSearchParams): Promise<SearchHit[]> {
  const key = qs.toString();
  const cached = nominatimCache.get(key);
  if (cached) return cached;
  const elapsed = Date.now() - lastNominatim;
  if (elapsed < 1100) await new Promise((resolve) => setTimeout(resolve, 1100 - elapsed));
  lastNominatim = Date.now();
  const data = await fetchJson(`https://nominatim.openstreetmap.org/search?${qs}`, undefined, 14000);
  const rows: SearchHit[] = (Array.isArray(data) ? data : []).map((item: any) => {
    const a = item?.address ?? {};
    return {
      lat: Number(item?.lat),
      lon: Number(item?.lon),
      road: String(a.road ?? a.pedestrian ?? a.residential ?? ""),
      place: String(a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state_district ?? ""),
      postcode: String(a.postcode ?? ""),
      houseNumber: String(a.house_number ?? ""),
      label: String(item?.display_name ?? ""),
    };
  }).filter((hit: SearchHit) => Number.isFinite(hit.lat) && Number.isFinite(hit.lon));
  nominatimCache.set(key, rows);
  if (nominatimCache.size > 150) {
    const oldest = nominatimCache.keys().next().value;
    if (oldest) nominatimCache.delete(oldest);
  }
  return rows;
}

async function nominatim(addresses: string[], street: string, height: number | undefined, locationKey: string): Promise<SearchHit | null> {
  const loc = locationByKey(locationKey);
  const place = loc.locality ?? loc.department;
  const structured = new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "8", countrycodes: "ar", street: `${height ? `${height} ` : ""}${street}`.trim(), city: place, state: loc.province });
  if (loc.postalCode) structured.set("postalcode", loc.postalCode);
  const candidates = [
    structured,
    ...addresses.slice(0, 3).map((address) => new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "8", countrycodes: "ar", q: `${address}, ${place}, ${loc.province}, Argentina` })),
  ];
  for (const qs of candidates) {
    const best = bestHit(await nominatimQuery(qs), locationKey, street, height);
    if (best?.hit && best.score >= (height ? 9 : 7)) return best.hit;
  }
  return null;
}

function canonicalStreet(name: string, locationKey: string) {
  const match = bestStreetMatch(name, locationKey);
  return normalizeText(match?.street && match.score >= 0.50 ? match.street.name : name);
}

async function streetAnchor(street: string, locationKey: string): Promise<Point | null> {
  const p = bestHit(await photon(street, locationKey, 10), locationKey, street);
  if (p?.hit && p.score >= 7) return { lat: p.hit.lat, lon: p.hit.lon };
  const osm = await nominatim([street], street, undefined, locationKey);
  return osm ? { lat: osm.lat, lon: osm.lon } : null;
}

async function overpassWays(anchor: Point, radius = 6000): Promise<OsmWay[]> {
  const query = `[out:json][timeout:18];way(around:${radius},${anchor.lat},${anchor.lon})["highway"]["name"];out body geom;`;
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  for (const endpoint of endpoints) {
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: new URLSearchParams({ data: query }),
    }, 22000);
    if (Array.isArray(data?.elements) && data.elements.length) return data.elements as OsmWay[];
  }
  return [];
}

function wayPoints(way: OsmWay): Point[] {
  return (Array.isArray(way.geometry) ? way.geometry : [])
    .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

function meters(a: Point, b: Point) {
  const y = (a.lat - b.lat) * 111000;
  const x = (a.lon - b.lon) * 111000 * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(x, y);
}

function matchingWays(ways: OsmWay[], wanted: string, locationKey: string) {
  const canonical = canonicalStreet(wanted, locationKey);
  return ways.filter((way) => canonicalStreet(String(way.tags?.name ?? ""), locationKey) === canonical);
}

function sharedNodeIntersection(aWays: OsmWay[], bWays: OsmWay[]): Point | null {
  for (const aWay of aWays) {
    if (!Array.isArray(aWay.nodes) || !Array.isArray(aWay.geometry)) continue;
    const bNodes = new Set<number>();
    for (const bWay of bWays) for (const node of bWay.nodes ?? []) bNodes.add(node);
    for (let index = 0; index < aWay.nodes.length; index++) {
      if (!bNodes.has(aWay.nodes[index])) continue;
      const point = aWay.geometry[index];
      if (point && Number.isFinite(point.lat) && Number.isFinite(point.lon)) return { lat: Number(point.lat), lon: Number(point.lon) };
    }
  }
  return null;
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | null {
  const lat0 = (a.lat + b.lat + c.lat + d.lat) / 4;
  const k = Math.cos(lat0 * Math.PI / 180);
  const ax = a.lon * k, ay = a.lat;
  const bx = b.lon * k, by = b.lat;
  const cx = c.lon * k, cy = c.lat;
  const dx = d.lon * k, dy = d.lat;
  const rX = bx - ax, rY = by - ay;
  const sX = dx - cx, sY = dy - cy;
  const denom = rX * sY - rY * sX;
  if (Math.abs(denom) < 1e-12) return null;
  const qX = cx - ax, qY = cy - ay;
  const t = (qX * sY - qY * sX) / denom;
  const u = (qX * rY - qY * rX) / denom;
  if (t < -0.01 || t > 1.01 || u < -0.01 || u > 1.01) return null;
  return { lat: ay + t * rY, lon: (ax + t * rX) / k };
}

function geometricIntersection(aWays: OsmWay[], bWays: OsmWay[]): Point | null {
  for (const aWay of aWays) {
    const aa = wayPoints(aWay);
    for (const bWay of bWays) {
      const bb = wayPoints(bWay);
      for (let i = 1; i < aa.length; i++) for (let j = 1; j < bb.length; j++) {
        const point = segmentIntersection(aa[i - 1], aa[i], bb[j - 1], bb[j]);
        if (point) return point;
      }
    }
  }
  return null;
}

function nearIntersection(aWays: OsmWay[], bWays: OsmWay[]): Point | null {
  let best: { point: Point; d: number } | null = null;
  for (const aw of aWays) for (const bw of bWays) for (const a of wayPoints(aw)) for (const b of wayPoints(bw)) {
    const distance = meters(a, b);
    if (distance <= 18 && (!best || distance < best.d)) best = { point: { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 }, d: distance };
  }
  return best?.point ?? null;
}

function intersection(aWays: OsmWay[], bWays: OsmWay[]) {
  return sharedNodeIntersection(aWays, bWays) ?? geometricIntersection(aWays, bWays) ?? nearIntersection(aWays, bWays);
}

function projectPointToSegment(p: Point, a: Point, b: Point): Point {
  const k = Math.cos(p.lat * Math.PI / 180);
  const ax = a.lon * k, ay = a.lat, bx = b.lon * k, by = b.lat, px = p.lon * k, py = p.lat;
  const vx = bx - ax, vy = by - ay;
  const den = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / den));
  return { lat: ay + t * vy, lon: (ax + t * vx) / k };
}

function projectToWays(point: Point, ways: OsmWay[]): Point {
  let best: { point: Point; d: number } | null = null;
  for (const way of ways) {
    const points = wayPoints(way);
    for (let index = 1; index < points.length; index++) {
      const projected = projectPointToSegment(point, points[index - 1], points[index]);
      const d = meters(point, projected);
      if (!best || d < best.d) best = { point: projected, d };
    }
  }
  return best?.point ?? point;
}

async function overpassBetween(main: string, between: string[], locationKey: string): Promise<{ point: Point; reason: string } | null> {
  if (between.length !== 2) return null;
  const anchor = await streetAnchor(main, locationKey);
  if (!anchor) return null;
  const ways = await overpassWays(anchor, 6500);
  if (!ways.length) return null;
  const mainWays = matchingWays(ways, main, locationKey);
  const firstWays = matchingWays(ways, between[0], locationKey);
  const secondWays = matchingWays(ways, between[1], locationKey);
  if (!mainWays.length || !firstWays.length || !secondWays.length) return null;
  const first = intersection(mainWays, firstWays);
  const second = intersection(mainWays, secondWays);
  if (!first || !second) return null;
  const midpoint = { lat: (first.lat + second.lat) / 2, lon: (first.lon + second.lon) / 2 };
  const onMain = projectToWays(midpoint, mainWays);
  return {
    point: onMain,
    reason: `Punto medio sobre ${main} entre ${between[0]} y ${between[1]}.`,
  };
}

async function nominatimBetween(main: string, between: string[], locationKey: string): Promise<{ point: Point; reason: string } | null> {
  if (between.length !== 2) return null;
  const loc = locationByKey(locationKey);
  const place = loc.locality ?? loc.department;
  const intersectionQueries = [
    `${main} y ${between[0]}, ${place}, ${loc.province}, Argentina`,
    `${main} y ${between[1]}, ${place}, ${loc.province}, Argentina`,
  ];
  const points: Point[] = [];
  for (const query of intersectionQueries) {
    const hits = await nominatimQuery(new URLSearchParams({ format: "jsonv2", addressdetails: "1", limit: "6", countrycodes: "ar", q: query }));
    const hit = hits.find((candidate) => samePlace(`${candidate.place} ${candidate.label}`, locationKey));
    if (!hit) return null;
    points.push({ lat: hit.lat, lon: hit.lon });
  }
  if (points.length !== 2) return null;
  return {
    point: { lat: (points[0].lat + points[1].lat) / 2, lon: (points[0].lon + points[1].lon) / 2 },
    reason: `Punto medio entre los cruces con ${between[0]} y ${between[1]}.`,
  };
}

function rawStreet(raw: string) {
  return raw.replace(/\s+(?:entre|e\/|e\.)\s+.+$/i, "").replace(/\b\d{1,6}\b.*$/, "").trim();
}

async function resolveOne(raw: string, locationKey: string): Promise<Result> {
  const loc = locationByKey(locationKey);
  const analysis = analyzeCatalogAddress(raw, locationKey);
  const normalizedAddress = analysis.correctedAddress || raw.trim();
  const corrections = analysis.corrections;
  const rangeWarning = analysis.heightPlausible === false && analysis.heightRange
    ? `La altura ${analysis.height} está fuera del rango oficial ${analysis.heightRange.from}-${analysis.heightRange.to} para ${analysis.mainStreet}. `
    : "";

  if (analysis.between.length === 2) {
    const exactBetween = await overpassBetween(analysis.mainStreet, analysis.between, locationKey)
      ?? await nominatimBetween(analysis.mainStreet, analysis.between, locationKey);
    if (exactBetween) {
      return {
        ...exactBetween.point,
        precision: "exact",
        source: "overpass",
        reason: `${rangeWarning}${exactBetween.reason}`.trim(),
        normalizedAddress,
        locality: loc.label,
        corrections,
      };
    }
    return {
      precision: "missing",
      source: "none",
      reason: `${rangeWarning}No se pudieron confirmar los dos cruces de ${analysis.mainStreet} con ${analysis.between[0]} y ${analysis.between[1]}.`,
      normalizedAddress,
      locality: loc.label,
      corrections,
    };
  }

  const base = normalizedAddress.replace(/\s+entre\s+.+$/i, "");
  const rawBase = raw.replace(/\s+(?:entre|e\/|e\.)\s+.+$/i, "").trim();
  const street = analysis.mainStreet || analysis.streetInput || rawStreet(raw);
  const variants = unique([
    base,
    rawBase,
    `${analysis.streetInput}${analysis.height ? ` ${analysis.height}` : ""}`,
    `${street}${analysis.height ? ` ${analysis.height}` : ""}`,
  ]);

  const exact = await georef(variants, locationKey);
  if (exact) return { ...exact, precision: "exact", source: "georef", reason: rangeWarning.trim(), normalizedAddress, locality: loc.label, corrections };

  for (const query of variants.slice(0, 4)) {
    const best = bestHit(await photon(query, locationKey, 10), locationKey, street, analysis.height);
    if (best?.hit && best.score >= (analysis.height ? 9 : 7)) {
      const exactHeight = !analysis.height || best.hit.houseNumber === String(analysis.height);
      return { lat: best.hit.lat, lon: best.hit.lon, precision: exactHeight ? "exact" : "street", source: "photon", reason: `${rangeWarning}${exactHeight ? "" : "Altura aproximada."}`.trim(), normalizedAddress, locality: loc.label, corrections };
    }
  }

  const osm = await nominatim(variants, street, analysis.height, locationKey);
  if (osm) {
    const exactHeight = !analysis.height || osm.houseNumber === String(analysis.height);
    return { lat: osm.lat, lon: osm.lon, precision: exactHeight ? "exact" : "street", source: "nominatim", reason: `${rangeWarning}${exactHeight ? "" : "Altura aproximada."}`.trim(), normalizedAddress, locality: loc.label, corrections };
  }

  const streetBest = bestHit(await photon(street, locationKey, 10), locationKey, street);
  if (streetBest?.hit && streetBest.score >= 7) {
    return { lat: streetBest.hit.lat, lon: streetBest.hit.lon, precision: "street", source: "photon", reason: `${rangeWarning}${analysis.height ? "Altura no encontrada; punto aproximado sobre la calle." : "Calle encontrada."}`.trim(), normalizedAddress, locality: loc.label, corrections };
  }

  if (analysis.streetCenter) {
    return {
      lat: analysis.streetCenter.lat,
      lon: analysis.streetCenter.lon,
      precision: "street",
      source: "catalog",
      reason: `${rangeWarning}Ubicación aproximada usando el centro geométrico oficial de la calle del catálogo Georef.`.trim(),
      normalizedAddress,
      locality: loc.label,
      corrections,
    };
  }

  return { precision: "missing", source: "none", reason: "No se pudo ubicar. Editá la dirección o pegá coordenadas.", normalizedAddress, locality: loc.label, corrections };
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const items = Array.isArray(body?.direcciones) ? body.direcciones : [];
  if (!items.length) return NextResponse.json({ error: "Faltan direcciones." }, { status: 400 });
  const results: Result[] = [];
  for (const item of items.slice(0, 100)) {
    results.push(await resolveOne(String(item?.direccion ?? ""), String(item?.locationKey ?? "junin-6000")));
  }
  return NextResponse.json({ results });
}
