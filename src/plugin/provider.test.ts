import { describe, expect, it } from "bun:test";
import type { Config } from "@opencode-ai/sdk";

import { resolveConfiguredProjectId, resolveConfiguredProjectIdFromConfig } from "./provider";
import type { Provider } from "./types";

describe("resolveConfiguredProjectId", () => {
  it("reads project id from provider options", () => {
    const provider = {
      id: "google",
      name: "Google",
      source: "config",
      env: [],
      options: {
        projectId: "  provider-project  ",
      },
      models: {},
    } satisfies Provider;

    expect(
      resolveConfiguredProjectId({
        provider,
        env: {},
      }),
    ).toBe("provider-project");
  });

  it("falls back to the top-level config project id when provider options are unavailable", () => {
    const config = {
      provider: {
        google: {
          options: {
            projectId: "config-project",
          },
        },
      },
    } satisfies Config;

    expect(resolveConfiguredProjectIdFromConfig(config)).toBe("config-project");
    expect(
      resolveConfiguredProjectId({
        config,
        env: {},
      }),
    ).toBe("config-project");
  });

  it("prefers OPENCODE_GEMINI_PROJECT_ID over config and google cloud env vars", () => {
    expect(
      resolveConfiguredProjectId({
        configProjectId: "config-project",
        env: {
          OPENCODE_GEMINI_PROJECT_ID: "opencode-project",
          GOOGLE_CLOUD_PROJECT: "google-project",
        },
      }),
    ).toBe("opencode-project");
  });
});
