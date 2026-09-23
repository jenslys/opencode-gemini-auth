import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Plugin } from "@opencode/plugin";

import plugin, { setupV2 } from "./plugin-v2";

const projectEnvKeys = ["OPENCODE_GEMINI_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"];
const savedEnv = new Map(projectEnvKeys.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of projectEnvKeys) delete process.env[key];
});

afterEach(() => {
  mock.restore();
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const providerResult = (projectId?: string): Awaited<ReturnType<Plugin.Context["provider"]["get"]>> => ({
  location: { directory: process.cwd() },
  data: {
    id: "google",
    name: "Google",
    activation: "auto",
    package: "@opencode/ai/providers/google",
    settings: projectId ? { projectId } : {},
  },
});

async function setup(getProvider: Plugin.Context["provider"]["get"] = async () => providerResult()) {
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
    provider: { get: getProvider },
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
  return { method, hooks, credential };
}

function requestEvent() {
  return {
    model: { providerID: "google", id: "gemini-2.5-pro" },
    request: new Request(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
      { method: "POST", body: JSON.stringify({ contents: [] }) },
    ),
  };
}

test("V2 plugin registers OAuth and rewrites Gemini requests and responses", async () => {
  const { method, hooks } = await setup();

  expect(plugin.id).toBe("opencode.provider.google-gemini-cli");
  expect(plugin.setup).toBe(setupV2);
  expect(method.integrationID).toBe("google");
  expect(method.method.id).toBe("gemini-cli");

  const event = requestEvent();
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

test("V2 requests use the configured project from the stable provider API", async () => {
  const getProvider = mock(async () => providerResult("configured-project"));
  const { hooks } = await setup(getProvider);
  const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ currentTier: { id: "standard-tier" } }),
  );
  const event = requestEvent();
  await hooks["http.request"]!(event);

  expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]?.[0]).toContain(":loadCodeAssist");
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    cloudaicompanionProject: "configured-project",
  });
  expect(await event.request.json()).toMatchObject({ project: "configured-project" });
});

test("V2 provider lookup failures do not fall back to a persisted project", async () => {
  process.env.GOOGLE_CLOUD_PROJECT = "ambient-project";
  const { hooks } = await setup(async () => { throw new Error("Provider unavailable"); });
  const event = requestEvent();
  const original = event.request;
  const fetchMock = spyOn(globalThis, "fetch");

  await expect(hooks["http.request"]!(event)).rejects.toThrow("Provider unavailable");
  expect(event.request).toBe(original);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("V2 explicit project environment works without a provider lookup", async () => {
  process.env.OPENCODE_GEMINI_PROJECT_ID = "environment-project";
  const getProvider = mock(async () => { throw new Error("Should not be called"); });
  const { hooks } = await setup(getProvider);
  spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
  const event = requestEvent();
  await hooks["http.request"]!(event);

  expect(getProvider).not.toHaveBeenCalled();
  expect(await event.request.json()).toMatchObject({ project: "environment-project" });
});

test("V2 requests with another OAuth method are left untouched", async () => {
  const getProvider = mock(async () => providerResult());
  const { hooks, credential } = await setup(getProvider);
  credential.methodID = "another-method";
  const event = requestEvent();
  const original = event.request;
  await hooks["http.request"]!(event);

  expect(event.request).toBe(original);
  expect(getProvider).not.toHaveBeenCalled();
});

test.each(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"])(
  "V2 explicit provider project takes precedence over %s",
  async (key) => {
    process.env[key] = "ambient-project";
    const getProvider = mock(async () => providerResult("explicit-project"));
    const { hooks } = await setup(getProvider);
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
    const event = requestEvent();
    await hooks["http.request"]!(event);

    expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
    expect(await event.request.json()).toMatchObject({ project: "explicit-project" });
  },
);

test.each(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT_ID"])(
  "V2 falls back to %s when the provider has no configured project",
  async (key) => {
    process.env[key] = "ambient-project";
    const getProvider = mock(async () => providerResult());
    const { hooks } = await setup(getProvider);
    spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ currentTier: { id: "standard-tier" } }));
    const event = requestEvent();
    await hooks["http.request"]!(event);

    expect(getProvider).toHaveBeenCalledWith({ providerID: "google" });
    expect(await event.request.json()).toMatchObject({ project: "ambient-project" });
  },
);
