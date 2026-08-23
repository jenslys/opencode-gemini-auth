import { expect, test } from "bun:test";

import plugin, { setupV2 } from "./plugin-v2";

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

  const context = {
    catalog: {
      provider: { async get() { return { data: { settings: {} } }; } },
    },
    integration: {
      async transform(callback: (draft: any) => void) {
        callback({ method: { update(input: any) { method = input; } } });
      },
      connection: {
        async active() { return { type: "credential" }; },
        async resolve() { return credential; },
      },
    },
    session: {
      async hook(name: string, callback: (event: any) => Promise<void>) { hooks[name] = callback; },
    },
  };
  await setupV2(context as unknown as Parameters<typeof setupV2>[0]);

  expect(plugin.id).toBe("opencode.provider.google-gemini-cli");
  expect(plugin.setup).toBe(setupV2);
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
