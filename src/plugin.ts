import { authorizeGemini, exchangeGemini } from "./gemini/oauth";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { promptProjectId } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import { prepareGeminiRequest, transformGeminiResponse } from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import type {
  GetAuth,
  LoaderResult,
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

export const GeminiCLIOAuthPlugin = async (
  { client }: PluginContext,
): Promise<PluginResult> => ({
  auth: {
    provider: "google",
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

          const projectContext = await ensureProjectContext(authRecord, client);

          const { request, init: transformedInit, streaming } = prepareGeminiRequest(
            input,
            init,
            accessToken,
            projectContext.effectiveProjectId,
          );

          const response = await fetch(request, transformedInit);
          return transformGeminiResponse(response, streaming);
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Gemini CLI)",
        type: "oauth",
        authorize: async () => {
          console.log("\n=== Google Gemini OAuth Setup ===");
          console.log("1. You'll be asked to sign in to your Google account and grant permission.");
          console.log("2. After you approve, the browser will try to redirect to a 'localhost' page.");
          console.log("3. This page will show an error like 'This site can’t be reached'. This is perfectly normal and means it worked!");
          console.log("4. Once you see that error, copy the entire URL from the address bar, paste it back here, and press Enter.");
          console.log("\n")

          const projectId = await promptProjectId();
          const authorization = await authorizeGemini(projectId);

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
        provider: "google",
        label: "Manually enter API Key",
        type: "api",
      },
    ],
  },
});

export const GoogleOAuthPlugin = GeminiCLIOAuthPlugin;
