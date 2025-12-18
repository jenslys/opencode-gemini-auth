import type { AuthDetails, OAuthAuthDetails, RefreshParts } from "./types";

const ACCESS_TOKEN_EXPIRY_BUFFER_MS = 60 * 1000;

export function isOAuthAuth(auth: AuthDetails): auth is OAuthAuthDetails {
  return auth.type === "oauth";
}

/**
 * Splits a packed refresh string into its constituent refresh token and project IDs.
 */
export function parseRefreshParts(refresh: string): RefreshParts {
  const [refreshToken = "", projectId = "", managedProjectId = "", email = ""] = (refresh ?? "").split("|");
  return {
    refreshToken,
    projectId: projectId || undefined,
    managedProjectId: managedProjectId || undefined,
    email: email || undefined,
  };
}

/**
 * Serializes refresh token parts into the stored string format.
 */
export function formatRefreshParts(parts: RefreshParts): string {
  const segments = [
    parts.refreshToken,
    parts.projectId ?? "",
    parts.managedProjectId ?? "",
    parts.email ?? "",
  ];
  return segments.join("|").replace(/\|+$/, "");
}

/**
 * Parses all accounts from a multi-account refresh string.
 */
export function parseAllAccounts(refresh: string): RefreshParts[] {
  if (!refresh) return [];
  return refresh.split(";").map(parseRefreshParts).filter(p => p.refreshToken);
}

/**
 * Formats multiple account parts into a single stored string.
 */
export function formatAllAccounts(accounts: RefreshParts[]): string {
  return accounts.map(formatRefreshParts).join(";");
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
