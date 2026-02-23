import { generatePKCE } from "@openauthjs/openauth/pkce";
import { createHash, randomBytes } from "node:crypto";

import {
  GEMINI_CLIENT_ID,
  GEMINI_CLIENT_SECRET,
  GEMINI_REDIRECT_URI,
  GEMINI_SCOPES,
} from "../constants";
import {
  formatDebugBodyPreview,
  isGeminiDebugEnabled,
  logGeminiDebugMessage,
} from "../plugin/debug";

interface PkcePair {
  challenge: string;
  verifier: string;
}

/**
 * Result returned to the caller after constructing an OAuth authorization URL.
 */
export interface GeminiAuthorization {
  url: string;
  verifier: string;
  state: string;
}

interface GeminiTokenExchangeSuccess {
  type: "success";
  refresh: string;
  access: string;
  expires: number;
  email?: string;
}

interface GeminiTokenExchangeFailure {
  type: "failed";
  error: string;
}

export type GeminiTokenExchangeResult =
  | GeminiTokenExchangeSuccess
  | GeminiTokenExchangeFailure;

interface GeminiTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
}

interface GeminiUserInfo {
  email?: string;
}

const AUTHORIZATION_CODE_REPLAY_TTL_MS = 10 * 60 * 1000;
const exchangeInFlight = new Map<string, Promise<GeminiTokenExchangeResult>>();
const consumedExchanges = new Map<string, number>();

/**
 * Build the Gemini OAuth authorization URL including PKCE.
 */
export async function authorizeGemini(): Promise<GeminiAuthorization> {
  const pkce = (await generatePKCE()) as PkcePair;
  const state = randomBytes(32).toString("hex");

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GEMINI_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", GEMINI_REDIRECT_URI);
  url.searchParams.set("scope", GEMINI_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");

  return {
    url: url.toString(),
    verifier: pkce.verifier,
    state,
  };
}

/**
 * Exchange an authorization code using a known PKCE verifier.
 */
export async function exchangeGeminiWithVerifier(
  code: string,
  verifier: string,
): Promise<GeminiTokenExchangeResult> {
  const normalizedCode = typeof code === "string" ? code.trim() : "";
  const normalizedVerifier = typeof verifier === "string" ? verifier.trim() : "";
  if (isGeminiDebugEnabled() && (typeof code !== "string" || typeof verifier !== "string")) {
    logGeminiDebugMessage(
      `OAuth exchange received non-string inputs: code=${typeof code} verifier=${typeof verifier}`,
    );
  }
  if (!normalizedCode) {
    return {
      type: "failed",
      error: "Missing authorization code in exchange request",
    };
  }
  if (!normalizedVerifier) {
    return {
      type: "failed",
      error: "Missing PKCE verifier for OAuth exchange",
    };
  }

  pruneConsumedExchanges();
  const exchangeKey = buildExchangeKey(normalizedCode, normalizedVerifier);
  if (consumedExchanges.has(exchangeKey)) {
    return {
      type: "failed",
      error: "Authorization code was already submitted. Start a new login flow.",
    };
  }

  const pending = exchangeInFlight.get(exchangeKey);
  if (pending) {
    return pending;
  }

  const exchangePromise = exchangeGeminiWithVerifierInternal(normalizedCode, normalizedVerifier).catch(
    (error): GeminiTokenExchangeResult => ({
      type: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    }),
  );
  exchangeInFlight.set(exchangeKey, exchangePromise);

  let exchangeResult: GeminiTokenExchangeResult | undefined;
  try {
    exchangeResult = await exchangePromise;
    return exchangeResult;
  } finally {
    exchangeInFlight.delete(exchangeKey);
    if (exchangeResult?.type === "success") {
      consumedExchanges.set(exchangeKey, Date.now());
    }
    pruneConsumedExchanges();
  }
}

async function exchangeGeminiWithVerifierInternal(
  code: string,
  verifier: string,
): Promise<GeminiTokenExchangeResult> {
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("OAuth exchange: POST https://oauth2.googleapis.com/token");
    logGeminiDebugMessage(`OAuth exchange code fingerprint: ${fingerprint(code)} len=${code.length}`);
  }
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: GEMINI_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    if (isGeminiDebugEnabled()) {
      logGeminiDebugMessage(
        `OAuth exchange response: ${tokenResponse.status} ${tokenResponse.statusText}`,
      );
      const preview = formatDebugBodyPreview(errorText);
      if (preview) {
        logGeminiDebugMessage(`OAuth exchange error body: ${preview}`);
      }
    }
    return { type: "failed", error: errorText };
  }

  const tokenPayload = (await tokenResponse.json()) as GeminiTokenResponse;
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth exchange success: expires_in=${tokenPayload.expires_in}s refresh_token=${tokenPayload.refresh_token ? "yes" : "no"}`,
    );
  }

  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage("OAuth userinfo: GET https://www.googleapis.com/oauth2/v1/userinfo");
  }
  const userInfoResponse = await fetch(
    "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    {
      headers: {
        Authorization: `Bearer ${tokenPayload.access_token}`,
      },
    },
  );
  if (isGeminiDebugEnabled()) {
    logGeminiDebugMessage(
      `OAuth userinfo response: ${userInfoResponse.status} ${userInfoResponse.statusText}`,
    );
  }

  const userInfo = userInfoResponse.ok
    ? ((await userInfoResponse.json()) as GeminiUserInfo)
    : {};

  const refreshToken = tokenPayload.refresh_token;
  if (!refreshToken) {
    return { type: "failed", error: "Missing refresh token in response" };
  }

  return {
    type: "success",
    refresh: refreshToken,
    access: tokenPayload.access_token,
    expires: Date.now() + tokenPayload.expires_in * 1000,
    email: userInfo.email,
  };
}

function buildExchangeKey(code: string, verifier: string): string {
  return createHash("sha256").update(code).update("\u0000").update(verifier).digest("hex");
}

function pruneConsumedExchanges(now = Date.now()): void {
  for (const [key, consumedAt] of consumedExchanges.entries()) {
    if (now - consumedAt > AUTHORIZATION_CODE_REPLAY_TTL_MS) {
      consumedExchanges.delete(key);
    }
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
