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

  it("drops thought-only model parts from replayed history", () => {
    const input =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent";
    const init: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          { role: "user", parts: [{ text: "give me a joke" }] },
          {
            role: "model",
            parts: [{ text: "internal thought", thought: true }],
          },
          { role: "user", parts: [{ text: "well?" }] },
        ],
      }),
    };

    const result = prepareGeminiRequest(input, init, "token-123", "project-456");
    const parsed = JSON.parse(result.init.body as string) as Record<string, unknown>;
    const request = parsed.request as Record<string, unknown>;
    const contents = request.contents as Array<Record<string, unknown>>;

    expect(contents.length).toBe(2);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("user");
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
});
