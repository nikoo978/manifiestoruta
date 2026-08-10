import { SUPPORTED_LOCATIONS } from "./supported-locations";

export type CatalogPlace = { name: string; postalCode: string; aliases: string[]; key: string };

export function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export const localityCatalog: CatalogPlace[] = SUPPORTED_LOCATIONS.map((location) => ({
  name: location.label,
  postalCode: location.postalCode,
  key: location.key,
  aliases: [location.label, location.locality ?? "", ...(location.aliases ?? [])].filter(Boolean).map(fold),
}));

export function canonicalLocality(value: string) {
  const candidate = fold(value);
  return localityCatalog.find((place) => place.aliases.some((alias) => candidate === alias || candidate.includes(alias)));
}
