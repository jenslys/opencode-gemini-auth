import { afterEach, describe, expect, it } from "bun:test";

import { GEMINI_CLI_VERSION } from "./gemini-cli-version";
import { buildGeminiCliUserAgent, getGeminiCliVersion, userAgentInternals } from "./user-agent";

const originalNpmPackageVersion = process.env.npm_package_version;
const originalExplicitVersion = process.env.OPENCODE_GEMINI_CLI_VERSION;

describe("user-agent", () => {
  afterEach(() => {
    if (originalNpmPackageVersion === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = originalNpmPackageVersion;
    }
    if (originalExplicitVersion === undefined) {
      delete process.env.OPENCODE_GEMINI_CLI_VERSION;
    } else {
      process.env.OPENCODE_GEMINI_CLI_VERSION = originalExplicitVersion;
    }
    userAgentInternals.resetCache();
  });

  it("prefers OPENCODE_GEMINI_CLI_VERSION when available", () => {
    process.env.OPENCODE_GEMINI_CLI_VERSION = "8.8.8-explicit";
    process.env.npm_package_version = "9.9.9-test";
    userAgentInternals.resetCache();

    expect(getGeminiCliVersion()).toBe("8.8.8-explicit");
    expect(buildGeminiCliUserAgent("gemini-3-flash-preview")).toContain("/8.8.8-explicit/");
  });

  it("prefers synced GEMINI_CLI_VERSION over npm_package_version", () => {
    delete process.env.OPENCODE_GEMINI_CLI_VERSION;
    process.env.npm_package_version = "9.9.9-test";
    userAgentInternals.resetCache();

    expect(getGeminiCliVersion()).toBe(GEMINI_CLI_VERSION);
  });

  it("builds a GeminiCLI-style user agent", () => {
    delete process.env.OPENCODE_GEMINI_CLI_VERSION;
    delete process.env.npm_package_version;
    userAgentInternals.resetCache();

    const userAgent = buildGeminiCliUserAgent("gemini-3-flash-preview");
    expect(userAgent).toContain("GeminiCLI/");
    expect(userAgent).toContain(`/gemini-3-flash-preview `);
  });
});
