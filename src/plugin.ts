import { GEMINI_PROVIDER_ID, GEMINI_REDIRECT_URI } from "./constants";
import { authorizeGemini, exchangeGemini } from "./gemini/oauth";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { accessTokenExpired, formatAllAccounts, formatRefreshParts, isOAuthAuth, parseAllAccounts, parseRefreshParts } from "./plugin/auth";
import { promptProjectId } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import { startGeminiDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./plugin/request";
import { refreshAccountToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { resolveCachedAuth } from "./plugin/cache";
import type {
  Account,
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
} from "./plugin/types";

const rateLimits = new Map<string, number>();

function markRateLimited(refreshToken: string, retryAfterMs: number) {
  rateLimits.set(refreshToken, Date.now() + retryAfterMs);
}

function isRateLimited(refreshToken: string): boolean {
  const expiry = rateLimits.get(refreshToken);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    rateLimits.delete(refreshToken);
    return false;
  }
  return true;
}

let capturedGetAuth: GetAuth | null = null;

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
      capturedGetAuth = getAuth;
      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return null;
      }

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

          const accountParts = parseAllAccounts(latestAuth.refresh);
          if (accountParts.length === 0) {
            return fetch(input, init);
          }

          // Filter out rate-limited accounts
          const availableParts = accountParts.filter(p => !isRateLimited(p.refreshToken));
          const pool = availableParts.length > 0 ? availableParts : accountParts;

          // Simple round-robin based on hash of input or random
          const index = Math.floor(Math.random() * pool.length);
          const parts = pool[index];

          let account: Account = {
            parts,
          };

          // Try to resolve from cache
          const cached = resolveCachedAuth({
            type: "oauth",
            refresh: formatRefreshParts(parts),
          } as OAuthAuthDetails);
          
          account.access = cached.access;
          account.expires = cached.expires;

          if (accessTokenExpired(account as OAuthAuthDetails)) {
            const refreshed = await refreshAccountToken(account, latestAuth, client);
            if (!refreshed) {
              // If refresh fails, try next available account if possible
              // For simplicity, we just fall back to standard fetch or return error
              return fetch(input, init);
            }
            account = refreshed;
          }

          const accessToken = account.access;
          if (!accessToken) {
            return fetch(input, init);
          }

          /**
           * Ensures we have a usable project context for the current auth snapshot.
           */
          async function resolveProjectContext(): Promise<ProjectContextResult> {
            try {
              return await ensureProjectContext({
                type: "oauth",
                refresh: formatRefreshParts(account.parts),
                access: account.access,
                expires: account.expires,
              }, client);
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
          
          if (response.status === 429) {
            const retryAfterMs = parseInt(response.headers.get("retry-after-ms") || "60000");
            markRateLimited(account.parts.refreshToken, retryAfterMs);
            // We could retry internally with another account, but Opencode has its own retry logic.
            // By returning 429 with Retry-After, we let Opencode handle the delay.
            // But if we have other accounts, we could technically just retry NOW.
          }

          return transformGeminiResponse(response, streaming, debugContext, requestedModel);
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Gemini CLI)",
        type: "oauth",
        authorize: async () => {
          console.log("\n=== Google Gemini OAuth Setup ===");

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
              const { host } = new URL(GEMINI_REDIRECT_URI);
              console.log("1. You'll be asked to sign in to your Google account and grant permission.");
              console.log(
                `2. We'll automatically capture the browser redirect on http://${host}. No need to paste anything back here.`,
              );
              console.log("3. Once you see the 'Authentication complete' page in your browser, return to this terminal.");
            } catch (error) {
              console.log("1. You'll be asked to sign in to your Google account and grant permission.");
              console.log("2. After you approve, the browser will try to redirect to a 'localhost' page.");
              console.log(
                "3. This page will show an error like 'This site can't be reached'. This is perfectly normal and means it worked!",
              );
              console.log(
                "4. Once you see that error, copy the entire URL from the address bar, paste it back here, and press Enter.",
              );
              if (error instanceof Error) {
                console.log(`\nWarning: Couldn't start the local callback listener (${error.message}). Falling back to manual copy/paste.`);
              } else {
                console.log("\nWarning: Couldn't start the local callback listener. Falling back to manual copy/paste.");
              }
            }
          } else {
            console.log("Headless environment detected. Using manual OAuth flow.");
            console.log("1. You'll be asked to sign in to your Google account and grant permission.");
            console.log("2. After you approve, the browser will redirect to a 'localhost' URL.");
            console.log(
              "3. Copy the ENTIRE URL from your browser's address bar (it will look like: http://localhost:8085/oauth2callback?code=...&state=...)",
            );
            console.log("4. Paste the URL back here and press Enter.");
          }
          console.log("\n");

          const projectId = await promptProjectId();
          const authorization = await authorizeGemini(projectId);

          const handleCallback = async (cb: () => Promise<GeminiTokenExchangeResult>): Promise<GeminiTokenExchangeResult> => {
            const result = await cb();
            if (result.type === "success") {
              if (!capturedGetAuth) {
                await client.config.providers().catch(() => null);
              }
              const currentAuth = capturedGetAuth ? await capturedGetAuth().catch(() => null) : null;
              const newPart = parseRefreshParts(result.refresh);
              let allParts = [newPart];
              
              if (currentAuth && isOAuthAuth(currentAuth)) {
                const existingParts = parseAllAccounts(currentAuth.refresh);
                // Remove existing if email matches to avoid duplicates
                const filtered = existingParts.filter(p => p.email !== newPart.email);
                allParts = [...filtered, newPart];
              }
              
              result.refresh = formatAllAccounts(allParts);
            }
            return result;
          };

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

                  return await handleCallback(() => exchangeGemini(code, state));
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
              "Visit the URL above, complete OAuth, ignore the localhost connection error, and paste the full redirected URL (e.g., http://localhost:8085/oauth2callback?code=...&state=...): ",
            method: "code",
            callback: async (callbackUrl: string): Promise<GeminiTokenExchangeResult> => {
              try {
                const url = new URL(callbackUrl);
                const code = url.searchParams.get("code");
                const state = url.searchParams.get("state");

                if (!code || !state) {
                  return {
                    type: "failed",
                    error: "Missing code or state in callback URL",
                  };
                }

                return await handleCallback(() => exchangeGemini(code, state));
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
