import { tool } from "@opencode-ai/plugin";
import { accessTokenExpired, isOAuthAuth } from "./auth";
import { resolveCachedAuth } from "./cache";
import { ensureProjectContext, retrieveUserQuota } from "./project";
import type { RetrieveUserQuotaBucket } from "./project/types";
import { refreshAccessToken } from "./token";
import type { GetAuth, PluginClient } from "./types";

export const GEMINI_QUOTA_TOOL_NAME = "gemini_quota";

interface GeminiQuotaToolDependencies {
  client: PluginClient;
  getAuthResolver: () => GetAuth | undefined;
  getConfiguredProjectId: () => string | undefined;
}

export function createGeminiQuotaTool({
  client,
  getAuthResolver,
  getConfiguredProjectId,
}: GeminiQuotaToolDependencies) {
  return tool({
    description:
      "Retrieve current Gemini Code Assist quota usage for the authenticated user and project.",
    args: {},
    async execute() {
      const getAuth = getAuthResolver();
      if (!getAuth) {
        return "Gemini quota is unavailable before Google auth is initialized. Authenticate with the Google provider and retry.";
      }

      const auth = await getAuth();
      if (!isOAuthAuth(auth)) {
        return "Gemini quota requires OAuth with Google. Run `opencode auth login` and choose `OAuth with Google (Gemini CLI)`.";
      }

      let authRecord = resolveCachedAuth(auth);
      if (accessTokenExpired(authRecord)) {
        const refreshed = await refreshAccessToken(authRecord, client);
        if (!refreshed?.access) {
          return "Gemini quota lookup failed because the access token could not be refreshed. Re-authenticate and retry.";
        }
        authRecord = refreshed;
      }

      if (!authRecord.access) {
        return "Gemini quota lookup failed because no access token is available. Re-authenticate and retry.";
      }

      try {
        const projectContext = await ensureProjectContext(
          authRecord,
          client,
          getConfiguredProjectId(),
        );
        if (!projectContext.effectiveProjectId) {
          return "Gemini quota lookup failed because no Google Cloud project could be resolved.";
        }

        const quota = await retrieveUserQuota(
          authRecord.access,
          projectContext.effectiveProjectId,
        );
        if (!quota?.buckets?.length) {
          return `No Gemini quota buckets were returned for project \`${projectContext.effectiveProjectId}\`.`;
        }

        return formatGeminiQuotaOutput(
          projectContext.effectiveProjectId,
          quota.buckets,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        return `Gemini quota lookup failed: ${message}`;
      }
    },
  });
}

export function formatGeminiQuotaOutput(
  projectId: string,
  buckets: RetrieveUserQuotaBucket[],
): string {
  const sortedBuckets = [...buckets].sort(compareQuotaBuckets);
  const lines = [`Gemini quota usage for project \`${projectId}\``, ""];

  for (const bucket of sortedBuckets) {
    lines.push(formatQuotaBucketLine(bucket));
  }

  return lines.join("\n");
}

function compareQuotaBuckets(
  left: RetrieveUserQuotaBucket,
  right: RetrieveUserQuotaBucket,
): number {
  const leftModel = left.modelId ?? "";
  const rightModel = right.modelId ?? "";
  if (leftModel !== rightModel) {
    return leftModel.localeCompare(rightModel);
  }

  const leftTokenType = left.tokenType ?? "";
  const rightTokenType = right.tokenType ?? "";
  if (leftTokenType !== rightTokenType) {
    return leftTokenType.localeCompare(rightTokenType);
  }

  return (left.resetTime ?? "").localeCompare(right.resetTime ?? "");
}

function formatQuotaBucketLine(bucket: RetrieveUserQuotaBucket): string {
  const modelId = bucket.modelId?.trim() || "unknown-model";
  const tokenType = bucket.tokenType?.trim();
  const usageRemaining = formatUsageRemaining(bucket);
  const resetLabel = formatRelativeResetTime(bucket.resetTime);
  const subject = tokenType ? `${modelId} (${tokenType})` : modelId;

  return resetLabel
    ? `- ${subject}: ${usageRemaining}, ${resetLabel}`
    : `- ${subject}: ${usageRemaining}`;
}

function formatUsageRemaining(bucket: RetrieveUserQuotaBucket): string {
  const remainingAmount = formatRemainingAmount(bucket.remainingAmount);
  const remainingFraction = bucket.remainingFraction;
  const hasFraction =
    typeof remainingFraction === "number" && Number.isFinite(remainingFraction);

  if (hasFraction) {
    const percent = Math.max(0, remainingFraction * 100).toFixed(1);
    return remainingAmount
      ? `${percent}% remaining (${remainingAmount} left)`
      : `${percent}% remaining`;
  }

  if (remainingAmount) {
    return `${remainingAmount} remaining`;
  }

  return "remaining unknown";
}

function formatRemainingAmount(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return parsed.toLocaleString("en-US");
}

export function formatRelativeResetTime(resetTime: string | undefined): string | undefined {
  if (!resetTime) {
    return undefined;
  }

  const resetAt = new Date(resetTime).getTime();
  if (Number.isNaN(resetAt)) {
    return undefined;
  }

  const diffMs = resetAt - Date.now();
  if (diffMs <= 0) {
    return "reset pending";
  }

  const totalMinutes = Math.ceil(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) {
    return `resets in ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `resets in ${hours}h`;
  }
  return `resets in ${minutes}m`;
}
