import { spawn } from "node:child_process";

import { authorizeGemini, exchangeGeminiWithVerifier } from "../gemini/oauth";
import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./debug";
import { resolveProjectContextFromAccessToken } from "./project";
import { startOAuthListener, type OAuthListener } from "./server";
import type { OAuthAuthDetails } from "./types";

const AUTHORIZATION_SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_AUTHORIZATION_CODE_LENGTH = 4096;

export interface ParsedOAuthCallbackInput {
  code?: string;
  state?: string;
  error?: string;
  source: "empty" | "url" | "query" | "raw";
}

/**
 * Builds the OAuth authorize callback used by plugin auth methods.
 */
export function createOAuthAuthorizeMethod(): () => Promise<{
  url: string;
  instructions: string;
  method: string;
  callback: (() => Promise<GeminiTokenExchangeResult>) | ((callbackUrl: string) => Promise<GeminiTokenExchangeResult>);
}> {
  return async () => {
    const maybeHydrateProjectId = async (
      result: GeminiTokenExchangeResult,
    ): Promise<GeminiTokenExchangeResult> => {
      if (result.type !== "success" || !result.access) {
        return result;
      }

      const projectFromEnv = process.env.OPENCODE_GEMINI_PROJECT_ID?.trim() ?? "";
      const googleProjectFromEnv =
        process.env.GOOGLE_CLOUD_PROJECT?.trim() ??
        process.env.GOOGLE_CLOUD_PROJECT_ID?.trim() ??
        "";
      const configuredProjectId = projectFromEnv || googleProjectFromEnv || undefined;

      try {
        const authSnapshot = {
          type: "oauth",
          refresh: result.refresh,
          access: result.access,
          expires: result.expires,
        } satisfies OAuthAuthDetails;
        const projectContext = await resolveProjectContextFromAccessToken(
          authSnapshot,
          result.access,
          configuredProjectId,
        );

        if (projectContext.auth.refresh !== result.refresh && isGeminiDebugEnabled()) {
          logGeminiDebugMessage(
            `OAuth project resolved during auth: ${projectContext.effectiveProjectId || "none"}`,
          );
        }
        return projectContext.auth.refresh !== result.refresh
          ? { ...result, refresh: projectContext.auth.refresh }
          : result;
      } catch (error) {
        if (isGeminiDebugEnabled()) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn(`[Gemini OAuth] Project resolution skipped: ${message}`);
        }
        return result;
      }
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
        const detail = error instanceof Error ? ` (${error.message})` : "";
        console.log(
          `Warning: Couldn't start the local callback listener${detail}. You'll need to paste the callback URL or authorization code.`,
        );
      }
    } else {
      console.log(
        "Headless environment detected. You'll need to paste the callback URL or authorization code.",
      );
    }

    const authorization = await authorizeGemini();
    const authorizationStartedAt = Date.now();
    let exchangePromise: Promise<GeminiTokenExchangeResult> | null = null;
    let exchangeConsumed = false;

    const finalizeExchange = async (
      parsed: ParsedOAuthCallbackInput,
    ): Promise<GeminiTokenExchangeResult> => {
      if (parsed.error) {
        return {
          type: "failed",
          error: `OAuth callback returned an error: ${parsed.error}`,
        };
      }

      if (parsed.source !== "raw" && !parsed.state) {
        return {
          type: "failed",
          error: "Missing state in callback input. Paste the full callback URL to continue.",
        };
      }

      if (parsed.state && parsed.state !== authorization.state) {
        return {
          type: "failed",
          error: "State mismatch in callback input (possible CSRF attempt)",
        };
      }

      if (Date.now() - authorizationStartedAt > AUTHORIZATION_SESSION_TTL_MS) {
        return {
          type: "failed",
          error: "OAuth authorization session expired. Start a new login flow.",
        };
      }

      const normalizedCode = normalizeAuthorizationCode(parsed.code);
      if (!normalizedCode) {
        return {
          type: "failed",
          error:
            "Invalid authorization code in callback input. Paste the full callback URL or a clean code value.",
        };
      }

      if (exchangePromise) {
        return exchangePromise;
      }

      if (exchangeConsumed) {
        return {
          type: "failed",
          error:
            "Authorization code was already submitted. Start a new login flow if you need to retry.",
        };
      }

      exchangeConsumed = true;
      exchangePromise = (async () => {
        const result = await exchangeGeminiWithVerifier(normalizedCode, authorization.verifier);
        return maybeHydrateProjectId(result);
      })();

      try {
        return await exchangePromise;
      } finally {
        exchangePromise = null;
      }
    };

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
            return await finalizeExchange({
              code: callbackUrl.searchParams.get("code") ?? undefined,
              state: callbackUrl.searchParams.get("state") ?? undefined,
              error: callbackUrl.searchParams.get("error") ?? undefined,
              source: "url",
            });
          } catch (error) {
            return {
              type: "failed",
              error: error instanceof Error ? error.message : "Unknown error",
            };
          } finally {
            try {
              await listener?.close();
            } catch {}
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
          return await finalizeExchange(parseOAuthCallbackInput(callbackUrl));
        } catch (error) {
          return {
            type: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      },
    };
  };
}

