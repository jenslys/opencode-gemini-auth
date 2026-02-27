import { classifyQuotaResponse } from "./retry/quota";
import { isGeminiDebugEnabled, logGeminiDebugMessage } from "./debug";
import type { PluginClient } from "./types";

const MODEL_CAPACITY_TOAST_COOLDOWN_MS = 30_000;
const modelCapacityToastCooldownByKey = new Map<string, number>();
const TEST_TOAST_FLAG = "OPENCODE_GEMINI_TEST_TOAST";
const testToastShownByProject = new Set<string>();

/**
 * Emits a user-facing toast for server-side Gemini model capacity exhaustion.
 *
 * We deliberately notify only `MODEL_CAPACITY_EXHAUSTED` (not generic 429s)
 * so we do not mislabel account-level quota limits as backend incidents.
 */
export async function maybeShowGeminiCapacityToast(
  client: PluginClient,
  response: Response,
  projectId: string,
  requestedModel?: string,
): Promise<void> {
  if (response.status !== 429 || !client.tui?.showToast) {
    return;
  }

  const quotaContext = await classifyQuotaResponse(response);
  if (quotaContext?.reason !== "MODEL_CAPACITY_EXHAUSTED") {
    return;
  }

  const model = requestedModel ?? "the selected model";
  const toastKey = `${projectId}|${model}|MODEL_CAPACITY_EXHAUSTED`;
  const now = Date.now();
  const cooldownUntil = modelCapacityToastCooldownByKey.get(toastKey) ?? 0;
  if (cooldownUntil > now) {
    return;
  }
  modelCapacityToastCooldownByKey.set(toastKey, now + MODEL_CAPACITY_TOAST_COOLDOWN_MS);

  await client.tui.showToast({
    body: {
      title: "Gemini Capacity Unavailable",
      message: `Google reports temporary server capacity limits for ${model}. Please retry in a few seconds.`,
      variant: "warning",
      duration: 7000,
    },
  });
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(`Toast: emitted capacity warning for model=${model} project=${projectId}`);
  }
}

/**
 * Temporary smoke-test toast, enabled only with OPENCODE_GEMINI_TEST_TOAST=1.
 * Emits once per project per process lifetime to avoid toast spam.
 */
export async function maybeShowGeminiTestToast(
  client: PluginClient,
  projectId: string,
): Promise<void> {
  if (process.env[TEST_TOAST_FLAG]?.trim() !== "1" || !client.tui?.showToast) {
    return;
  }

  const key = projectId || "global";
  if (testToastShownByProject.has(key)) {
    return;
  }
  testToastShownByProject.add(key);

  await client.tui.showToast({
    body: {
      title: "Gemini Toast Test",
      message: "Temporary test toast from opencode-gemini-auth.",
      variant: "info",
      duration: 5000,
    },
  });
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(`Toast: emitted test toast (project=${key})`);
  }
}

export const notifyInternals = {
  resetCooldowns() {
    modelCapacityToastCooldownByKey.clear();
    testToastShownByProject.clear();
  },
};
