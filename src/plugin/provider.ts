import type { Config } from "@opencode-ai/sdk";

import { GEMINI_PROVIDER_ID } from "../constants";
import type { Provider } from "./types";

interface ResolveConfiguredProjectIdInput {
  provider?: Provider | null;
  config?: Config | null;
  configProjectId?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveConfiguredProjectId(
  input: ResolveConfiguredProjectIdInput = {},
): string | undefined {
  const env = input.env ?? process.env;

  return (
    normalizeProjectId(env.OPENCODE_GEMINI_PROJECT_ID) ??
    resolveConfiguredProjectIdFromProvider(input.provider) ??
    normalizeProjectId(input.configProjectId) ??
    resolveConfiguredProjectIdFromConfig(input.config) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT) ??
    normalizeProjectId(env.GOOGLE_CLOUD_PROJECT_ID)
  );
}

export function resolveConfiguredProjectIdFromProvider(
  provider: Provider | null | undefined,
): string | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  return normalizeProjectId(provider.options?.projectId);
}

export function resolveConfiguredProjectIdFromConfig(
  config: Config | null | undefined,
): string | undefined {
  if (!config?.provider || typeof config.provider !== "object") {
    return undefined;
  }

  const providerConfig = config.provider[GEMINI_PROVIDER_ID];
  return normalizeProjectId(providerConfig?.options?.projectId);
}

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}
