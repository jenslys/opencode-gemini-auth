import type { AuthDetails, OAuthAuthDetails, RefreshParts } from "./types";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Splits a packed refresh string into its constituent refresh token and project IDs.
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
  };
}

/**
 * Serializes refresh token parts into the stored string format.
 */
export function formatRefreshParts(parts: RefreshParts): string {
  const projectSegment = parts.projectId ?? "";
  const base = `${parts.refreshToken}|${projectSegment}`;
  return parts.managedProjectId ? `${base}|${parts.managedProjectId}` : base;
}

/**
 * Determines whether an access token is expired or missing, with buffer for clock skew.
 */
export function accessTokenExpired(auth: OAuthAuthDetails): boolean {
  if (!auth.access || typeof auth.expires !== "number") {
    return true;
  }
  return auth.expires <= Date.now() + ACCESS_TOKEN_EXPIRY_BUFFER_MS;
}
