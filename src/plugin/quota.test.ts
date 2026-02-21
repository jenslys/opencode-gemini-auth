import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { formatGeminiQuotaOutput, formatRelativeResetTime } from "./quota";
import type { RetrieveUserQuotaBucket } from "./project/types";

const REAL_DATE_NOW = Date.now;
const FIXED_NOW = Date.parse("2026-02-21T00:00:00.000Z");

describe("formatRelativeResetTime", () => {
  beforeEach(() => {
    Date.now = () => FIXED_NOW;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  it("formats future reset times as relative labels", () => {
    const reset = new Date(FIXED_NOW + 90 * 60 * 1000).toISOString();
    expect(formatRelativeResetTime(reset)).toBe("resets in 1h 30m");
  });

  it("returns reset pending when reset time is in the past", () => {
    const reset = new Date(FIXED_NOW - 60 * 1000).toISOString();
    expect(formatRelativeResetTime(reset)).toBe("reset pending");
  });
});

describe("formatGeminiQuotaOutput", () => {
  beforeEach(() => {
    Date.now = () => FIXED_NOW;
  });

  afterEach(() => {
    Date.now = REAL_DATE_NOW;
  });

  it("renders sorted, model-specific usage lines", () => {
    const buckets: RetrieveUserQuotaBucket[] = [
      {
        modelId: "gemini-2.5-pro",
        tokenType: "requests",
        remainingFraction: 0.5,
        remainingAmount: "100",
        resetTime: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
      },
      {
        modelId: "gemini-2.5-flash",
        remainingAmount: "20",
      },
    ];

    const output = formatGeminiQuotaOutput("test-project", buckets);
    expect(output).toContain("Gemini quota usage for project `test-project`");
    expect(output).toContain("- gemini-2.5-flash: 20 remaining");
    expect(output).toContain(
      "- gemini-2.5-pro (requests): 50.0% remaining (100 left), resets in 1h",
    );
    expect(output.indexOf("gemini-2.5-flash")).toBeLessThan(
      output.indexOf("gemini-2.5-pro"),
    );
  });
});
