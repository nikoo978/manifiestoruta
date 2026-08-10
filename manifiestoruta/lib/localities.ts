export type CatalogPlace = {
  name: string;
  postalCode: string;
  aliases: string[];
};

export function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

export const localityCatalog: CatalogPlace[] = [
  { name: "Ascensión", postalCode: "6003", aliases: ["ASCENSION", "ASCENCION"] },
  { name: "Junín", postalCode: "6000", aliases: ["JUNIN"] },
  { name: "Ferré", postalCode: "6027", aliases: ["FERRE"] },
  { name: "Baigorrita", postalCode: "6013", aliases: ["BAIGORRITA"] },
  { name: "Los Toldos", postalCode: "6015", aliases: ["LOS TOLDOS"] },
  { name: "General Viamonte", postalCode: "6015", aliases: ["GENERAL VIAMONTE"] },
];

export function canonicalLocality(value: string) {
  const candidate = fold(value);
  return localityCatalog.find(place => place.aliases.some(alias => candidate === alias || candidate.includes(alias)));
}
