import { describe, expect, it } from "bun:test";

import { HealthTracker } from "./health";

describe("HealthTracker", () => {
  it("starts with a perfect score of 1.0 before any records", () => {
    const tracker = new HealthTracker();
    const score = tracker.compute();
    expect(score.value).toBe(1);
    expect(score.successRate).toBe(1);
    expect(score.quotaRemaining).toBe(1);
    // No records yet → no latency penalty → perfect latency score
    expect(score.latencyScore).toBe(1);
    expect(score.cooldownScore).toBe(1);
  });

  it("maintains a high score after a successful request", () => {
    const tracker = new HealthTracker();
    tracker.recordSuccess(100);
    const score = tracker.compute();
    // 1 success, 0 failures → successRate = 1.0
    // latency = 100ms → latencyScore = 1 - 100/5000 = 0.98
    // no cooldowns → cooldownScore = 1.0
    // quota = 1.0 (default)
    // value = 0.40*1.0 + 0.30*1.0 + 0.15*0.98 + 0.15*1.0 = 0.40+0.30+0.147+0.15 = 0.997 → 1.0
    expect(score.value).toBeGreaterThanOrEqual(0.99);
  });

  it("decreases the score when failures are recorded", () => {
    const tracker = new HealthTracker();
    // Start with perfect
    const initial = tracker.compute();
    expect(initial.value).toBe(1);

    // Record 3 failures in a row
    tracker.recordFailure();
    tracker.recordFailure();
    tracker.recordFailure();
    const afterFailures = tracker.compute();
    // successRate = 0/3 = 0 → weight 40% drops to 0
    // value ≈ 0 + 0.30*1 + 0.15*0.9 + 0.15*1 = 0.585
    expect(afterFailures.value).toBeLessThan(initial.value);
    expect(afterFailures.successRate).toBe(0);
  });

  it("decreases cooldown score when cooldowns are recorded", () => {
    const tracker = new HealthTracker();
    const before = tracker.compute();
    expect(before.cooldownScore).toBe(1);

    tracker.recordCooldown();
    // Cooldown score decays based on recency; value should drop
    const after = tracker.compute();
    expect(after.cooldownScore).toBeLessThan(before.cooldownScore);
  });

  it("reflects quota remaining in the score", () => {
    const tracker = new HealthTracker();
    expect(tracker.compute().quotaRemaining).toBe(1);

    tracker.setQuotaRemaining(0.5);
    expect(tracker.compute().quotaRemaining).toBe(0.5);

    tracker.setQuotaRemaining(0);
    expect(tracker.compute().quotaRemaining).toBe(0);
  });

  it("clamps quota values to [0, 1]", () => {
    const tracker = new HealthTracker();
    tracker.setQuotaRemaining(-0.5);
    expect(tracker.compute().quotaRemaining).toBe(0);

    tracker.setQuotaRemaining(1.5);
    expect(tracker.compute().quotaRemaining).toBe(1);
  });

  it("returns rounded values from compute()", () => {
    const tracker = new HealthTracker();
    // Record enough to create non-trivial fractions
    tracker.recordSuccess(333);
    tracker.recordFailure();
    tracker.recordSuccess(250);
    const score = tracker.compute();
    // All values should be rounded to at most 2 decimal places
    expect(score.value * 100 % 1).toBe(0);
    expect(score.successRate * 100 % 1).toBe(0);
    expect(Math.round(score.successRate * 100) / 100).toBe(score.successRate);
  });

  it("resets all state back to defaults", () => {
    const tracker = new HealthTracker();
    tracker.recordSuccess(200);
    tracker.recordFailure();
    tracker.recordCooldown();
    tracker.setQuotaRemaining(0.3);

    const before = tracker.compute();
    expect(before.value).toBeLessThan(1);

    tracker.reset();
    const after = tracker.compute();
    expect(after.value).toBe(1);
    expect(after.successRate).toBe(1);
    expect(after.quotaRemaining).toBe(1);
    expect(after.cooldownScore).toBe(1);
  });

  it("is O(1): compute() does not mutate internal state", () => {
    const tracker = new HealthTracker();
    tracker.recordSuccess(100);
    tracker.recordFailure();

    const first = tracker.compute();
    const second = tracker.compute();
    const third = tracker.compute();

    // Calling compute() repeatedly without new records returns the same values
    expect(first).toEqual(second);
    expect(second).toEqual(third);
  });
});
