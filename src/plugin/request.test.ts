import { describe, expect, it } from "bun:test";

import { GEMINI_CODE_ASSIST_ENDPOINT } from "../constants";
import {
  isGenerativeLanguageRequest,
  prepareGeminiRequest,
  transformGeminiResponse,
} from "./request";

describe("request helpers", () => {
  it("detects generativelanguage URLs", () => {
    expect(
      isGenerativeLanguageRequest(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent",
      ),
    ).toBe(true);
    expect(isGenerativeLanguageRequest("https://example.com/foo")).toBe(false);
  });

  it("wraps requests for Gemini Code Assist streaming", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "should-be-removed",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        system_instruction: { parts: [{ text: "system" }] },
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");

    expect(result.streaming).toBe(true);
    expect(typeof result.request).toBe("string");
    expect(result.request).toBe(
      `${GEMINI_CODE_ASSIST_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`,
    );

    const headers = new Headers(result.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer token-123");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("x-activity-request-id")).toBeTruthy();

    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    expect(parsed.project).toBe("project-456");
    expect(parsed.model).toBe("gemini-3-flash-preview");
    expect(parsed.user_prompt_id).toBeTruthy();
    expect((parsed.request as Record<string, unknown>).session_id).toBeTruthy();
    expect((parsed.request as Record<string, unknown>).systemInstruction).toBeDefined();
    expect((parsed.request as Record<string, unknown>).system_instruction).toBeUndefined();
  });

  it("maps traceId to responseId for JSON responses", async () => {
    const response = new Response(
      JSON.stringify({
        traceId: "trace-123",
        response: {
          candidates: [],
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

    const transformed = await transformGeminiResponse(response, false);
    const parsed = (await transformed.json()) as Record<string, unknown>;
    expect(parsed.responseId).toBe("trace-123");
  });

  it("maps traceId to responseId for streaming payloads", async () => {
    const response = new Response(
      'data: {"traceId":"trace-456","response":{"candidates":[]}}\n\n',
      {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      },
    );

    const transformed = await transformGeminiResponse(response, true);
    const payload = await transformed.text();
    expect(payload).toContain('"responseId":"trace-456"');
    expect(payload).not.toContain('"traceId"');
  });

  it("normalizes anyOf schema nodes in function declarations", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "edit",
                parameters: {
                  type: "object",
                  properties: {
                    edits: {
                      description: "Array of edits",
                      anyOf: [
                        { type: "array", items: { type: "string" } },
                        { type: "null" },
                      ],
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");
    const wrapped = JSON.parse(result.init.body as string) as {
      request: {
        tools: Array<{
          functionDeclarations: Array<{
            parameters: {
              properties: {
                edits: Record<string, unknown>;
              };
            };
          }>;
        }>;
      };
    };

    const editsSchema =
      wrapped.request.tools[0]?.functionDeclarations[0]?.parameters.properties.edits;
    expect(editsSchema).toBeDefined();
    if (!editsSchema) {
      throw new Error("Expected edits schema to be present");
    }
    expect(editsSchema.anyOf).toBeDefined();
    expect(editsSchema.description).toBeUndefined();
    expect(editsSchema.type).toBeUndefined();
  });

  it("preserves definition siblings when normalizing anyOf nodes", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "edit",
                parameters: {
                  anyOf: [
                    { $ref: "#/$defs/EditArray" },
                    { type: "null" },
                  ],
                  $defs: {
                    EditArray: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  description: "should be dropped",
                },
              },
            ],
          },
        ],
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");
    const wrapped = JSON.parse(result.init.body as string) as {
      request: {
        tools: Array<{
          functionDeclarations: Array<{
            parameters: Record<string, unknown>;
          }>;
        }>;
      };
    };

    const parameters = wrapped.request.tools[0]?.functionDeclarations[0]?.parameters;
    expect(parameters).toBeDefined();
    if (!parameters) {
      throw new Error("Expected parameters schema to be present");
    }

    expect(parameters.anyOf).toBeDefined();
    expect(parameters.$defs).toBeDefined();
    expect(parameters.description).toBeUndefined();

    const firstBranch = Array.isArray(parameters.anyOf) ? parameters.anyOf[0] : undefined;
    expect(firstBranch).toBeDefined();
    if (!firstBranch || typeof firstBranch !== "object") {
      throw new Error("Expected anyOf[0] branch to be present");
    }
    expect((firstBranch as Record<string, unknown>).$ref).toBe("#/$defs/EditArray");
  });
});
