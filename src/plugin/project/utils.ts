import type { OAuthAuthDetails } from "../types";
import {
  CODE_ASSIST_METADATA,
  LEGACY_TIER_ID,
  type CloudAiCompanionProject,
  type GeminiIneligibleTier,
  type GeminiUserTier,
} from "./types";

/**
 * Builds metadata headers required by the Code Assist API.
 */
export function buildMetadata(projectId?: string, includeDuetProject = true): Record<string, string> {
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
export function normalizeProjectId(value?: string | CloudAiCompanionProject): string | undefined {
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
export function pickOnboardTier(allowedTiers?: GeminiUserTier[]): GeminiUserTier {
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
export function buildIneligibleTierMessage(tiers?: GeminiIneligibleTier[]): string | undefined {
  if (!tiers || tiers.length === 0) {
    return undefined;
  }
  const reasons = tiers
    .map((tier) => tier?.reasonMessage?.trim())
    .filter((message): message is string => !!message);
  return reasons.length > 0 ? reasons.join(", ") : undefined;
}

/**
 * Detects VPC-SC errors from Cloud Code responses.
 */
export function isVpcScError(payload: unknown): boolean {
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
    return (detail as { reason?: unknown }).reason === "SECURITY_POLICY_VIOLATED";
  });
}

/**
 * Safely parses JSON, returning null on failure.
 */
export function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Promise-based delay utility.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Generates a cache key for project context based on refresh token.
 */
export function getCacheKey(auth: OAuthAuthDetails): string | undefined {
  const refresh = auth.refresh?.trim();
  return refresh ? refresh : undefined;
}
