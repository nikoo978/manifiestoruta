import { inferLocation } from "@/lib/supported-locations";

export const ROUTE_TRANSFER_KEY = "manifiesto-ocr:route-transfer:v2";
export const LEGACY_ROUTE_TRANSFER_KEY = "manifiesto-ocr:route-transfer:v1";

export type RouteTransferRow = {
  sourceRowId: string;
  packageNo: number;
  name: string;
  address: string;
  locality: string;
  postalCode: string;
  locationKey: string;
};

export type RouteTransferPayload = {
  version: 2;
  manifestNumber: string;
  createdAt: string;
  rows: RouteTransferRow[];
};

type TransferableScanResult = {
  manifestNumber: string;
  rows: Array<{
    id: string;
    page: number;
    rowNumber: number;
    barcode: string;
    name: string;
    address: string;
    locality: string;
    postalCode: string;
  }>;
};

export function buildRouteTransfer(result: TransferableScanResult): RouteTransferPayload {
  return {
    version: 2,
    manifestNumber: result.manifestNumber,
    createdAt: new Date().toISOString(),
    rows: result.rows.map((row) => ({
      sourceRowId: `${row.page}:${row.rowNumber}:${row.barcode || `${row.name}|${row.address}`}`,
      packageNo: row.rowNumber,
      name: row.name,
      address: row.address,
      locality: row.locality,
      postalCode: row.postalCode,
      locationKey: inferLocation(row.locality, row.postalCode).key,
    })),
  };
}

export function normalizeRouteTransferPayload(value: unknown): RouteTransferPayload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.rows)) return null;
  if (candidate.version !== 1 && candidate.version !== 2) return null;

  const rows = candidate.rows.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const locality = String(row.locality ?? "").trim();
    const postalCode = String(row.postalCode ?? "").trim();
    const inferred = inferLocation(locality, postalCode);
    return [{
      sourceRowId: String(row.sourceRowId ?? `legacy:${index + 1}`),
      packageNo: Number(row.packageNo ?? index + 1) || index + 1,
      name: String(row.name ?? row.recipient ?? "").trim(),
      address: String(row.address ?? "").trim(),
      locality: locality || inferred.label,
      postalCode: postalCode || inferred.postalCode,
      locationKey: String(row.locationKey ?? inferred.key),
    }];
  }).filter((row) => row.address);

  return {
    version: 2,
    manifestNumber: String(candidate.manifestNumber ?? ""),
    createdAt: String(candidate.createdAt ?? new Date().toISOString()),
    rows,
  };
}

export function isRouteTransferPayload(value: unknown): value is RouteTransferPayload {
  return normalizeRouteTransferPayload(value) !== null;
}
