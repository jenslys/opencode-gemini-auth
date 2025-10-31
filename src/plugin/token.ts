import { GEMINI_CLIENT_ID, GEMINI_CLIENT_SECRET } from "../constants";
import { formatRefreshParts, parseRefreshParts } from "./auth";
import type { OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
): Promise<OAuthAuthDetails | undefined> {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: parts.refreshToken,
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
      }),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      refreshToken: payload.refresh_token ?? parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    };

    const updatedAuth: OAuthAuthDetails = {
      ...auth,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
      refresh: formatRefreshParts(refreshedParts),
    };

    await client.auth.set({
      path: { id: "gemini-cli" },
      body: updatedAuth,
    });

    return updatedAuth;
  } catch (error) {
    console.error("Failed to refresh Gemini access token:", error);
    return undefined;
  }
}
