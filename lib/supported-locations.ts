export type SupportedLocation = {
  key: string;
  label: string;
  postalCode: string;
  department: string;
  locality?: string;
  localityId?: string;
  georefLocality?: string;
  aliases?: string[];
};

export type CanonicalLocation = {
  locationKey: string;
  locality: string;
  postalCode: string;
  location: SupportedLocation;
};

export const SUPPORTED_LOCATIONS: SupportedLocation[] = [
  { key: "ascension-6003", label: "Ascensión", postalCode: "6003", department: "General Arenales", locality: "Ascensión", aliases: ["ASCENSION", "ASCENCION"] },
  { key: "junin-6000", label: "Junín", postalCode: "6000", department: "Junín", locality: "Junín", localityId: "06413050", aliases: ["JUNIN"] },
  { key: "ferre-6027", label: "Ferré", postalCode: "6027", department: "General Arenales", locality: "Ferré", aliases: ["FERRE"] },
  { key: "baigorrita-6013", label: "Baigorrita", postalCode: "6013", department: "General Viamonte", locality: "Baigorrita", aliases: ["BAIGORRITA"] },
  {
    key: "los-toldos-6015", label: "Los Toldos", postalCode: "6015", department: "General Viamonte", locality: "Los Toldos",
    aliases: ["LOS TOLDOS", "GENERAL VIAMONTE", "GRAL VIAMONTE", "GRAL. VIAMONTE", "PARTIDO DE GENERAL VIAMONTE", "GENERAL VIAMONTE PARTIDO"]
  },
  { key: "lincoln-6070", label: "Lincoln", postalCode: "6070", department: "Lincoln", locality: "Lincoln", aliases: ["LINCOLN", "ESTACION LINCOLN"] },
  { key: "el-triunfo-6073", label: "El Triunfo", postalCode: "6073", department: "Lincoln", locality: "El Triunfo", aliases: ["EL TRIUNFO"] },
  { key: "coronel-martinez-de-hoz-6533", label: "Coronel Martínez de Hoz", postalCode: "6533", department: "Lincoln", locality: "Coronel Martínez de Hoz", aliases: ["CORONEL MARTINEZ DE HOZ", "CNEL MARTINEZ DE HOZ", "MARTINEZ DE HOZ"] },
  {
    key: "alfredo-demarchi-6533", label: "Alfredo Demarchi", postalCode: "6533", department: "9 de Julio", locality: "Alfredo Demarchi",
    georefLocality: "Facundo Quiroga", aliases: ["ALFREDO DEMARCHI", "ESTACION FACUNDO QUIROGA", "EST FACUNDO QUIROGA"]
  },
  { key: "facundo-quiroga-6533", label: "Facundo Quiroga", postalCode: "6533", department: "9 de Julio", locality: "Facundo Quiroga", aliases: ["FACUNDO QUIROGA", "QUIROGA"] },
];

const LEGACY_LOCATION_KEYS: Record<string, string> = {
  "general-viamonte-6015": "los-toldos-6015",
};

function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function normalizedKey(key?: string) {
  const value = String(key ?? "").trim();
  return LEGACY_LOCATION_KEYS[value] ?? value;
}

function aliasesFor(location: SupportedLocation) {
  return [location.label, location.locality ?? "", ...(location.aliases ?? [])]
    .filter(Boolean)
    .map(fold)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function findLocationByText(city?: string) {
  const value = fold(city ?? "");
  if (!value) return undefined;
  return SUPPORTED_LOCATIONS.find((location) => aliasesFor(location).some((alias) => value === alias || value.includes(alias)));
}

export function locationByKey(key: string) {
  const resolvedKey = normalizedKey(key);
  return SUPPORTED_LOCATIONS.find((item) => item.key === resolvedKey) ?? SUPPORTED_LOCATIONS[1];
}

export function inferLocation(city?: string, postalCode?: string) {
  const byText = findLocationByText(city);
  if (byText) return byText;

  const postal = String(postalCode ?? "").replace(/\D/g, "").slice(0, 4);
  const byPostal = postal ? SUPPORTED_LOCATIONS.filter((location) => location.postalCode === postal) : [];
  if (byPostal.length === 1) return byPostal[0];
  // 6070 aparece también en barrios/parajes del partido: si el texto no logra
  // resolver otra localidad, la cabecera Lincoln es el fallback útil.
  if (postal === "6070") return SUPPORTED_LOCATIONS.find((item) => item.key === "lincoln-6070")!;
  return byPostal[0] ?? SUPPORTED_LOCATIONS[1];
}

/**
 * Devuelve siempre un único nombre, CP y key para una ciudad soportada.
 * El nombre explícito tiene prioridad para corregir datos viejos que pudieran
 * haber quedado asociados a una key incorrecta; luego se usa la key y por
 * último el CP como fallback.
 */
export function canonicalizeLocation(city?: string, postalCode?: string, locationKey?: string): CanonicalLocation {
  const byText = findLocationByText(city);
  const key = normalizedKey(locationKey);
  const byKey = key ? SUPPORTED_LOCATIONS.find((item) => item.key === key) : undefined;
  const location = byText ?? byKey ?? inferLocation(city, postalCode);
  return {
    locationKey: location.key,
    locality: location.label,
    postalCode: location.postalCode,
    location,
  };
}
