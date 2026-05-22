import { GEMINI_PROVIDER_ID } from "./constants";
import { geminiFetch } from "./fetch";
import { AccountPool } from "./plugin/account-pool";
import { AccountManager } from "./plugin/account-manager";
import { accessTokenExpired, isOAuthAuth } from "./plugin/auth";
import { createOAuthAuthorizeMethod, createAddAccountAuthMethod } from "./plugin/oauth-authorize";
import { resolveCachedAuth } from "./plugin/cache";
import { loadAccountsFromDisk, saveAccountsToDisk } from "./plugin/config-store";
import { ensureProjectContext, ensureProjectContextForAccount, retrieveUserQuota } from "./plugin/project";
import {
  createGeminiQuotaTool,
  GEMINI_QUOTA_TOOL_NAME,
} from "./plugin/quota";
import { isGeminiDebugEnabled, logGeminiDebugMessage, startGeminiDebugRequest } from "./plugin/debug";
import { maybeShowGeminiCapacityToast, maybeShowGeminiTestToast } from "./plugin/notify";
import {
  resolveAccountsFromProvider,
  resolveConfiguredProjectId,
  resolveConfiguredProjectIdFromClient,
  resolveConfiguredProjectIdFromConfig,
  resolveProjectIdForAccount,
} from "./plugin/provider";
import {
  isGenerativeLanguageRequest,
  parseGenerativeLanguageRequest,
  prepareGeminiRequest,
  type ThinkingConfigDefaults,
  transformGeminiResponse,
} from "./plugin/request";
import { fetchWithRetry } from "./plugin/retry";
import { refreshAccessToken, refreshAccessTokenForAccount } from "./plugin/token";
import type {
  GeminiAccount,
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  Provider,
} from "./plugin/types";

const GEMINI_QUOTA_COMMAND = "gquota";
const GEMINI_QUOTA_COMMAND_TEMPLATE = `Retrieve Gemini Code Assist quota usage for the current authenticated account.

Immediately call \`${GEMINI_QUOTA_TOOL_NAME}\` with no arguments and return its output verbatim.
Do not call other tools.
`;
let latestGeminiAuthResolver: GetAuth | undefined;
let latestGeminiConfiguredProjectId: string | undefined;
let latestGeminiUserAgentModel: string | undefined;
let latestGeminiPool: AccountPool | undefined;

/**
 * Registers the Gemini OAuth provider for Opencode, handling auth, request rewriting,
 * debug logging, and response normalization for Gemini Code Assist endpoints.
 */
