import { beforeEach, describe, expect, it, mock } from "bun:test";

import { GEMINI_PROVIDER_ID } from "../constants";
import { refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: mock(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof mock<(input: any) => Promise<void>>> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    mock.restore();
  });

  it("updates the caller but skips persisting when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("persists when Google rotates the refresh token", async () => {
    const client = createClient();
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client);

    expect(result?.access).toBe("next-access");
    expect(client.auth.set.mock.calls.length).toBe(1);
    expect(client.auth.set.mock.calls[0]?.[0]).toEqual({
      path: { id: GEMINI_PROVIDER_ID },
      body: expect.objectContaining({
        type: "oauth",
        refresh: expect.stringContaining("rotated-token"),
      }),
    });
  });
});
