import { APICallError, NoObjectGeneratedError } from "ai";
import { runOcr, type OcrMode, type OcrProgress } from "../../../lib/ocr";
import { persistResult } from "../../../lib/supabase-admin";

export const runtime = "nodejs";
export const maxDuration = 300;

function jsonError(error: string, status: number, code?: string) {
  return Response.json({ error, ...(code ? { code } : {}) }, { status });
}

export async function POST(request: Request) {
  const started = Date.now();
  const hasGoogleKey = Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY);
  const hasGatewayAuth = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  if (!hasGoogleKey && !hasGatewayAuth) {
    return jsonError("Falta configurar GOOGLE_GENERATIVE_AI_API_KEY para activar la lectura OCR gratuita.", 503);
  }

  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return jsonError("La solicitud debe enviar imágenes como formulario multipart.", 415);
  }

  let files: File[] = [];
  let mode: OcrMode = "fast";
  try {
    const form = await request.formData();
    files = form.getAll("images").filter((entry): entry is File => entry instanceof File);
    mode = form.get("mode") === "maximum" || form.get("mode") === "intense" ? "maximum" : "fast";
  } catch {
    return jsonError("No se pudo leer el formulario de imágenes.", 400);
  }

  if (!files.length || files.length > 8) return jsonError("Adjuntá entre 1 y 8 imágenes.", 400);
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (total > 24 * 1024 * 1024) return jsonError("Las imágenes superan el máximo total de 24 MB.", 413);
  if (files.some(file => !["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"].includes(file.type))) {
    return jsonError("Formato de imagen no admitido.", 415);
  }

  const images = await Promise.all(files.map(async file => ({
    bytes: new Uint8Array(await file.arrayBuffer()),
    type: file.type,
    name: file.name,
  })));

  console.info("[api/scan] request accepted", { mode, pages: images.length, totalBytes: total });
  const encoder = new TextEncoder();
  let closed = false;
  let latestProgress: OcrProgress = {
    percent: 2,
    phase: "starting",
    message: mode === "fast" ? "Iniciando análisis rápido…" : "Iniciando análisis intenso…",
    pages: images.length,
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      send({ type: "progress", ...latestProgress, elapsedMs: 0, mode });

      const heartbeat = setInterval(() => {
        send({
          type: "heartbeat",
          percent: latestProgress.percent,
          phase: latestProgress.phase,
          message: latestProgress.message,
          elapsedMs: Date.now() - started,
          mode,
        });
      }, 4000);

      void (async () => {
        try {
          const result = await runOcr(images, mode, (progress) => {
            latestProgress = progress;
            send({ type: "progress", ...progress, elapsedMs: Date.now() - started, mode });
          });
          latestProgress = { percent: 97, phase: "verifying", message: "Guardando resultado…", pages: images.length };
          send({ type: "progress", ...latestProgress, elapsedMs: Date.now() - started, mode });
          const persisted = await persistResult(result, mode);
          console.info("[api/scan] request complete", { mode, pages: images.length, rows: result.rows.length, persisted, durationMs: Date.now() - started });
          send({ type: "result", result: { ...result, persisted }, elapsedMs: Date.now() - started, mode });
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

          let message = "Ocurrió un error interno al procesar el documento.";
          let code = "INTERNAL";
          if (details.message.includes("valid credit card on file")) {
            message = "Vercel bloqueó AI Gateway porque no hay una tarjeta asociada. Configurá GOOGLE_GENERATIVE_AI_API_KEY con una clave gratuita de Google AI Studio.";
            code = "GATEWAY_CARD_REQUIRED";
          } else if (APICallError.isInstance(error)) {
            if (error.statusCode === 401 || error.statusCode === 403) { message = "La clave del motor OCR no es válida."; code = "AI_AUTH"; }
            else if (error.statusCode === 402) { message = "El motor OCR no tiene crédito disponible."; code = "AI_CREDIT"; }
            else if (error.statusCode === 429) { message = "Se alcanzó temporalmente el límite del proveedor. Volvé a intentar en un momento."; code = "AI_RATE_LIMIT"; }
            else { message = "El motor OCR rechazó la solicitud."; code = "AI_PROVIDER"; }
          } else if (NoObjectGeneratedError.isInstance(error)) {
            message = "El OCR leyó la imagen, pero no pudo convertir todas las filas al formato esperado.";
            code = "AI_FORMAT";
          }
          send({ type: "error", error: message, code, elapsedMs: Date.now() - started, mode });
        } finally {
          clearInterval(heartbeat);
          closed = true;
          controller.close();
        }
      })();
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
