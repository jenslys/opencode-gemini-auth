import {
  canRetryRequest,
  DEFAULT_MAX_ATTEMPTS,
  getExponentialDelayWithJitter,
  isRetryableNetworkError,
  isRetryableStatus,
  resolveRetryDelayMs,
  wait,
} from "./helpers";
import { classifyQuotaResponse, retryInternals } from "./quota";

/**
 * Sends requests with retry/backoff semantics aligned to Gemini CLI:
 * - Retries on 429/5xx and transient network failures
 * - Honors Retry-After and google.rpc.RetryInfo
 * - Never rewrites requested model
 */
export async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit | undefined,
): Promise<Response> {
  if (!canRetryRequest(init)) {
    return fetch(input, init);
  }

  const retryInit = cloneRetryableInit(init);
  let attempt = 1;

  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    let response: Response;
    try {
      response = await fetch(input, retryInit);
    } catch (error) {
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        throw error;
      }
      if (retryInit.signal?.aborted) {
        throw error;
      }

      await wait(getExponentialDelayWithJitter(attempt));
      attempt += 1;
      continue;
    }

    if (!isRetryableStatus(response.status)) {
      return response;
    }

    const quotaContext = response.status === 429 ? await classifyQuotaResponse(response) : null;
    if (response.status === 429 && quotaContext?.terminal) {
      return response;
    }

    if (attempt >= DEFAULT_MAX_ATTEMPTS || retryInit.signal?.aborted) {
      return response;
    }

    const delayMs = await resolveRetryDelayMs(response, attempt, quotaContext?.retryDelayMs);
    if (delayMs > 0) {
      await wait(delayMs);
    }
    attempt += 1;
  }

  return fetch(input, retryInit);
}

function cloneRetryableInit(init: RequestInit | undefined): RequestInit {
  if (!init) {
    return {};
  }
  return {
    ...init,
    headers: new Headers(init.headers ?? {}),
  };
}

export { retryInternals };
