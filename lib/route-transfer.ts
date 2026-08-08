import { inferLocation } from "@/lib/supported-locations";

export const ROUTE_TRANSFER_KEY = "manifiesto-ocr:route-transfer:v1";

export type RouteTransferRow = {
  sourceRowId: string;
  packageNo: number;
  shipmentCode: string;
  recipient: string;
  address: string;
  locality: string;
  postalCode: string;
  locationKey: string;
};

export type RouteTransferPayload = {
  version: 1;
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
    version: 1,
    manifestNumber: result.manifestNumber,
    createdAt: new Date().toISOString(),
    rows: result.rows.map((row) => ({
      sourceRowId: `${row.page}:${row.rowNumber}:${row.barcode || `${row.name}|${row.address}`}`,
      packageNo: row.rowNumber,
      shipmentCode: row.barcode,
      recipient: row.name,
      address: row.address,
      locality: row.locality,
      postalCode: row.postalCode,
      locationKey: inferLocation(row.locality, row.postalCode).key,
    })),
  };
}

export function isRouteTransferPayload(value: unknown): value is RouteTransferPayload {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RouteTransferPayload>;
  return candidate.version === 1 && typeof candidate.manifestNumber === "string" && Array.isArray(candidate.rows);
}
