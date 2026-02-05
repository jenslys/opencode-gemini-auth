import { spawn } from "node:child_process";

import { GEMINI_PROVIDER_ID, GEMINI_REDIRECT_URI } from "./constants";
import {
  authorizeGemini,
  exchangeGeminiWithVerifier,
} from "./gemini/oauth";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import {
  ensureProjectContext,
  resolveProjectContextFromAccessToken,
} from "./plugin/project";
import { isGeminiDebugEnabled, logGeminiDebugMessage, startGeminiDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { setGlobalState } from "./plugin/state";
import { geminiQuota } from "./plugin/tools";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types";

/**
 * Registers the Gemini OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Gemini Code Assist endpoints.
 */
export const GeminiCLIOAuthPlugin = async (
  { client }: PluginContext,
): Promise<PluginResult> => ({
  tool: {
    "gemini-quota": geminiQuota,
  },
  auth: {
    provider: GEMINI_PROVIDER_ID,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
      setGlobalState(getAuth, provider, client);
      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return null;
      }

      const providerOptions =
        provider && typeof provider === "object"
          ? ((provider as { options?: Record<string, unknown> }).options ?? undefined)
          : undefined;
      const projectIdFromConfig =
        providerOptions && typeof providerOptions.projectId === "string"
          ? providerOptions.projectId.trim()
          : "";
      const projectIdFromEnv = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim() ?? "";
      const googleProjectIdFromEnv =
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
        process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() ??
        "";
      const configuredProjectId =
        projectIdFromEnv || projectIdFromConfig || googleProjectIdFromEnv || undefined;

      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      return {
        apiKey: "",
        async fetch(input, init) {
          if (!isGenerativeLanguageRequest(input)) {
            return fetch(input, init);
          }

          const latestAuth = await getAuth();
          if (!isOAuthAuth(latestAuth)) {
            return fetch(input, init);
          }

          let authRecord = latestAuth;
          if (accessTokenExpired(authRecord)) {
            const refreshed = await refreshAccessToken(authRecord, client);
            if (!refreshed) {
              return fetch(input, init);
            }
            authRecord = refreshed;
          }

          const accessToken = authRecord.access;
          if (!accessToken) {
            return fetch(input, init);
          }

          /**
           * Ensures we have a usable project context for the current auth snapshot.
           */
          async function resolveProjectContext(): Promise<ProjectContextResult> {
            try {
              return await ensureProjectContext(authRecord, client, configuredProjectId);
            } catch (error) {
              if (error instanceof Error) {
                console.error(error.message);
              }
              throw error;
            }
          }

          const projectContext = await resolveProjectContext();

          const {
            request,
            init: transformedInit,
            streaming,
            requestedModel,
          } = prepareGeminiRequest(
            input,
            init,
            accessToken,
            projectContext.effectiveProjectId,
          );

          const originalUrl = toUrlString(input);
          const resolvedUrl = toUrlString(request);
          const debugContext = startGeminiDebugRequest({
            originalUrl,
            resolvedUrl,
            method: transformedInit.method,
            headers: transformedInit.headers,
            body: transformedInit.body,
            streaming,
            projectId: projectContext.effectiveProjectId,
          });

          const response = await fetchWithRetry(request, transformedInit);
          return transformGeminiResponse(response, streaming, debugContext, requestedModel);
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Gemini CLI)",
        type: "oauth",
        authorize: async () => {
          const maybeHydrateProjectId = async (
            result: GeminiTokenExchangeResult,
          ): Promise<GeminiTokenExchangeResult> => {
            if (result.type !== "success") {
              return result;
            }

            const accessToken = result.access;
            if (!accessToken) {
              return result;
            }

            const projectFromEnv = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim() ?? "";
            const googleProjectFromEnv =
              process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
              process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() ??
              "";
            const configuredProjectId =
              projectFromEnv || googleProjectFromEnv || undefined;

            try {
              const authSnapshot = {
                type: "oauth",
                refresh: result.refresh,
                access: result.access,
                expires: result.expires,
              } satisfies OAuthAuthDetails;
              const projectContext = await resolveProjectContextFromAccessToken(
                authSnapshot,
                accessToken,
                configuredProjectId,
              );

              if (projectContext.auth.refresh !== result.refresh) {
                if (isGeminiDebugEnabled()) {
                  logGeminiDebugMessage(
                    `OAuth project resolved during auth: ${projectContext.effectiveProjectId || "none"}`,
                  );
                }
                return { ...result, refresh: projectContext.auth.refresh };
              }
            } catch (error) {
              if (isGeminiDebugEnabled()) {
                const message = error instanceof Error ? error.message : String(error);
                console.warn(`[Gemini OAuth] Project resolution skipped: ${message}`);
              }
            }

            return result;
          };

          const isHeadless = !!(
            process.env.SSH_CONNECTION ||
            process.env.SSH_CLIENT ||
            process.env.SSH_TTY ||
            process.env.OPENCODE_HEADLESS
          );

          let listener: OAuthListener | null = null;
          if (!isHeadless) {
            try {
              listener = await startOAuthListener();
            } catch (error) {
              if (error instanceof Error) {
                console.log(
                  `Warning: Couldn't start the local callback listener (${error.message}). You'll need to paste the callback URL or authorization code.`,
                );
              } else {
                console.log(
                  "Warning: Couldn't start the local callback listener. You'll need to paste the callback URL or authorization code.",
                );
              }
            }
          } else {
            console.log(
              "Headless environment detected. You'll need to paste the callback URL or authorization code.",
            );
          }

          const authorization = await authorizeGemini();
          if (!isHeadless) {
            openBrowserUrl(authorization.url);
          }

          if (listener) {
            return {
              url: authorization.url,
              instructions:
                "Complete the sign-in flow in your browser. We'll automatically detect the redirect back to localhost.",
              method: "auto",
              callback: async (): Promise<GeminiTokenExchangeResult> => {
                try {
                  const callbackUrl = await listener.waitForCallback();
                  const code = callbackUrl.searchParams.get("code");
                  const state = callbackUrl.searchParams.get("state");

                  if (!code || !state) {
                    return {
                      type: "failed",
                      error: "Missing code or state in callback URL",
                    };
                  }

                  if (state !== authorization.state) {
                    return {
                      type: "failed",
                      error: "State mismatch in callback URL (possible CSRF attempt)",
                    };
                  }

                  return await maybeHydrateProjectId(
                    await exchangeGeminiWithVerifier(code, authorization.verifier),
                  );
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                } finally {
                  try {
                    await listener?.close();
                  } catch {
                  }
                }
              },
            };
          }

          return {
            url: authorization.url,
            instructions:
              "Complete OAuth in your browser, then paste the full redirected URL (e.g., http://localhost:8085/oauth2callback?code=...&state=...) or just the authorization code.",
              method: "code",
              callback: async (callbackUrl: string): Promise<GeminiTokenExchangeResult> => {
                try {
                  const { code, state } = parseOAuthCallbackInput(callbackUrl);

                if (!code) {
                  return {
                    type: "failed",
                    error: "Missing authorization code in callback input",
                  };
                }

                if (state && state !== authorization.state) {
                  return {
                    type: "failed",
                    error: "State mismatch in callback input (possible CSRF attempt)",
                  };
                }

                return await maybeHydrateProjectId(
                  await exchangeGeminiWithVerifier(code, authorization.verifier),
                );
              } catch (error) {
                return {
                  type: "failed",
                  error: error instanceof Error ? error.message : "Unknown error",
                };
              }
            },
          };
        },
      },
      {
        provider: GEMINI_PROVIDER_ID,
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

export const GoogleOAuthPlugin = GeminiCLIOAuthPlugin;

const RETRYABLE_STATUS_CODES = new Set([429, 503]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 800;
const DEFAULT_MAX_DELAY_MS = 8000;
const CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
];

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

function parseOAuthCallbackInput(input: string): { code?: string; state?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return {
        code: url.searchParams.get("code") || undefined,
        state: url.searchParams.get("state") || undefined,
      };
    } catch {
      return {};
    }
  }

  const candidate = trimmed.startsWith("?") ? trimmed.slice(1) : trimmed;
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    const code = params.get("code") || undefined;
    const state = params.get("state") || undefined;
    if (code || state) {
      return { code, state };
    }
  }

  return { code: trimmed };
}

function openBrowserUrl(url: string): void {
  try {
    // Best-effort: don't block auth flow if spawning fails.
    const platform = process.platform;
    const command =
      platform === "darwin"
        ? "open"
        : platform === "win32"
          ? "rundll32"
          : "xdg-open";
    const args =
      platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref?.();
  } catch {
  }
}

/**
 * Sends requests with bounded retry logic for transient Cloud Code failures.
 * Mirrors the Gemini CLI handling of Code Assist rate-limit signals.
 */
async function fetchWithRetry(input: RequestInfo, init: RequestInit | undefined): Promise<Response> {
  const maxRetries = DEFAULT_MAX_RETRIES;
  const baseDelayMs = DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = DEFAULT_MAX_DELAY_MS;

  if (!canRetryRequest(init)) {
    return fetch(input, init);
  }

  let attempt = 0;
  while (true) {
    const response = await fetch(input, init);
    if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= maxRetries) {
      return response;
    }

    let retryDelayMs: number | null = null;
    if (response.status === 429) {
      const quotaContext = await classifyQuotaResponse(response);
      if (quotaContext?.terminal) {
        return response;
      }
      retryDelayMs = quotaContext?.retryDelayMs ?? null;
    }

    const delayMs = await getRetryDelayMs(
      response,
      attempt,
      baseDelayMs,
      maxDelayMs,
      retryDelayMs,
    );
    if (!delayMs || delayMs <= 0) {
      return response;
    }

    if (init?.signal?.aborted) {
      return response;
    }

    await wait(delayMs);
    attempt += 1;
  }
}

