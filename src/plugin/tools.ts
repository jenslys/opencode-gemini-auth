import { tool } from "@opencode-ai/plugin";
import { getGlobalState } from "./state";
import { isOAuthAuth, accessTokenExpired } from "./auth";
import { refreshAccessToken } from "./token";
import { ensureProjectContext } from "./project";
import { GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import type { RetrieveUserQuotaResponse } from "./types";

export const geminiQuota = tool({
  description: "Retrieves the current user's quota usage for Gemini models.",
  args: {},
  execute: async (_args, _ctx) => {
    const { getAuth, client } = getGlobalState();
    
    if (!getAuth || !client) {
      throw new Error("Gemini plugin not initialized. Please ensure the provider is configured.");
    }

    let auth = await getAuth();
    if (!isOAuthAuth(auth)) {
      throw new Error("Quota retrieval is only available for OAuth authentication.");
    }

    if (accessTokenExpired(auth)) {
      const refreshed = await refreshAccessToken(auth, client);
      if (refreshed) {
        auth = refreshed;
      } else {
        throw new Error("Failed to refresh access token.");
      }
    }

    const projectContext = await ensureProjectContext(auth, client);
    const projectId = projectContext.effectiveProjectId;

    const url = `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`;
    
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${auth.access}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        project: projectId
      })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to retrieve quota: ${response.status} ${response.statusText} - ${text}`);
    }

    const data = await response.json() as RetrieveUserQuotaResponse;
    return JSON.stringify(data, null, 2);
  },
});
