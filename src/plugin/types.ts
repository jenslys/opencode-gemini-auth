import type { GeminiTokenExchangeResult } from "../gemini/oauth";
import type { Config } from "@opencode-ai/sdk";
import type { ToolDefinition } from "@opencode-ai/plugin";

export interface OAuthAuthDetails {
  type: "oauth";
  refresh: string;
  access?: string;
  expires?: number;
}

export interface NonOAuthAuthDetails {
  type: string;
  [key: string]: unknown;
}

export type AuthDetails = OAuthAuthDetails | NonOAuthAuthDetails;

export type GetAuth = () => Promise<AuthDetails>;

export interface ProviderModel {
  cost?: {
    input: number;
    output: number;
    cache?: {
      read: number;
      write: number;
    };
  };
  [key: string]: unknown;
}

export interface Provider {
  models?: Record<string, ProviderModel>;
  options?: Record<string, unknown>;
}

export interface LoaderResult {
  apiKey: string;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

export interface AuthMethod {
  provider?: string;
  label: string;
  type: "oauth" | "api";
  authorize?: () => Promise<{
    url: string;
    instructions: string;
    method: string;
    callback: (() => Promise<GeminiTokenExchangeResult>) | ((callbackUrl: string) => Promise<GeminiTokenExchangeResult>);
  }>;
}

export interface PluginClient {
  auth: {
    set(input: { path: { id: string }; body: OAuthAuthDetails }): Promise<void>;
  };
  config?: {
    get(options?: unknown): Promise<{
      data?: Config;
    } | undefined>;
  };
  tui?: {
    showToast(input: {
      body: {
        title?: string;
        message: string;
        variant: "info" | "success" | "warning" | "error";
        duration?: number;
      };
    }): Promise<unknown>;
  };
}

export interface PluginContext {
  client: PluginClient;
}

export interface PluginResult {
  config?: (config: Config) => Promise<void>;
  tool?: Record<string, ToolDefinition>;
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | null>;
    methods: AuthMethod[];
  };
}

export interface RefreshParts {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
}

export interface ProjectContextResult {
  auth: OAuthAuthDetails;
  effectiveProjectId: string;
}

// ── Multi-account types ──────────────────────────────────────────────

export interface GeminiAccount {
  id: string;                    // email from OAuth userinfo
  email?: string;
  refreshToken: string;
  projectId?: string;            // optional per-account project override
  enabled: boolean;
}

export interface HealthScore {
  value: number;                 // 0.0 - 1.0
  successRate: number;           // 0.0 - 1.0
  quotaRemaining: number;        // 0.0 - 1.0
  latencyScore: number;          // 0.0 - 1.0
  cooldownScore: number;         // 0.0 - 1.0
}

export interface CooldownState {
  accountId: string;
  expiresAt: number;             // Date.now() + durationMs
  reason: string;                // e.g. "MODEL_CAPACITY_EXHAUSTED", "QUOTA_EXHAUSTED"
  model?: string;
}

export type RotationStrategy = "round-robin" | "lru" | "quota-aware" | "health-weighted";

export interface AccountPoolConfig {
  accounts: GeminiAccount[];
  strategy?: RotationStrategy;
}

export interface AccountState {
  account: GeminiAccount;
  auth: OAuthAuthDetails;
  projectContext?: ProjectContextResult;
  cooldowns: Map<string, CooldownState>;  // key: model or "model|url"
  lastUsed: number;              // timestamp
  usageCount: number;
  health: HealthScore;
  refreshLock?: Promise<OAuthAuthDetails | null>;  // per-account refresh lock
}