function canRetryRequest(init: RequestInit | undefined): boolean {
  if (!init?.body) {
    return true;
  }

  const body = init.body;
  if (typeof body === "string") {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
    return true;
  }
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }

  return false;
}

/**
 * Resolves a retry delay from headers, body hints, or exponential backoff.
 * Honors RetryInfo/Retry-After hints emitted by Code Assist.
 */
async function getRetryDelayMs(
  response: Response,
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  bodyDelayMs: number | null = null,
): Promise<number | null> {
  const headerDelayMs = parseRetryAfterMs(response.headers.get("retry-after-ms"));
  if (headerDelayMs !== null) {
    return clampDelay(headerDelayMs, maxDelayMs);
  }

  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  if (retryAfter !== null) {
    return clampDelay(retryAfter, maxDelayMs);
  }

  const parsedBodyDelayMs = bodyDelayMs ?? (await parseRetryDelayFromBody(response));
  if (parsedBodyDelayMs !== null) {
    return clampDelay(parsedBodyDelayMs, maxDelayMs);
  }

  const fallback = baseDelayMs * Math.pow(2, attempt);
  return clampDelay(fallback, maxDelayMs);
}

function clampDelay(delayMs: number, maxDelayMs: number): number {
  if (!Number.isFinite(delayMs)) {
    return maxDelayMs;
  }
  return Math.min(Math.max(0, delayMs), maxDelayMs);
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, Math.round(asNumber * 1000));
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return null;
}

