import { describe, expect, test, mock } from "bun:test";
import { AccountManager } from "./account-manager";
import { AccountPool } from "./account-pool";
import type { GeminiAccount, PluginClient } from "./types";
import { resolveCachedAuthForAccount } from "./cache";
import { invalidateProjectContextCacheForAccount } from "./project/context";

describe("AccountManager", () => {
  const mockClient: PluginClient = {
    auth: { set: mock(() => Promise.resolve()) }
  };

  test("addAccount adds to pool and notifies config update", async () => {
    const pool = new AccountPool({ accounts: [] });
    let notifiedAccounts: GeminiAccount[] = [];
    const manager = new AccountManager({
      pool,
      client: mockClient,
      onConfigUpdate: (accounts) => { notifiedAccounts = accounts; }
    });

    const account: GeminiAccount = { id: "test", refreshToken: "ref", enabled: true };
    await manager.addAccount(account);

    expect(pool.count()).toBe(1);
    expect(notifiedAccounts.length).toBe(1);
    expect(notifiedAccounts[0].id).toBe("test");
  });

  test("removeAccount removes from pool and notifies", () => {
    const account: GeminiAccount = { id: "test", refreshToken: "ref", enabled: true };
    const pool = new AccountPool({ accounts: [account] });
    let notifiedAccounts: GeminiAccount[] | null = null;
    const manager = new AccountManager({
      pool,
      client: mockClient,
      onConfigUpdate: (accounts) => { notifiedAccounts = accounts; }
    });

    manager.removeAccount("test");

    expect(pool.count()).toBe(0);
    expect(notifiedAccounts?.length).toBe(0);
  });

  test("toggleAccount enables/disables account and notifies", () => {
    const account: GeminiAccount = { id: "test", refreshToken: "ref", enabled: true };
    const pool = new AccountPool({ accounts: [account] });
    let notifiedAccounts: GeminiAccount[] | null = null;
    const manager = new AccountManager({
      pool,
      client: mockClient,
      onConfigUpdate: (accounts) => { notifiedAccounts = accounts; }
    });

    manager.toggleAccount("test", false);

    expect(pool.getAccount("test")?.account.enabled).toBe(false);
    expect(notifiedAccounts?.[0].enabled).toBe(false);
  });

  test("listAccounts returns status for all accounts", () => {
    const pool = new AccountPool({
      accounts: [
        { id: "acc1", email: "1@test.com", refreshToken: "ref1", enabled: true },
        { id: "acc2", refreshToken: "ref2", enabled: false }
      ]
    });
    
    // Simulate cooldown on acc1
    pool.cooldownAccount("acc1", "gemini-test", 10000, "TEST_COOLDOWN");

    const manager = new AccountManager({ pool, client: mockClient });
    const list = manager.listAccounts();

    expect(list.length).toBe(2);
    
    const acc1 = list.find(a => a.id === "acc1");
    expect(acc1?.email).toBe("1@test.com");
    expect(acc1?.enabled).toBe(true);
    expect(acc1?.health).toBe(0.85);
    expect(acc1?.cooldownStatus).toContain("1 active (TEST_COOLDOWN)");

    const acc2 = list.find(a => a.id === "acc2");
    expect(acc2?.enabled).toBe(false);
    expect(acc2?.cooldownStatus).toBe("none");
  });

  test("createAddAccountCallback handles OAuth success", async () => {
    const pool = new AccountPool({ accounts: [] });
    const manager = new AccountManager({ pool, client: mockClient });
    
    const callback = manager.createAddAccountCallback();
    await callback({
      type: "success",
      refresh: "new-refresh",
      access: "new-access",
      email: "new@test.com"
    });

    expect(pool.count()).toBe(1);
    const newAcc = pool.getAccounts()[0];
    expect(newAcc.account.id).toBe("new@test.com");
    expect(newAcc.account.refreshToken).toBe("new-refresh");
    expect(newAcc.auth.access).toBe("new-access");
    
    const cached = resolveCachedAuthForAccount("new@test.com");
    expect(cached?.access).toBe("new-access");
  });

  test("createAddAccountCallback throws on OAuth failure", async () => {
    const pool = new AccountPool({ accounts: [] });
    const manager = new AccountManager({ pool, client: mockClient });
    
    const callback = manager.createAddAccountCallback();
    
    expect(callback({ type: "failed", refresh: "" })).rejects.toThrow("OAuth failed or missing refresh token");
    expect(pool.count()).toBe(0);
  });
});
