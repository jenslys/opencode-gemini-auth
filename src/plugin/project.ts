import {
  CODE_ASSIST_HEADERS,
  GEMINI_CODE_ASSIST_ENDPOINT,
  GEMINI_PROVIDER_ID,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import type {
  OAuthAuthDetails,
  PluginClient,
  ProjectContextResult,
} from "./types";

const projectContextResultCache = new Map<string, ProjectContextResult>();
const projectContextPendingCache = new Map<string, Promise<ProjectContextResult>>();

function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}

export function invalidateProjectContextCache(refresh?: string): void {
  if (!refresh) {
    projectContextPendingCache.clear();
    projectContextResultCache.clear();
    return;
  }
  projectContextPendingCache.delete(refresh);
  projectContextResultCache.delete(refresh);
}

export async function loadManagedProject(accessToken: string): Promise<{
  managedProjectId?: string;
  needsOnboarding: boolean;
}> {
  try {
    const response = await fetch(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...CODE_ASSIST_HEADERS,
        },
        body: JSON.stringify({
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      },
    );

    if (!response.ok) {
      return { needsOnboarding: false };
    }

    const payload = (await response.json()) as {
      cloudaicompanionProject?: string;
      currentTier?: string;
    };

    if (payload.cloudaicompanionProject) {
      return {
        managedProjectId: payload.cloudaicompanionProject,
        needsOnboarding: false,
      };
    }

    return { needsOnboarding: !payload.currentTier };
  } catch (error) {
    console.error("Failed to load Gemini managed project:", error);
    return { needsOnboarding: false };
  }
}

export async function pollOperation(
  accessToken: string,
  operationName: string,
  attempts = 10,
  intervalMs = 2000,
): Promise<string | undefined> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    try {
      const response = await fetch(
        `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal/operations/${operationName}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as {
        done?: boolean;
        response?: {
          cloudaicompanionProject?: {
            id?: string;
          };
        };
      };

      const projectId = payload.response?.cloudaicompanionProject?.id;
      if (payload.done && projectId) {
        return projectId;
      }
    } catch (error) {
      console.error("Failed to poll Gemini onboarding operation:", error);
    }
  }
  return undefined;
}

export async function onboardManagedProject(
  accessToken: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...CODE_ASSIST_HEADERS,
        },
        body: JSON.stringify({
          tierId: "FREE",
          metadata: {
            ideType: "IDE_UNSPECIFIED",
            platform: "PLATFORM_UNSPECIFIED",
            pluginType: "GEMINI",
          },
        }),
      },
    );

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      done?: boolean;
      name?: string;
      response?: {
        cloudaicompanionProject?: {
          id?: string;
        };
      };
    };

    if (payload.done && payload.response?.cloudaicompanionProject?.id) {
      return payload.response.cloudaicompanionProject.id;
    }

    if (!payload.done && payload.name) {
      return pollOperation(accessToken, payload.name);
    }

    return undefined;
  } catch (error) {
    console.error("Failed to onboard Gemini managed project:", error);
    return undefined;
  }
}

export async function ensureProjectContext(
  auth: OAuthAuthDetails,
  client: PluginClient,
): Promise<ProjectContextResult> {
  const accessToken = auth.access;
  if (!accessToken) {
    return { auth, effectiveProjectId: "" };
  }

  const cacheKey = getCacheKey(auth);
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

  const resolveContext = async (): Promise<ProjectContextResult> => {
    const parts = parseRefreshParts(auth.refresh);
    if (parts.projectId || parts.managedProjectId) {
      return {
        auth,
        effectiveProjectId: parts.projectId || parts.managedProjectId || "",
      };
    }

    const loadResult = await loadManagedProject(accessToken);
    let managedProjectId = loadResult.managedProjectId;

    if (!managedProjectId && loadResult.needsOnboarding) {
      managedProjectId = await onboardManagedProject(accessToken);
    }

    if (managedProjectId) {
      const updatedAuth: OAuthAuthDetails = {
        ...auth,
        refresh: formatRefreshParts({
          refreshToken: parts.refreshToken,
          projectId: parts.projectId,
          managedProjectId,
        }),
      };

      await client.auth.set({
        path: { id: GEMINI_PROVIDER_ID },
        body: updatedAuth,
      });

      return { auth: updatedAuth, effectiveProjectId: managedProjectId };
    }

    return { auth, effectiveProjectId: "" };
  };

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
