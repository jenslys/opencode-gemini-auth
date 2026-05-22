/**
 * Canonical model mapping for Gemini.
 * Maps various aliases and formats to a single canonical name to ensure
 * cooldowns and quota tracking are consistent across requests.
 */

const MODEL_MAP: Record<string, string> = {
  "gemini-1.5-pro": "models/gemini-1.5-pro",
  "gemini-1.5-flash": "models/gemini-1.5-flash",
  "gemini-2.0-flash": "models/gemini-2.0-flash",
  "gemini-2.0-flash-lite": "models/gemini-2.0-flash-lite",
  "gemini-2.0-pro-exp-02-05": "models/gemini-2.0-pro-exp-02-05",
};

/**
 * Returns the canonical name for a model.
 * If no mapping exists, returns the original name.
 */
export function getCanonicalModelName(model: string): string {
  // If it already starts with models/, use it as is
  if (model.startsWith("models/")) {
    return model;
  }
  
  // Check the map
  const mapped = MODEL_MAP[model];
  if (mapped) {
    return mapped;
  }

  // Fallback: if it's a versioned model without prefix (e.g. gemini-1.5-pro-002)
  if (model.startsWith("gemini-")) {
    // If it has a specific version suffix, we might still want to canonicalize the base
    // but for now let's just prefix it if it's a known gemini model.
    return `models/${model}`;
  }

  return model;
}
