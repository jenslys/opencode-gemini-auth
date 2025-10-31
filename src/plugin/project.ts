import {
  CODE_ASSIST_HEADERS,
  GEMINI_CODE_ASSIST_ENDPOINT,
} from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import type {
  OAuthAuthDetails,
  PluginClient,
  ProjectContextResult,
} from "./types";

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
  if (!auth.access) {
    return { auth, effectiveProjectId: "" };
  }

  const parts = parseRefreshParts(auth.refresh);
  if (parts.projectId || parts.managedProjectId) {
    return {
      auth,
      effectiveProjectId: parts.projectId || parts.managedProjectId || "",
    };
  }

  const loadResult = await loadManagedProject(auth.access);
  let managedProjectId = loadResult.managedProjectId;

  if (!managedProjectId && loadResult.needsOnboarding) {
    managedProjectId = await onboardManagedProject(auth.access);
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
      path: { id: "gemini-cli" },
      body: updatedAuth,
    });

    return { auth: updatedAuth, effectiveProjectId: managedProjectId };
  }

  return { auth, effectiveProjectId: "" };
}
