import type { LanguageModelV1Prompt } from "ai";

export interface GeminiPart {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: object;
  };
  functionResponse?: {
    name: string;
    response: object;
  };
}

export interface GeminiContent {
  role: string;
  parts: GeminiPart[];
}

export interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    candidateCount?: number;
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stopSequences?: string[];
  };
}

export async function mapPromptToGemini(prompt: LanguageModelV1Prompt): Promise<GeminiRequest> {
  const contents: GeminiContent[] = [];
  let systemInstruction: { parts: GeminiPart[] } | undefined;

  for (const message of prompt) {
    if (message.role === 'system') {
      systemInstruction = { parts: [{ text: message.content }] };
      continue;
    }

    const role = message.role === 'user' ? 'user' : 'model';
    const parts: GeminiPart[] = [];

    if (typeof message.content === 'string') {
      parts.push({ text: message.content });
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text') {
          parts.push({ text: part.text });
        } else if (part.type === 'image') {
          let base64Data = '';
          let mimeType = part.mimeType || 'image/jpeg';

          if (part.image instanceof Uint8Array) {
             base64Data = Buffer.from(part.image).toString('base64');
          } else if (part.image instanceof URL) {
             // Fetch the image
             try {
                const res = await fetch(part.image);
                const arrayBuffer = await res.arrayBuffer();
                base64Data = Buffer.from(arrayBuffer).toString('base64');
                mimeType = res.headers.get('content-type') || mimeType;
             } catch (e) {
                console.warn(`Failed to fetch image from URL: ${part.image}`, e);
                continue;
             }
          }

          if (base64Data) {
             parts.push({
                inlineData: {
                  mimeType,
                  data: base64Data,
                }
             });
          }
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  return { contents, systemInstruction };
}
