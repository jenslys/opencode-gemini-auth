import type { ThinkingConfig } from "./types";

/**
 * Normalizes thinkingConfig aliases into canonical Gemini field names.
 */
export function normalizeThinkingConfig(config: unknown): ThinkingConfig | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const record = config as Record<string, unknown>;
  const budgetRaw = record.thinkingBudget ?? record.thinking_budget;
  const levelRaw = record.thinkingLevel ?? record.thinking_level;
  const includeRaw = record.includeThoughts ?? record.include_thoughts;

  const thinkingBudget = typeof budgetRaw === "number" && Number.isFinite(budgetRaw) ? budgetRaw : undefined;
  const thinkingLevel =
    typeof levelRaw === "string" && levelRaw.trim().length > 0 ? levelRaw.trim().toLowerCase() : undefined;
  const includeThoughts = typeof includeRaw === "boolean" ? includeRaw : undefined;

  if (thinkingBudget === undefined && thinkingLevel === undefined && includeThoughts === undefined) {
    return undefined;
  }

  const thinkingEnabled =
    (thinkingBudget !== undefined && thinkingBudget > 0) ||
    thinkingLevel !== undefined;
  const finalIncludeThoughts = thinkingEnabled ? includeThoughts ?? false : false;

  const normalized: ThinkingConfig = {};
  if (thinkingBudget !== undefined) {
    normalized.thinkingBudget = thinkingBudget;
  }
  if (thinkingLevel !== undefined) {
    normalized.thinkingLevel = thinkingLevel;
  }
  normalized.includeThoughts = finalIncludeThoughts;

  return normalized;
}
