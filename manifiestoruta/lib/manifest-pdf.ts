import { SUPPORTED_LOCATIONS } from "@/lib/supported-locations";

export type ManifestRow = {
  packageNo: number;
  name: string;
  address: string;
  locality: string;
  postalCode: string;
  locationKey: string;
  sourceCode?: string;
};

export type ManifestParseResult = {
  manifestNumber?: string;
  date?: string;
  expectedCount?: number;
  rows: ManifestRow[];
  warnings: string[];
  diagnostics?: {
    pages: number;
    textItems: number;
    destinationLines: number;
    localityMarkers: number;
    strategy: string;
  };
};

type Item = {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  eol: boolean;
  order: number;
};

type PageData = {
  items: Item[];
  width: number;
  height: number;
  sequentialLines: string[];
};

type Line = {
  text: string;
  y: number;
  minX: number;
  maxX: number;
  items: Item[];
};

const FOLDED_LOCATIONS = SUPPORTED_LOCATIONS.map((location) => ({
  ...location,
  foldedLabel: fold(location.label.replace(/\s*\(.*?\)\s*/g, "")),
  foldedLocality: fold(location.locality ?? location.label.replace(/\s*\(.*?\)\s*/g, "")),
}));

function fold(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function cleanSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanAddress(value: string) {
  return cleanSpaces(value)
    .replace(/\bOBS\s*\d*\b.*$/i, "")
    .replace(/\bCONTACTO\s*:.*$/i, "")
    .replace(/\s+\d{12,}(?:-\d+)?\s*---.*$/i, "")
    .replace(/\s+X\s*-\s*X.*$/i, "")
    .replace(/\s+-\s+(\d+)\s+-\s+-$/, " $1")
    .replace(/\s+0$/, " ")
    .replace(/^DOMICILIO\s*:?\s*/i, "")
    .replace(/^DIRECCI[ÓO]N\s*:?\s*/i, "")
    .trim();
}

function cleanName(value: string) {
  return cleanSpaces(value)
    .replace(/^APELLIDO\s+Y\s+DNI\s*:?\s*/i, "")
    .replace(/^DESTINATARIO\s*:?\s*/i, "")
    .replace(/\bDNI\s*:?\s*[\d.]{6,}\b/ig, " ")
    .replace(/\s+-\s+\d{6,}\s*$/i, "")
    .trim();
}

function isPureNoise(value: string) {
  const text = cleanSpaces(value);
  if (!text) return true;
  return /^(?:APELLIDO\s+Y\s+DNI|DESTINATARIO|DOMICILIO|DIRECCI[ÓO]N|LOCALIDAD|PROVINCIA|C\.?P\.?|CODIGO\s+POSTAL|FIRMAR\s+DOCUMENTO|DE\s+PORTAGUIA|SERVICIO|ENTREGA|CONTRAREEMBOLSO|MERCADO\s+PAGO|REMITENTE|OBS\s*\d*|CONTACTO)\s*:?[\s-]*$/i.test(text);
}

function isHeaderOrFooter(value: string) {
  return /(?:N[°º]?\s*MANIFIESTO|FECHA\s+MANIFIESTO|CANTIDAD\s+DE\s+ENVIOS|P[ÁA]GINA\s+\d+|CORREO\s+ARGENTINO|MANIFIESTO\s+DE|TOTAL\s+DE\s+ENVIOS)/i.test(value);
}

function keyFor(city: string, postal: string) {
  const normalized = fold(city);
  if (normalized.includes("BAIGOR")) return "baigorrita-6013";
  if (normalized.includes("TOLDOS")) return "los-toldos-6015";
  if (normalized.includes("ASCEN")) return "ascension-6003";
  if (normalized.includes("FERRE")) return "ferre-6027";
  if (normalized.includes("JUNIN")) return "junin-6000";
  if (normalized.includes("VIAMONTE")) return "general-viamonte-6015";
  if (postal === "6003") return "ascension-6003";
  if (postal === "6027") return "ferre-6027";
  if (postal === "6013") return "baigorrita-6013";
  if (postal === "6015") return "los-toldos-6015";
  return "junin-6000";
}

function locationFromText(value: string) {
  const text = cleanSpaces(value);
  const folded = fold(text);
  const postalMatch = text.match(/\b(\d{4})\b/);
  const postalCode = postalMatch?.[1] ?? "";

  let matched = FOLDED_LOCATIONS.find((location) =>
    (location.foldedLocality && folded.includes(location.foldedLocality)) ||
    (location.foldedLabel && folded.includes(location.foldedLabel)),
  );

  if (!matched && postalCode) {
    const postalMatches = FOLDED_LOCATIONS.filter((location) => location.postalCode === postalCode);
    if (postalMatches.length === 1) matched = postalMatches[0];
    else if (postalMatches.length > 1) {
      matched = postalMatches.find((location) => folded.includes(location.foldedLocality)) ?? postalMatches[0];
    }
  }

  const hasProvince = /BUENOS\s+AIRES|PROV(?:INCIA)?\.?\s+DE\s+BUENOS\s+AIRES/i.test(text);
  const plausiblePostal = Boolean(postalCode && (matched || hasProvince));
  const plausibleLocation = Boolean(matched && (postalCode || text.length <= 65));
  if (!plausiblePostal && !plausibleLocation) return null;

  let locality = matched?.locality ?? matched?.label.replace(/\s*\(.*?\)\s*/g, "") ?? "";
  let cp = postalCode || matched?.postalCode || "";

  if (!locality) {
    locality = cleanSpaces(text
      .replace(/\b\d{4}\b/g, " ")
      .replace(/PROV(?:INCIA)?\.?\s+DE\s+BUENOS\s+AIRES/ig, " ")
      .replace(/BUENOS\s+AIRES/ig, " ")
      .replace(/\b(?:LOCALIDAD|C\.?P\.?|CODIGO\s+POSTAL)\b\s*:?/ig, " ")
      .replace(/[(),;]+/g, " "));
  }

  if (!cp && matched) cp = matched.postalCode;
  if (!locality || !cp) return null;

  return {
    locality,
    postalCode: cp,
    locationKey: matched?.key ?? keyFor(locality, cp),
  };
}

function buildLines(items: Item[], tolerance = 2.6): Line[] {
  const lines: Line[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x || a.order - b.order)) {
    let line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (!line) {
      line = { text: "", y: item.y, minX: item.x, maxX: item.x + item.width, items: [] };
      lines.push(line);
    }
    line.items.push(item);
    line.minX = Math.min(line.minX, item.x);
    line.maxX = Math.max(line.maxX, item.x + item.width);
    line.y = (line.y * (line.items.length - 1) + item.y) / line.items.length;
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x || a.order - b.order);
    line.text = cleanSpaces(line.items.map((item) => item.text).join(" "));
  }
  return lines.filter((line) => line.text).sort((a, b) => b.y - a.y || a.minX - b.minX);
}

