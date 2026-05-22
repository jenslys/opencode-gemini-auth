/**
 * AccountPool manages multiple Gemini accounts with rotation, cooldown tracking,
 * and health scoring. It is the source of truth for per-account state.
 */

import { HealthTracker } from "./health";
import { selectBestAccount } from "./rotation";
import { getCanonicalModelName } from "./models";
import type {
  AccountState,
  GeminiAccount,
  AccountPoolConfig,
  OAuthAuthDetails,
  ProjectContextResult,
  CooldownState,
} from "./types";

export class AccountPool {
  private states: Map<string, AccountState> = new Map();
  private trackers: Map<string, HealthTracker> = new Map();
  private refreshLocks: Map<string, Promise<OAuthAuthDetails | null>> = new Map();
  private strategy: string = "health-weighted";

  constructor(config: AccountPoolConfig) {
    this.strategy = config.strategy ?? "health-weighted";
    for (const account of config.accounts) {
      this.addAccount(account);
    }
  }

  addAccount(account: GeminiAccount): void {
    if (this.states.has(account.id)) return;
    const defaultAuth: OAuthAuthDetails = {
      type: "oauth",
      refresh: account.refreshToken,
    };
    this.states.set(account.id, {
      account,
      auth: defaultAuth,
      cooldowns: new Map(),
      lastUsed: 0,
      usageCount: 0,
      health: { value: 1.0, successRate: 1.0, quotaRemaining: 1.0, latencyScore: 1.0, cooldownScore: 1.0 },
    });
    this.trackers.set(account.id, new HealthTracker());
  }

  removeAccount(accountId: string): void {
    this.states.delete(accountId);
    this.trackers.delete(accountId);
  }

  toggleAccount(accountId: string, enabled: boolean): void {
    const state = this.states.get(accountId);
    if (state) {
      state.account.enabled = enabled;
    }
  }

  getAccount(accountId: string): AccountState | undefined {
    return this.states.get(accountId);
  }

  getAccounts(): AccountState[] {
    return Array.from(this.states.values());
  }

  count(): number {
    return this.states.size;
  }

  select(model?: string, url?: string): AccountState | undefined {
    const accounts = this.getAccounts();
    const selected = selectBestAccount(accounts, { model, url });
    if (selected) {
      selected.lastUsed = Date.now();
      selected.usageCount++;
    }
    return selected;
  }

  cooldownAccount(accountId: string, model: string, durationMs: number, reason: string): void {
    const state = this.states.get(accountId);
    if (!state) return;
    const canonicalModel = getCanonicalModelName(model);
    state.cooldowns.set(canonicalModel, {
      accountId,
      expiresAt: Date.now() + durationMs,
      reason,
      model: canonicalModel,
    });
    const tracker = this.trackers.get(accountId);
    if (tracker) {
      tracker.recordCooldown();
      state.health = tracker.compute();
    }
  }

  reportResult(accountId: string, status: number, latencyMs?: number): void {
    if (status >= 200 && status < 300) {
      this.reportSuccess(accountId, latencyMs);
    } else {
      if (status === 401) {
        this.toggleAccount(accountId, false);
      }
      this.reportFailure(accountId);
    }
  }

  reportSuccess(accountId: string, latencyMs?: number): void {
    const state = this.states.get(accountId);
    if (!state) return;
    const tracker = this.trackers.get(accountId);
    if (tracker) {
      tracker.recordSuccess(latencyMs);
      state.health = tracker.compute();
    }
  }

  reportFailure(accountId: string): void {
    const state = this.states.get(accountId);
    if (!state) return;
    const tracker = this.trackers.get(accountId);
    if (tracker) {
      tracker.recordFailure();
      state.health = tracker.compute();
    }
  }

  updateAuth(accountId: string, auth: OAuthAuthDetails): void {
    const state = this.states.get(accountId);
    if (!state) return;
    state.auth = auth;
    // Sync the refresh token back to the base account object so it can be persisted
    if (auth.refresh && auth.refresh !== state.account.refreshToken) {
      state.account.refreshToken = auth.refresh;
    }
  }

  updateProjectContext(accountId: string, context: ProjectContextResult): void {
    const state = this.states.get(accountId);
    if (!state) return;
    state.projectContext = context;
  }

  updateQuotaRemaining(accountId: string, pct: number): void {
    const state = this.states.get(accountId);
    if (!state) return;
    const tracker = this.trackers.get(accountId);
    if (tracker) {
      tracker.setQuotaRemaining(pct);
      state.health = tracker.compute();
    }
  }

  getHealthTracker(_accountId: string): HealthTracker | null {
    // HealthTracker is internal to AccountPool, not exposed directly
    return null;
  }

  withRefreshLock(
    accountId: string,
    refreshFn: () => Promise<OAuthAuthDetails | null>,
  ): Promise<OAuthAuthDetails | null> {
    const existing = this.refreshLocks.get(accountId);
    if (existing) return existing;

    const timeout = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error("Refresh lock timeout after 30s")), 30000),
    );

    const lock = Promise.race([refreshFn(), timeout]).finally(() => {
      this.refreshLocks.delete(accountId);
    }) as Promise<OAuthAuthDetails | null>;

    this.refreshLocks.set(accountId, lock);
    return lock;
  }

  /**
   * Creates a pool-of-one wrapper for backwards compatibility.
   * When no accounts[] are configured, the single legacy credential
   * is wrapped in a pool that always returns that account.
   */
  static fromSingleAccount(account: GeminiAccount): AccountPool {
    return new AccountPool({ accounts: [account], strategy: "health-weighted" });
  }
}
