import { NextRequest, NextResponse } from "next/server";
import { allStreetRecords } from "@/lib/street-catalog";
import { SUPPORTED_LOCATIONS } from "@/lib/supported-locations";

function q(value: string | number) { return `"${String(value).replaceAll('"', '""')}"`; }

export async function GET(request: NextRequest) {
  const format = request.nextUrl.searchParams.get("format") ?? "csv";
  const rows = allStreetRecords();
  if (format === "json") return NextResponse.json({ locations: SUPPORTED_LOCATIONS, streets: rows });
  const header = ["Zona","Código postal","Partido","Localidad informada por Georef","Calle oficial","Categoría","Altura desde","Altura hasta","ID Georef"];
  const out = [header.map(q).join(";")];
  for (const loc of SUPPORTED_LOCATIONS) {
    const catalogLocality = loc.georefLocality ?? loc.locality;
    const source = rows.filter((r) => r.department === loc.department && (!catalogLocality || r.locality === catalogLocality));
    for (const row of source) out.push([loc.label,loc.postalCode,row.department,row.locality,row.name,row.category,row.from,row.to,row.id].map(q).join(";"));
  }
  return new NextResponse(out.join("\n"), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="callejeros-ruta-postal.csv"', "cache-control": "public, max-age=3600" } });
}
