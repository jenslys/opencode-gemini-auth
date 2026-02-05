const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";

export interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
  [key: string]: unknown;
}

/**
 * Minimal representation of Gemini API responses we touch.
 */
export interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

interface GoogleRpcHelp {
  "@type"?: string;
  links?: Array<{
    description?: string;
    url?: string;
  }>;
}

interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: Array<{
    subject?: string;
    description?: string;
  }>;
}

interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

const CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
];

export interface GeminiErrorEnhancement {
  body?: GeminiApiBody;
  retryAfterMs?: number;
}

/**
 * Usage metadata exposed by Gemini responses. Fields are optional to reflect partial payloads.
 */
export interface GeminiUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Thinking configuration accepted by Gemini.
 * - Gemini 3 models use thinkingLevel (string: 'low', 'medium', 'high')
 * - Gemini 2.5 models use thinkingBudget (number)
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}

/**
 * Normalizes thinkingConfig - passes through values as-is without mapping.
 * User should use thinkingLevel for Gemini 3 and thinkingBudget for Gemini 2.5.
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel = typeof levelRaw === "string" && levelRaw.length > 0 ? levelRaw.toLowerCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (thinkingBudget === undefined && thinkingLevel === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  if (includeThoughts !== undefined) {
    normalized.includeThoughts = includeThoughts;
  }
  return normalized;
}

/**
 * Parses a Gemini API body; handles array-wrapped responses the API sometimes returns.
 */