async function parseRetryDelayFromBody(response: Response): Promise<number | null> {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const details = parsed?.error?.details;
  if (!Array.isArray(details)) {
    const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
    return parseRetryDelayFromMessage(message);
  }

  for (const detail of details) {
    if (!detail || typeof detail !== "object") {
      continue;
    }
    const retryDelay = (detail as Record<string, unknown>).retryDelay;
    if (!retryDelay) {
      continue;
    }
    const delayMs = parseRetryDelayValue(retryDelay);
    if (delayMs !== null) {
      return delayMs;
    }
  }

  const message = typeof parsed?.error?.message === "string" ? parsed.error.message : "";
  return parseRetryDelayFromMessage(message);
}

function parseRetryDelayValue(value: unknown): number | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    const match = value.match(/^([\d.]+)s$/);
    if (!match || !match[1]) {
      return null;
    }
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return null;
    }
    return Math.round(seconds * 1000);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const seconds = typeof record.seconds === "number" ? record.seconds : 0;
    const nanos = typeof record.nanos === "number" ? record.nanos : 0;
    if (!Number.isFinite(seconds) || !Number.isFinite(nanos)) {
      return null;
    }
    const totalMs = Math.round(seconds * 1000 + nanos / 1e6);
    return totalMs > 0 ? totalMs : null;
  }

  return null;
}

/**
 * Parses retry delays embedded in error message strings (e.g., "Please retry in 5s").
 */
function parseRetryDelayFromMessage(message: string): number | null {
  if (!message) {
    return null;
  }
  const retryMatch = message.match(/Please retry in ([0-9.]+(?:ms|s))/);
  if (retryMatch?.[1]) {
    return parseRetryDelayValue(retryMatch[1]);
  }
  const afterMatch = message.match(/after\s+([0-9.]+(?:ms|s))/i);
  if (afterMatch?.[1]) {
    return parseRetryDelayValue(afterMatch[1]);
  }
  return null;
}

/**
 * Classifies quota errors as terminal vs retryable and extracts retry hints.
 * Matches Gemini CLI semantics: QUOTA_EXHAUSTED is terminal, RATE_LIMIT_EXCEEDED is retryable.
 */
async function classifyQuotaResponse(
  response: Response,
): Promise<{ terminal: boolean; retryDelayMs?: number } | null> {
  let text = "";
  try {
    text = await response.clone().text();
  } catch {
    return null;
  }

  if (!text) {
    return null;
  }

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const error = parsed?.error ?? {};
  const details = Array.isArray(error?.details) ? error.details : [];
  const retryDelayMs = parseRetryDelayFromMessage(error?.message ?? "") ?? undefined;

  const errorInfo = details.find(
    (detail: any) =>
      detail &&
      typeof detail === "object" &&
      detail["@type"] === "type.googleapis.com/google.rpc.ErrorInfo",
  );

  if (errorInfo?.domain && !CLOUDCODE_DOMAINS.includes(errorInfo.domain)) {
    return null;
  }

  if (errorInfo?.reason === "QUOTA_EXHAUSTED") {
    return { terminal: true, retryDelayMs };
  }
  if (errorInfo?.reason === "RATE_LIMIT_EXCEEDED") {
    return { terminal: false, retryDelayMs };
  }

  const quotaFailure = details.find(
    (detail: any) =>
      detail &&
      typeof detail === "object" &&
      detail["@type"] === "type.googleapis.com/google.rpc.QuotaFailure",
  );

  if (quotaFailure?.violations && Array.isArray(quotaFailure.violations)) {
    const combined = quotaFailure.violations
      .map((violation: any) => String(violation?.description ?? "").toLowerCase())
      .join(" ");
    if (combined.includes("daily") || combined.includes("per day")) {
      return { terminal: true, retryDelayMs };
    }
    return { terminal: false, retryDelayMs };
  }

  return { terminal: false, retryDelayMs };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
