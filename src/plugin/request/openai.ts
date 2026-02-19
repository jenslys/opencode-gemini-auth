interface GeminiFunctionCallPart {
  functionCall?: {
    name: string;
    args?: Record<string, unknown>;
    [key: string]: unknown;
  };
  thoughtSignature?: string;
  [key: string]: unknown;
}

interface OpenAIToolCall {
  function?: {
    name?: string;
    arguments?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface OpenAIMessage {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  [key: string]: unknown;
}

/**
 * Transforms OpenAI `tool_calls` to Gemini `functionCall` parts.
 */
export function transformOpenAIToolCalls(requestPayload: Record<string, unknown>): void {
  const messages = requestPayload.messages;
  if (!messages || !Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }

    const msgObj = message as OpenAIMessage;
    const toolCalls = msgObj.tool_calls;
    if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
      continue;
    }

    const parts: GeminiFunctionCallPart[] = [];
    if (typeof msgObj.content === "string" && msgObj.content.length > 0) {
      parts.push({ text: msgObj.content });
    }

    for (const toolCall of toolCalls) {
      if (!toolCall || typeof toolCall !== "object") {
        continue;
      }

      const fn = toolCall.function;
      if (!fn || typeof fn !== "object") {
        continue;
      }

      const name = fn.name;
      const args = parseJsonObject(fn.arguments);
      parts.push({
        functionCall: {
          name: name ?? "",
          args,
        },
        thoughtSignature: "skip_thought_signature_validator",
      });
    }

    msgObj.parts = parts;
    delete msgObj.tool_calls;
    delete msgObj.content;
  }
}

/**
 * Adds synthetic thoughtSignature to function calls in both flat and wrapped payloads.
 */
export function addThoughtSignaturesToFunctionCalls(requestPayload: Record<string, unknown>): void {
  const processContents = (contents: unknown): void => {
    if (!contents || !Array.isArray(contents)) {
      return;
    }

    for (const content of contents) {
      if (!content || typeof content !== "object") {
        continue;
      }

      const parts = (content as Record<string, unknown>).parts;
      if (!parts || !Array.isArray(parts)) {
        continue;
      }

      for (const part of parts) {
        if (!part || typeof part !== "object") {
          continue;
        }
        const partObj = part as Record<string, unknown>;
        if (partObj.functionCall && !partObj.thoughtSignature) {
          partObj.thoughtSignature = "skip_thought_signature_validator";
        }
      }
    }
  };

  processContents(requestPayload.contents);
  if (requestPayload.request && typeof requestPayload.request === "object") {
    processContents((requestPayload.request as Record<string, unknown>).contents);
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
