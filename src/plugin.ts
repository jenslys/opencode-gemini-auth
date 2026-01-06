import { spawn } from "node:child_process";

import { GEMINI_PROVIDER_ID, GEMINI_REDIRECT_URI } from "./constants";
import {
  authorizeGemini,
  exchangeGemini,
  exchangeGeminiWithVerifier,
} from "./gemini/oauth";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { ensureProjectContext } from "./plugin/project";
import { startGeminiDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import type {
  GetAuth,
  LoaderResult,
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
  auth: {
    provider: GEMINI_PROVIDER_ID,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
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
      const configuredProjectId = projectIdFromEnv || projectIdFromConfig || undefined;

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

          const response = await fetch(request, transformedInit);
          return transformGeminiResponse(response, streaming, debugContext, requestedModel);
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Gemini CLI)",
        type: "oauth",
        authorize: async () => {
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

                  return await exchangeGemini(code, state);
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

                if (state) {
                  return exchangeGemini(code, state);
                }

                return exchangeGeminiWithVerifier(code, authorization.verifier);
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
