import {
  CODE_ASSIST_HEADERS,
  GEMINI_CODE_ASSIST_ENDPOINT,
} from "../constants";
import { logGeminiDebugResponse, type GeminiDebugContext } from "./debug";

const STREAM_ACTION = "streamGenerateContent";
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};
const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";

interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return typeof input === "string" && input.includes("generativelanguage.googleapis.com");
}

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

        if ("system_instruction" in requestPayload) {
          requestPayload.systemInstruction = requestPayload.system_instruction;
          delete requestPayload.system_instruction;
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
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers,
    };

    logGeminiDebugResponse(debugContext, response, {
      body: text,
      note: streaming ? "Streaming SSE payload" : undefined,
    });

    if (streaming && response.ok && isEventStreamResponse) {
      return new Response(transformStreamingPayload(text), init);
    }

    const parsed = parseGeminiApiBody(text);
    if (!parsed) {
      return new Response(text, init);
    }

    const patched = rewriteGeminiPreviewAccessError(parsed, response.status, requestedModel);
    const effectiveBody = patched ?? parsed;

    if (effectiveBody.response !== undefined) {
      return new Response(JSON.stringify(effectiveBody.response), init);
    }

    if (patched) {
      return new Response(JSON.stringify(effectiveBody), init);
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

function rewriteGeminiPreviewAccessError(
  body: GeminiApiBody,
  status: number,
  requestedModel?: string,
): GeminiApiBody | null {
  if (!needsPreviewAccessOverride(status, body, requestedModel)) {
    return null;
  }

  const error: GeminiApiError = body.error ?? {};
  const trimmedMessage = typeof error.message === "string" ? error.message.trim() : "";
  const messagePrefix = trimmedMessage.length > 0
    ? trimmedMessage
    : "Gemini 3 preview features are not enabled for this account.";
  const enhancedMessage = `${messagePrefix} Request preview access at ${GEMINI_PREVIEW_LINK} before using Gemini 3 models.`;

  return {
    ...body,
    error: {
      ...error,
      message: enhancedMessage,
    },
  };
}

function needsPreviewAccessOverride(
  status: number,
  body: GeminiApiBody,
  requestedModel?: string,
): boolean {
  if (status !== 404) {
    return false;
  }

  if (isGeminiThreeModel(requestedModel)) {
    return true;
  }

  const errorMessage = typeof body.error?.message === "string" ? body.error.message : "";
  return isGeminiThreeModel(errorMessage);
}

function isGeminiThreeModel(target?: string): boolean {
  if (!target) {
    return false;
  }

  return /gemini[\s-]?3/i.test(target);
}

function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find(function (item: unknown) {
        return typeof item === "object" && item !== null;
      });
      if (firstObject && typeof firstObject === "object") {
        return firstObject as GeminiApiBody;
      }
      return null;
    }

    if (parsed && typeof parsed === "object") {
      return parsed as GeminiApiBody;
    }

    return null;
  } catch {
    return null;
  }
}
