import { beforeEach, describe, expect, it, mock } from "bun:test";

import { resolveProjectContextFromAccessToken } from "./project";
import type { OAuthAuthDetails } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token",
  access: "access-token",
  expires: Date.now() + 60_000,
};

function toUrlString(input: RequestInfo): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return (input as Request).url ?? input.toString();
}

describe("resolveProjectContextFromAccessToken", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("stores managed project id from loadCodeAssist without onboarding", async () => {
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            currentTier: { id: "free-tier" },
            cloudaicompanionProject: "projects/server-project",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      baseAuth,
      baseAuth.access ?? "",
    );

    expect(result.effectiveProjectId).toBe("projects/server-project");
    expect(result.auth.refresh).toContain("projects/server-project");
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("onboards free-tier users without sending a project id", async () => {
    let onboardBody: Record<string, unknown> | undefined;
    const fetchMock = mock(async (input: RequestInfo, init?: RequestInit) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "free-tier", isDefault: true }],
          }),
          { status: 200 },
        );
      }
      if (url.includes(":onboardUser")) {
        const rawBody = typeof init?.body === "string" ? init.body : "{}";
        onboardBody = JSON.parse(rawBody) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            done: true,
            response: { cloudaicompanionProject: { id: "managed-project" } },
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await resolveProjectContextFromAccessToken(
      baseAuth,
      baseAuth.access ?? "",
    );

    expect(result.effectiveProjectId).toBe("managed-project");
    expect(result.auth.refresh).toContain("managed-project");
    expect(onboardBody?.cloudaicompanionProject).toBeUndefined();
    const metadata = onboardBody?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.duetProject).toBeUndefined();
  });

  it("throws when a non-free tier requires a project id", async () => {
    const fetchMock = mock(async (input: RequestInfo) => {
      const url = toUrlString(input);
      if (url.includes(":loadCodeAssist")) {
        return new Response(
          JSON.stringify({
            allowedTiers: [{ id: "standard-tier", isDefault: true }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    await expect(
      resolveProjectContextFromAccessToken(baseAuth, baseAuth.access ?? ""),
    ).rejects.toThrow("Google Gemini requires a Google Cloud project");
  });
});
