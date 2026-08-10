export type SupportedLocation = {
  key: string;
  label: string;
  postalCode: string;
  postalAliases?: string[];
  province: string;
  provinceId: string;
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

const BA = { province: "Buenos Aires", provinceId: "06" } as const;
const SF = { province: "Santa Fe", provinceId: "82" } as const;
const DEFAULT_LOCATION_KEY = "junin-6000";

export const SUPPORTED_LOCATIONS: SupportedLocation[] = [
  { ...BA, key: "junin-6000", label: "Junín", postalCode: "6000", department: "Junín", locality: "Junín", localityId: "06413050", aliases: ["JUNIN"] },
  { ...BA, key: "agustina-6001", label: "Agustina", postalCode: "6001", department: "Junín", locality: "Agustina", aliases: ["AGUSTINA", "SANTA AGUSTINA"] },
  { ...BA, key: "fortin-tiburcio-6001", label: "Tiburcio", postalCode: "6001", department: "Junín", locality: "Fortín Tiburcio", aliases: ["TIBURCIO", "FORTIN TIBURCIO", "FORTÍN TIBURCIO"] },
  { ...BA, key: "ascension-6003", label: "Ascensión", postalCode: "6003", department: "General Arenales", locality: "Ascensión", aliases: ["ASCENSION", "ASCENCION"] },
  { ...BA, key: "ferre-6027", label: "Ferré", postalCode: "6027", postalAliases: ["6003"], department: "General Arenales", locality: "Ferré", aliases: ["FERRE"] },
  { ...BA, key: "general-arenales-6005", label: "Arenales", postalCode: "6005", department: "General Arenales", locality: "General Arenales", aliases: ["ARENALES", "GENERAL ARENALES", "GRAL ARENALES", "GRAL. ARENALES"] },
  { ...BA, key: "arribenos-6007", label: "Arribeños", postalCode: "6007", department: "General Arenales", locality: "Arribeños", aliases: ["ARRIBENOS", "ARRIBEÑOS"] },
  { ...SF, key: "teodelina-6009", label: "Teodelina", postalCode: "6009", department: "General López", locality: "Teodelina", aliases: ["TEODELINA", "TEODELINA SANTA FE"] },

  // Localidades ya soportadas en versiones anteriores.
  { ...BA, key: "baigorrita-6013", label: "Baigorrita", postalCode: "6013", department: "General Viamonte", locality: "Baigorrita", aliases: ["BAIGORRITA"] },
  {
    ...BA, key: "los-toldos-6015", label: "Los Toldos", postalCode: "6015", department: "General Viamonte", locality: "Los Toldos",
    aliases: ["LOS TOLDOS", "GENERAL VIAMONTE", "GRAL VIAMONTE", "GRAL. VIAMONTE", "PARTIDO DE GENERAL VIAMONTE", "GENERAL VIAMONTE PARTIDO"]
  },
  { ...BA, key: "lincoln-6070", label: "Lincoln", postalCode: "6070", department: "Lincoln", locality: "Lincoln", aliases: ["LINCOLN", "ESTACION LINCOLN"] },
  { ...BA, key: "el-triunfo-6073", label: "El Triunfo", postalCode: "6073", department: "Lincoln", locality: "El Triunfo", aliases: ["EL TRIUNFO"] },
  { ...BA, key: "coronel-martinez-de-hoz-6533", label: "Coronel Martínez de Hoz", postalCode: "6533", department: "Lincoln", locality: "Coronel Martínez de Hoz", aliases: ["CORONEL MARTINEZ DE HOZ", "CNEL MARTINEZ DE HOZ", "MARTINEZ DE HOZ"] },
  {
    ...BA, key: "alfredo-demarchi-6533", label: "Alfredo Demarchi", postalCode: "6533", department: "9 de Julio", locality: "Alfredo Demarchi",
    georefLocality: "Facundo Quiroga", aliases: ["ALFREDO DEMARCHI", "ESTACION FACUNDO QUIROGA", "EST FACUNDO QUIROGA"]
  },
  { ...BA, key: "facundo-quiroga-6533", label: "Facundo Quiroga", postalCode: "6533", department: "9 de Julio", locality: "Facundo Quiroga", aliases: ["FACUNDO QUIROGA", "QUIROGA"] },
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

function postalsFor(location: SupportedLocation) {
  return [location.postalCode, ...(location.postalAliases ?? [])];
}

export function locationByKey(key: string) {
  const resolvedKey = normalizedKey(key);
  return SUPPORTED_LOCATIONS.find((item) => item.key === resolvedKey)
    ?? SUPPORTED_LOCATIONS.find((item) => item.key === DEFAULT_LOCATION_KEY)!;
}

export function inferLocation(city?: string, postalCode?: string) {
  const byText = findLocationByText(city);
  if (byText) return byText;

  const postal = String(postalCode ?? "").replace(/\D/g, "").slice(0, 4);
  const byPostal = postal ? SUPPORTED_LOCATIONS.filter((location) => postalsFor(location).includes(postal)) : [];
  if (byPostal.length === 1) return byPostal[0];
  if (postal === "6070") return SUPPORTED_LOCATIONS.find((item) => item.key === "lincoln-6070")!;
  return byPostal[0] ?? SUPPORTED_LOCATIONS.find((item) => item.key === DEFAULT_LOCATION_KEY)!;
}

/**
 * Devuelve siempre un único nombre, CP y key para una ciudad soportada.
 * El nombre explícito tiene prioridad; luego se usa la key y por último el CP.
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
