import { GEMINI_CODE_ASSIST_ENDPOINT, CODE_ASSIST_HEADERS } from "../constants";

/**
 * Represents a single quota bucket for a specific model and token type.
 */
export interface QuotaBucket {
  resetTime: string;
  tokenType: string;
  modelId: string;
  remainingFraction: number;
}

/**
 * Response from the retrieveUserQuota API endpoint.
 */
export interface QuotaResponse {
  buckets: QuotaBucket[];
}

/**
 * Retrieves the user's quota information from the Gemini Code Assist API.
 * 
 * @param accessToken - Valid OAuth access token
 * @returns QuotaResponse containing quota buckets for all models
 * @throws Error if the API request fails
 */
export async function retrieveUserQuota(
  accessToken: string,
): Promise<QuotaResponse> {
  const response = await fetch(
    `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:retrieveUserQuota`,
    {
      method: "POST",
      headers: {
        ...CODE_ASSIST_HEADERS,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Failed to retrieve quota: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = (await response.json()) as QuotaResponse;
  return data;
}

/**
 * Formats a quota bucket for display.
 */
function formatBucket(bucket: QuotaBucket): string {
  const percentage = (bucket.remainingFraction * 100).toFixed(1);
  const resetDate = new Date(bucket.resetTime);
  const now = new Date();
  const hoursUntilReset = Math.max(
    0,
    (resetDate.getTime() - now.getTime()) / (1000 * 60 * 60),
  );

  const resetInfo =
    hoursUntilReset < 24
      ? `resets in ${hoursUntilReset.toFixed(1)}h`
      : `resets ${resetDate.toLocaleDateString()}`;

  return `  ${bucket.modelId}: ${percentage}% remaining (${resetInfo})`;
}

/**
 * Formats the full quota response for display in the TUI.
 */
export function formatQuotaResponse(quota: QuotaResponse): string {
  if (!quota.buckets || quota.buckets.length === 0) {
    return "No quota information available.";
  }

  const lines = ["Gemini API Quota:", ""];
  
  // Group by model
  const byModel = new Map<string, QuotaBucket[]>();
  for (const bucket of quota.buckets) {
    const existing = byModel.get(bucket.modelId) || [];
    existing.push(bucket);
    byModel.set(bucket.modelId, existing);
  }

  // Format each model's buckets
  for (const [modelId, buckets] of byModel.entries()) {
    for (const bucket of buckets) {
      lines.push(formatBucket(bucket));
    }
  }

  return lines.join("\n");
}
