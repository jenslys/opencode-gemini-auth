import { createServer } from "node:http";

import { GEMINI_REDIRECT_URI } from "../constants";

interface OAuthListenerOptions {
  /**
   * How long to wait for the OAuth redirect before timing out (in milliseconds).
   */
  timeoutMs?: number;
}

export interface OAuthListener {
  /**
   * Resolves with the callback URL once Google redirects back to the local server.
   */
  waitForCallback(): Promise<URL>;
  /**
   * Cleanly stop listening for callbacks.
   */
  close(): Promise<void>;
}

const redirectUri = new URL(GEMINI_REDIRECT_URI);
const callbackPath = redirectUri.pathname || "/";

/**
 * Start a lightweight HTTP server that listens for the Gemini OAuth redirect.
 * Returns a listener object that resolves with the callback once received.
 */
export async function startOAuthListener(
  { timeoutMs = 5 * 60 * 1000 }: OAuthListenerOptions = {},
): Promise<OAuthListener> {
  const port = redirectUri.port
    ? Number.parseInt(redirectUri.port, 10)
    : redirectUri.protocol === "https:"
    ? 443
    : 80;
  const origin = `${redirectUri.protocol}//${redirectUri.host}`;

  let settled = false;
  let resolveCallback: (url: URL) => void;
  let rejectCallback: (error: Error) => void;
  const callbackPromise = new Promise<URL>((resolve, reject) => {
    resolveCallback = (url: URL) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(url);
    };
    rejectCallback = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(error);
    };
  });

  const successResponse = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Opencode Gemini OAuth</title>
    <style>
      body { font-family: sans-serif; margin: 2rem; line-height: 1.5; }
      h1 { font-size: 1.5rem; margin-bottom: 1rem; }
    </style>
  </head>
  <body>
    <h1>Authentication complete</h1>
    <p>You can close this tab and return to the Opencode CLI.</p>
  </body>
</html>`;

  const timeoutHandle = setTimeout(() => {
    rejectCallback(new Error("Timed out waiting for OAuth callback"));
  }, timeoutMs);
  timeoutHandle.unref?.();

  const server = createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request");
      return;
    }

    const url = new URL(request.url, origin);
    if (url.pathname !== callbackPath) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(successResponse);

    resolveCallback(url);

    // Close the server after handling the first valid callback.
    setImmediate(() => {
      server.close();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off("error", handleError);
      reject(error);
    };
    server.once("error", handleError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", handleError);
      resolve();
    });
  });

  server.on("error", (error) => {
    rejectCallback(error instanceof Error ? error : new Error(String(error)));
  });

  return {
    waitForCallback: () => callbackPromise,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
            reject(error);
            return;
          }
          if (!settled) {
            rejectCallback(new Error("OAuth listener closed before callback"));
          }
          resolve();
        });
      }),
  };
}
