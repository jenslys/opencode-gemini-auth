import { randomUUID } from "node:crypto";

import { CODE_ASSIST_HEADERS, GEMINI_CODE_ASSIST_ENDPOINT } from "../../constants";
import { normalizeThinkingConfig } from "../request-helpers";
import { normalizeRequestPayloadIdentifiers, normalizeWrappedIdentifiers } from "./identifiers";
import { addThoughtSignaturesToFunctionCalls, transformOpenAIToolCalls } from "./openai";
import { isGenerativeLanguageRequest, toRequestUrlString } from "./shared";

const STREAM_ACTION = "streamGenerateContent";
const MODEL_FALLBACKS: Record<string, string> = {
  "gemini-2.5-flash-image": "gemini-2.5-flash",
  "gemini-3.1-pro-preview": "gemini-3-pro-preview",
  "gemini-3.1-flash-preview": "gemini-3-flash-preview",
  "gemini-3.1-pro-preview-customtools": "gemini-3-pro-preview",
};

/**
 * Rewrites OpenAI-style requests into Gemini Code Assist request shape.
 */
export function prepareGeminiRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  accessToken: string,
  projectId: string,
): {
  request: RequestInfo;
  init: RequestInit;
  streaming: boolean;
  requestedModel?: string;
} {
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

  const match = toRequestUrlString(input).match(/\/models\/([^:]+):(\w+)/);
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
  let requestIdentifier: string = randomUUID();

  if (typeof baseInit.body === "string" && baseInit.body) {
    const transformed = transformRequestBody(baseInit.body, projectId, effectiveModel);
    if (transformed.body) {
      body = transformed.body;
      requestIdentifier = transformed.userPromptId;
    }
  }

  if (streaming) {
    headers.set("Accept", "text/event-stream");
  }

  headers.set("User-Agent", CODE_ASSIST_HEADERS["User-Agent"]);
  headers.set("X-Goog-Api-Client", CODE_ASSIST_HEADERS["X-Goog-Api-Client"]);
  headers.set("Client-Metadata", CODE_ASSIST_HEADERS["Client-Metadata"]);
  /**
   * Request-scoped identifier used by Gemini CLI tooling and backend traces.
   * We keep this aligned so quota/debug triage can correlate client and server events.
   */
  headers.set("x-activity-request-id", requestIdentifier);

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

function transformRequestBody(
  body: string,
  projectId: string,
  effectiveModel: string,
): { body?: string; userPromptId: string } {
  const fallbackId = randomUUID();
  try {
    const parsedBody = JSON.parse(body) as Record<string, unknown>;
    const isWrapped = typeof parsedBody.project === "string" && "request" in parsedBody;

    if (isWrapped) {
      const wrappedBody = {
        ...parsedBody,
        model: effectiveModel,
      } as Record<string, unknown>;
      const { userPromptId } = normalizeWrappedIdentifiers(wrappedBody);
      return { body: JSON.stringify(wrappedBody), userPromptId };
    }

    const requestPayload = { ...parsedBody };
    transformOpenAIToolCalls(requestPayload);
    addThoughtSignaturesToFunctionCalls(requestPayload);
    normalizeThinking(requestPayload);
    normalizeSystemInstruction(requestPayload);
    normalizeCachedContent(requestPayload);

    if ("model" in requestPayload) {
      delete requestPayload.model;
    }

    const { userPromptId } = normalizeRequestPayloadIdentifiers(requestPayload);
    const wrappedBody = {
      project: projectId,
      model: effectiveModel,
      user_prompt_id: userPromptId,
      request: requestPayload,
    };

    return { body: JSON.stringify(wrappedBody), userPromptId };
  } catch (error) {
    console.error("Failed to transform Gemini request body:", error);
    return { userPromptId: fallbackId };
  }
}

function normalizeThinking(requestPayload: Record<string, unknown>): void {
  const rawGenerationConfig = requestPayload.generationConfig as Record<string, unknown> | undefined;
  const normalizedThinking = normalizeThinkingConfig(rawGenerationConfig?.thinkingConfig);
  if (normalizedThinking) {
    if (rawGenerationConfig) {
      rawGenerationConfig.thinkingConfig = normalizedThinking;
      requestPayload.generationConfig = rawGenerationConfig;
    } else {
      requestPayload.generationConfig = { thinkingConfig: normalizedThinking };
    }
    return;
  }

  if (rawGenerationConfig?.thinkingConfig) {
    delete rawGenerationConfig.thinkingConfig;
    requestPayload.generationConfig = rawGenerationConfig;
  }
}

function normalizeSystemInstruction(requestPayload: Record<string, unknown>): void {
  if ("system_instruction" in requestPayload) {
    requestPayload.systemInstruction = requestPayload.system_instruction;
    delete requestPayload.system_instruction;
  }
}

function normalizeCachedContent(requestPayload: Record<string, unknown>): void {
  const extraBody =
    requestPayload.extra_body && typeof requestPayload.extra_body === "object"
      ? (requestPayload.extra_body as Record<string, unknown>)
      : undefined;
  const cachedContentFromExtra = extraBody?.cached_content ?? extraBody?.cachedContent;
  const cachedContent =
    (requestPayload.cached_content as string | undefined) ??
    (requestPayload.cachedContent as string | undefined) ??
    (cachedContentFromExtra as string | undefined);

  if (cachedContent) {
    requestPayload.cachedContent = cachedContent;
  }

  delete requestPayload.cached_content;
  if (!extraBody) {
    return;
  }

  delete extraBody.cached_content;
  delete extraBody.cachedContent;
  if (Object.keys(extraBody).length === 0) {
    delete requestPayload.extra_body;
  }
}
