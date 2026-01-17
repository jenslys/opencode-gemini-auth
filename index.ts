export {
  GeminiCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export {
  authorizeGemini,
  exchangeGemini,
} from "./src/gemini/oauth";

export type {
  GeminiAuthorization,
  GeminiTokenExchangeResult,
} from "./src/gemini/oauth";

// Profile management exports
export {
  listProfiles,
  saveProfile,
  useProfile,
  deleteProfile,
  getProfile,
  getActiveProfileName,
  currentInfo,
} from "./src/plugin/profiles";

export type { Profile, ProfileResult } from "./src/plugin/profiles";