function destinationStart(page: PageData) {
  const headerCandidates = page.items.filter((item) => /DESTINATARIO|APELLIDO\s+Y\s+DNI|DOMICILIO/i.test(item.text) && item.x > page.width * 0.2);
  if (headerCandidates.length) {
    return Math.max(page.width * 0.28, Math.min(page.width * 0.68, Math.min(...headerCandidates.map((item) => item.x)) - 12));
  }

  const localityCandidates = page.items.filter((item) => {
    if (item.x < page.width * 0.25) return false;
    const folded = fold(item.text);
    return FOLDED_LOCATIONS.some((location) => folded.includes(location.foldedLocality)) || /^60(?:00|03|13|15|27)$/.test(item.text.trim()) || /BUENOS\s+AIRES/i.test(item.text);
  });
  if (localityCandidates.length) {
    const sorted = localityCandidates.map((item) => item.x).sort((a, b) => a - b);
    const sample = sorted[Math.min(Math.floor(sorted.length * 0.2), sorted.length - 1)];
    return Math.max(page.width * 0.28, Math.min(page.width * 0.68, sample - 20));
  }
  return page.width * 0.43;
}

function looksLikeTrackingCode(value: string) {
  const text = cleanSpaces(value);
  if (!text || /\s/.test(text)) return false;
  const compact = text.replace(/-/g, "");
  const digitCount = (compact.match(/\d/g) ?? []).length;
  const letterCount = (compact.match(/[A-Z]/gi) ?? []).length;
  return compact.length >= 10 && digitCount >= 4 && letterCount >= 2 && /^[A-Z0-9]+$/i.test(compact);
}

function looksLikeAddress(value: string) {
  const text = fold(value);
  if (/\b\d{1,5}\b/.test(text)) return true;
  return /\b(?:AV|AVENIDA|CALLE|PJE|PASAJE|RUTA|CAMINO|BARRIO|B°|MANZANA|MZA|LOTE|KM|S\/N|SN)\b/.test(text);
}

