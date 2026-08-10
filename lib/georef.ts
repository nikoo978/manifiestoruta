import { canonicalLocality, fold } from "./localities";
import { locationByKey } from "./supported-locations";

type GeorefStreet = { id?: string; nombre?: string };
type GeorefResponse = { calles?: GeorefStreet[] };

export type AddressValidation = {
  streetId?: string;
  matchedStreet?: string;
};

function streetCandidate(address: string) {
  const clean = address
    .replace(/\bOBS\s*1\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const numbered = clean.match(/^(.+?[A-ZÁÉÍÓÚÑ])\s+(\d{1,5})(?:\s|$)/i);
  const base = numbered?.[1] ?? clean.split(/\s+(?:ENTRE|ESQUINA|CASA|S\/?N|FRENTE|CONTACTO)\b/i)[0];
  return base.replace(/^(?:CALLE|AVENIDA|AV\.?)[\s]+/i, "").trim();
}

export async function validateAddress(address: string, locality: string): Promise<AddressValidation | null> {
  const place = canonicalLocality(locality);
  const street = streetCandidate(address);
  if (!place || street.length < 3) return null;

  const location = locationByKey(place.key);
  const catalogLocality = location.georefLocality ?? location.locality;
  const baseParams = {
    nombre: street,
    provincia: location.province,
    departamento: location.department,
    max: "8",
    campos: "completo",
  };
  const candidates = catalogLocality
    ? [
        new URLSearchParams({ ...baseParams, localidad_censal: catalogLocality }),
        new URLSearchParams({ ...baseParams, localidad: catalogLocality }),
        new URLSearchParams(baseParams),
      ]
    : [new URLSearchParams(baseParams)];

  const expected = fold(street);
  for (const params of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`https://apis.datos.gob.ar/georef/api/v2.0/calles?${params}`, {
        signal: controller.signal,
        next: { revalidate: 60 * 60 * 24 * 30 },
      });
      if (!response.ok) continue;
      const data = await response.json() as GeorefResponse;
      const match = data.calles?.find(item => {
        const found = fold(item.nombre ?? "");
        return found === expected || found.includes(expected) || expected.includes(found);
      }) ?? data.calles?.[0];
      if (match) return { streetId: match.id, matchedStreet: match.nombre };
    } catch {
      // Probamos el siguiente filtro; Georef puede no indexar una localidad con
      // el mismo tipo territorial (localidad vs. localidad censal).
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}
