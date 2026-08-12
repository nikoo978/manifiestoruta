import fs from "node:fs/promises";
import path from "node:path";

const API = "https://apis.datos.gob.ar/georef/api/v2.0/calles";
const OUT = path.join(process.cwd(), "data", "street-catalog.json");
const META = path.join(process.cwd(), "data", "street-catalog.meta.json");

const TARGETS = [
  { provinceId: "06", province: "Buenos Aires", department: "Junín", localities: ["Junín", "Agustina", "Fortín Tiburcio"] },
  { provinceId: "06", province: "Buenos Aires", department: "General Arenales", localities: ["Ascensión", "Ferré", "General Arenales", "Arribeños"] },
  { provinceId: "82", province: "Santa Fe", department: "General López", localities: ["Teodelina"] },
  { provinceId: "06", province: "Buenos Aires", department: "General Viamonte", localities: ["Los Toldos", "Baigorrita"] },
  { provinceId: "06", province: "Buenos Aires", department: "Lincoln", localities: ["Lincoln", "El Triunfo", "Coronel Martínez de Hoz"] },
  { provinceId: "06", province: "Buenos Aires", department: "9 de Julio", localities: ["Facundo Quiroga"] },
];

function fold(value) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim(); }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : undefined; }
function rangeEdge(values, fn, fallback = 0) { const nums = values.map(finite).filter(Number.isFinite); return nums.length ? fn(...nums) : fallback; }
function geometryCenter(geometry) {
  const coords = [];
  const walk = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) { coords.push([Number(value[0]), Number(value[1])]); return; }
    value.forEach(walk);
  };
  walk(geometry?.coordinates);
  if (!coords.length) return {};
  const sum = coords.reduce((acc,[lon,lat]) => [acc[0]+lon, acc[1]+lat], [0,0]);
  return { centerLon: sum[0] / coords.length, centerLat: sum[1] / coords.length };
}

async function fetchPage(target, locality, inicio) {
  const qs = new URLSearchParams({ provincia: target.provinceId, departamento: target.department, localidad_censal: locality, max: "5000", inicio: String(inicio), campos: "completo" });
  let response = await fetch(`${API}?${qs}`, { headers: { "user-agent": "RutaEnvios/2.5.4 complete street catalog" } });
  let data = response.ok ? await response.json() : null;
  // Algunas fuentes indexan la localidad como localidad simple y no censal.
  if ((!response.ok || !Array.isArray(data?.calles) || (!data.calles.length && inicio === 0))) {
    qs.delete("localidad_censal");
    qs.set("localidad", locality);
    response = await fetch(`${API}?${qs}`, { headers: { "user-agent": "RutaEnvios/2.5.4 complete street catalog" } });
    if (!response.ok) throw new Error(`Georef ${response.status} al descargar ${locality}, ${target.department}`);
    data = await response.json();
  }
  return data;
}

const existing = JSON.parse(await fs.readFile(OUT, "utf8"));
const targetSet = new Set(TARGETS.flatMap((t) => t.localities.map((locality) => `${fold(t.province)}|${fold(t.department)}|${fold(locality)}`)));
const keep = existing.filter((row) => !targetSet.has(`${fold(row.province || "Buenos Aires")}|${fold(row.department)}|${fold(row.locality)}`));
const collected = [];
const stats = [];

for (const target of TARGETS) {
  for (const locality of target.localities) {
    let inicio = 0;
    let total = Infinity;
    let count = 0;
    while (inicio < total) {
      const data = await fetchPage(target, locality, inicio);
      total = Number(data?.total ?? 0);
      const rows = Array.isArray(data?.calles) ? data.calles : [];
      for (const row of rows) {
        const start = row.altura?.inicio ?? {};
        const end = row.altura?.fin ?? {};
        const rightFrom = finite(start.derecha), leftFrom = finite(start.izquierda), rightTo = finite(end.derecha), leftTo = finite(end.izquierda);
        const center = geometryCenter(row.geometria);
        collected.push({
          id: String(row.id ?? ""),
          name: String(row.nombre ?? "").trim(),
          category: String(row.categoria ?? "CALLE"),
          nomenclature: String(row.nomenclatura ?? ""),
          province: String(row.provincia?.nombre ?? target.province),
          provinceId: String(row.provincia?.id ?? target.provinceId),
          department: String(row.departamento?.nombre ?? target.department),
          departmentId: String(row.departamento?.id ?? ""),
          locality: String(row.localidad_censal?.nombre ?? row.localidad?.nombre ?? locality),
          localityId: String(row.localidad_censal?.id ?? row.localidad?.id ?? ""),
          source: String(row.fuente ?? "INDEC / Georef"),
          from: rangeEdge([rightFrom, leftFrom], Math.min, 0),
          to: rangeEdge([rightTo, leftTo], Math.max, 0),
          ...(rightFrom !== undefined ? { rightFrom } : {}), ...(rightTo !== undefined ? { rightTo } : {}),
          ...(leftFrom !== undefined ? { leftFrom } : {}), ...(leftTo !== undefined ? { leftTo } : {}),
          ...center,
        });
      }
      count += rows.length;
      if (!rows.length || rows.length < 5000) break;
      inicio += rows.length;
    }
    stats.push({ province: target.province, department: target.department, locality, streets: count });
    console.log(`[street-catalog] ${locality}, ${target.department}: ${count} registros`);
  }
}

const unique = new Map();
for (const row of [...keep, ...collected]) {
  if (!row.name) continue;
  unique.set(`${row.id}|${fold(row.province)}|${fold(row.department)}|${fold(row.locality)}|${fold(row.name)}`, row);
}
const result = [...unique.values()].sort((a,b) => String(a.province ?? "").localeCompare(String(b.province ?? ""),"es") || a.department.localeCompare(b.department,"es") || a.locality.localeCompare(b.locality,"es") || a.name.localeCompare(b.name,"es"));
await fs.writeFile(OUT, JSON.stringify(result, null, 2) + "\n");
await fs.writeFile(META, JSON.stringify({ schemaVersion: 2, generatedAt: new Date().toISOString(), source: "Georef Argentina v2.0 / INDEC", endpoint: API, completePerLocality: true, includes: ["officialName", "nomenclature", "category", "heightRange", "rightHeightRange", "leftHeightRange", "locality", "department", "province", "source", "geometryCenterWhenAvailable"], stats }, null, 2) + "\n");
console.log(`[street-catalog] total ${result.length} registros oficiales`);