function sanitizeBlock(lines: string[]) {
  return lines
    .map((line) => cleanSpaces(line))
    .filter(Boolean)
    .filter((line) => !isPureNoise(line) && !isHeaderOrFooter(line))
    .filter((line) => !/^(?:SERVICIO|ENTREGA|CONTRAREEMBOLSO|MERCADO\s+PAGO|OBS\s*\d*|CONTACTO)\b/i.test(line))
    .map((line) => line.replace(/^DESTINATARIO\s*:?\s*/i, "").replace(/^DOMICILIO\s*:?\s*/i, "").trim())
    .filter(Boolean);
}

function parseBlock(blockLines: string[]) {
  let cleaned = sanitizeBlock(blockLines);
  if (!cleaned.length) return null;

  // Keep the part closest to the locality marker. Long headers/codes usually sit farther above.
  if (cleaned.length > 8) cleaned = cleaned.slice(-8);
  cleaned = cleaned.filter((line) => !looksLikeTrackingCode(line));
  if (cleaned.length < 2) return null;

  let addressIndex = -1;
  for (let index = cleaned.length - 1; index >= 0; index--) {
    if (looksLikeAddress(cleaned[index])) {
      addressIndex = index;
      break;
    }
  }
  if (addressIndex < 0) addressIndex = cleaned.length - 1;

  let nameIndex = addressIndex - 1;
  while (nameIndex >= 0 && (looksLikeTrackingCode(cleaned[nameIndex]) || isPureNoise(cleaned[nameIndex]))) nameIndex--;
  if (nameIndex < 0) return null;

  const name = cleanName(cleaned[nameIndex]);
  const address = cleanAddress(cleaned.slice(addressIndex).join(" "));
  if (!name || !address || isHeaderOrFooter(name) || isHeaderOrFooter(address)) return null;
  return { name, address };
}

function leftSource(page: PageData, startX: number, topY: number, bottomY: number) {
  const left = page.items.filter((item) => item.x < startX && item.y <= topY + 5 && item.y >= bottomY - 5);
  const code = left.map((item) => item.text).find(looksLikeTrackingCode);
  const standaloneNumber = left
    .map((item) => item.text.trim())
    .find((value) => /^\d{1,3}$/.test(value));
  return { code, packageNo: standaloneNumber ? Number(standaloneNumber) : undefined };
}

function parseDestinationGeometry(page: PageData) {
  const startX = destinationStart(page);
  const destinationItems = page.items.filter((item) => item.x >= startX);
  const lines = buildLines(destinationItems);
  const markers = lines.map((line, index) => ({ index, line, location: locationFromText(line.text) })).filter((entry) => entry.location);
  const rows: ManifestRow[] = [];

  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const marker = markers[markerIndex];
    const previousMarkerLineIndex = markerIndex > 0 ? markers[markerIndex - 1].index : -1;
    const block = lines.slice(previousMarkerLineIndex + 1, marker.index).map((line) => line.text);
    const parsed = parseBlock(block);
    if (!parsed || !marker.location) continue;

    const topY = lines[previousMarkerLineIndex + 1]?.y ?? marker.line.y + 75;
    const bottomY = marker.line.y;
    const source = leftSource(page, startX, topY, bottomY);
    rows.push({
      packageNo: source.packageNo ?? rows.length + 1,
      name: parsed.name,
      address: parsed.address,
      locality: marker.location.locality,
      postalCode: marker.location.postalCode,
      locationKey: marker.location.locationKey,
      sourceCode: source.code,
    });
  }

  return { rows, lines: lines.length, markers: markers.length };
}

function parseSequentialFallback(page: PageData) {
  const lines = page.sequentialLines.map(cleanSpaces).filter(Boolean);
  const markers = lines.map((line, index) => ({ index, line, location: locationFromText(line) })).filter((entry) => entry.location);
  const rows: ManifestRow[] = [];

  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const marker = markers[markerIndex];
    const previousIndex = markerIndex > 0 ? markers[markerIndex - 1].index : Math.max(-1, marker.index - 10);
    const block = lines.slice(previousIndex + 1, marker.index);
    const parsed = parseBlock(block);
    if (!parsed || !marker.location) continue;
    const sourceCode = [...block].reverse().find(looksLikeTrackingCode);
    rows.push({
      packageNo: rows.length + 1,
      name: parsed.name,
      address: parsed.address,
      locality: marker.location.locality,
      postalCode: marker.location.postalCode,
      locationKey: marker.location.locationKey,
      sourceCode,
    });
  }
  return { rows, markers: markers.length };
}

