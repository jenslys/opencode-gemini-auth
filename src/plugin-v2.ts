import { GEMINI_PROVIDER_ID } from "./constants";
import type { GeminiTokenExchangeResult } from "./gemini/oauth";
import { GeminiCLIOAuthPlugin } from "./plugin";
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

const GEMINI_OAUTH_METHOD_ID = "gemini-cli";

interface V2Credential extends OAuthAuthDetails {
  methodID: string;
  access: string;
  expires: number;
  metadata?: Record<string, unknown>;
}

interface V2Context {
  catalog: {
    provider: {
      get(input: { providerID: string }): Promise<{
        data?: { settings?: Record<string, unknown> };
      } | undefined>;
    };
  };
  integration: {
    transform(callback: (draft: {
      method: {
        update(input: {
          integrationID: string;
          method: { id: string; type: "oauth"; label: string };
          authorize: () => Promise<{
            url: string;
            instructions: string;
            mode: "auto" | "code";
            callback: Promise<V2Credential> | ((code: string) => Promise<V2Credential>);
          }>;
          refresh: (credential: V2Credential) => Promise<V2Credential>;
          label: (credential: V2Credential) => string | undefined;
        }): void;
      };
    }) => void): Promise<unknown>;
    connection: {
      active(id: string): Promise<unknown>;
      resolve(connection: unknown): Promise<V2Credential | { type: string } | undefined>;
    };
  };
  session: {
    hook(
      name: "http.request" | "http.response",
      callback: (event: V2RequestEvent | V2ResponseEvent) => Promise<void>,
    ): Promise<unknown>;
  };
}

interface V2RequestEvent {
  model: { providerID: string; id: string };
  request: Request;
}

interface V2ResponseEvent extends V2RequestEvent {
  response: Response;
}

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

  await ctx.session.hook("http.request", async (rawEvent) => {
    const event = rawEvent as V2RequestEvent;
    if (
      event.model.providerID !== GEMINI_PROVIDER_ID ||
      !isGenerativeLanguageRequest(event.request)
    ) {
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
  });

  await ctx.session.hook("http.response", async (rawEvent) => {
    const event = rawEvent as V2ResponseEvent;
    const request = requests.get(event.request);
    if (!request) return;
    event.response = await transformGeminiResponse(
      event.response,
      request.streaming,
      null,
      request.requestedModel,
    );
  });
}

async function resolveV2ConfiguredProjectId(ctx: V2Context): Promise<string | undefined> {
  const fromEnvironment = resolveConfiguredProjectId();
  if (fromEnvironment) return fromEnvironment;
  try {
    const provider = await ctx.catalog.provider.get({ providerID: GEMINI_PROVIDER_ID });
    return resolveConfiguredProjectId({
      provider: { options: provider?.data?.settings },
    });
  } catch {
    return undefined;
  }
}

function toV2Credential(result: GeminiTokenExchangeResult): V2Credential {
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

function isV2Credential(value: unknown): value is V2Credential {
  return !!value && typeof value === "object" &&
    (value as { type?: unknown }).type === "oauth" &&
    typeof (value as { methodID?: unknown }).methodID === "string";
}

export default {
  id: "opencode.provider.google-gemini-cli",
  setup: (ctx: unknown) => setupV2(ctx as V2Context),
  server: GeminiCLIOAuthPlugin,
};