export function parseGeminiApiBody(rawText: string): GeminiApiBody | null {
  try {
    const parsed = JSON.parse(rawText);
    if (Array.isArray(parsed)) {
      const firstObject = parsed.find((item: unknown) => typeof item === "object" && item !== null);
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

/**
 * Extracts usageMetadata from a response object, guarding types.
 */
export function extractUsageMetadata(body: GeminiApiBody): GeminiUsageMetadata | null {
  const usage = (body.response && typeof body.response === "object"
    ? (body.response as { usageMetadata?: unknown }).usageMetadata
    : undefined) as GeminiUsageMetadata | undefined;

  if (!usage || typeof usage !== "object") {
    return null;
  }

  const asRecord = usage as Record<string, unknown>;
  const toNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  return {
    totalTokenCount: toNumber(asRecord.totalTokenCount),
    promptTokenCount: toNumber(asRecord.promptTokenCount),
    candidatesTokenCount: toNumber(asRecord.candidatesTokenCount),
    cachedContentTokenCount: toNumber(asRecord.cachedContentTokenCount),
  };
}

/**
 * Enhances 404 errors for Gemini 3 models with a direct preview-access message.
 */
export function rewriteGeminiPreviewAccessError(
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

/**
 * Enhances Gemini error responses with friendly messages and retry hints.
 */
/**
 * Enhances Gemini errors with validation/quota messaging and retry hints.
 * Keeps messaging aligned with Gemini CLI's Cloud Code error handling.
 */
export function enhanceGeminiErrorResponse(
  body: GeminiApiBody,
  status: number,
): GeminiErrorEnhancement | null {
  const error = body.error;
  if (!error) {
    return null;
  }

  const details = Array.isArray(error.details) ? error.details : [];
  const retryAfterMs = extractRetryDelay(details, error.message) ?? undefined;

  if (status === 403) {
    const validationInfo = extractValidationInfo(details);
    if (validationInfo) {
      const message = [
        error.message ?? "Account validation required for Gemini Code Assist.",
        validationInfo.link ? `Complete validation: ${validationInfo.link}` : undefined,
        validationInfo.learnMore ? `Learn more: ${validationInfo.learnMore}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      return {
        body: {
          ...body,
          error: {
            ...error,
            message,
          },
        },
        retryAfterMs,
      };
    }
  }

  if (status === 429) {
    const quotaInfo = extractQuotaInfo(details);
    if (quotaInfo) {
      const message = quotaInfo.retryable
        ? `Rate limit exceeded. ${retryAfterMs ? "Please retry shortly." : "Please retry."}`
        : "Quota exhausted for this account. Please wait for your quota to reset or upgrade your plan.";
      return {
        body: {
          ...body,
          error: {
            ...error,
            message,
          },
        },
        retryAfterMs,
      };
    }
  }

  if (retryAfterMs !== undefined) {
    return { retryAfterMs };
  }

  return null;
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

/**
 * Extracts validation URLs when the backend requires account verification.
 */
function extractValidationInfo(details: unknown[]): { link?: string; learnMore?: string } | null {
  const errorInfo = details.find(
    (detail): detail is GoogleRpcErrorInfo =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as GoogleRpcErrorInfo)["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );

  if (
    !errorInfo ||
    errorInfo.reason !== "VALIDATION_REQUIRED" ||
    !errorInfo.domain ||
    !CLOUDCODE_DOMAINS.includes(errorInfo.domain)
  ) {
    return null;
  }

  const helpDetail = details.find(
    (detail): detail is GoogleRpcHelp =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as GoogleRpcHelp)["@type"] === "type.googleapis.com/google.rpc.Help",
  );

  let link: string | undefined;
  let learnMore: string | undefined;
  if (helpDetail?.links && helpDetail.links.length > 0) {
    link = helpDetail.links[0]?.url;
    const learnMoreLink = helpDetail.links.find((candidate) => {
      if (!candidate?.url) {
        return false;
      }
      if (candidate.description?.toLowerCase().trim() === "learn more") {
        return true;
      }
      try {
        return new URL(candidate.url).hostname === "support.google.com";
      } catch {
        return false;
      }
    });
    learnMore = learnMoreLink?.url;
  }

  if (!link && errorInfo.metadata?.validation_link) {
    link = errorInfo.metadata.validation_link;
  }

  return link || learnMore ? { link, learnMore } : null;
}

/**
 * Classifies quota-related error details as retryable or terminal.
 */
function extractQuotaInfo(details: unknown[]): { retryable: boolean } | null {
  const errorInfo = details.find(
    (detail): detail is GoogleRpcErrorInfo =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as GoogleRpcErrorInfo)["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );

  if (errorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return { retryable: true };
  }
  if (errorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { retryable: false };
  }

  const quotaFailure = details.find(
    (detail): detail is GoogleRpcQuotaFailure =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as GoogleRpcQuotaFailure)["@type"] === "type.googleapis.com/google.rpc.QuotaFailure",
  );

  if (quotaFailure?.violations?.length) {
    const description = quotaFailure.violations
      .map((violation) => violation.description?.toLowerCase() ?? "")
      .join(" ");
    if (description.includes("daily") || description.includes("per day")) {
      return { retryable: false };
    }
    return { retryable: true };
  }

  return null;
}

/**
 * Extracts retry delay hints from structured error details or message text.
 */
function extractRetryDelay(details: unknown[], errorMessage?: string): number | null {
  const retryInfo = details.find(
    (detail): detail is GoogleRpcRetryInfo =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as GoogleRpcRetryInfo)["@type"] === "type.googleapis.com/google.rpc.RetryInfo",
  );

  if (retryInfo?.retryDelay) {
    const delayMs = parseRetryDelayValue(retryInfo.retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }

  if (errorMessage) {
    const retryMatch = errorMessage.match(/Please retry in ([0-9.]+(?:ms|s))/);
    if (retryMatch?.[1]) {
      return parseRetryDelayValue(retryMatch[1]);
    }
    const resetMatch = errorMessage.match(/after\s+([0-9.]+(?:ms|s))/i);
    if (resetMatch?.[1]) {
      return parseRetryDelayValue(resetMatch[1]);
    }
  }

  return null;
}

/**
 * Parses retry delay values from strings or protobuf-style objects.
 */
function parseRetryDelayValue(value: string | { seconds?: number; nanos?: number }): number | null {
  if (!value) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.endsWith("ms")) {
      const ms = Number(trimmed.slice(0, -2));
      return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null;
    }
    const match = trimmed.match(/^([\d.]+)s$/);
    if (match?.[1]) {
      const seconds = Number(match[1]);
      return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
    }
    return null;
  }

  const seconds = typeof value.seconds === "number" ? value.seconds : 0;
  const nanos = typeof value.nanos === "number" ? value.nanos : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
    return null;
  }
  const totalMs = Math.round(seconds * 1000 + nanos / 1e6);
  return totalMs > 0 ? totalMs : null;
}
