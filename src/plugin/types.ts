import type { GeminiTokenExchangeResult } from "../gemini/oauth";
// V2 compat: Config lives in @opencode-ai/sdk (V1) and also re-exported via
// @opencode-ai/client (V2 Promise API). Keep the V1 import for types, but
// allow absence at runtime — V2 uses a global service with config at
// ~/.config/opencode/opencode.json and no `createOpencodeClient`.
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
  // V2 compat: allow extra fields when the client is the V2 Promise API
  // (`@opencode-ai/client`). The plugin only uses `auth.set` / `config.get`
  // / `tui.showToast` above, so additional V2 surfaces are ignored safely.
  [key: string]: unknown;
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
