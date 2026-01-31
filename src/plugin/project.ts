import {
  CODE_ASSIST_HEADERS,
  GEMINI_CODE_ASSIST_ENDPOINT,
  GEMINI_PROVIDER_ID,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import { logGeminiDebugResponse, startGeminiDebugRequest } from "./debug";
import type {
  OAuthAuthDetails,
  PluginClient,
  ProjectContextResult,
} from "./types";

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

const FREE_TIER_ID = "free-tier";
const LEGACY_TIER_ID = "legacy-tier";

const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

interface GeminiUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
  name?: string;
  description?: string;
}

interface CloudAiCompanionProject {
  id?: string;
}

interface GeminiIneligibleTier {
  reasonMessage?: string;
}

interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | CloudAiCompanionProject;
  currentTier?: {
    id?: string;
    name?: string;
  };
  allowedTiers?: GeminiUserTier[];
  ineligibleTiers?: GeminiIneligibleTier[];
}

interface OnboardUserPayload {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

class ProjectIdRequiredError extends Error {
  /**
   * Error raised when a required Google Cloud project is missing during Gemini onboarding.
   */
  constructor() {
    super(
      "Google Gemini requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, then set `provider.google.options.projectId` in your Opencode config (or set OPENCODE_GEMINI_PROJECT_ID / GOOGLE_CLOUD_PROJECT).",
    );
  }
}

/**
 * Builds metadata headers required by the Code Assist API.
 */
function buildMetadata(projectId?: string, includeDuetProject = true): Record<string, string> {
  const metadata: Record<string, string> = {
    ideType: CODE_ASSIST_METADATA.ideType,
    platform: CODE_ASSIST_METADATA.platform,
    pluginType: CODE_ASSIST_METADATA.pluginType,
  };
  if (projectId && includeDuetProject) {
    metadata.duetProject = projectId;
  }
  return metadata;
}

/**
 * Normalizes project identifiers from API payloads or config.
 */
function normalizeProjectId(value?: string | CloudAiCompanionProject): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (typeof value === "object" && typeof value.id === "string") {
    const trimmed = value.id.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Selects the default tier ID from the allowed tiers list.
 */
function pickOnboardTier(allowedTiers?: GeminiUserTier[]): GeminiUserTier {
  if (allowedTiers && allowedTiers.length > 0) {
    for (const tier of allowedTiers) {
      if (tier?.isDefault) {
        return tier;
      }
    }
    return allowedTiers[0] ?? { id: LEGACY_TIER_ID, userDefinedCloudaicompanionProject: true };
  }
  return { id: LEGACY_TIER_ID, userDefinedCloudaicompanionProject: true };
}

/**
 * Builds a concise error message from ineligible tier payloads.
 */
function buildIneligibleTierMessage(tiers?: GeminiIneligibleTier[]): string | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const reasons = tiers
    .map((tier) => tier?.reasonMessage?.trim())
    .filter((message): message is string => !!message);
  if (reasons.length === 0) {
    return undefined;
  }
  return reasons.join(", ");
}

function isVpcScError(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") {
    return false;
  }
  const details = (error as { details?: unknown }).details;
  if (!Array.isArray(details)) {
    return false;
  }
  return details.some((detail) => {
    if (!detail || typeof detail !== "object") {
      return false;
    }
    const reason = (detail as { reason?: unknown }).reason;
    return reason === "SECURITY_POLICY_VIOLATED";
  });
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Promise-based delay utility.
 */
function wait(ms: number): Promise<void> {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/**
 * Generates a cache key for project context based on refresh token.
 */
function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

/**
 * Clears cached project context results and pending promises, globally or for a refresh key.
 */
export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }

  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);

  const prefix = `${refresh}|cfg:`;
  for (const key of projectContextPendingCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextPendingCache.delete(key);
    }
  }
  for (const key of projectContextResultCache.keys()) {
    if (key.startsWith(prefix)) {
      projectContextResultCache.delete(key);
    }
  }
}

/**
 * Loads managed project information for the given access token and optional project.
 */
