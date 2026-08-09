/**
 * Tracks per-account health scores with O(1) incremental updates.
 *
 * Weights: success rate 40%, quota remaining 30%, latency 15%, cooldown frequency 15%.
 */

import type { HealthScore } from "./types";

const WEIGHT_SUCCESS = 0.40;
const WEIGHT_QUOTA = 0.30;
const WEIGHT_LATENCY = 0.15;
const WEIGHT_COOLDOWN = 0.15;

const DEFAULT_LATENCY_MS = 500;
const MAX_LATENCY_MS = 5000;
const COOLDOWN_PENALTY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export class HealthTracker {
  private successCount: number = 0;
  private failureCount: number = 0;
  private totalLatencyMs: number = 0;
  private requestCount: number = 0;
  private cooldownCount: number = 0;
  private lastCooldownAt: number = 0;
  private quotaRemaining: number = 1.0;

  recordSuccess(latencyMs: number = DEFAULT_LATENCY_MS): void {
    this.successCount++;
    this.requestCount++;
    this.totalLatencyMs += latencyMs;
  }

  recordFailure(): void {
    this.failureCount++;
    this.requestCount++;
  }

  recordCooldown(): void {
    this.cooldownCount++;
    this.lastCooldownAt = Date.now();
  }

  setQuotaRemaining(pct: number): void {
    this.quotaRemaining = Math.max(0, Math.min(1, pct));
  }

  compute(): HealthScore {
    const total = this.successCount + this.failureCount;
    const successRate = total > 0 ? this.successCount / total : 1.0;
    const avgLatency = this.requestCount > 0 ? this.totalLatencyMs / this.requestCount : 0;
    const latencyScore = Math.max(0, 1 - (avgLatency / MAX_LATENCY_MS));

    // Cooldown score: penalize recent cooldowns
    const timeSinceLastCooldown = Date.now() - this.lastCooldownAt;
    const cooldownDecay = this.lastCooldownAt > 0
      ? Math.max(0, 1 - (this.cooldownCount * (COOLDOWN_PENALTY_WINDOW_MS / Math.max(timeSinceLastCooldown, 1))))
      : 1.0;
    const cooldownScore = Math.max(0, Math.min(1, cooldownDecay));

    const value =
      WEIGHT_SUCCESS * successRate +
      WEIGHT_QUOTA * this.quotaRemaining +
      WEIGHT_LATENCY * latencyScore +
      WEIGHT_COOLDOWN * cooldownScore;

    return {
      value: Math.round(value * 100) / 100,
      successRate: Math.round(successRate * 100) / 100,
      quotaRemaining: Math.round(this.quotaRemaining * 100) / 100,
      latencyScore: Math.round(latencyScore * 100) / 100,
      cooldownScore: Math.round(cooldownScore * 100) / 100,
    };
  }

  reset(): void {
    this.successCount = 0;
    this.failureCount = 0;
    this.totalLatencyMs = 0;
    this.requestCount = 0;
    this.cooldownCount = 0;
    this.lastCooldownAt = 0;
    this.quotaRemaining = 1.0;
  }
}
