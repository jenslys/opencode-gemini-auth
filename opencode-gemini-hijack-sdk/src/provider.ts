import {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2CallWarning,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart
} from 'ai';
import { getCredentials, refreshAccessToken, HEADERS } from './auth.js';
import { mapPromptToGemini } from './mapping.js';

function mapFinishReason(reason: string): LanguageModelV2FinishReason {
    switch (reason) {
        case 'STOP': return 'stop';
        case 'MAX_TOKENS': return 'length';
        case 'SAFETY': return 'content-filter';
        case 'RECITATION': return 'content-filter';
        default: return 'other';
    }
}

export class OpencodeGeminiLanguageModel implements LanguageModelV2 {
  public specificationVersion = 'v2' as const;
  public provider: string = 'opencode-gemini';
  public modelId: string = 'gemini-pro-vision';

  constructor(private projectId?: string) {}

  get supportedUrls() {
      return {};
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const creds = getCredentials();
    if (!creds) {
      throw new Error("Opencode credentials not found.");
    }
    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) {
      throw new Error("Failed to refresh access token.");
    }

    const projectId = this.projectId || creds.projectId;
    // Note: mapPromptToGemini needs to be compatible with V2 prompt structure.
    // Assuming prompt structure is compatible or handled by ai package conversion.
    // Wait, V2 uses `options.prompt` which is `LanguageModelV2Prompt`.
    // My mapPromptToGemini handles `LanguageModelV1Prompt`.
    // They are likely similar enough for this hijack (array of messages).
    const request = await mapPromptToGemini(options.prompt as any);

    const wrappedRequest = {
      project: projectId,
      model: this.modelId,
      request,
    };

    const response = await fetch("https://cloudcode-pa.googleapis.com/v1internal:generateContent", {
      method: "POST",
      headers: {
        ...HEADERS,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(wrappedRequest),
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
    }

    const json = await response.json();

    const candidate = json.candidates?.[0];
    if (!candidate) {
      throw new Error("No candidate returned.");
    }

    const text = candidate.content?.parts?.[0]?.text || '';
    const finishReason = mapFinishReason(candidate.finishReason);

    return {
      content: [{ type: 'text', text }] as any, // V2 expects array of content parts
      finishReason,
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount || 0,
        completionTokens: json.usageMetadata?.candidatesTokenCount || 0,
      },
      request: { body: JSON.stringify(wrappedRequest) },
      response: { body: json },
      warnings: [] as LanguageModelV2CallWarning[],
    };
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const creds = getCredentials();
    if (!creds) {
      throw new Error("Opencode credentials not found.");
    }
    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) {
      throw new Error("Failed to refresh access token.");
    }

    const projectId = this.projectId || creds.projectId;
    const request = await mapPromptToGemini(options.prompt as any);

    const wrappedRequest = {
      project: projectId,
      model: this.modelId,
      request,
    };

    const response = await fetch("https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: {
        ...HEADERS,
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
      },
      body: JSON.stringify(wrappedRequest),
    });

    if (!response.ok) {
      throw new Error(`Gemini API error: ${response.status} ${await response.text()}`);
    }

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
        async start(controller) {
            const reader = response.body?.getReader();
            if (!reader) {
                controller.close();
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const parts = buffer.split('\n');
                    buffer = parts.pop() || '';

                    for (const line of parts) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;

                        const jsonStr = trimmed.slice(5).trim();
                        if (!jsonStr) continue;

                        try {
                            const parsed = JSON.parse(jsonStr);
                            const data = parsed.response || parsed;

                            const candidate = data.candidates?.[0];
                            if (candidate) {
                                const text = candidate.content?.parts?.[0]?.text;
                                if (text) {
                                    controller.enqueue({
                                        type: 'text-delta',
                                        textDelta: text
                                    });
                                }

                                if (candidate.finishReason) {
                                    controller.enqueue({
                                        type: 'finish',
                                        finishReason: mapFinishReason(candidate.finishReason),
                                        usage: {
                                            promptTokens: data.usageMetadata?.promptTokenCount || 0,
                                            completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
                                        }
                                    });
                                }
                            }
                        } catch (e) {
                        }
                    }
                }
            } catch (err) {
                controller.error(err);
            } finally {
                controller.close();
            }
        }
    });

    return {
        stream,
        request: { body: JSON.stringify(wrappedRequest) },
    };
  }
}
