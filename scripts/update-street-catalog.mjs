import fs from "node:fs/promises";
import path from "node:path";

const API = "https://apis.datos.gob.ar/georef/api/v2.0/calles";
const OUT = path.join(process.cwd(), "data", "street-catalog.json");
const TARGET_DEPARTMENTS = ["General Arenales", "Junín", "General Viamonte", "Lincoln", "9 de Julio"];
const LEGACY_DEPARTMENT_NAMES = ["Nueve de Julio"];

const old = JSON.parse(await fs.readFile(OUT, "utf8"));
const targetDepartmentFolds = new Set([...TARGET_DEPARTMENTS, ...LEGACY_DEPARTMENT_NAMES].map(fold));
const keep = old.filter((row) => !targetDepartmentFolds.has(fold(row.department)));
const collected = [];

function fold(value) { return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim(); }
function edge(values, fn, fallback = 0) { const nums = values.filter(Number.isFinite); return nums.length ? fn(...nums) : fallback; }

for (const department of TARGET_DEPARTMENTS) {
  let inicio = 0;
  let total = Infinity;
  let count = 0;
  while (inicio < total) {
    const qs = new URLSearchParams({ provincia: "06", departamento: department, max: "5000", inicio: String(inicio), campos: "completo" });
    const response = await fetch(`${API}?${qs}`, { headers: { "user-agent": "RutaEnvios/2.4.1 street catalog" } });
    if (!response.ok) throw new Error(`Georef ${response.status} al descargar el callejero de ${department}`);
    const data = await response.json();
    total = Number(data.total ?? 0);
    const rows = Array.isArray(data.calles) ? data.calles : [];
    for (const row of rows) {
      const start = row.altura?.inicio ?? {};
      const end = row.altura?.fin ?? {};
      collected.push({
        id: String(row.id ?? ""), name: String(row.nombre ?? "").trim(), category: String(row.categoria ?? "CALLE"),
        department: String(row.departamento?.nombre ?? department), locality: String(row.localidad_censal?.nombre ?? ""),
        localityId: String(row.localidad_censal?.id ?? ""),
        from: edge([Number(start.derecha), Number(start.izquierda)], Math.min, 0),
        to: edge([Number(end.derecha), Number(end.izquierda)], Math.max, 0),
      });
    }
    count += rows.length;
    if (!rows.length || rows.length < 5000) break;
    inicio += rows.length;
  }
  console.log(`[street-catalog] partido ${department}: ${count} registros de calles`);
}

const unique = new Map();
for (const row of [...keep, ...collected]) {
  if (!row.name) continue;
  unique.set(`${row.id}|${row.department}|${row.locality}|${row.name}`, row);
}
const result = [...unique.values()].sort((a,b) => a.department.localeCompare(b.department,"es") || a.locality.localeCompare(b.locality,"es") || a.name.localeCompare(b.name,"es"));
await fs.writeFile(OUT, JSON.stringify(result, null, 2) + "\n");
console.log(`[street-catalog] total ${result.length} registros oficiales`);
