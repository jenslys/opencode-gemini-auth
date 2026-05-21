/**
 * Account management utilities for adding, removing, enabling/disabling accounts.
 * Integrates with the AccountPool and provides auth method callbacks.
 */

import type { AccountPool, GeminiAccount, PluginClient } from "./types";
import { clearCachedAuthForAccount, storeCachedAuthForAccount } from "./cache";
import { invalidateProjectContextCacheForAccount } from "./project/context";

export interface AccountManagerOptions {
  pool: AccountPool;
  client: PluginClient;
  onConfigUpdate?: (accounts: GeminiAccount[]) => void;
}

export class AccountManager {
  private pool: AccountPool;
  private client: PluginClient;
  private onConfigUpdate?: (accounts: GeminiAccount[]) => void;

  constructor(options: AccountManagerOptions) {
    this.pool = options.pool;
    this.client = options.client;
    this.onConfigUpdate = options.onConfigUpdate;
  }

  /**
   * Adds a new account to the pool after successful OAuth.
   */
  async addAccount(account: GeminiAccount): Promise<void> {
    this.pool.addAccount(account);
    this.notifyConfigUpdate();
  }

  /**
   * Removes an account from the pool, clearing its cache and context.
   */
  removeAccount(accountId: string): void {
    this.pool.removeAccount(accountId);
    clearCachedAuthForAccount(accountId);
    invalidateProjectContextCacheForAccount(accountId);
    this.notifyConfigUpdate();
  }

  /**
   * Toggles an account's enabled state.
   */
  toggleAccount(accountId: string, enabled: boolean): void {
    this.pool.toggleAccount(accountId, enabled);
    this.notifyConfigUpdate();
  }

  /**
   * Lists all accounts with their current status.
   */
  listAccounts(): {
    id: string;
    email?: string;
    enabled: boolean;
    health: number;
    cooldownStatus: string;
  }[] {
    const now = Date.now();
    return this.pool.getAccounts().map((state) => {
      const activeCooldowns = Array.from(state.cooldowns.values()).filter((c) => c.expiresAt > now);
      return {
        id: state.account.id,
        email: state.account.email,
        enabled: state.account.enabled,
        health: state.health.value,
        cooldownStatus: activeCooldowns.length > 0
          ? `${activeCooldowns.length} active (${activeCooldowns[0].reason})`
          : "none",
      };
    });
  }

  /**
   * Creates an OAuth callback handler for adding a new account.
   * When OAuth succeeds, this adds the account to the pool.
   */
  createAddAccountCallback(): (result: {
    type: string;
    refresh: string;
    access?: string;
    expires?: number;
    email?: string;
  }) => Promise<void> {
    return async (result) => {
      if (result.type !== "success" || !result.refresh) {
        throw new Error("OAuth failed or missing refresh token");
      }
      const account: GeminiAccount = {
        id: result.email || result.refresh.split("|")[0] || `account-${Date.now()}`,
        email: result.email,
        refreshToken: result.refresh,
        enabled: true,
      };
      await this.addAccount(account);
      // Store initial auth in pool and cache
      this.pool.updateAuth(account.id, {
        type: "oauth",
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
      });
      storeCachedAuthForAccount(account.id, {
        type: "oauth",
        refresh: result.refresh,
        access: result.access,
        expires: result.expires,
      });
    };
  }

  private notifyConfigUpdate(): void {
    if (this.onConfigUpdate) {
      const accounts = this.pool.getAccounts().map((s) => s.account);
      this.onConfigUpdate(accounts);
    }
  }
}
