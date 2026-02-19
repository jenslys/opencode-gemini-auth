import { GEMINI_PROVIDER_ID } from "../../constants";
import { formatRefreshParts, parseRefreshParts } from "../auth";
import type { OAuthAuthDetails, PluginClient, ProjectContextResult } from "../types";
import { loadManagedProject, onboardManagedProject } from "./api";
import { FREE_TIER_ID, LEGACY_TIER_ID, ProjectIdRequiredError } from "./types";
import { buildIneligibleTierMessage, getCacheKey, normalizeProjectId, pickOnboardTier } from "./utils";

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

/**
 * Clears cached project context results and pending promises.
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
 * Resolves a project context for an access token, optionally persisting updated auth.
 */
export async function resolveProjectContextFromAccessToken(
  auth: OAuthAuthDetails,
  accessToken: string,
  configuredProjectId?: string,
  persistAuth?: (auth: OAuthAuthDetails) => Promise<void>,
): Promise<ProjectContextResult> {
  const parts = parseRefreshParts(auth.refresh);
  const projectId = configuredProjectId?.trim() || parts.projectId;

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
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, managedProjectId);
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
    const updatedAuth = withProjectAuth(auth, parts.refreshToken, projectId, onboardedProjectId);
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

  const cacheKey = buildProjectCacheKey(auth, configuredProjectId);
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

function withProjectAuth(
  auth: OAuthAuthDetails,
  refreshToken: string,
  projectId: string | undefined,
  managedProjectId: string,
): OAuthAuthDetails {
  return {
    ...auth,
    refresh: formatRefreshParts({
      refreshToken,
      projectId,
      managedProjectId,
    }),
  };
}

function buildProjectCacheKey(auth: OAuthAuthDetails, configuredProjectId?: string): string | undefined {
  const base = getCacheKey(auth);
  if (!base) {
    return undefined;
  }
  const project = configuredProjectId?.trim() ?? "";
  return project ? `${base}|cfg:${project}` : base;
}
