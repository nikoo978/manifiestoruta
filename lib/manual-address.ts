import { locationByKey, SUPPORTED_LOCATIONS } from "@/lib/supported-locations";

export type ManualAddressRow = {
  address: string;
  locality: string;
  postalCode: string;
  locationKey: string;
};

function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

const LOCATION_ALIASES = SUPPORTED_LOCATIONS.flatMap((location) => {
  const aliases = new Set([
    location.label,
    location.locality ?? "",
    ...(location.aliases ?? []),
  ].map((value) => value.replace(/\s*\(.*?\)\s*/g, "").trim()).filter(Boolean));
  return [...aliases].map((alias) => ({ location, alias, folded: fold(alias) }));
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function explicitLocation(value: string) {
  const folded = fold(value);
  let best: { index: number; locationKey: string; alias: string } | null = null;
  for (const item of LOCATION_ALIASES) {
    const index = folded.lastIndexOf(item.folded);
    if (index >= 0 && (!best || index > best.index || (index === best.index && item.folded.length > fold(best.alias).length))) {
      best = { index, locationKey: item.location.key, alias: item.alias };
    }
  }
  const postalMatches = [...value.matchAll(/\b(\d{4})\b/g)];
  const lastPostal = postalMatches.at(-1)?.[1];
  if (!best && lastPostal) {
    const candidates = SUPPORTED_LOCATIONS.filter((location) => location.postalCode === lastPostal);
    if (candidates.length === 1) best = { index: value.lastIndexOf(lastPostal), locationKey: candidates[0].key, alias: "" };
  }
  return best ? locationByKey(best.locationKey) : null;
}

function splitFreeEntries(text: string) {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const output: string[] = [];
  for (const line of lines) {
    const separator = line.includes(";") ? ";" : line.includes(",") ? "," : "";
    if (!separator) {
      output.push(line);
      continue;
    }
    const chunks = line.split(separator).map((part) => part.trim()).filter(Boolean);
    // Split comma/semicolon lists only when every chunk identifies its locality.
    // This keeps "Rivadavia 40, Junín" as one address while accepting
    // "Rivadavia 40 Junín, Salta 32 Junín" as two entries.
    if (chunks.length > 1 && chunks.every((chunk) => explicitLocation(chunk))) output.push(...chunks);
    else output.push(line);
  }
  return output;
}

export function parseManualAddresses(text: string, defaultLocationKey: string): ManualAddressRow[] {
  const defaultLocation = locationByKey(defaultLocationKey);
  return splitFreeEntries(text).flatMap((raw) => {
    let value = raw.replace(/^[-•*\s]+/, "").replace(/^\d+[.)-]\s*/, "").trim();
    if (!value) return [];

    const detected = explicitLocation(value) ?? defaultLocation;
    const aliases = LOCATION_ALIASES.filter((item) => item.location.key === detected.key)
      .sort((a, b) => b.alias.length - a.alias.length);
    for (const item of aliases) {
      if (!item.alias) continue;
      const re = new RegExp(`(?:^|[\\s,;()])${escapeRegExp(item.alias)}(?=$|[\\s,;()])`, "ig");
      value = value.replace(re, " ");
    }
    value = value.replace(new RegExp(`\\b${escapeRegExp(detected.postalCode)}\\b`, "g"), " ");
    value = value.replace(/\s*[,;]+\s*/g, " ").replace(/\s+/g, " ").trim();
    if (!value) return [];

    return [{
      address: value,
      locality: detected.label,
      postalCode: detected.postalCode,
      locationKey: detected.key,
    }];
  });
}
