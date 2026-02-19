import { logGeminiDebugResponse, type GeminiDebugContext } from "../debug";
import {
  enhanceGeminiErrorResponse,
  extractUsageMetadata,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  type GeminiApiBody,
} from "../request-helpers";
import { injectResponseIdFromTrace } from "./shared";

/**
 * Normalizes Gemini responses, preserving request metadata and usage counters.
 */
export async function transformGeminiResponse(
  response: Response,
  streaming: boolean,
  debugContext?: GeminiDebugContext | null,
  requestedModel?: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  const isJsonResponse = contentType.includes("application/json");
  const isEventStreamResponse = contentType.includes("text/event-stream");

  if (!isJsonResponse && !isEventStreamResponse) {
    logGeminiDebugResponse(debugContext, response, {
      note: "Non-JSON response (body omitted)",
    });
    return response;
  }

  try {
    const headers = new Headers(response.headers);

    if (streaming && response.ok && isEventStreamResponse && response.body) {
      logGeminiDebugResponse(debugContext, response, {
        note: "Streaming SSE payload (body omitted)",
        headersOverride: headers,
      });

      return new Response(transformStreamingPayloadStream(response.body), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    const text = await response.text();
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const parsed: GeminiApiBody | null = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null;
    const enhanced = !response.ok && parsed ? enhanceGeminiErrorResponse(parsed, response.status) : null;
    if (enhanced?.retryAfterMs) {
      const retryAfterSec = Math.ceil(enhanced.retryAfterMs / 1000).toString();
      headers.set("Retry-After", retryAfterSec);
      headers.set("retry-after-ms", String(enhanced.retryAfterMs));
    }

    const previewPatched = parsed
      ? rewriteGeminiPreviewAccessError(enhanced?.body ?? parsed, response.status, requestedModel)
      : null;

    const effectiveBodyRaw = previewPatched ?? enhanced?.body ?? parsed ?? undefined;
    const effectiveBody =
      effectiveBodyRaw && typeof effectiveBodyRaw === "object"
        ? injectResponseIdFromTrace(effectiveBodyRaw as Record<string, unknown>)
        : effectiveBodyRaw;

    attachUsageHeaders(headers, effectiveBody);

    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload (buffered)" : undefined,
      headersOverride: headers,
    });

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody && typeof effectiveBody === "object" && "response" in effectiveBody) {
      return new Response(JSON.stringify((effectiveBody as { response: unknown }).response), init);
    }
    if (previewPatched) {
      return new Response(JSON.stringify(previewPatched), init);
    }

    return new Response(text, init);
  } catch (error) {
    logGeminiDebugResponse(debugContext, response, {
      error,
      note: "Failed to transform Gemini response",
    });
    console.error("Failed to transform Gemini response:", error);
    return response;
  }
}

function attachUsageHeaders(headers: Headers, effectiveBody: unknown): void {
  if (!effectiveBody || typeof effectiveBody !== "object") {
    return;
  }
  const usage = extractUsageMetadata(effectiveBody as GeminiApiBody);
  if (usage?.cachedContentTokenCount === undefined) {
    return;
  }

  headers.set("x-gemini-cached-content-token-count", String(usage.cachedContentTokenCount));
  if (usage.totalTokenCount !== undefined) {
    headers.set("x-gemini-total-token-count", String(usage.totalTokenCount));
  }
  if (usage.promptTokenCount !== undefined) {
    headers.set("x-gemini-prompt-token-count", String(usage.promptTokenCount));
  }
  if (usage.candidatesTokenCount !== undefined) {
    headers.set("x-gemini-candidates-token-count", String(usage.candidatesTokenCount));
  }
}

function transformStreamingPayloadStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = stream.getReader();
      const pump = (): void => {
        reader!
          .read()
          .then(({ done, value }) => {
            if (done) {
              buffer += decoder.decode();
              if (buffer.length > 0) {
                controller.enqueue(encoder.encode(transformStreamingLine(buffer)));
              }
              controller.close();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            let newlineIndex = buffer.indexOf("\n");
            while (newlineIndex !== -1) {
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              const hasCr = line.endsWith("\r");
              const rawLine = hasCr ? line.slice(0, -1) : line;
              const transformed = transformStreamingLine(rawLine);
              controller.enqueue(encoder.encode(`${transformed}${hasCr ? "\r\n" : "\n"}`));
              newlineIndex = buffer.indexOf("\n");
            }
            pump();
          })
          .catch((error) => {
            controller.error(error);
          });
      };
      pump();
    },
    cancel(reason) {
      if (reader) {
        reader.cancel(reason).catch(() => {});
      }
    },
  });
}

function transformStreamingLine(line: string): string {
  if (!line.startsWith("data:")) {
    return line;
  }
  const json = line.slice(5).trim();
  if (!json) {
    return line;
  }

  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const patched = injectResponseIdFromTrace(parsed);
    if (patched.response !== undefined) {
      return `data: ${JSON.stringify(patched.response)}`;
    }
  } catch {
    return line;
  }
  return line;
}
