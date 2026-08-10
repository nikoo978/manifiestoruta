import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ScanResult } from "./manifest";

let client: SupabaseClient | null = null;

function adminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  client ??= createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function persistResult(result: Omit<ScanResult, "persisted">, mode: "fast" | "maximum") {
  const supabase = adminClient();
  if (!supabase) return false;
  const { error } = await supabase.from("ocr_scans").insert({
    manifest_number: result.manifestNumber,
    page_count: result.pages,
    mode,
    result,
  });
  if (error) {
    console.error("[supabase] persist failed", { code: error.code, message: error.message });
    return false;
  }
  return true;
}
