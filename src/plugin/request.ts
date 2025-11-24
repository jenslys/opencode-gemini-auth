import { CODE_ASSIST_HEADERS, GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import { logGeminiDebugResponse, type GeminiDebugContext } from "./debug";
import {
  extractUsageFromSsePayload,
  extractUsageMetadata,
  normalizeThinkingConfig,
  parseGeminiApiBody,
  rewriteGeminiPreviewAccessError,
  type GeminiApiBody,
  type GeminiUsageMetadata,
} from "./request-helpers";

const STREAM_ACTION = "streamGenerateContent";
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};
/**
 * Detects Gemini/Generative Language API requests by URL.
 * @param input Request target passed to fetch.
 * @returns True when the URL targets generativelanguage.googleapis.com.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return typeof input === "string" && input.includes("generativelanguage.googleapis.com");
}

/**
 * Rewrites SSE payloads so downstream consumers see only the inner `response` objects.
 */
function transformStreamingPayload(payload: string): string {
  return payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) {
        return line;
      }
      const json = line.slice(5).trim();
      if (!json) {
        return line;
      }
      try {
        const parsed = JSON.parse(json) as { response?: unknown };
        if (parsed.response !== undefined) {
          return `data: ${JSON.stringify(parsed.response)}`;
        }
      } catch (_) {}
      return line;
    })
    .join("\n");
}

/**
 * Rewrites OpenAI-style requests into Gemini Code Assist shape, normalizing model, headers,
 * optional cached_content, and thinking config. Also toggles streaming mode for SSE actions.
 */
export function prepareGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
): { request: RequestInfo; init: RequestInit; streaming: boolean; requestedModel?: string } {
  const baseInit: RequestInit = { ...init };
  const headers = new Headers(init?.headers ?? {});

  if (!isGenerativeLanguageRequest(input)) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.delete("x-api-key");

  const match = input.match(/\/models\/([^:]+):(\w+)/);
  if (!match) {
    return {
      request: input,
      init: { ...baseInit, headers },
      streaming: false,
    };
  }

  const [, rawModel = "", rawAction = ""] = match;
  const effectiveModel = MODEL_FALLBACKS[rawModel] ?? rawModel;
  const streaming = rawAction === STREAM_ACTION;
  const transformedUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:${rawAction}${
    streaming ? "?alt=sse" : ""
  }`;

  let body = baseInit.body;
  if (typeof baseInit.body === "string" && baseInit.body) {
    try {
      const parsedBody = JSON.parse(baseInit.body) as Record<string, unknown>;
      const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

      if (isWrapped) {
        const wrappedBody = {
          ...parsedBody,
          model: effectiveModel,
        } as Record<string, unknown>;
        body = JSON.stringify(wrappedBody);
      } else {
        const requestPayload: Record<string, unknown> = { ...parsedBody };

        const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
        const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
        if (normalizedThinking) {
          if (rawGenerationConfig) {
            rawGenerationConfig.thinkingConfig = normalizedThinking;
            requestPayload.generationConfig = rawGenerationConfig;
          } else {
            requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
          }
        } else if (rawGenerationConfig?.thinkingConfig) {
          delete rawGenerationConfig.thinkingConfig;
          requestPayload.generationConfig = rawGenerationConfig;
        }

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
        }

        const cachedContentFromExtra =
          typeof requestPayload.extra_body === "object" && requestPayload.extra_body
            ? (requestPayload.extra_body as Record<string, unknown>).cached_content ??
              (requestPayload.extra_body as Record<string, unknown>).cachedContent
            : undefined;
        const cachedContent =
          (requestPayload.cached_content as string | undefined) ??
          (requestPayload.cachedContent as string | undefined) ??
          (cachedContentFromExtra as string | undefined);
        if (cachedContent) {
          requestPayload.cachedContent = cachedContent;
        }

        delete requestPayload.cached_content;
        delete requestPayload.cachedContent;
        if (requestPayload.extra_body && typeof requestPayload.extra_body === "object") {
          delete (requestPayload.extra_body as Record<string, unknown>).cached_content;
          delete (requestPayload.extra_body as Record<string, unknown>).cachedContent;
          if (Object.keys(requestPayload.extra_body as Record<string, unknown>).length === 0) {
            delete requestPayload.extra_body;
          }
        }

        if ("model" in requestPayload) {
          delete requestPayload.model;
        }

        const wrappedBody = {
          project: projectId,
          model: effectiveModel,
          request: requestPayload,
        };

        body = JSON.stringify(wrappedBody);
      }
    } catch (error) {
      console.error("Failed to transform Gemini request body:", error);
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  headers.set("User-Agent", CODE_ASSIST_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", CODE_ASSIST_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", CODE_ASSIST_HEADERS["Client-Metadata"]);

  return {
    request: transformedUrl,
    init: {
      ...baseInit,
      headers,
      body,
    },
    streaming,
    requestedModel: rawModel,
  };
}

/**
 * Normalizes Gemini responses: applies retry headers, extracts cache usage into headers,
 * rewrites preview errors, flattens streaming payloads, and logs debug metadata.
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
    const text = await response.text();
    const headers = new Headers(response.headers);
    
    if (!response.ok && text) {
      try {
        const errorBody = JSON.parse(text);
        if (errorBody?.error?.details && Array.isArray(errorBody.error.details)) {
          const retryInfo = errorBody.error.details.find(
            (detail: any) => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
          );
          
          if (retryInfo?.retryDelay) {
            const match = retryInfo.retryDelay.match(/^([\d.]+)s$/);
            if (match && match[1]) {
              const retrySeconds = parseFloat(match[1]);
              if (!isNaN(retrySeconds) && retrySeconds > 0) {
                const retryAfterSec = Math.ceil(retrySeconds).toString();
                const retryAfterMs = Math.ceil(retrySeconds * 1000).toString();
                headers.set('Retry-After', retryAfterSec);
                headers.set('retry-after-ms', retryAfterMs);
              }
            }
          }
        }
      } catch (parseError) {
      }
    }
    
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    const usageFromSse = streaming && isEventStreamResponse ? extractUsageFromSsePayload(text) : null;
    const parsed: GeminiApiBody | null = !streaming || !isEventStreamResponse ? parseGeminiApiBody(text) : null;
    const patched = parsed ? rewriteGeminiPreviewAccessError(parsed, response.status, requestedModel) : null;
    const effectiveBody = patched ?? parsed ?? undefined;

    const usage = usageFromSse ?? (effectiveBody ? extractUsageMetadata(effectiveBody) : null);
    if (usage?.cachedContentTokenCount !== undefined) {
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

    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload" : undefined,
      headersOverride: headers,
    });

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text), init);
    }

    if (!parsed) {
      return new Response(text, init);
    }

    if (effectiveBody?.response !== undefined) {
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    if (patched) {
      return new Response(JSON.stringify(patched), init);
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