export function parseOAuthCallbackInput(input: string): ParsedOAuthCallbackInput {
  const trimmed = trimWrappingQuotes(input.trim());
  if (!trimmed) {
    return { source: "empty" };
  }

  const urlInput = normalizeUrlInput(trimmed);
  if (urlInput) {
    const parsedUrl = parseCallbackUrl(urlInput);
    if (parsedUrl) {
      return parsedUrl;
    }
  }

  const candidate = extractQueryCandidate(trimmed);
  if (candidate.includes("=")) {
    const params = new URLSearchParams(candidate);
    const code = params.get("code") || undefined;
    const state = params.get("state") || undefined;
    const error = params.get("error") || undefined;
    if (code || state || error) {
      return { source: "query", code, state, error };
    }
  }

  return { source: "raw", code: trimmed };
}

export function normalizeAuthorizationCode(rawCode: string | undefined): string | undefined {
  if (!rawCode) {
    return undefined;
  }

  let candidate = trimWrappingQuotes(rawCode).trim();
  if (!candidate) {
    return undefined;
  }

  if (/[\r\n]/.test(candidate)) {
    return undefined;
  }

  for (let index = 0; index < 2; index += 1) {
    if (!/%[0-9A-Fa-f]{2}/.test(candidate)) {
      break;
    }

    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) {
        break;
      }
      candidate = decoded;
    } catch {
      break;
    }
  }

  candidate = candidate.trim();
  if (!candidate || /\s/.test(candidate)) {
    return undefined;
  }

  if (candidate.length > MAX_AUTHORIZATION_CODE_LENGTH) {
    return undefined;
  }

  return candidate;
}

function parseCallbackUrl(input: string): ParsedOAuthCallbackInput | undefined {
  try {
    const url = new URL(input);
    const code = url.searchParams.get("code") || undefined;
    const state = url.searchParams.get("state") || undefined;
    const error = url.searchParams.get("error") || undefined;
    if (code || state || error || url.pathname.includes("oauth2callback")) {
      return { source: "url", code, state, error };
    }

    const hashParams = parseHashParams(url.hash);
    if (hashParams.code || hashParams.state || hashParams.error) {
      return { source: "url", ...hashParams };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseHashParams(hash: string): { code?: string; state?: string; error?: string } {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw.includes("=")) {
    return {};
  }

  const params = new URLSearchParams(raw);
  return {
    code: params.get("code") || undefined,
    state: params.get("state") || undefined,
    error: params.get("error") || undefined,
  };
}

function normalizeUrlInput(input: string): string | undefined {
  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  if (/^(localhost|127\.0\.0\.1):\d+/i.test(input)) {
    return `http://${input}`;
  }

  return undefined;
}

function extractQueryCandidate(input: string): string {
  const withoutQuotes = trimWrappingQuotes(input);
  const queryIndex = withoutQuotes.indexOf("?");
  let candidate = queryIndex >= 0 ? withoutQuotes.slice(queryIndex + 1) : withoutQuotes;
  const hashIndex = candidate.indexOf("#");
  if (hashIndex >= 0) {
    const hashCandidate = candidate.slice(hashIndex + 1);
    candidate = candidate.slice(0, hashIndex);
    if (!candidate.includes("=") && hashCandidate.includes("=")) {
      candidate = hashCandidate;
    }
  }
  return candidate.startsWith("?") ? candidate.slice(1) : candidate;
}

function trimWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function openBrowserUrl(url: string): void {
  try {
    const platform = process.platform;
    const command =
      platform === "darwin" ? "open" : platform === "win32" ? "rundll32" : "xdg-open";
    const args = platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, {
      stdio: "ignore",
      detached: true,
    });
    child.unref?.();
  } catch {}
}
