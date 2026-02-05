import type { ToolDefinition } from "@opencode-ai/plugin";
import type { GeminiTokenExchangeResult } from "../gemini/oauth";

export interface QuotaBucket {
  resetTime: string;
  tokenType: string;
  modelId: string;
  remainingFraction: number;
}

export interface RetrieveUserQuotaResponse {
  buckets: QuotaBucket[];
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
}

export interface PluginContext {
  client: PluginClient;
}

export interface PluginResult {
  auth: {
    provider: string;
    loader: (getAuth: GetAuth, provider: Provider) => Promise<LoaderResult | null>;
    methods: AuthMethod[];
  };
  tool?: Record<string, ToolDefinition>;
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
