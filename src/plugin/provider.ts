import type { Config } from "@opencode-ai/sdk";

import { GEMINI_PROVIDER_ID } from "../constants";
import type {
  GeminiAccount,
  PluginClient,
  Provider,
} from "./types";

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

export async function resolveConfiguredProjectIdFromClient(
  client: PluginClient | null | undefined,
): Promise<string | undefined> {
  if (!client?.config?.get) {
    return undefined;
  }

  try {
    const result = await client.config.get();
    return resolveConfiguredProjectIdFromConfig(result?.data);
  } catch {
    return undefined;
  }
}

function normalizeProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Resolves project ID for a specific account, using the account's optional override.
 */
export function resolveProjectIdForAccount(
  account: GeminiAccount,
  fallbackProjectId?: string,
): string | undefined {
  return account.projectId ?? fallbackProjectId;
}

/**
 * Reads accounts[] from the provider's options.
 * Returns undefined when no accounts are configured (pool-of-one fallback).
 */
export function resolveAccountsFromProvider(provider?: Provider | null): GeminiAccount[] | undefined {
  if (!provider || typeof provider !== "object") {
    return undefined;
  }
  const options = provider.options;
  if (!options || typeof options !== "object") {
    return undefined;
  }
  const raw = (options as Record<string, unknown>).accounts;
  if (!Array.isArray(raw) || raw.length === 0) {
    return undefined;
  }
  const accounts = raw.filter(
    (a): a is GeminiAccount =>
      a !== null &&
      typeof a === "object" &&
      typeof (a as GeminiAccount).id === "string",
  );
  return accounts.length > 0 ? accounts : undefined;
}