export async function loadManagedProject(
  accessToken: string,
  projectId?: string,
): Promise<LoadCodeAssistPayload | null> {
  try {
    const metadata = buildMetadata(projectId);

    const requestBody: Record<string, unknown> = { metadata };
    if (projectId) {
      requestBody.cloudaicompanionProject = projectId;
    }
    const url = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...CODE_ASSIST_HEADERS,
    };
    const debugContext = startGeminiDebugRequest({
      originalUrl: url,
      resolvedUrl: url,
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      streaming: false,
      projectId,
    });

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    let responseBody: string | undefined;
    if (debugContext || !response.ok) {
      try {
        responseBody = await response.clone().text();
      } catch {
        responseBody = undefined;
      }
    }
    if (debugContext) {
      logGeminiDebugResponse(debugContext, response, { body: responseBody });
    }

    if (!response.ok) {
      if (responseBody) {
        const parsed = parseJsonSafe(responseBody);
        if (isVpcScError(parsed)) {
          return { currentTier: { id: "standard-tier" } };
        }
      }
      return null;
    }

    if (responseBody) {
      return parseJsonSafe(responseBody) as LoadCodeAssistPayload;
    }

    return (await response.json()) as LoadCodeAssistPayload;
  } catch (error) {
    console.error("Failed to load Gemini managed project:", error);
    return null;
  }
}


/**
 * Onboards a managed project for the user, optionally retrying until completion.
 */
