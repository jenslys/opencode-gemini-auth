/**
 * Selects the best account from a pool using:
 * 1. Filter out disabled accounts
 * 2. Filter out accounts in cooldown for the given model
 * 3. If all filtered out → pick account with shortest remaining cooldown
 * 4. Apply health score weighting (higher health = higher probability)
 * 5. Prefer accounts with >20% remaining quota (if quota data is fresh)
 * 6. LRU tiebreaker (lowest usageCount)
 */

import type { AccountState, CooldownState } from "./types";
import { getCanonicalModelName } from "./models";

export interface SelectOptions {
  model?: string;
  url?: string;
}

export function selectBestAccount(
  accounts: AccountState[],
  options: SelectOptions = {},
): AccountState | undefined {
  if (accounts.length === 0) return undefined;
  if (accounts.length === 1) return accounts[0];

  const enabled = accounts.filter((a) => a.account.enabled);
  if (enabled.length === 0) return undefined;

  const now = Date.now();
  const model = options.model ? getCanonicalModelName(options.model) : undefined;

  // Check cooldown status per account
  const cooldownStatus = enabled.map((account) => {
    const cooldown = model ? account.cooldowns.get(model) : undefined;
    const isCooldowned = cooldown && cooldown.expiresAt > now;
    const remainingMs = isCooldowned ? cooldown!.expiresAt - now : 0;
    return { account, isCooldowned: !!isCooldowned, remainingMs };
  });

  const available = cooldownStatus.filter((c) => !c.isCooldowned);

  // If all are cooldowned, pick the one with shortest remaining cooldown
  if (available.length === 0) {
    const shortest = cooldownStatus.reduce((a, b) =>
      a.remainingMs < b.remainingMs ? a : b,
    );
    return shortest.account;
  }

  // Filter by quota preference (>20% remaining)
  const quotaPreferred = available.filter(
    (c) => c.account.health.quotaRemaining > 0.2,
  );
  const candidates = quotaPreferred.length > 0 ? quotaPreferred : available;

  // Weighted random selection among accounts with health > 0
  const totalHealth = candidates.reduce((sum, c) => sum + Math.max(0, c.account.health.value), 0);
  
  if (totalHealth > 0) {
    let random = Math.random() * totalHealth;
    for (const c of candidates) {
      const weight = Math.max(0, c.account.health.value);
      if (random <= weight) {
        return c.account;
      }
      random -= weight;
    }
  }

  // Fallback: pick the one with lowest usageCount (LRU)
  return candidates.reduce((a, b) =>
    a.account.usageCount <= b.account.usageCount ? a : b,
  ).account;
}

/**
 * Returns a human-readable summary of why an account was or wasn't selected.
 */
export function explainSelection(
  accounts: AccountState[],
  selected: AccountState | undefined,
  options: SelectOptions = {},
): string {
  if (!selected) return "No accounts available";
  if (accounts.length === 1) return `Single account: ${selected.account.id}`;

  const now = Date.now();
  const model = options.model;
  const disabled = accounts.filter((a) => !a.account.enabled);
  const cooldowned = accounts.filter((a) => {
    if (!model) return false;
    const cd = a.cooldowns.get(model);
    return cd && cd.expiresAt > now;
  });

  const parts: string[] = [];
  if (disabled.length > 0) parts.push(`${disabled.length} disabled`);
  if (cooldowned.length > 0) parts.push(`${cooldowned.length} in cooldown`);
  parts.push(`selected: ${selected.account.id} (health: ${selected.health.value})`);

  return parts.join(", ");
}
