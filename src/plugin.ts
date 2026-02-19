import { GEMINI_PROVIDER_ID } from "./constants";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { resolveCachedAuth } from "./plugin/cache";
import { ensureProjectContext, retrieveUserQuota } from "./plugin/project";
import { isGeminiDebugEnabled, logGeminiDebugMessage, startGeminiDebugRequest } from "./plugin/debug";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./plugin/request";
import { fetchWithRetry } from "./plugin/retry";
import { refreshAccessToken } from "./plugin/token";
import type {
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
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

      const configuredProjectId = resolveConfiguredProjectId(provider);
      normalizeProviderModelCosts(provider);

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

          let authRecord = resolveCachedAuth(latestAuth);
          if (accessTokenExpired(authRecord)) {
            const refreshed = await refreshAccessToken(authRecord, client);
            if (!refreshed) {
              return fetch(input, init);
            }
            authRecord = refreshed;
          }

          if (!authRecord.access) {
            return fetch(input, init);
          }

          const projectContext = await ensureProjectContextOrThrow(
            authRecord,
            client,
            configuredProjectId,
          );
          await maybeLogAvailableQuotaModels(
            authRecord.access,
            projectContext.effectiveProjectId,
          );
          const transformed = prepareGeminiRequest(
            input,
            init,
            authRecord.access,
            projectContext.effectiveProjectId,
          );
          const debugContext = startGeminiDebugRequest({
            originalUrl: toUrlString(input),
            resolvedUrl: toUrlString(transformed.request),
            method: transformed.init.method,
            headers: transformed.init.headers,
            body: transformed.init.body,
            streaming: transformed.streaming,
            projectId: projectContext.effectiveProjectId,
          });

          /**
           * Retry transport/429 failures while preserving the requested model.
           * We intentionally do not auto-downgrade model tiers to avoid misleading users.
           */
          const response = await fetchWithRetry(transformed.request, transformed.init);
          return transformGeminiResponse(
            response,
            transformed.streaming,
            debugContext,
            transformed.requestedModel,
          );
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Gemini CLI)",
        type: "oauth",
        authorize: createOAuthAuthorizeMethod(),
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
const loggedQuotaModelsByProject = new Set<string>();

function resolveConfiguredProjectId(provider: Provider): string | undefined {
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

  return projectIdFromEnv || projectIdFromConfig || googleProjectIdFromEnv || undefined;
}

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider.models) {
    return;
  }
  for (const model of Object.values(provider.models)) {
    if (model) {
      model.cost = { input: 0, output: 0 };
    }
  }
}

async function ensureProjectContextOrThrow(
  authRecord: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
) {
  try {
    return await ensureProjectContext(authRecord, client, configuredProjectId);
  } catch (error) {
    if (error instanceof Error) {
      console.error(error.message);
    }
    throw error;
  }
}

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

/**
 * Debug-only, best-effort model visibility log from Code Assist quota buckets.
 *
 * Why: it gives a concrete backend-side list of model IDs currently visible to the
 * current account/project, which helps explain 404/notFound model failures quickly.
 */
async function maybeLogAvailableQuotaModels(
  accessToken: string,
  projectId: string,
): Promise<void> {
  if (!isGeminiDebugEnabled() || !projectId) {
    return;
  }

  if (loggedQuotaModelsByProject.has(projectId)) {
    return;
  }
  loggedQuotaModelsByProject.add(projectId);

  const quota = await retrieveUserQuota(accessToken, projectId);
  if (!quota?.buckets) {
    logGeminiDebugMessage(`Code Assist quota model lookup returned no buckets for project: ${projectId}`);
    return;
  }

  const modelIds = [...new Set(quota.buckets.map((bucket) => bucket.modelId).filter(Boolean))];
  if (modelIds.length === 0) {
    logGeminiDebugMessage(`Code Assist quota buckets contained no model IDs for project: ${projectId}`);
    return;
  }

  logGeminiDebugMessage(
    `Code Assist models visible via quota buckets (${projectId}): ${modelIds.join(", ")}`,
  );
}
