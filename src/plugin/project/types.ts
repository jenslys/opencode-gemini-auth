export const FREE_TIER_ID = "free-tier";
export const LEGACY_TIER_ID = "legacy-tier";

export const CODE_ASSIST_METADATA = {
  ideType: "IDE_UNSPECIFIED",
  platform: "PLATFORM_UNSPECIFIED",
  pluginType: "GEMINI",
} as const;

export interface GeminiUserTier {
  id?: string;
  isDefault?: boolean;
  userDefinedCloudaicompanionProject?: boolean;
  name?: string;
  description?: string;
}

export interface CloudAiCompanionProject {
  id?: string;
}

export interface GeminiIneligibleTier {
  reasonMessage?: string;
}

export interface LoadCodeAssistPayload {
  cloudaicompanionProject?: string | CloudAiCompanionProject;
  currentTier?: {
    id?: string;
    name?: string;
  };
  allowedTiers?: GeminiUserTier[];
  ineligibleTiers?: GeminiIneligibleTier[];
}

export interface OnboardUserPayload {
  name?: string;
  done?: boolean;
  response?: {
    cloudaicompanionProject?: {
      id?: string;
    };
  };
}

/**
 * Error raised when a required Google Cloud project is missing during Gemini onboarding.
 */
export class ProjectIdRequiredError extends Error {
  constructor() {
    super(
      "Google Gemini requires a Google Cloud project. Enable the Gemini for Google Cloud API on a project you control, then set `provider.google.options.projectId` in your Opencode config (or set OPENCODE_GEMINI_PROJECT_ID / GOOGLE_CLOUD_PROJECT).",
    );
  }
}
