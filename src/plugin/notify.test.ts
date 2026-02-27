import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";

import { maybeShowGeminiCapacityToast, notifyInternals } from "./notify";
import type { PluginClient } from "./types";

function makeQuota429(reason: string): Response {
  return new Response(
    JSON.stringify([
      {
        error: {
          message: "rate limited",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason,
              domain: "cloudcode-pa.googleapis.com",
            },
          ],
        },
      },
    ]),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("maybeShowGeminiCapacityToast", () => {
  const originalTestToastFlag = process.env.OPENCODE_GEMINI_TEST_TOAST;

  beforeEach(() => {
    notifyInternals.resetCooldowns();
    delete process.env.OPENCODE_GEMINI_TEST_TOAST;
  });

  afterEach(() => {
    mock.restore();
    if (originalTestToastFlag === undefined) {
      delete process.env.OPENCODE_GEMINI_TEST_TOAST;
    } else {
      process.env.OPENCODE_GEMINI_TEST_TOAST = originalTestToastFlag;
    }
  });

  it("shows toast for MODEL_CAPACITY_EXHAUSTED", async () => {
    const showToast = mock(async (_input: unknown) => true);
    const client = { auth: { set: async () => {} }, tui: { showToast } } as PluginClient;
    const response = makeQuota429("MODEL_CAPACITY_EXHAUSTED");

    await maybeShowGeminiCapacityToast(client, response, "project-1", "gemini-3-flash-preview");

    expect(showToast.mock.calls.length).toBe(1);
    const firstCall = showToast.mock.calls.at(0);
    expect(firstCall?.[0]).toEqual({
      body: {
        title: "Gemini Capacity Unavailable",
        message:
          "Google reports temporary server capacity limits for gemini-3-flash-preview. Please retry in a few seconds.",
        variant: "warning",
        duration: 7000,
      },
    });
  });

  it("does not show toast for non-capacity 429 reasons", async () => {
    const showToast = mock(async (_input: unknown) => true);
    const client = { auth: { set: async () => {} }, tui: { showToast } } as PluginClient;
    const response = makeQuota429("RATE_LIMIT_EXCEEDED");

    await maybeShowGeminiCapacityToast(client, response, "project-1", "gemini-3-flash-preview");

    expect(showToast.mock.calls.length).toBe(0);
  });

  it("dedupes toasts within cooldown window", async () => {
    const showToast = mock(async (_input: unknown) => true);
    const client = { auth: { set: async () => {} }, tui: { showToast } } as PluginClient;

    await maybeShowGeminiCapacityToast(
      client,
      makeQuota429("MODEL_CAPACITY_EXHAUSTED"),
      "project-1",
      "gemini-3-flash-preview",
    );
    await maybeShowGeminiCapacityToast(
      client,
      makeQuota429("MODEL_CAPACITY_EXHAUSTED"),
      "project-1",
      "gemini-3-flash-preview",
    );

    expect(showToast.mock.calls.length).toBe(1);
  });
});

describe("maybeShowGeminiTestToast", () => {
  const originalTestToastFlag = process.env.OPENCODE_GEMINI_TEST_TOAST;

  beforeEach(() => {
    notifyInternals.resetCooldowns();
    delete process.env.OPENCODE_GEMINI_TEST_TOAST;
  });

  afterEach(() => {
    mock.restore();
    if (originalTestToastFlag === undefined) {
      delete process.env.OPENCODE_GEMINI_TEST_TOAST;
    } else {
      process.env.OPENCODE_GEMINI_TEST_TOAST = originalTestToastFlag;
    }
  });

  it("does not show test toast when flag is not enabled", async () => {
    const { maybeShowGeminiTestToast } = await import("./notify");
    const showToast = mock(async (_input: unknown) => true);
    const client = { auth: { set: async () => {} }, tui: { showToast } } as PluginClient;

    await maybeShowGeminiTestToast(client, "project-1");

    expect(showToast.mock.calls.length).toBe(0);
  });

  it("shows test toast once per project when flag is enabled", async () => {
    process.env.OPENCODE_GEMINI_TEST_TOAST = "1";
    const { maybeShowGeminiTestToast } = await import("./notify");
    const showToast = mock(async (_input: unknown) => true);
    const client = { auth: { set: async () => {} }, tui: { showToast } } as PluginClient;

    await maybeShowGeminiTestToast(client, "project-1");
    await maybeShowGeminiTestToast(client, "project-1");

    expect(showToast.mock.calls.length).toBe(1);
    const firstCall = showToast.mock.calls.at(0);
    expect(firstCall?.[0]).toEqual({
      body: {
        title: "Gemini Toast Test",
        message: "Temporary test toast from opencode-gemini-auth.",
        variant: "info",
        duration: 5000,
      },
    });
  });
});
