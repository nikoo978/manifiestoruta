import recordsJson from "@/data/street-catalog.json";
import { locationByKey } from "@/lib/supported-locations";

export type StreetRecord = {
  id: string;
  name: string;
  category: string;
  department: string;
  locality: string;
  localityId: string;
  from: number;
  to: number;
};

const RECORDS = recordsJson as StreetRecord[];

export type AddressAnalysis = {
  input: string;
  streetInput: string;
  mainStreet: string;
  height?: number;
  between: string[];
  correctedAddress: string;
  corrections: Array<{ original: string; corrected: string; score: number }>;
  catalogMatched: boolean;
};

const MANUAL_ALIASES: Record<string, string> = {
  "BENITO DE MIGUEL": "AV B DE MIGUEL",
  "B DE MIGUEL": "AV B DE MIGUEL",
  "GENERAL SAN MARTIN": "AV GENERAL SAN MARTIN",
  "SAN MARTIN": "AV GENERAL SAN MARTIN",
  "ROQUE SAENZ PENA": "AV ROQUE SAENZ PENA",
  "SAENZ PENA": "AV ROQUE SAENZ PENA",
  "CORONEL SUAREZ": "CNEL SUEREZ",
  "CNEL SUAREZ": "CNEL SUEREZ",
  "CARLOS PELLEGRINI": "PELLEGRINI CARLOS",
  "ALBERDI": "JUAN B ALBERDI",
  "JUAN BAUTISTA ALBERDI": "JUAN B ALBERDI",
  "LEBENSOHN": "LEBENSHON",
  "PRIMERA JUNTA": "PRIMERA JUNTA",
  "BORGES": "CNEL BORGES",
  "GENERAL PAZ": "GRAL PAZ",
  "GRAL PAZ": "GRAL PAZ",
  "RIVADAVIA": "AV RIVADAVIA",
  "ARIAS": "AV J L ARIAS",
  "J L ARIAS": "AV J L ARIAS",
  "JOSE LUIS ARIAS": "AV J L ARIAS"
};

export function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\bAVENIDA\b/g, "AV")
    .replace(/\bAV\.?(?=\s|$)/g, "AV")
    .replace(/\bGENERAL\b/g, "GRAL")
    .replace(/\bCORONEL\b/g, "CNEL")
    .replace(/\bALMIRANTE\b/g, "ALMTE")
    .replace(/\bPRESIDENTE\b/g, "PRES")
    .replace(/[^A-Z0-9°Ñ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = Array.from({ length: cols }, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j < cols; j++) prev[j] = cur[j];
  }
  return prev[cols - 1];
}

function tokenScore(a: string, b: string) {
  const aa = normalizeText(a).split(" ").filter(Boolean);
  const bb = normalizeText(b).split(" ").filter(Boolean);
  const sa = new Set(aa);
  const sb = new Set(bb);
  const common = [...sa].filter((token) => sb.has(token)).length;
  const union = new Set([...aa, ...bb]).size || 1;
  return common / union;
}

function similarity(a: string, b: string) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length) || 1;
  const edit = 1 - levenshtein(na, nb) / maxLen;
  return Math.max(edit, tokenScore(na, nb) * 0.95);
}

export function streetsForLocation(locationKey: string) {
  const loc = locationByKey(locationKey);
  const rows = RECORDS.filter((r) => r.department === loc.department && (!loc.locality || r.locality === loc.locality));
  const byName = new Map<string, StreetRecord>();
  for (const row of rows) {
    const key = `${row.locality}|${row.name}`;
    if (!byName.has(key)) byName.set(key, row);
  }
  return [...byName.values()];
}

export function bestStreetMatch(input: string, locationKey: string) {
  const candidates = streetsForLocation(locationKey);
  if (!candidates.length) return null;
  const normalized = normalizeText(input);
  const loc = locationByKey(locationKey);
  const alias = MANUAL_ALIASES[normalized] ?? MANUAL_ALIASES[normalized.replace(/^AV /, "")];
  const aliasMatches = alias
    ? candidates.filter((r) => normalizeText(r.name) === normalizeText(alias))
    : [];
  // Manual aliases are deliberate canonical mappings. If the mapped street
  // exists in this locality, treat it as an exact match instead of penalizing
  // abbreviated input such as "Arias" -> "AV J L ARIAS".
  if (aliasMatches.length) return { street: aliasMatches[0], score: 1 };
  // An alias can be valid in one locality but absent in another (for example,
  // RIVADAVIA is AV RIVADAVIA in Junín but CALLE RIVADAVIA elsewhere).
  // Never return a match object without an actual street. Fall back to the
  // locality catalog when the alias-specific candidate does not exist.
  const pool = candidates;
  let best = pool[0];
  let score = -1;
  for (const row of pool) {
    let s = similarity(normalized, row.name);
    if (loc.locality === "Los Toldos" && normalized === "BALBN" && /BALBIN/.test(normalizeText(row.name))) s = 0.96;
    if (s > score) { score = s; best = row; }
  }
  return best ? { street: best, score } : null;
}

function splitBetween(input: string) {
  const m = input.match(/\s+(?:ENTRE|E\/|E\.)\s+(.+?)\s+(?:Y|E|\/|-)\s+(.+)$/i);
  if (!m) return { main: input.trim(), refs: [] as string[] };
  return { main: input.slice(0, m.index).trim(), refs: [m[1].trim(), m[2].trim()] };
}

export function analyzeCatalogAddress(input: string, locationKey: string): AddressAnalysis {
  const cleaned = input.replace(/\s+/g, " ").trim();
  const { main, refs } = splitBetween(cleaned);
  const numberMatch = main.match(/\b(\d{1,6})\b/);
  const height = numberMatch ? Number(numberMatch[1]) : undefined;
  const streetInput = (numberMatch ? main.slice(0, numberMatch.index).trim() : main).replace(/[-,]+$/g, "").trim();
  const mainMatch = bestStreetMatch(streetInput, locationKey);
  const corrections: AddressAnalysis["corrections"] = [];
  let mainStreet = streetInput;
  let matched = false;
  if (mainMatch?.street && (mainMatch.score >= 0.72 || normalizeText(mainMatch.street.name) === normalizeText(streetInput))) {
    mainStreet = mainMatch.street.name;
    matched = true;
    if (normalizeText(streetInput) !== normalizeText(mainStreet)) corrections.push({ original: streetInput, corrected: mainStreet, score: mainMatch.score });
  }
  const correctedRefs = refs.map((ref) => {
    const match = bestStreetMatch(ref, locationKey);
    if (match?.street && match.score >= 0.68) {
      if (normalizeText(ref) !== normalizeText(match.street.name)) corrections.push({ original: ref, corrected: match.street.name, score: match.score });
      return match.street.name;
    }
    return ref;
  });
  const correctedAddress = `${mainStreet}${height ? ` ${height}` : ""}${correctedRefs.length === 2 ? ` entre ${correctedRefs[0]} y ${correctedRefs[1]}` : ""}`.trim();
  return { input, streetInput, mainStreet, height, between: correctedRefs, correctedAddress, corrections, catalogMatched: matched };
}

export function allStreetRecords() { return RECORDS; }
