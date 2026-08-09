# Tasks: multi-account-rotation

Chain strategy: stacked-to-main | PR 1 of 5

## Phase 1: Foundation (PR 1, ~300 lines)

- [x] T1: types.ts — Add GeminiAccount, AccountState, HealthScore, CooldownState, AccountPoolConfig, RotationStrategy
- [x] T2: health.ts — HealthTracker class, O(1) incremental scoring (success 40%, quota 30%, latency 15%, cooldown 15%)
- [x] T3: rotation.ts — selectBestAccount() filter→health-weight→quota→LRU
- [x] T4: health.test.ts — Score monotonicity tests
- [x] T5: rotation.test.ts — All-filter scenarios

## Phase 2: Core Pool (PR 2, ~350 lines)

- [ ] T6: account-pool.ts — AccountPool class (select, cooldown, reportSuccess/Failure, get/add/remove/toggle)
- [ ] T7: account-pool.ts — Per-account refresh lock via Map<accountId, Promise>
- [ ] T8: account-pool.ts — Pool-of-one wrapper for backwards compat
- [ ] T9: cache.ts — Re-key auth cache by account ID
- [ ] T10: account-pool.test.ts — Selection, cooldown isolation, refresh lock, pool-of-one

## Phase 3: Auth & Project Context (PR 3, ~300 lines)

- [ ] T11: token.ts — refreshAccessTokenForAccount()
- [ ] T12: token.test.ts — Per-account refresh lock tests
- [ ] T13: project/utils.ts — buildProjectCacheKeyForAccount()
- [ ] T14: project/context.ts — Cache keyed by account ID, ensureProjectContextForAccount()
- [ ] T15: project/context.test.ts — Cache isolation per account
- [ ] T16: provider.ts — Per-account project ID resolution
- [ ] T17: oauth-authorize.ts — createOAuthAuthorizeMethodForAccount()

## Phase 4: Plugin Integration (PR 4, ~300 lines)

- [ ] T18: plugin.ts — Loader detects accounts[], builds AccountPool, fetch calls pool.select()
- [ ] T19: plugin.ts — fetch calls pool.refreshAccount(), ensureProjectContextForAccount()
- [ ] T20: plugin.test.ts — Multi-account init, fetch dispatch, backwards compat

## Phase 5: Retry & Quota (PR 4 continued)

- [ ] T21: retry/index.ts — Cooldown keys include account ID namespace
- [ ] T22: retry/index.ts — Terminal 429 sets per-account cooldown, delegates to pool.select()
- [ ] T23: retry/index.ts — All-exhausted error message lists accounts with reasons
- [ ] T24: quota.ts — Per-account quota sections
- [ ] T25: quota.ts — Aggregate summary header
- [ ] T26: quota.test.ts — Per-account formatting, aggregate, single-account compat

## Phase 6: Account Management (PR 5, ~350 lines)

- [ ] T27: account-manager.ts — Add Gemini Account auth method
- [ ] T28: account-manager.ts — Manage Gemini Accounts (list, toggle)
- [ ] T29: account-manager.ts — Remove account flow
- [ ] T30: oauth-authorize.ts — Extend OAuth for multi-account context
- [ ] T31: account-manager.test.ts — Add/remove/toggle, OAuth integration, config persistence
