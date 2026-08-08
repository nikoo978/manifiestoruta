import { z } from "zod";

export const importantFieldSchema = z.enum(["rowNumber", "name", "address", "locality", "postalCode", "barcode"]);

export const rawRowSchema = z.object({
  page: z.number().int().min(1),
  rowNumber: z.number().int().min(1).max(999),
  name: z.string(),
  address: z.string(),
  locality: z.string(),
  postalCode: z.string(),
  barcode: z.string(),
  confidence: z.number().min(0).max(100),
  uncertainFields: z.array(importantFieldSchema),
});

export const extractionSchema = z.object({
  manifestNumber: z.string(),
  pages: z.number().int().min(1),
  rows: z.array(rawRowSchema),
});

export type RawExtraction = z.infer<typeof extractionSchema>;
export type RawRow = z.infer<typeof rawRowSchema>;

export type VerifiedRow = Omit<RawRow, "uncertainFields"> & {
  id: string;
  status: "verified" | "review";
  note?: string;
  georefStreetId?: string;
};

export type ScanResult = {
  manifestNumber: string;
  pages: number;
  rows: VerifiedRow[];
  persisted: boolean;
};
