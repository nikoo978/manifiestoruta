import { APICallError, NoObjectGeneratedError } from "ai";
import { runOcr } from "../../../lib/ocr";
import { persistResult } from "../../../lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const started = Date.now();
  try {
    const hasGoogleKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY);
    const hasGatewayAuth = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
    if (!hasGoogleKey && !hasGatewayAuth) {
      return Response.json({ error: "Falta configurar GOOGLE_GENERATIVE_AI_API_KEY para activar la lectura OCR gratuita." }, { status: 503 });
    }

    if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
      return Response.json({ error: "La solicitud debe enviar imágenes como formulario multipart." }, { status: 415 });
    }

    const form = await request.formData();
    const files = form.getAll("images").filter((entry): entry is File => entry instanceof File);
    if (!files.length || files.length > 8) return Response.json({ error: "Adjuntá entre 1 y 8 imágenes." }, { status: 400 });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > 24 * 1024 * 1024) return Response.json({ error: "Las imágenes superan el máximo total de 24 MB." }, { status: 413 });
    if (files.some(file => !["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(file.type))) {
      return Response.json({ error: "Formato de imagen no admitido." }, { status: 415 });
    }

    const images = await Promise.all(files.map(async file => ({
      bytes: new Uint8Array(await file.arrayBuffer()),
      type: file.type,
      name: file.name,
    })));
    const mode = form.get("mode") === "fast" ? "fast" : "maximum";
    console.info("[api/scan] request accepted", { mode, pages: images.length, totalBytes: total });
    const result = await runOcr(images, mode);
    const persisted = await persistResult(result, mode);
    console.info("[api/scan] request complete", { mode, pages: images.length, rows: result.rows.length, persisted, durationMs: Date.now() - started });
    return Response.json({ ...result, persisted });
  } catch (error) {
    const details = {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      statusCode: APICallError.isInstance(error) ? error.statusCode : undefined,
      responseBody: APICallError.isInstance(error) ? error.responseBody : undefined,
      generatedText: NoObjectGeneratedError.isInstance(error) ? error.text?.slice(0, 500) : undefined,
      durationMs: Date.now() - started,
    };
    console.error("[api/scan] OCR failed", details);

    if (details.message.includes("valid credit card on file")) {
      return Response.json({
        error: "Vercel bloqueó AI Gateway porque no hay una tarjeta asociada. Configurá GOOGLE_GENERATIVE_AI_API_KEY con una clave gratuita de Google AI Studio.",
        code: "GATEWAY_CARD_REQUIRED",
      }, { status: 503 });
    }
    if (APICallError.isInstance(error)) {
      if (error.statusCode === 401 || error.statusCode === 403) return Response.json({ error: "La clave del motor OCR no es válida.", code: "AI_AUTH" }, { status: 502 });
      if (error.statusCode === 402) return Response.json({ error: "El motor OCR no tiene crédito disponible.", code: "AI_CREDIT" }, { status: 502 });
      if (error.statusCode === 429) return Response.json({ error: "Se alcanzó temporalmente el límite gratuito. Volvé a intentar en un minuto.", code: "AI_RATE_LIMIT" }, { status: 429 });
      return Response.json({ error: "El motor OCR rechazó la solicitud.", code: "AI_PROVIDER" }, { status: 502 });
    }
    if (NoObjectGeneratedError.isInstance(error)) {
      return Response.json({ error: "El OCR leyó la imagen, pero no pudo convertir todas las filas al formato esperado.", code: "AI_FORMAT" }, { status: 502 });
    }
    return Response.json({ error: "Ocurrió un error interno al procesar el documento.", code: "INTERNAL" }, { status: 500 });
  }
}
