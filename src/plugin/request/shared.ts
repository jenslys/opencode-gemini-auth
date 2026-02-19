/**
 * Returns a URL string for supported RequestInfo inputs.
 */
export function toRequestUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

/**
 * Detects Gemini/Generative Language API requests by URL.
 */
export function isGenerativeLanguageRequest(input: RequestInfo): input is string {
  return toRequestUrlString(input).includes("generativelanguage.googleapis.com");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

export function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const str = readString(value);
    if (str) {
      return str;
    }
  }
  return undefined;
}

/**
 * Preserves Cloud Code trace identity for downstream clients by mapping traceId -> responseId.
 */
export function injectResponseIdFromTrace<T extends Record<string, unknown>>(body: T): T {
  const traceId = readString(body.traceId);
  if (!traceId) {
    return body;
  }

  const response = body.response;
  if (!isRecord(response)) {
    return body;
  }

  if (readString(response.responseId)) {
    return body;
  }

  return {
    ...body,
    response: {
      ...response,
      responseId: traceId,
    },
  };
}
