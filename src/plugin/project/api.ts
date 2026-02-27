import { CODE_ASSIST_HEADERS, GEMINI_CODE_ASSIST_ENDPOINT } from "../../constants";
import { logGeminiDebugResponse, startGeminiDebugRequest } from "../debug";
import { buildGeminiCliUserAgent } from "../user-agent";
import {
  FREE_TIER_ID,
  type LoadCodeAssistPayload,
  type OnboardUserPayload,
  type RetrieveUserQuotaResponse,
  ProjectIdRequiredError,
} from "./types";
import { buildMetadata, isVpcScError, parseJsonSafe, wait } from "./utils";

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
      "User-Agent": buildGeminiCliUserAgent(),
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
    const responseBody = await readResponseTextIfNeeded(response, !!debugContext);
    if (debugContext) {
      logGeminiDebugResponse(debugContext, response, { body: responseBody });
    }

    if (!response.ok) {
      if (responseBody && isVpcScError(parseJsonSafe(responseBody))) {
        return { currentTier: { id: "standard-tier" } };
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
  const requestBody: Record<string, unknown> = { tierId, metadata };

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
    "User-Agent": buildGeminiCliUserAgent(),
    ...CODE_ASSIST_HEADERS,
  };

  try {
    const response = await fetchWithDebug(onboardUrl, "POST", headers, requestBody, projectId);
    if (!response.ok) {
      return undefined;
    }

    let payload = (await response.json()) as OnboardUserPayload;
    if (!payload.done && payload.name) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(delayMs);
        const operationUrl = `${baseUrl}/${payload.name}`;
        const opResponse = await fetchWithDebug(operationUrl, "GET", headers, undefined, projectId);
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
 * Retrieves Code Assist quota buckets, which include model IDs visible to the current account/project.
 */
export async function retrieveUserQuota(
  accessToken: string,
  projectId: string,
): Promise<RetrieveUserQuotaResponse | null> {
  const url = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": buildGeminiCliUserAgent(),
    ...CODE_ASSIST_HEADERS,
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ project: projectId }),
    });

    if (!response.ok) {
      return null;
    }
    return (await response.json()) as RetrieveUserQuotaResponse;
  } catch {
    return null;
  }
}

async function fetchWithDebug(
  url: string,
  method: "GET" | "POST",
  headers: Record<string, string>,
  body: Record<string, unknown> | undefined,
  projectId?: string,
): Promise<Response> {
  const debugContext = startGeminiDebugRequest({
    originalUrl: url,
    resolvedUrl: url,
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    streaming: false,
    projectId,
  });
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (debugContext) {
    const responseBody = await readResponseTextIfNeeded(response, true);
    logGeminiDebugResponse(debugContext, response, { body: responseBody });
  }
  return response;
}

async function readResponseTextIfNeeded(response: Response, needed: boolean): Promise<string | undefined> {
  if (!needed && response.ok) {
    return undefined;
  }
  try {
    return await response.clone().text();
  } catch {
    return undefined;
  }
}
