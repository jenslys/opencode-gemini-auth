import {
  CODE_ASSIST_HEADERS,
  GEMINI_CODE_ASSIST_ENDPOINT,
} from "../constants";
import { logGeminiDebugResponse, type GeminiDebugContext } from "./debug";

const STREAM_ACTION = "streamGenerateContent";
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
};

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
): { request: RequestInfo; init: RequestInit; streaming: boolean } {
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
  };
}

export async function transformGeminiResponse(
  response: Response,
  streaming: boolean,
  debugContext?: GeminiDebugContext | null,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!streaming && !contentType.includes("application/json")) {
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

    if (streaming) {
      return new Response(transformStreamingPayload(text), init);
    }

    const parsed = JSON.parse(text) as { response?: unknown };
    if (parsed.response !== undefined) {
      return new Response(JSON.stringify(parsed.response), init);
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
