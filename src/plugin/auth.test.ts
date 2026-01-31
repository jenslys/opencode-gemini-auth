import { describe, expect, it } from "bun:test";

import {
  accessTokenExpired,
  formatRefreshParts,
  isOAuthAuth,
  parseRefreshParts,
} from "./auth";

describe("auth helpers", () => {
  it("parses refresh parts with project and managed ids", () => {
    const parts = parseRefreshParts("refresh|project-123|managed-456");
    expect(parts.refreshToken).toBe("refresh");
    expect(parts.projectId).toBe("project-123");
    expect(parts.managedProjectId).toBe("managed-456");
  });

  it("formats refresh parts with optional segments", () => {
    expect(formatRefreshParts({ refreshToken: "refresh" })).toBe("refresh");
    expect(
      formatRefreshParts({
        refreshToken: "refresh",
        projectId: "project-123",
      }),
    ).toBe("refresh|project-123|");
    expect(
      formatRefreshParts({
        refreshToken: "refresh",
        managedProjectId: "managed-456",
      }),
    ).toBe("refresh||managed-456");
  });

  it("detects OAuth auth payloads", () => {
    expect(isOAuthAuth({ type: "oauth", refresh: "refresh" })).toBe(true);
    expect(isOAuthAuth({ type: "api", refresh: "refresh" } as never)).toBe(false);
  });

  it("treats tokens near expiry as expired", () => {
    const now = Date.now();
    expect(
      accessTokenExpired({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: now + 59_000,
      }),
    ).toBe(true);
    expect(
      accessTokenExpired({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: now + 61_000,
      }),
    ).toBe(false);
  });
});