export const GeminiCLIOAuthPlugin = async (
  { client }: PluginContext,
): Promise<PluginResult> => {
  const resolveLatestConfiguredProjectId = async (provider?: Provider): Promise<string | undefined> => {
    const configProjectId =
      (await resolveConfiguredProjectIdFromClient(client)) ?? latestGeminiConfiguredProjectId;
    const resolvedProjectId = resolveConfiguredProjectId({
      provider,
      configProjectId,
    });
    latestGeminiConfiguredProjectId = resolvedProjectId;
    return resolvedProjectId;
  };

  return {
    config: async (config) => {
      latestGeminiConfiguredProjectId = resolveConfiguredProjectIdFromConfig(config);
      config.command = config.command || {};
      config.command[GEMINI_QUOTA_COMMAND] = {
        description: "Show Gemini Code Assist quota usage",
        template: GEMINI_QUOTA_COMMAND_TEMPLATE,
      };
    },
    tool: {
      [GEMINI_QUOTA_TOOL_NAME]: createGeminiQuotaTool({
        client,
        getAuthResolver: () => latestGeminiAuthResolver,
        getConfiguredProjectId: () => latestGeminiConfiguredProjectId,
        getUserAgentModel: () => latestGeminiUserAgentModel,
        getPool: () => latestGeminiPool,
      }),
    },
    auth: {
      provider: GEMINI_PROVIDER_ID,
      loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | null> => {
        latestGeminiAuthResolver = getAuth;
        const auth = await getAuth();
        if (!isOAuthAuth(auth)) {
          return null;
        }

        await resolveLatestConfiguredProjectId(provider);
        normalizeProviderModelCosts(provider);
        const thinkingConfigDefaults = resolveThinkingConfigDefaults(provider);

        // Initialize AccountPool from disk, then config accounts[], or pool-of-one
        if (!latestGeminiPool) {
          const diskAccounts = await loadAccountsFromDisk() || [];
          const configAccounts = resolveAccountsFromProvider(provider) || [];
          
          // Merge accounts from both sources, deduplicating by ID (config accounts take precedence for overriding)
          const mergedAccountsMap = new Map<string, GeminiAccount>();
          
          for (const acc of diskAccounts) {
            mergedAccountsMap.set(acc.id, acc);
          }
          for (const acc of configAccounts) {
            mergedAccountsMap.set(acc.id, acc);
          }
          
          const accounts = Array.from(mergedAccountsMap.values());

          if (accounts && accounts.length > 0) {
            latestGeminiPool = new AccountPool({ accounts, strategy: "health-weighted" });
            for (const account of accounts) {
              // Hydrate the matching account from the global getAuth() if it's the primary one
              if (auth.refresh && account.refreshToken === auth.refresh) {
                latestGeminiPool.updateAuth(account.id, auth);
              }
            }
          } else {
            const singleAccount: GeminiAccount = {
              id: auth.refresh.split("|")[0] || "default",
              refreshToken: auth.refresh,
              enabled: true,
            };
            latestGeminiPool = AccountPool.fromSingleAccount(singleAccount);
            latestGeminiPool.updateAuth(singleAccount.id, auth);
          }
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            if (!isGenerativeLanguageRequest(input)) {
              return geminiFetch(input, init);
            }

            // Select account from pool
            const requestTarget = parseGenerativeLanguageRequest(input);
            const model = requestTarget?.effectiveModel;
            const url = toUrlString(input);

            let selected = latestGeminiPool?.select(model, url);
            if (!selected) {
              return geminiFetch(input, init);
            }

            const maxAttempts = latestGeminiPool ? latestGeminiPool.count() : 1;
            let attempt = 0;
            let lastResponse: Response | null = null;
            let lastTransformedModel: string | undefined = undefined;
            let lastDebugContext: any = null;
            let lastProjectContext: any = null;

            let lastTransformedStreaming: boolean = false;

            while (attempt < maxAttempts) {
              attempt++;

              const currentAccountId = selected.account.id;

              // Refresh token if needed
              if (accessTokenExpired(selected.auth)) {
                try {
                  const refreshed = await refreshAccessTokenForAccount(latestGeminiPool!, currentAccountId, client);
                  if (refreshed) {
                    selected = latestGeminiPool!.getAccount(currentAccountId);
                  }
                } catch (error) {
                  const message = error instanceof Error ? error.message : String(error);
                  const isTimeout = message.includes("timeout");
                  logGeminiDebugMessage(`Token refresh for account ${currentAccountId} failed: ${message}`);
                  
                  // Cooldown account and try next
                  latestGeminiPool!.cooldownAccount(
                    currentAccountId, 
                    model ?? "all", 
                    60000, 
                    isTimeout ? "REFRESH_TIMEOUT" : "REFRESH_ERROR"
                  );
                  selected = latestGeminiPool!.select(model, url);
                  if (!selected) break;
                  continue;
                }

                if (!selected?.auth.access) {
                  // If this account can't refresh, cooldown and try next
                  latestGeminiPool!.cooldownAccount(currentAccountId, model ?? "all", 60000, "AUTH_FAILED");
                  selected = latestGeminiPool!.select(model, url);
                  if (!selected) break;
                  continue;
                }
              }

              const requestUserAgentModel = model;
              if (requestUserAgentModel) {
                latestGeminiUserAgentModel = requestUserAgentModel;
              }

              // Resolve project context for this account
              const configuredProjectId = resolveProjectIdForAccount(
                selected.account,
                await resolveLatestConfiguredProjectId(provider),
              );
              const projectContext = await ensureProjectContextForAccount(
                selected.auth,
                client,
                selected.account.id,
                configuredProjectId,
                requestUserAgentModel,
              );
              lastProjectContext = projectContext;

              await maybeShowGeminiTestToast(client, projectContext.effectiveProjectId);
              await maybeLogAvailableQuotaModels(
                selected.auth.access!,
                projectContext.effectiveProjectId,
                requestUserAgentModel,
              );

              const transformed = prepareGeminiRequest(
                input,
                init,
                selected.auth.access!,
                projectContext.effectiveProjectId,
                thinkingConfigDefaults,
              );
              lastTransformedModel = transformed.requestedModel;
              lastTransformedStreaming = transformed.streaming;

              const debugContext = startGeminiDebugRequest({
                originalUrl: toUrlString(input),
                resolvedUrl: toUrlString(transformed.request),
                method: transformed.init.method,
                headers: transformed.init.headers,
                body: transformed.init.body,
                streaming: transformed.streaming,
                projectId: projectContext.effectiveProjectId,
              });
              lastDebugContext = debugContext;

              /**
               * Retry transport/429 failures while preserving the requested model.
               * We intentionally do not auto-downgrade model tiers to avoid misleading users.
               */
              const response = await fetchWithRetry(transformed.request, transformed.init, selected.account.id);
              lastResponse = response;

              // Report result to pool (handles success, failure, and 401 circuit breaker)
              latestGeminiPool!.reportResult(selected.account.id, response.status);

              if (response.ok) {
                break; // Success! Exit the loop.
              } else {
                // Check for terminal 429 to cooldown this account
                if (response.status === 429 && response.headers.get("X-Gemini-Terminal-429") === "true") {
                  const reason = response.headers.get("X-Gemini-429-Reason") ?? "UNKNOWN";
                  
                  // Default 60s cooldown (C-02) or honor Retry-After
                  let durationMs = 60000;
                  const retryAfter = response.headers.get("Retry-After");
                  if (retryAfter) {
                    const parsed = parseInt(retryAfter, 10);
                    if (!isNaN(parsed)) {
                      durationMs = parsed * 1000;
                    } else {
                      const date = Date.parse(retryAfter);
                      if (!isNaN(date)) {
                        durationMs = Math.max(0, date - Date.now());
                      }
                    }
                  }

                  latestGeminiPool!.cooldownAccount(selected.account.id, model ?? "all", durationMs, reason);
                  
                  // Try to select another account
                  const nextAccount = latestGeminiPool!.select(model, url);
                  if (!nextAccount || nextAccount.account.id === selected.account.id) {
                    // No other healthy accounts available, break and return the 429
                    break;
                  }
                  selected = nextAccount;
                  continue; // Loop again with the new account
                }
                
                // If it's not a terminal 429 (e.g. 500 server error, 400 bad request), 
                // we don't rotate accounts. We just return the error.
                break; 
              }
            }

            // Fallback if loop finishes without a response
            if (!lastResponse) {
               return geminiFetch(input, init);
            }

            await maybeShowGeminiCapacityToast(
              client,
              lastResponse,
              lastProjectContext?.effectiveProjectId ?? "unknown",
              lastTransformedModel,
            );
            return transformGeminiResponse(
              lastResponse,
              lastTransformedStreaming,
              lastDebugContext,
              lastTransformedModel,
            );
          },
        };
      },
      methods: [
        {
          label: "OAuth with Google (Gemini CLI)",
          type: "oauth",
          authorize: createOAuthAuthorizeMethod({
            getConfiguredProjectId: () => resolveLatestConfiguredProjectId(),
            getUserAgentModel: () => latestGeminiUserAgentModel,
          }),
        },
        createAddAccountAuthMethod(() => {
          if (!latestGeminiPool) {
            throw new Error("Gemini plugin not yet loaded (pool is undefined)");
          }
          return new AccountManager({
            pool: latestGeminiPool,
            client,
            onConfigUpdate: (accounts) => {
              saveAccountsToDisk(accounts).catch(console.error);
            }
          });
        }),
        {
          provider: GEMINI_PROVIDER_ID,
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  };
};

export const GoogleOAuthPlugin = GeminiCLIOAuthPlugin;
const loggedQuotaModelsByProject = new Set<string>();

function normalizeProviderModelCosts(provider: Provider): void {
  if (!provider?.models || typeof provider.models !== "object") {
    return;
  }
  for (const [modelId, model] of Object.entries(provider.models)) {
    if (!model || typeof model !== "object") {
      continue;
    }
    // Preserve existing cost fields while ensuring required fields exist
    const existingCost = model.cost;
    const isValidCost =
      existingCost &&
      typeof existingCost === "object" &&
      typeof existingCost.input === "number" &&
      typeof existingCost.output === "number";
    // Build full OpenCode cost shape including cache fields
    const normalizedCost = {
      input: isValidCost ? existingCost.input : 0,
      output: isValidCost ? existingCost.output : 0,
      cache: {
        read:
          isValidCost &&
          typeof existingCost.cache === "object" &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { read?: number }).read === "number"
            ? (existingCost.cache as { read: number }).read
            : 0,
        write:
          isValidCost &&
          typeof existingCost.cache === "object" &&
          existingCost.cache !== null &&
          typeof (existingCost.cache as { write?: number }).write === "number"
            ? (existingCost.cache as { write: number }).write
            : 0,
      },
    };
    model.cost = normalizedCost;
  }
}

function resolveThinkingConfigDefaults(provider: Provider): ThinkingConfigDefaults | undefined {
  const providerOptions =
    provider && typeof provider === "object"
      ? ((provider as { options?: Record<string, unknown> }).options ?? undefined)
      : undefined;
  const providerThinkingConfig = providerOptions?.thinkingConfig;

  const modelThinkingConfigByModel: Record<string, unknown> = {};
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const modelOptions = (model as { options?: Record<string, unknown> }).options;
    if (modelOptions && typeof modelOptions === "object" && "thinkingConfig" in modelOptions) {
      modelThinkingConfigByModel[modelId] = modelOptions.thinkingConfig;
    }
  }

  if (providerThinkingConfig === undefined && Object.keys(modelThinkingConfigByModel).length === 0) {
    return undefined;
  }

  return {
    provider: providerThinkingConfig,
    models: modelThinkingConfigByModel,
  };
}

async function ensureProjectContextOrThrow(
  authRecord: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
  userAgentModel?: string,
) {
  try {
    return await ensureProjectContext(authRecord, client, configuredProjectId, userAgentModel);
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
  userAgentModel?: string,
): Promise<void> {
  if (!isGeminiDebugEnabled() || !projectId) {
    return;
  }

  if (loggedQuotaModelsByProject.has(projectId)) {
    return;
  }
  loggedQuotaModelsByProject.add(projectId);

  const quota = await retrieveUserQuota(accessToken, projectId, userAgentModel);
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

/**
 * Returns the current AccountPool instance (for testing and quota tool access).
 */
export function getLatestGeminiPool(): AccountPool | undefined {
  return latestGeminiPool;
}

/**
 * Resets plugin module state for testing.
 */
export function resetPluginState(): void {
  latestGeminiPool = undefined;
  latestGeminiAuthResolver = undefined;
  latestGeminiConfiguredProjectId = undefined;
  latestGeminiUserAgentModel = undefined;
}
