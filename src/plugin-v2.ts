import { Integration, Plugin, type Credential } from "@opencode-ai/plugin";

import { GEMINI_PROVIDER_ID } from "./constants";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { createOAuthAuthorizeMethod } from "./plugin/oauth-authorize";
import { resolveProjectContextFromAccessToken } from "./plugin/project";
import { resolveConfiguredProjectId } from "./plugin/provider";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./plugin/request";
import { refreshAccessToken } from "./plugin/token";
import type { OAuthAuthDetails, PluginClient } from "./plugin/types";

const GEMINI_OAUTH_METHOD_ID = Integration.MethodID.make("gemini-cli");

type V2Context = Pick<Plugin.Context, "catalog" | "integration" | "session">;

const noPersistClient = {
  auth: { set: async () => {} },
} as PluginClient;

export async function setupV2(ctx: V2Context): Promise<void> {
  const requests = new WeakMap<Request, { streaming: boolean; requestedModel?: string }>();
  const getConfiguredProjectId = () => resolveV2ConfiguredProjectId(ctx);
  const authorize = createOAuthAuthorizeMethod({ getConfiguredProjectId });

  await ctx.integration.transform((draft) => {
    draft.method.update({
      integrationID: GEMINI_PROVIDER_ID,
      method: {
        id: GEMINI_OAUTH_METHOD_ID,
        type: "oauth",
        label: "OAuth with Google (Gemini CLI)",
      },
      authorize: async () => {
        const authorization = await authorize();
        return authorization.method === "auto"
          ? {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "auto",
              callback: authorization.callback().then(toV2Credential),
            }
          : {
              url: authorization.url,
              instructions: authorization.instructions,
              mode: "code",
              callback: (code: string) => authorization.callback(code).then(toV2Credential),
            };
      },
      refresh: async (credential) => {
        const refreshed = await refreshAccessToken(credential, noPersistClient);
        if (!refreshed?.access || refreshed.expires === undefined) {
          throw new Error("Gemini OAuth token refresh failed");
        }
        return { ...credential, ...refreshed };
      },
      label: (credential) =>
        typeof credential.metadata?.email === "string" ? credential.metadata.email : undefined,
    });
  });

  await ctx.session.hook("http.request", async (event) => {
    if (!isGenerativeLanguageRequest(event.request)) {
      return;
    }

    const connection = await ctx.integration.connection.active(GEMINI_PROVIDER_ID);
    const credential = connection
      ? await ctx.integration.connection.resolve(connection)
      : undefined;
    if (!isV2Credential(credential) || credential.methodID !== GEMINI_OAUTH_METHOD_ID) {
      return;
    }

    const project = await resolveProjectContextFromAccessToken(
      credential,
      credential.access,
      await getConfiguredProjectId(),
      undefined,
      event.model.id,
    );
    const original = event.request;
    const body = original.method === "GET" || original.method === "HEAD"
      ? undefined
      : await original.clone().text();
    const transformed = prepareGeminiRequest(
      original,
      { method: original.method, headers: original.headers, body, signal: original.signal },
      credential.access,
      project.effectiveProjectId,
    );
    const request = new Request(transformed.request, transformed.init);
    requests.set(request, {
      streaming: transformed.streaming,
      requestedModel: transformed.requestedModel,
    });
    event.request = request;
  }, { providerID: GEMINI_PROVIDER_ID });

  await ctx.session.hook("http.response", async (event) => {
    const request = requests.get(event.request);
    if (!request) return;
    event.response = await transformGeminiResponse(
      event.response,
      request.streaming,
      null,
      request.requestedModel,
    );
  }, { providerID: GEMINI_PROVIDER_ID });
}

async function resolveV2ConfiguredProjectId(ctx: V2Context): Promise<string | undefined> {
  const fromEnvironment = resolveConfiguredProjectId();
  if (fromEnvironment) return fromEnvironment;
  try {
    const provider = await ctx.catalog.provider.get({ providerID: GEMINI_PROVIDER_ID });
    return resolveConfiguredProjectId({
      provider: { options: provider.data.settings },
    });
  } catch {
    return undefined;
  }
}

function toV2Credential(result: GeminiTokenExchangeResult): Credential.OAuth {
  if (result.type !== "success") throw new Error(result.error);
  return {
    type: "oauth",
    methodID: GEMINI_OAUTH_METHOD_ID,
    refresh: result.refresh,
    access: result.access,
    expires: result.expires,
    metadata: result.email ? { email: result.email } : undefined,
  };
}

function isV2Credential(value: unknown): value is Credential.OAuth {
  return !!value && typeof value === "object" &&
    (value as { type?: unknown }).type === "oauth" &&
    typeof (value as { methodID?: unknown }).methodID === "string";
}

export default Plugin.define({
  id: "opencode.provider.google-gemini-cli",
  setup: setupV2,
});
