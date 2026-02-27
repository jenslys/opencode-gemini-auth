import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GEMINI_CLI_VERSION } from "./gemini-cli-version";

const GEMINI_CLI_UA_NAME = "GeminiCLI";
const GEMINI_CLI_DEFAULT_MODEL = "gemini-code-assist";

let cachedGeminiCliVersion: string | undefined;

/**
 * Resolves plugin version for User-Agent:
 * 1) explicit override (`OPENCODE_GEMINI_CLI_VERSION`)
 * 2) synced Gemini CLI version file (`src/plugin/gemini-cli-version.ts`)
 * 3) package-manager runtime env (`npm_package_version`)
 * 4) local package.json next to the plugin sources
 * 5) cwd package.json as final fallback
 */
export function getGeminiCliVersion(): string {
  if (cachedGeminiCliVersion) {
    return cachedGeminiCliVersion;
  }

  const explicitVersion = process.env.OPENCODE_GEMINI_CLI_VERSION?.trim();
  if (explicitVersion) {
    cachedGeminiCliVersion = explicitVersion;
    return cachedGeminiCliVersion;
  }

  if (GEMINI_CLI_VERSION.trim()) {
    cachedGeminiCliVersion = GEMINI_CLI_VERSION.trim();
    return cachedGeminiCliVersion;
  }

  const envVersion = process.env.npm_package_version?.trim();
  if (envVersion) {
    cachedGeminiCliVersion = envVersion;
    return cachedGeminiCliVersion;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(moduleDir, "../../package.json"),
    join(moduleDir, "../package.json"),
    join(process.cwd(), "package.json"),
  ];

  for (const packagePath of candidatePaths) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        cachedGeminiCliVersion = parsed.version.trim();
        return cachedGeminiCliVersion;
      }
    } catch {
      continue;
    }
  }

  cachedGeminiCliVersion = "0.0.0";
  return cachedGeminiCliVersion;
}

/**
 * Builds a Gemini CLI-style User-Agent string.
 */
export function buildGeminiCliUserAgent(model?: string): string {
  const modelSegment = model?.trim() || GEMINI_CLI_DEFAULT_MODEL;
  return `${GEMINI_CLI_UA_NAME}/${getGeminiCliVersion()}/${modelSegment} (${process.platform}; ${process.arch})`;
}

export const userAgentInternals = {
  resetCache() {
    cachedGeminiCliVersion = undefined;
  },
};
