import {
  LanguageModelV1,
  LanguageModelV1Prompt,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1StreamPart,
  LanguageModelV1LogProbs
} from 'ai';
import { getCredentials, refreshAccessToken, HEADERS } from './auth.js';
import { mapPromptToGemini } from './mapping.js';

function mapFinishReason(reason: string): LanguageModelV1FinishReason {
    switch (reason) {
        case 'STOP': return 'stop';
        case 'MAX_TOKENS': return 'length';
        case 'SAFETY': return 'content-filter';
        case 'RECITATION': return 'content-filter';
        default: return 'other';
    }
}

export class OpencodeGeminiLanguageModel implements LanguageModelV1 {
  public specificationVersion = 'v1' as const;
  public provider: string = 'opencode-gemini';
  public modelId: string = 'gemini-pro-vision';

  constructor(private projectId?: string) {}

  get defaultObjectGenerationMode() {
    return 'json' as const;
  }

  async doGenerate(options: {
    inputFormat: 'prompt';
    mode: { type: 'regular' | 'chat' | 'completion' };
    prompt: LanguageModelV1Prompt;
    headers?: Record<string, string>;
  }) {
    const creds = getCredentials();
    if (!creds) {
      throw new Error("Opencode credentials not found.");
    }
    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) {
      throw new Error("Failed to refresh access token.");
    }

    const projectId = this.projectId || creds.projectId;
    const request = await mapPromptToGemini(options.prompt);

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
      text,
      finishReason,
      usage: {
        promptTokens: json.usageMetadata?.promptTokenCount || 0,
        completionTokens: json.usageMetadata?.candidatesTokenCount || 0,
      },
      rawCall: { rawPrompt: wrappedRequest, rawSettings: {} },
      warnings: [] as LanguageModelV1CallWarning[],
    };
  }

  async doStream(options: {
    inputFormat: 'prompt';
    mode: { type: 'regular' | 'chat' | 'completion' };
    prompt: LanguageModelV1Prompt;
    headers?: Record<string, string>;
  }) {
    const creds = getCredentials();
    if (!creds) {
      throw new Error("Opencode credentials not found.");
    }
    const accessToken = await refreshAccessToken(creds.refreshToken);
    if (!accessToken) {
      throw new Error("Failed to refresh access token.");
    }

    const projectId = this.projectId || creds.projectId;
    const request = await mapPromptToGemini(options.prompt);

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

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
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
        rawCall: { rawPrompt: wrappedRequest, rawSettings: {} },
        warnings: [] as LanguageModelV1CallWarning[],
    };
  }
}
