import { describe, expect, it } from "bun:test";

import type { AccountState, CooldownState, HealthScore } from "./types";
import { explainSelection, selectBestAccount } from "./rotation";

const BASE_TIME = 1_000_000_000_000;

function makeScore(overrides: Partial<HealthScore> = {}): HealthScore {
  return {
    value: 1.0,
    successRate: 1.0,
    quotaRemaining: 1.0,
    latencyScore: 1.0,
    cooldownScore: 1.0,
    ...overrides,
  };
}

function makeCooldown(
  accountId: string,
  expiresAt: number,
  reason = "RATE_LIMIT",
  model?: string,
): CooldownState {
  return { accountId, expiresAt, reason, model };
}

function makeAccountState(
  id: string,
  overrides: Partial<AccountState> = {},
): AccountState {
  return {
    account: {
      id,
      email: `${id}@example.com`,
      refreshToken: `rt-${id}`,
      enabled: true,
    },
    auth: { type: "oauth", refresh: `rt-${id}`, access: "tok", expires: BASE_TIME + 3600000 },
    cooldowns: new Map(),
    lastUsed: 0,
    usageCount: 0,
    health: makeScore(),
    ...overrides,
  } satisfies AccountState;
}

describe("selectBestAccount", () => {
  it("returns undefined for an empty pool", () => {
    expect(selectBestAccount([])).toBeUndefined();
  });

  it("returns the only account when the pool has one entry", () => {
    const acc = makeAccountState("alice");
    expect(selectBestAccount([acc])).toBe(acc);
  });

  it("picks available account when others have zero health", () => {
    const zero = makeAccountState("zero", { health: makeScore({ value: 0.0 }) });
    const high = makeAccountState("high", { health: makeScore({ value: 0.9 }) });
    const result = selectBestAccount([zero, high]);
    expect(result?.account.id).toBe("high");
  });

  it("canonicalizes model names in selectBestAccount", () => {
    const now = Date.now();
    const acc = makeAccountState("acc", {
      cooldowns: new Map([["models/gemini-1.5-pro", makeCooldown("acc", now + 60000, "RATE_LIMIT", "models/gemini-1.5-pro")]])
    });
    const other = makeAccountState("other");
    // gemini-1.5-pro should map to models/gemini-1.5-pro
    const result = selectBestAccount([acc, other], { model: "gemini-1.5-pro" });
    expect(result?.account.id).toBe("other");
  });

  it("picks the account with shortest remaining cooldown when all are cooldowned", () => {
    const now = Date.now();
    const model = "models/gemini-2.0-flash";
    // long cooldown: expires far in future
    const longCd = makeAccountState("long", {
      cooldowns: new Map([[model, makeCooldown("long", now + 60000, "MODEL_CAPACITY_EXHAUSTED", model)]]),
    });
    // short cooldown: expires sooner
    const shortCd = makeAccountState("short", {
      cooldowns: new Map([[model, makeCooldown("short", now + 10000, "MODEL_CAPACITY_EXHAUSTED", model)]]),
    });
    const result = selectBestAccount([longCd, shortCd], { model: "gemini-2.0-flash" });
    expect(result?.account.id).toBe("short");
  });

  it("never selects a disabled account", () => {
    const disabled = makeAccountState("bob", { account: { id: "bob", email: "bob@x.com", refreshToken: "rt-bob", enabled: false } });
    const enabled = makeAccountState("alice");
    const result = selectBestAccount([disabled, enabled]);
    expect(result?.account.id).toBe("alice");
  });

  it("returns undefined when all accounts are disabled", () => {
    const a = makeAccountState("a", { account: { id: "a", email: "a@x.com", refreshToken: "rt-a", enabled: false } });
    const b = makeAccountState("b", { account: { id: "b", email: "b@x.com", refreshToken: "rt-b", enabled: false } });
    expect(selectBestAccount([a, b])).toBeUndefined();
  });

  it("prefers available healthy account over cooldowned ones", () => {
    const now = Date.now();
    const model = "models/gemini-2.0-flash";
    const cooldowned = makeAccountState("coold", {
      cooldowns: new Map([[model, makeCooldown("coold", now + 30000, "RATE_LIMIT", model)]]),
    });
    const healthy = makeAccountState("healthy", { health: makeScore({ value: 0.95 }) });
    const result = selectBestAccount([cooldowned, healthy], { model: "gemini-2.0-flash" });
    expect(result?.account.id).toBe("healthy");
  });

  it("breaks ties by LRU when weights are zero", () => {
    const busy = makeAccountState("busy", { usageCount: 10, health: makeScore({ value: 0.0 }) });
    const idle = makeAccountState("idle", { usageCount: 2, health: makeScore({ value: 0.0 }) });
    const result = selectBestAccount([busy, idle]);
    expect(result?.account.id).toBe("idle");
  });

  it("prefers accounts with >20% quota remaining over those with low quota", () => {
    const lowQuota = makeAccountState("low-quota", { health: makeScore({ value: 0.8, quotaRemaining: 0.1 }) });
    const highQuota = makeAccountState("high-quota", { health: makeScore({ value: 0.7, quotaRemaining: 0.5 }) });
    const result = selectBestAccount([lowQuota, highQuota]);
    // high-quota has lower health but >20% quota; low-quota has higher health but <20%
    // Quota filter prefers >20% first; within those, highest health
    expect(result?.account.id).toBe("high-quota");
  });

  it("uses weighted random when all accounts have <20% quota", () => {
    const zero = makeAccountState("zero-health", { health: makeScore({ value: 0.0, quotaRemaining: 0.1 }) });
    const higher = makeAccountState("higher-health", { health: makeScore({ value: 0.6, quotaRemaining: 0.05 }) });
    const result = selectBestAccount([zero, higher]);
    // zero-health has 0 weight, so higher-health must be picked
    expect(result?.account.id).toBe("higher-health");
  });
});

describe("explainSelection", () => {
  it("returns a readable summary for a normal selection", () => {
    const a = makeAccountState("alice", { health: makeScore({ value: 0.9 }) });
    const b = makeAccountState("bob", { health: makeScore({ value: 0.5 }) });
    const selected = selectBestAccount([a, b]);
    const summary = explainSelection([a, b], selected);
    expect(summary).toContain("selected: ");
    expect(summary).toContain(selected!.account.id);
  });

  it("reports no accounts available when selected is undefined", () => {
    const summary = explainSelection([], undefined);
    expect(summary).toBe("No accounts available");
  });

  it("reports disabled accounts", () => {
    const disabled = makeAccountState("disabled", {
      account: { id: "disabled", email: "d@x.com", refreshToken: "rt-d", enabled: false },
    });
    const healthy = makeAccountState("healthy", { health: makeScore({ value: 0.9 }) });
    const selected = selectBestAccount([disabled, healthy]);
    const summary = explainSelection([disabled, healthy], selected, {});
    expect(summary).toContain("1 disabled");
    expect(summary).toContain("selected: healthy");
  });
});
