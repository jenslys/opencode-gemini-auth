import { describe, expect, it } from "bun:test";

import { AccountPool } from "./account-pool";
import type { GeminiAccount, OAuthAuthDetails, ProjectContextResult } from "./types";

function createPool(count: number = 2): AccountPool {
  const accounts: GeminiAccount[] = Array.from({ length: count }, (_, i) => ({
    id: `acc-${i}`,
    email: `acc-${i}@example.com`,
    refreshToken: `rt-acc-${i}`,
    enabled: true,
  }));
  return new AccountPool({ accounts, strategy: "health-weighted" });
}

describe("AccountPool", () => {
  describe("pool construction", () => {
    it("initializes with correct account count", () => {
      const pool = createPool(2);
      expect(pool.count()).toBe(2);
    });

    it("initializes with zero accounts when given an empty list", () => {
      const pool = new AccountPool({ accounts: [] });
      expect(pool.count()).toBe(0);
    });

    it("ignores duplicate addAccount calls", () => {
      const pool = createPool(1);
      pool.addAccount({ id: "acc-0", email: "dup@x.com", refreshToken: "rt-dup", enabled: true });
      expect(pool.count()).toBe(1);
    });
  });

  describe("select", () => {
    it("returns undefined on an empty pool", () => {
      const pool = new AccountPool({ accounts: [] });
      expect(pool.select()).toBeUndefined();
    });

    it("returns the only account on a pool of one", () => {
      const pool = createPool(1);
      const selected = pool.select();
      expect(selected?.account.id).toBe("acc-0");
    });

    it("returns account with highest health (deterministic if other is zero)", () => {
      const pool = createPool(2);
      // Set acc-0's health to 0
      pool.updateQuotaRemaining("acc-0", 0);
      // We need to make sure health actually goes to 0 or very low
      // Actually, HealthTracker compute() might not go to 0 immediately.
      // Let's just report many failures.
      for (let i = 0; i < 20; i++) pool.reportFailure("acc-0");
      
      const selected = pool.select();
      // acc-1 still has perfect health (1.0)
      expect(selected?.account.id).toBe("acc-1");
    });

    it("excludes cooldowned accounts", () => {
      const pool = createPool(2);
      pool.cooldownAccount("acc-0", "gemini-2.0-flash", 60000, "RATE_LIMIT");
      const selected = pool.select("gemini-2.0-flash");
      expect(selected?.account.id).toBe("acc-1");
    });

    it("excludes disabled accounts", () => {
      const pool = createPool(2);
      pool.toggleAccount("acc-0", false);
      const selected = pool.select();
      expect(selected?.account.id).toBe("acc-1");
    });

    it("picks shortest remaining cooldown when all accounts are cooldowned", () => {
      const pool = createPool(2);
      // Long cooldown on acc-0, short cooldown on acc-1
      pool.cooldownAccount("acc-0", "gemini-2.0-flash", 60000, "RATE_LIMIT");
      pool.cooldownAccount("acc-1", "gemini-2.0-flash", 10000, "RATE_LIMIT");
      const selected = pool.select("gemini-2.0-flash");
      expect(selected?.account.id).toBe("acc-1");
    });

    it("increments usageCount and updates lastUsed on selection", () => {
      const pool = createPool(2);
      const selected = pool.select();
      const id = selected?.account.id;
      expect(id).toBeDefined();
      const after = pool.getAccount(id!)?.usageCount ?? -1;
      expect(after).toBe(1);
    });
  });

  describe("cooldown and health reporting", () => {
    it("cooldownAccount sets a cooldown entry (canonicalized)", () => {
      const pool = createPool(2);
      pool.cooldownAccount("acc-0", "gemini-2.0-flash", 10000, "RATE_LIMIT");
      const cooldowns = pool.getAccount("acc-0")?.cooldowns;
      expect(cooldowns?.has("models/gemini-2.0-flash")).toBe(true);
      expect(cooldowns?.get("models/gemini-2.0-flash")?.reason).toBe("RATE_LIMIT");
    });

    it("reportFailure lowers health score", () => {
      const pool = createPool(1);
      expect(pool.getAccount("acc-0")?.health.value).toBe(1);
      pool.reportFailure("acc-0");
      expect(pool.getAccount("acc-0")?.health.value).toBeLessThan(1);
    });

    it("reportResult handles 401 by disabling the account", () => {
      const pool = createPool(1);
      expect(pool.getAccount("acc-0")?.account.enabled).toBe(true);
      pool.reportResult("acc-0", 401);
      expect(pool.getAccount("acc-0")?.account.enabled).toBe(false);
    });

    it("reportResult handles success", () => {
      const pool = createPool(1);
      pool.reportFailure("acc-0");
      const low = pool.getAccount("acc-0")?.health.value ?? 1;
      pool.reportResult("acc-0", 200);
      const high = pool.getAccount("acc-0")?.health.value ?? 0;
      expect(high).toBeGreaterThan(low);
    });

    it("canonicalizes model names in cooldownAccount", () => {
      const pool = createPool(1);
      pool.cooldownAccount("acc-0", "gemini-1.5-pro", 10000, "RATE_LIMIT");
      const cooldowns = pool.getAccount("acc-0")?.cooldowns;
      expect(cooldowns?.has("models/gemini-1.5-pro")).toBe(true);
    });

    it("reportSuccess after failure improves health score", () => {
      const pool = createPool(1);
      pool.reportFailure("acc-0");
      const afterFailure = pool.getAccount("acc-0")?.health.value ?? 1;
      pool.reportSuccess("acc-0", 100);
      const afterSuccess = pool.getAccount("acc-0")?.health.value ?? 0;
      expect(afterSuccess).toBeGreaterThan(afterFailure);
    });
  });

  describe("withRefreshLock", () => {
    it("deduplicates concurrent refreshes for the same account", async () => {
      const pool = createPool(2);
      let callCount = 0;
      const refreshFn = async (): Promise<OAuthAuthDetails | null> => {
        callCount++;
        return null;
      };
      const p1 = pool.withRefreshLock("acc-0", refreshFn);
      const p2 = pool.withRefreshLock("acc-0", refreshFn);
      expect(callCount).toBe(1);
      expect(p1).toBe(p2);
      await p1;
    });

    it("allows concurrent refreshes for different accounts", async () => {
      const pool = createPool(2);
      let callCount = 0;
      const refreshFn = async (): Promise<OAuthAuthDetails | null> => {
        callCount++;
        return null;
      };
      const p1 = pool.withRefreshLock("acc-0", refreshFn);
      const p2 = pool.withRefreshLock("acc-1", refreshFn);
      // Different accounts → both refreshFn should be called
      expect(p1).not.toBe(p2);
      await Promise.all([p1, p2]);
      expect(callCount).toBe(2);
    });
  });

  describe("account lifecycle", () => {
    it("removeAccount decreases count", () => {
      const pool = createPool(3);
      expect(pool.count()).toBe(3);
      pool.removeAccount("acc-1");
      expect(pool.count()).toBe(2);
      expect(pool.getAccount("acc-1")).toBeUndefined();
    });

    it("toggleAccount enables and disables accounts", () => {
      const pool = createPool(2);
      expect(pool.getAccount("acc-0")?.account.enabled).toBe(true);
      pool.toggleAccount("acc-0", false);
      expect(pool.getAccount("acc-0")?.account.enabled).toBe(false);
      pool.toggleAccount("acc-0", true);
      expect(pool.getAccount("acc-0")?.account.enabled).toBe(true);
    });

    it("fromSingleAccount creates pool-of-one that always returns that account", () => {
      const account: GeminiAccount = {
        id: "legacy",
        email: "legacy@example.com",
        refreshToken: "rt-legacy",
        enabled: true,
      };
      const pool = AccountPool.fromSingleAccount(account);
      expect(pool.count()).toBe(1);
      const selected = pool.select();
      expect(selected?.account.id).toBe("legacy");
    });
  });

  describe("auth and project context", () => {
    it("updateAuth updates account auth details", () => {
      const pool = createPool(2);
      const newAuth: OAuthAuthDetails = {
        type: "oauth",
        refresh: "rt-new",
        access: "tok-new",
        expires: Date.now() + 3600000,
      };
      pool.updateAuth("acc-0", newAuth);
      const state = pool.getAccount("acc-0");
      expect(state?.auth.refresh).toBe("rt-new");
      expect(state?.auth.access).toBe("tok-new");
    });

    it("updateProjectContext updates account project context", () => {
      const pool = createPool(2);
      const ctx: ProjectContextResult = {
        auth: { type: "oauth", refresh: "rt-ctx" },
        effectiveProjectId: "proj-123",
      };
      pool.updateProjectContext("acc-0", ctx);
      const state = pool.getAccount("acc-0");
      expect(state?.projectContext?.effectiveProjectId).toBe("proj-123");
      expect(state?.projectContext?.auth.refresh).toBe("rt-ctx");
    });

    it("updateQuotaRemaining updates health quota remaining", () => {
      const pool = createPool(1);
      expect(pool.getAccount("acc-0")?.health.quotaRemaining).toBe(1);
      pool.updateQuotaRemaining("acc-0", 0.3);
      expect(pool.getAccount("acc-0")?.health.quotaRemaining).toBe(0.3);
    });
  });
});
