import { GEMINI_PROVIDER_ID, GEMINI_REDIRECT_URI } from "./constants";
import { authorizeGemini, exchangeGemini } from "./gemini/oauth";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { promptProjectId } from "./plugin/cli";
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

          async function resolveProjectContext(): Promise<ProjectContextResult> {
            try {
              return await ensureProjectContext(authRecord, client);
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
          console.log("\n=== Google Gemini OAuth Setup ===");

          let listener: OAuthListener | null = null;
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
              "3. This page will show an error like 'This site can’t be reached'. This is perfectly normal and means it worked!",
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
          console.log("\n");

          const projectId = await promptProjectId();
          const authorization = await authorizeGemini(projectId);

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
                    // Ignore close errors.
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

                return exchangeGemini(code, state);
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
