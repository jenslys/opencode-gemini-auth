export const GEMINI_PREVIEW_LINK = "https://goo.gle/enable-preview-features";

export interface GeminiApiError {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
  [key: string]: unknown;
}

/**
 * Minimal representation of Gemini API responses we touch.
 */
export interface GeminiApiBody {
  response?: unknown;
  error?: GeminiApiError;
  [key: string]: unknown;
}

export interface GeminiErrorEnhancement {
  body?: GeminiApiBody;
  retryAfterMs?: number;
}

/**
 * Usage metadata exposed by Gemini responses. Fields are optional to reflect partial payloads.
 */
export interface GeminiUsageMetadata {
  totalTokenCount?: number;
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

/**
 * Thinking configuration accepted by Gemini.
 * - Gemini 3 models use thinkingLevel (string: 'low', 'medium', 'high')
 * - Gemini 2.5 models use thinkingBudget (number)
 */
export interface ThinkingConfig {
  thinkingBudget?: number;
  thinkingLevel?: string;
  includeThoughts?: boolean;
}

export interface GoogleRpcErrorInfo {
  "@type"?: string;
  reason?: string;
  domain?: string;
  metadata?: Record<string, string>;
}

export interface GoogleRpcHelp {
  "@type"?: string;
  links?: Array<{
    description?: string;
    url?: string;
  }>;
}

export interface GoogleRpcQuotaFailure {
  "@type"?: string;
  violations?: Array<{
    subject?: string;
    description?: string;
  }>;
}

export interface GoogleRpcRetryInfo {
  "@type"?: string;
  retryDelay?: string | { seconds?: number; nanos?: number };
}

export const CLOUDCODE_DOMAINS = [
  "cloudcode-pa.googleapis.com",
  "staging-cloudcode-pa.googleapis.com",
  "autopush-cloudcode-pa.googleapis.com",
];
