/**
 * Constants used for Google Gemini OAuth flows and Cloud Code Assist API integration.
 */
export const GEMINI_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";

/**
 * Client secret issued for the Gemini CLI OAuth application.
 */
export const GEMINI_CLIENT_SECRET = "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";

/**
 * Scopes required for Gemini CLI integrations.
 */
export const GEMINI_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

/**
 * OAuth redirect URI used by the local CLI callback server.
 */
export const GEMINI_REDIRECT_URI = "http://localhost:8085/oauth2callback";

/**
 * Root endpoint for the Cloud Code Assist API which backs Gemini CLI traffic.
 */
export const GEMINI_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";

export const CODE_ASSIST_HEADERS = {
  "User-Agent": "google-api-nodejs-client/9.15.1",
  "X-Goog-Api-Client": "gl-node/22.17.0",
  "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
} as const;

/**
 * Provider identifier shared between the plugin loader and credential store.
 */
export const GEMINI_PROVIDER_ID = "google";