export async function onboardManagedProject(
  accessToken: string,
  tierId: string,
  projectId?: string,
  attempts = 10,
  delayMs = 5000,
): Promise<string | undefined> {
  const isFreeTier = tierId === FREE_TIER_ID;
  const metadata = buildMetadata(projectId, !isFreeTier);
  const requestBody: Record<string, unknown> = {
    tierId,
    metadata,
  };

  if (!isFreeTier) {
    if (!projectId) {
      throw new ProjectIdRequiredError();
    }
    requestBody.cloudaicompanionProject = projectId;
  }

  const baseUrl = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal`;
  const onboardUrl = `${baseUrl}:onboardUser`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    ...CODE_ASSIST_HEADERS,
  };

  try {
    const debugContext = startGeminiDebugRequest({
      originalUrl: onboardUrl,
      resolvedUrl: onboardUrl,
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      streaming: false,
      projectId,
    });

    const response = await fetch(onboardUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    if (debugContext) {
      let responseBody: string | undefined;
      try {
        responseBody = await response.clone().text();
      } catch {
        responseBody = undefined;
      }
      logGeminiDebugResponse(debugContext, response, { body: responseBody });
    }

    if (!response.ok) {
      return undefined;
    }

    let payload = (await response.json()) as OnboardUserPayload;
    if (!payload.done && payload.name) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(delayMs);
        const operationUrl = `${baseUrl}/${payload.name}`;
        const opDebugContext = startGeminiDebugRequest({
          originalUrl: operationUrl,
          resolvedUrl: operationUrl,
          method: "GET",
          headers,
          streaming: false,
          projectId,
        });
        const opResponse = await fetch(operationUrl, {
          method: "GET",
          headers,
        });
        if (opDebugContext) {
          let responseBody: string | undefined;
          try {
            responseBody = await opResponse.clone().text();
          } catch {
            responseBody = undefined;
          }
          logGeminiDebugResponse(opDebugContext, opResponse, { body: responseBody });
        }
        if (!opResponse.ok) {
          return undefined;
        }
        payload = (await opResponse.json()) as OnboardUserPayload;
        if (payload.done) {
          break;
        }
      }
    }

    const managedProjectId = payload.response?.cloudaicompanionProject?.id;
    if (payload.done && managedProjectId) {
      return managedProjectId;
    }
    if (payload.done && projectId) {
      return projectId;
    }
  } catch (error) {
    console.error("Failed to onboard Gemini managed project:", error);
    return undefined;
  }

  return undefined;
}

/**
 * Resolves a project context for an access token, optionally persisting updated auth.
 */
export async function resolveProjectContextFromAccessToken(
  auth: OAuthAuthDetails,
  accessToken: string,
  configuredProjectId?: string,
  persistAuth?: (auth: OAuthAuthDetails) => Promise<void>,
): Promise<ProjectContextResult> {
  const parts = parseRefreshParts(auth.refresh);
  const effectiveConfiguredProjectId = configuredProjectId?.trim() || undefined;
  const projectId = effectiveConfiguredProjectId ?? parts.projectId;

  if (projectId || parts.managedProjectId) {
    return {
      auth,
      effectiveProjectId: projectId || parts.managedProjectId || "",
    };
  }

  const loadPayload = await loadManagedProject(accessToken, projectId);
  if (!loadPayload) {
    throw new ProjectIdRequiredError();
  }

  const managedProjectId = normalizeProjectId(loadPayload.cloudaicompanionProject);
  if (managedProjectId) {
    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      refresh: formatRefreshParts({
        refreshToken: parts.refreshToken,
        projectId,
        managedProjectId,
      }),
    };

    if (persistAuth) {
      await persistAuth(updatedAuth);
    }

    return { auth: updatedAuth, effectiveProjectId: managedProjectId };
  }

  const currentTierId = loadPayload.currentTier?.id;
  if (currentTierId) {
    if (projectId) {
      return { auth, effectiveProjectId: projectId };
    }

    const ineligibleMessage = buildIneligibleTierMessage(loadPayload.ineligibleTiers);
    if (ineligibleMessage) {
      throw new Error(ineligibleMessage);
    }

    throw new ProjectIdRequiredError();
  }

  const tier = pickOnboardTier(loadPayload.allowedTiers);
  const tierId = tier.id ?? LEGACY_TIER_ID;

  if (tierId !== FREE_TIER_ID && !projectId) {
    throw new ProjectIdRequiredError();
  }

  const onboardedProjectId = await onboardManagedProject(accessToken, tierId, projectId);
  if (onboardedProjectId) {
    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      refresh: formatRefreshParts({
        refreshToken: parts.refreshToken,
        projectId,
        managedProjectId: onboardedProjectId,
      }),
    };

    if (persistAuth) {
      await persistAuth(updatedAuth);
    }

    return { auth: updatedAuth, effectiveProjectId: onboardedProjectId };
  }

  if (projectId) {
    return { auth, effectiveProjectId: projectId };
  }

  throw new ProjectIdRequiredError();
}

/**
 * Resolves an effective project ID for the current auth state, caching results per refresh token.
 */
export async function ensureProjectContext(
  auth: OAuthAuthDetails,
  client: PluginClient,
  configuredProjectId?: string,
): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = (() => {
    const base = getCacheKey(auth);
    if (!base) return undefined;
    const project = configuredProjectId?.trim() ?? "";
    return project ? `${base}|cfg:${project}` : base;
  })();
  if (cacheKey) {
    const cached = projectContextResultCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const pending = projectContextPendingCache.get(cacheKey);
    if (pending) {
      return pending;
    }
  }

  const resolveContext = async (): Promise<ProjectContextResult> =>
    resolveProjectContextFromAccessToken(
      auth,
      accessToken,
      configuredProjectId,
      async (updatedAuth) => {
        await client.auth.set({
          path: { id: GEMINI_PROVIDER_ID },
          body: updatedAuth,
        });
      },
    );

  if (!cacheKey) {
    return resolveContext();
  }

  const promise = resolveContext()
    .then((result) => {
      const nextKey = getCacheKey(result.auth) ?? cacheKey;
      projectContextPendingCache.delete(cacheKey);
      projectContextResultCache.set(nextKey, result);
      if (nextKey !== cacheKey) {
        projectContextResultCache.delete(cacheKey);
      }
      return result;
    })
    .catch((error) => {
      projectContextPendingCache.delete(cacheKey);
      throw error;
    });

  projectContextPendingCache.set(cacheKey, promise);
  return promise;
}
