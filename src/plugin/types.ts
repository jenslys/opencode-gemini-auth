import type { GeminiTokenExchangeResult } from "../gemini/oauth";

export interface PluginConfig {
  provider?: Record<string, { options?: Record<string, unknown> }>;
  command?: Record<string, { description: string; template: string }>;
  [key: string]: unknown;
}

interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(args: unknown, context: unknown): Promise<string>;
}

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
      data?: PluginConfig;
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
  config?: (config: PluginConfig) => Promise<void>;
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