function uniqueRows(rows: ManifestRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${fold(row.name)}|${fold(row.address)}|${row.postalCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row, index) => ({ ...row, packageNo: row.packageNo || index + 1 }));
}

export async function parseManifestPdf(file: File): Promise<ManifestParseResult> {
  const importExternal = new Function("url", "return import(url)") as (url: string) => Promise<any>;
  const pdfjs: any = await importExternal("https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@5.4.149/build/pdf.worker.min.mjs";

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data }).promise;
  const pages: PageData[] = [];
  const allText: string[] = [];
  let order = 0;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent({ disableNormalization: false });
    const items: Item[] = [];
    const sequentialLines: string[] = [];
    let currentLine: string[] = [];

    for (const raw of content.items) {
      if (!raw?.str) continue;
      const text = cleanSpaces(raw.str);
      if (!text) continue;
      const x = Number(raw.transform?.[4] ?? 0);
      const y = Number(raw.transform?.[5] ?? 0);
      items.push({
        text,
        x,
        y,
        width: Number(raw.width ?? 0),
        height: Number(raw.height ?? 0),
        eol: Boolean(raw.hasEOL),
        order: order++,
      });
      allText.push(text);
      currentLine.push(text);
      if (raw.hasEOL) {
        sequentialLines.push(cleanSpaces(currentLine.join(" ")));
        currentLine = [];
      }
    }
    if (currentLine.length) sequentialLines.push(cleanSpaces(currentLine.join(" ")));
    pages.push({ items, width: viewport.width, height: viewport.height, sequentialLines });
  }

  const joined = allText.join(" ");
  const manifestNumber = joined.match(/N[°º]?\s*Manifiesto\s*:?\s*(\d{8,})/i)?.[1] ?? joined.match(/\b(\d{12})\b/)?.[1];
  const date = joined.match(/FECHA\s+MANIFIESTO\s*:?\s*(\d{2}[-/]\d{2}[-/]\d{4})/i)?.[1];
  const expectedCount = Number(joined.match(/Cantidad\s+de\s+envios\s*:?\s*(\d+)/i)?.[1] ?? joined.match(/Cantidad\s+de\s+env[ií]os\s*:?\s*(\d+)/i)?.[1] ?? 0) || undefined;

  let rows: ManifestRow[] = [];
  let destinationLines = 0;
  let localityMarkers = 0;
  let strategy = "geometry";

  for (const page of pages) {
    const parsed = parseDestinationGeometry(page);
    destinationLines += parsed.lines;
    localityMarkers += parsed.markers;
    rows.push(...parsed.rows);
  }
  rows = uniqueRows(rows);

  if (!rows.length || (expectedCount && rows.length < Math.max(1, Math.floor(expectedCount * 0.45)))) {
    const sequential: ManifestRow[] = [];
    let sequentialMarkers = 0;
    for (const page of pages) {
      const parsed = parseSequentialFallback(page);
      sequentialMarkers += parsed.markers;
      sequential.push(...parsed.rows);
    }
    const fallbackRows = uniqueRows(sequential);
    if (fallbackRows.length > rows.length) {
      rows = fallbackRows;
      localityMarkers = Math.max(localityMarkers, sequentialMarkers);
      strategy = "sequential-fallback";
    }
  }

  rows = rows.map((row, index) => ({ ...row, packageNo: Number.isFinite(row.packageNo) && row.packageNo > 0 ? row.packageNo : index + 1 }));

  const warnings: string[] = [];
  if (expectedCount && rows.length !== expectedCount) warnings.push(`El manifiesto indica ${expectedCount} envíos y se pudieron leer ${rows.length}.`);
  if (!rows.length) {
    if (allText.length < 30) warnings.push("El PDF casi no contiene texto seleccionable. Para mantener el PDF sin OCR, necesitás un PDF con capa de texto.");
    else warnings.push("El PDF tiene texto, pero no se pudieron reconstruir las filas de destinatarios. Se detectó la cabecera pero no una estructura de nombre/dirección/localidad utilizable.");
  }

  return {
    manifestNumber,
    date,
    expectedCount,
    rows,
    warnings,
    diagnostics: {
      pages: pages.length,
      textItems: allText.length,
      destinationLines,
      localityMarkers,
      strategy,
    },
  };
}
