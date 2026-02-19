interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface GoogleRpcQuotaViolation {
  quotaId?: string;
  description?: string;
}

interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: GoogleRpcQuotaViolation[];
}

interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

export interface QuotaContext {
  terminal: boolean;
  retryDelayMs?: number;
}

const CLOUDCODE_DOMAINS = new Set([
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
]);

/**
 * Parses Code Assist 429 payload details to determine terminal vs retryable quota states.
 *
 * This mirrors Gemini CLI behavior so we:
 * - fail fast on hard quota exhaustion (`QUOTA_EXHAUSTED`, daily limits)
 * - keep retrying on short-window limits (`RATE_LIMIT_EXCEEDED`, per-minute limits)
 */
export async function classifyQuotaResponse(response: Response): Promise<QuotaContext | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  const retryDelayMs =
    (retryInfo?.retryDelay ? parseRetryDelayValue(retryInfo.retryDelay) : null) ??
    parseRetryDelayFromMessage(payload.message ?? "") ??
    undefined;

  const errorInfo = details.find(
    (detail): detail is GoogleRpcErrorInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );

  if (errorInfo?.domain && !CLOUDCODE_DOMAINS.has(errorInfo.domain)) {
    return null;
  }
  if (errorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { terminal: true, retryDelayMs };
  }
  if (errorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return { terminal: false, retryDelayMs: retryDelayMs ?? 10_000 };
  }

  const quotaFailure = details.find(
    (detail): detail is GoogleRpcQuotaFailure =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure",
  );
  if (quotaFailure?.violations?.length) {
    const allTexts = quotaFailure.violations
      .flatMap((violation) => [violation.quotaId ?? "", violation.description ?? ""])
      .join(" ")
      .toLowerCase();

    if (allTexts.includes("perday") || allTexts.includes("daily") || allTexts.includes("per day")) {
      return { terminal: true, retryDelayMs };
    }
    if (allTexts.includes("perminute") || allTexts.includes("per minute")) {
      return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000 };
    }
    return { terminal: false, retryDelayMs };
  }

  const quotaLimit = errorInfo?.metadata?.quota_limit?.toLowerCase() ?? "";
  if (quotaLimit.includes("perminute") || quotaLimit.includes("per minute")) {
    return { terminal: false, retryDelayMs: retryDelayMs ?? 60_000 };
  }

  return { terminal: false, retryDelayMs };
}

/**
 * Extracts RetryInfo delay hints directly from error payloads.
 *
 * We keep this as a shared utility for retry scheduling so request-level behavior
 * and quota-classified behavior derive from the same delay parser.
 */
export async function parseRetryDelayFromBody(response: Response): Promise<number | null> {
  const payload = await parseErrorBody(response);
  if (!payload) {
    return null;
  }

  const details = Array.isArray(payload.details) ? payload.details : [];
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      isObject(detail) &&
      detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );
  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }

  if (typeof payload.message === "string") {
    return parseRetryDelayFromMessage(payload.message);
  }
  return null;
}

function parseRetryDelayValue(value: string | { seconds?: number; nanos?: number }): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const milliseconds = Number(trimmed.slice(0, -2));
      return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.round(milliseconds) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (!match?.[1]) {
      return null;
    }
    const seconds = Number(match[1]);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  }

  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1000 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}

function parseRetryDelayFromMessage(message: string): number | null {
  const retryMatch = message.match(/Please retry in ([0-9.]+(?:ms|s))/i);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }

  const afterMatch = message.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (afterMatch?.[1]) {
    return parseRetryDelayValue(afterMatch[1]);
  }

  return null;
}

async function parseErrorBody(
  response: Response,
): Promise<{ message?: string; details?: unknown[] } | null> {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }
  if (!text) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isObject(parsed) || !isObject(parsed.error)) {
    return null;
  }
  return {
    message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
    details: Array.isArray(parsed.error.details) ? parsed.error.details : undefined,
  };
}

function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object";
}

export const retryInternals = {
  parseRetryDelayValue,
  parseRetryDelayFromMessage,
};
