export {
  GeminiCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export {
  authorizeGemini,
  exchangeGeminiWithVerifier,
} from "./src/gemini/oauth";

export type {
  GeminiAuthorization,
  GeminiTokenExchangeResult,
} from "./src/gemini/oauth";

// OpenCode V2 compatibility: V2 uses `@opencode-ai/client` (Promise API,
// global service, config at `~/.config/opencode/opencode.json`) and no
// `createOpencodeClient`. The named `GeminiCLIOAuthPlugin` export above
// remains the V1 loader (`@opencode-ai/plugin` v1 / `@opencode-ai/plugin/v1`
// compat). For native V2 `Plugin.define` consumers the same plugin works
// because `peerDependencies` now optionally allows `@opencode-ai/client`
// and runtime only touches `client.auth.set` / `client.config.get` /
// `client.tui.showToast` (other V2 surfaces are ignored via index signature).
// Quota via embedded Google client secrets matches CodeNomad e2b784f2.
