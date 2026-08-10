import { canonicalLocality, fold } from "./localities";

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

  const params = new URLSearchParams({ nombre: street, localidad: place.name, max: "5" });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`https://apis.datos.gob.ar/georef/api/calles?${params}`, {
      signal: controller.signal,
      next: { revalidate: 60 * 60 * 24 * 30 },
    });
    if (!response.ok) return null;
    const data = await response.json() as GeorefResponse;
    const expected = fold(street);
    const match = data.calles?.find(item => {
      const found = fold(item.nombre ?? "");
      return found === expected || found.includes(expected) || expected.includes(found);
    }) ?? data.calles?.[0];
    return match ? { streetId: match.id, matchedStreet: match.nombre } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
