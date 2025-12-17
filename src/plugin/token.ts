import {
  GEMINI_CLIENT_ID,
  GEMINI_CLIENT_SECRET,
  GEMINI_PROVIDER_ID,
} from "../constants";
import { formatAllAccounts, formatRefreshParts, parseAllAccounts, parseRefreshParts } from "./auth";
import { clearCachedAuth, storeCachedAuth } from "./cache";
import { invalidateProjectContextCache } from "./project";
import type { Account, OAuthAuthDetails, PluginClient, RefreshParts } from "./types";

interface OAuthErrorPayload {
  error?:
    | string
    | {
        code?: string;
        status?: string;
        message?: string;
      };
  error_description?: string;
}

/**
 * Parses OAuth error payloads returned by Google token endpoints, tolerating varied shapes.
 */
function parseOAuthErrorPayload(text: string | undefined): { code?: string; description?: string } {
  if (!text) {
    return {};
  }

  try {
    const payload = JSON.parse(text) as OAuthErrorPayload;
    if (!payload || typeof payload !== "object") {
      return { description: text };
    }

    let code: string | undefined;
    if (typeof payload.error === "string") {
      code = payload.error;
    } else if (payload.error && typeof payload.error === "object") {
      code = payload.error.status ?? payload.error.code;
      if (!payload.error_description && payload.error.message) {
        return { code, description: payload.error.message };
      }
    }

    const description = payload.error_description;
    if (description) {
      return { code, description };
    }

    if (payload.error && typeof payload.error === "object" && payload.error.message) {
      return { code, description: payload.error.message };
    }

    return { code };
  } catch {
    return { description: text };
  }
}

/**
 * Refreshes a Gemini OAuth access token for a specific account.
 */
export async function refreshAccountToken(
  account: Account,
  allAuth: OAuthAuthDetails,
  client: PluginClient,
): Promise<Account | undefined> {
  const parts = account.parts;
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
      let errorText: string | undefined;
      try {
        errorText = await response.text();
      } catch {
        errorText = undefined;
      }

      const { code, description } = parseOAuthErrorPayload(errorText);
      const details = [code, description ?? errorText].filter(Boolean).join(": ");
      const baseMessage = `Gemini token refresh failed (${response.status} ${response.statusText})`;
      console.warn(`[Gemini OAuth] ${details ? `${baseMessage} - ${details}` : baseMessage}`);

      if (code === "invalid_grant") {
        console.warn(
          `[Gemini OAuth] Google revoked the stored refresh token for ${parts.email || "unknown account"}.`,
        );
        invalidateProjectContextCache(formatRefreshParts(parts));
        
        // Remove the invalid account from the pool
        const currentAccounts = parseAllAccounts(allAuth.refresh);
        const filtered = currentAccounts.filter(p => p.refreshToken !== parts.refreshToken);
        
        await client.auth.set({
          path: { id: GEMINI_PROVIDER_ID },
          body: {
            ...allAuth,
            refresh: formatAllAccounts(filtered),
          },
        });
      }

      return undefined;
    }

    const payload = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    const refreshedParts: RefreshParts = {
      ...parts,
      refreshToken: payload.refresh_token ?? parts.refreshToken,
    };

    const updatedAccount: Account = {
      parts: refreshedParts,
      access: payload.access_token,
      expires: Date.now() + payload.expires_in * 1000,
    };

    // Update the full auth record with the refreshed account
    const currentAccounts = parseAllAccounts(allAuth.refresh);
    const updatedPool = currentAccounts.map(p => 
      p.refreshToken === parts.refreshToken ? refreshedParts : p
    );

    const updatedAuth: OAuthAuthDetails = {
      ...allAuth,
      refresh: formatAllAccounts(updatedPool),
    };

    // Note: We don't store individual account access tokens in the global auth.refresh string,
    // but we can store them in cache for this session.
    storeCachedAuth({
      ...updatedAuth,
      access: updatedAccount.access,
      expires: updatedAccount.expires,
      refresh: formatRefreshParts(refreshedParts), // Use individual part for caching key
    });

    try {
      await client.auth.set({
        path: { id: GEMINI_PROVIDER_ID },
        body: updatedAuth,
      });
    } catch (storeError) {
      console.error("Failed to persist refreshed Gemini OAuth credentials:", storeError);
    }

    return updatedAccount;
  } catch (error) {
    console.error("Failed to refresh Gemini access token due to an unexpected error:", error);
    return undefined;
  }
}

/**
 * Refreshes a Gemini OAuth access token, updates persisted credentials, and handles revocation.
 * Legacy compatibility.
 */
export async function refreshAccessToken(
  auth: OAuthAuthDetails,
  client: PluginClient,
): Promise<OAuthAuthDetails | undefined> {
  const accounts = parseAllAccounts(auth.refresh);
  if (accounts.length === 0) return undefined;

  const firstAccount: Account = {
    parts: accounts[0],
    access: auth.access,
    expires: auth.expires,
  };

  const updated = await refreshAccountToken(firstAccount, auth, client);
  if (!updated) return undefined;

  return {
    ...auth,
    access: updated.access,
    expires: updated.expires,
    refresh: auth.refresh, // Keep full pool in refresh
  };
}
