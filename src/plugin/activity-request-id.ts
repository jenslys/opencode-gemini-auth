/**
 * Gemini CLI attaches a short per-request activity id via its network logger.
 * We mirror the same shape so backend/debug traces look like CLI traffic.
 */
export function createGeminiActivityRequestId(): string {
  return Math.random().toString(36).substring(7);
}
