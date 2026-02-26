import { describe, expect, it } from "bun:test";

import {
  normalizeAuthorizationCode,
  parseOAuthCallbackInput,
} from "./oauth-authorize";

describe("oauth authorize helpers", () => {
  it("parses full callback URLs", () => {
    const parsed = parseOAuthCallbackInput(
      "http://localhost:8085/oauth2callback?code=4%2Fabc123&state=state-1",
    );

    expect(parsed.source).toBe("url");
    expect(parsed.code).toBe("4/abc123");
    expect(parsed.state).toBe("state-1");
  });

  it("parses query-style callback inputs", () => {
    const parsed = parseOAuthCallbackInput("code=4%2Fabc123&state=state-2");

    expect(parsed.source).toBe("query");
    expect(parsed.code).toBe("4/abc123");
    expect(parsed.state).toBe("state-2");
  });

  it("falls back to raw code when no query markers are present", () => {
    const parsed = parseOAuthCallbackInput("4/0AbCDef");

    expect(parsed.source).toBe("raw");
    expect(parsed.code).toBe("4/0AbCDef");
  });

  it("normalizes encoded authorization codes", () => {
    const singleEncoded = normalizeAuthorizationCode("4%2Fabc");
    const doubleEncoded = normalizeAuthorizationCode("4%252Fabc");

    expect(singleEncoded).toBe("4/abc");
    expect(doubleEncoded).toBe("4/abc");
  });

  it("rejects malformed authorization codes", () => {
    expect(normalizeAuthorizationCode(" ")).toBeUndefined();
    expect(normalizeAuthorizationCode("4/abc 123")).toBeUndefined();
    expect(normalizeAuthorizationCode("4/abc\n123")).toBeUndefined();
  });
});
