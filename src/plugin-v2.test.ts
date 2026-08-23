import { expect, test } from "bun:test";

import { setupV2 } from "./plugin-v2";

test("V2 plugin registers OAuth and rewrites Gemini requests and responses", async () => {
  let method: any;
  const hooks: Record<string, (event: any) => Promise<void>> = {};
  const credential = {
    type: "oauth",
    methodID: "gemini-cli",
    refresh: "refresh-token||managed-project",
    access: "access-token",
    expires: Date.now() + 60_000,
  };

  await setupV2({
    catalog: {
      provider: { async get() { return { data: { settings: {} } }; } },
    },
    integration: {
      async transform(callback) {
        callback({ method: { update(input) { method = input; } } });
      },
      connection: {
        async active() { return { type: "credential" }; },
        async resolve() { return credential; },
      },
    },
    session: {
      async hook(name, callback) { hooks[name] = callback; },
    },
  });

  expect(method.integrationID).toBe("google");
  expect(method.method.id).toBe("gemini-cli");

  const event = {
    model: { providerID: "google", id: "gemini-2.5-pro" },
    request: new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
  };
  await hooks["http.request"]!(event);

  expect(event.request.url).toContain("cloudcode-pa.googleapis.com/v1internal:streamGenerateContent");
  expect(event.request.headers.get("authorization")).toBe("Bearer access-token");
  expect(await event.request.clone().json()).toMatchObject({
    project: "managed-project",
    model: "gemini-2.5-pro",
  });

  const responseEvent = {
    ...event,
    response: Response.json({ response: { candidates: [] } }),
  };
  await hooks["http.response"]!(responseEvent);
  expect(await responseEvent.response.json()).toEqual({ candidates: [] });
});
