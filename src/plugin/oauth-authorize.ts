import { spawn } from "node:child_process";

import { authorizeGemini, exchangeGeminiWithVerifier } from "../gemini/oauth";
import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./debug";
import { resolveProjectContextFromAccessToken } from "./project";
import { startOAuthListener, type OAuthListener } from "./server";
import type { OAuthAuthDetails } from "./types";

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
              return { type: "failed", error: "Missing code or state in callback URL" };
            }
            if (state !== authorization.state) {
              return { type: "failed", error: "State mismatch in callback URL (possible CSRF attempt)" };
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
          const { code, state } = parseOAuthCallbackInput(callbackUrl);
          if (!code) {
            return { type: "failed", error: "Missing authorization code in callback input" };
          }
          if (state && state !== authorization.state) {
            return { type: "failed", error: "State mismatch in callback input (possible CSRF attempt)" };
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
  };
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
