export type SupportedLocation = {
  key: string;
  label: string;
  postalCode: string;
  department: string;
  locality?: string;
  localityId?: string;
};

export const SUPPORTED_LOCATIONS: SupportedLocation[] = [
  { key: "ascension-6003", label: "Ascensión", postalCode: "6003", department: "General Arenales", locality: "Ascensión" },
  { key: "junin-6000", label: "Junín", postalCode: "6000", department: "Junín", locality: "Junín", localityId: "06413050" },
  { key: "ferre-6027", label: "Ferré", postalCode: "6027", department: "General Arenales", locality: "Ferré" },
  { key: "baigorrita-6013", label: "Baigorrita", postalCode: "6013", department: "General Viamonte", locality: "Baigorrita" },
  { key: "los-toldos-6015", label: "Los Toldos", postalCode: "6015", department: "General Viamonte", locality: "Los Toldos" },
  { key: "general-viamonte-6015", label: "General Viamonte (partido)", postalCode: "6015", department: "General Viamonte" }
];

export function locationByKey(key: string) {
  return SUPPORTED_LOCATIONS.find((item) => item.key === key) ?? SUPPORTED_LOCATIONS[1];
}

export function inferLocation(city?: string, postalCode?: string) {
  const value = (city ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const byPostal = postalCode ? SUPPORTED_LOCATIONS.filter((l) => l.postalCode === postalCode) : [];
  const pool = byPostal.length ? byPostal : SUPPORTED_LOCATIONS;
  if (/ascen/.test(value)) return SUPPORTED_LOCATIONS[0];
  if (/junin/.test(value)) return SUPPORTED_LOCATIONS[1];
  if (/ferre/.test(value)) return SUPPORTED_LOCATIONS[2];
  if (/baigor/.test(value)) return SUPPORTED_LOCATIONS[3];
  if (/toldos/.test(value)) return SUPPORTED_LOCATIONS[4];
  if (/viamonte/.test(value)) return SUPPORTED_LOCATIONS[5];
  return pool[0] ?? SUPPORTED_LOCATIONS[1];
}
