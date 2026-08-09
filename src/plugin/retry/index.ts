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
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "../debug";
import { geminiFetch } from "../../fetch";
import type { AccountState } from "../types";

const retryCooldownByKey = new Map<string, number>();
const RETRY_IN_FLIGHT_LOG_INTERVAL_MS = 5000;
const MODEL_CAPACITY_COOLDOWN_MS = 8000;

/**
 * Sends requests with retry/backoff semantics aligned to Gemini CLI:
 * - Retries on 429/5xx and transient network failures
 * - Honors Retry-After and google.rpc.RetryInfo
 * - Never rewrites requested model
 */
export async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit | undefined,
  accountId?: string,
): Promise<Response> {
  if (!canRetryRequest(init)) {
    return geminiFetch(input, init);
  }

  const retryInit = cloneRetryableInit(init);
  const throttleKey = buildRetryThrottleKey(input, retryInit, accountId);
  await waitForRetryCooldown(throttleKey, retryInit.signal);
  let attempt = 1;
  const url = readRequestUrl(input);

  while (attempt <= DEFAULT_MAX_ATTEMPTS) {
    let response: Response;
    const stopInFlightLog = startInFlightLog(attempt, url);
    try {
      debugRetry(
        `attempt ${attempt}/${DEFAULT_MAX_ATTEMPTS} -> ${url}`,
      );
      response = await geminiFetch(input, retryInit);
    } catch (error) {
      stopInFlightLog();
      if (attempt >= DEFAULT_MAX_ATTEMPTS || !isRetryableNetworkError(error)) {
        debugRetry(
          `attempt ${attempt} network error is non-retryable or maxed: ${formatErrorSummary(error)}`,
        );
        throw error;
      }
      if (retryInit.signal?.aborted) {
        debugRetry(`attempt ${attempt} aborted before retry`);
        throw error;
      }

      const delayMs = getExponentialDelayWithJitter(attempt);
      debugRetry(
        `attempt ${attempt} network retry scheduled in ${delayMs}ms (${formatErrorSummary(error)})`,
      );
      await wait(delayMs);
      attempt += 1;
      continue;
    }
    stopInFlightLog();

    if (!isRetryableStatus(response.status) && response.status !== 400 && response.status !== 403) {
      debugRetry(`attempt ${attempt} success or non-retryable status: ${response.status}`);
      return response;
    }

    const isPotentialQuotaError = response.status === 429 || response.status === 400 || response.status === 403;
    const quotaContext = isPotentialQuotaError ? await classifyQuotaResponse(response) : null;
    
    if (isPotentialQuotaError && quotaContext?.terminal) {
      if (quotaContext.reason === "MODEL_CAPACITY_EXHAUSTED") {
        const cooldownMs = quotaContext.retryDelayMs ?? MODEL_CAPACITY_COOLDOWN_MS;
        setRetryCooldown(throttleKey, cooldownMs);
        debugRetry(`terminal model capacity; cooldown ${cooldownMs}ms before next request`);
      }
      debugRetry(
        `attempt ${attempt} terminal 429 (${quotaContext.reason ?? "unknown"}), returning without retry`,
      );
      // Add headers so callers (e.g. plugin.ts with AccountPool) can cooldown accounts
      if (accountId) {
        const headers = new Headers(response.headers);
        headers.set("X-Gemini-Terminal-429", "true");
        headers.set("X-Gemini-429-Reason", quotaContext.reason ?? "unknown");
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      return response;
    }

    if (attempt >= DEFAULT_MAX_ATTEMPTS || retryInit.signal?.aborted) {
      debugRetry(
        `attempt ${attempt} reached retry boundary (status=${response.status})`,
      );
      return response;
    }

    const delayMs = await resolveRetryDelayMs(response, attempt, quotaContext?.retryDelayMs);
    debugRetry(
      `attempt ${attempt} retrying status=${response.status} reason=${quotaContext?.reason ?? "n/a"} delay=${delayMs}ms`,
    );
    if (delayMs > 0 && response.status === 429) {
      setRetryCooldown(throttleKey, delayMs);
    }
    if (delayMs > 0) {
      await wait(delayMs);
    }
    attempt += 1;
  }

  return geminiFetch(input, retryInit);
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

export function buildRetryThrottleKey(input: RequestInfo, init: RequestInit, accountId?: string): string {
  const url = readRequestUrl(input);
  const body = typeof init.body === "string" ? safeParseBody(init.body) : null;
  const project = readString(body?.project);
  const model = readString(body?.model);
  const accountPrefix = accountId ? `account:${accountId}|` : "";
  return `${accountPrefix}${url}|${project ?? ""}|${model ?? ""}`;
}

async function waitForRetryCooldown(key: string, signal?: AbortSignal | null): Promise<void> {
  const until = retryCooldownByKey.get(key);
  if (!until) {
    return;
  }

  const remaining = until - Date.now();
  if (remaining <= 0) {
    retryCooldownByKey.delete(key);
    return;
  }
  if (signal?.aborted) {
    debugRetry(`cooldown skipped due to abort (key=${shortKey(key)})`);
    return;
  }

  debugRetry(`cooldown wait ${remaining}ms (key=${shortKey(key)})`);
  await wait(remaining);
  retryCooldownByKey.delete(key);
}

function setRetryCooldown(key: string, delayMs: number): void {
  const next = Date.now() + delayMs;
  const current = retryCooldownByKey.get(key) ?? 0;
  retryCooldownByKey.set(key, Math.max(current, next));
  debugRetry(`cooldown set ${delayMs}ms (key=${shortKey(key)})`);
}

function readRequestUrl(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }

  const request = input as Request;
  if (request.url) {
    return request.url;
  }
  return input.toString();
}

function safeParseBody(body: string): Record<string, unknown> | null {
  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function debugRetry(message: string): void {
  if (!isGeminiDebugEnabled()) {
    return;
  }
  logGeminiDebugMessage(`Retry: ${message}`);
}

function formatErrorSummary(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shortKey(key: string): string {
  return key.length <= 120 ? key : `${key.slice(0, 120)}...`;
}

function startInFlightLog(attempt: number, url: string): () => void {
  if (!isGeminiDebugEnabled()) {
    return () => {};
  }

  const startedAt = Date.now();
  const interval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    debugRetry(`attempt ${attempt} still waiting for response (${elapsed}ms) -> ${url}`);
  }, RETRY_IN_FLIGHT_LOG_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}

/**
 * Formats a human-readable message when all pool accounts have exhausted their quota
 * or are in cooldown. Used by plugin.ts when pool.select() returns an account that's
 * already cooldowned and all others are too.
 */
export function formatAllAccountsExhaustedMessage(accounts: AccountState[]): string {
  const now = Date.now();
  const lines = accounts.map((a) => {
    const cooldowns = Array.from(a.cooldowns.values())
      .filter((c) => c.expiresAt > now)
      .map((c) => `${c.model ?? "all"}: ${c.reason} (${Math.round((c.expiresAt - now) / 1000)}s)`);
    return `  ${a.account.id}: ${cooldowns.join(", ") || "no cooldown"}`;
  });
  return `All accounts exhausted. Cooldown status:\n${lines.join("\n")}`;
}

export { retryInternals };
