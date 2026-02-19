import {
  CLOUDCODE_DOMAINS,
  GEMINI_PREVIEW_LINK,
  type GeminiApiBody,
  type GeminiErrorEnhancement,
  type GoogleRpcErrorInfo,
  type GoogleRpcHelp,
  type GoogleRpcQuotaFailure,
  type GoogleRpcRetryInfo,
} from "./types";

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

  const error = body.error ?? {};
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
 * Enhances Gemini errors with validation/quota messaging and retry hints.
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

  return retryAfterMs !== undefined ? { retryAfterMs } : null;
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
  return isGeminiThreeModel(typeof body.error?.message === "string" ? body.error.message : "");
}

function isGeminiThreeModel(target?: string): boolean {
  return !!target && /gemini[\s-]?3/i.test(target);
}

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

  if (!quotaFailure?.violations?.length) {
    return null;
  }

  const description = quotaFailure.violations
    .map((violation) => violation.description?.toLowerCase() ?? "")
    .join(" ");
  if (description.includes("daily") || description.includes("per day")) {
    return { retryable: false };
  }
  return { retryable: true };
}

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

  if (!errorMessage) {
    return null;
  }

  const retryMatch = errorMessage.match(/Please retry in ([0-9.]+(?:ms|s))/);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }
  const resetMatch = errorMessage.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (resetMatch?.[1]) {
    return parseRetryDelayValue(resetMatch[1]);
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
