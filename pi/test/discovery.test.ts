import { describe, expect, it, vi } from "vitest";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  buildCatalog,
  GatewayDiscoveryClient,
  parseModelInfo,
  parseModelsList,
} from "../src/discovery.ts";
import { ExpDiscoveryError } from "../src/errors.ts";
import { jsonResponse, modelInfoFixture, modelsFixture, REAL_MODEL_IDS } from "./fixtures.ts";

const defaults = {
  baseUrl: "https://gateway.test/v1/",
  token: "fixture-secret-never-a-real-token",
  defaultMaxTokens: 65_536,
  timeoutMs: 100,
};

describe("gateway response parsing and model metadata", () => {
  it("uses /models as the authoritative intersection and maps conservative metadata", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return jsonResponse(url.endsWith("/models") ? modelsFixture : modelInfoFixture);
    });
    const client = new GatewayDiscoveryClient(fetchMock);
    const models = await client.discover(defaults);

    expect(models.map((model) => model.id)).toEqual(REAL_MODEL_IDS);
    expect(models.some((model) => model.id === "MiniMax-M3")).toBe(false);
    expect(models[0]).toMatchObject({
      id: "Kimi-K3",
      name: "Kimi-K3",
      provider: "exp",
      api: "openai-completions",
      baseUrl: "https://gateway.test/v1",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models.every((model) => model.reasoning)).toBe(true);
    expect(models.find((model) => model.id === "Qwen3.8-27B")).toMatchObject({
      input: ["text"],
      reasoning: true,
      maxTokens: 8_192,
    });
    // Every OpenAI-completions model retains normal Pi tool support.
    expect(models.every((model) => model.api === "openai-completions")).toBe(true);
  });

  it("sends Bearer authentication to both routes without changing the catalog when info fails", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      return url.endsWith("/models") ? jsonResponse(modelsFixture) : jsonResponse({ error: "ignored" }, 503);
    });
    const models = await new GatewayDiscoveryClient(fetchMock).discover(defaults);

    expect(models).toHaveLength(REAL_MODEL_IDS.length);
    expect(models.every((model) => model.input.join(",") === "text")).toBe(true);
    expect(models.every((model) => model.reasoning)).toBe(true);
    expect(models.every((model) => model.maxTokens === 65_536)).toBe(true);
    expect(calls.map((call) => call.url).sort()).toEqual([
      "https://gateway.test/v1/model/info",
      "https://gateway.test/v1/models",
    ]);
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({ Authorization: `Bearer ${defaults.token}` });
    }
  });

  it("refuses redirects so the Bearer token is never forwarded elsewhere", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.redirect !== "error") throw new Error("redirects must be refused by the request");
      return jsonResponse(modelsFixture);
    });

    const models = await new GatewayDiscoveryClient(fetchMock).discover(defaults);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(models).toHaveLength(REAL_MODEL_IDS.length);
  });

  it("supports numeric strings and clamps output limits to context", () => {
    const listed = parseModelsList({ data: [{ id: "small", max_input_tokens: "1024" }] });
    const info = new Map([
      ["small", {
        model_name: "small",
        model_info: { max_output_tokens: "99999", supports_vision: true },
      }],
    ]);
    expect(buildCatalog(listed, info, "https://gateway.test/v1", 65_536)[0]).toMatchObject({
      contextWindow: 1024,
      maxTokens: 1024,
      input: ["text", "image"],
    });
  });

  it("does not infer vision from a model name and always enables reasoning", () => {
    const listed = parseModelsList({ data: [{ id: "Kimi-K3.1-Pro-reasoning-vision" }] });
    const [model] = buildCatalog(listed, new Map(), "https://gateway.test/v1", 65_536);
    expect(model).toMatchObject({ reasoning: true, input: ["text"] });
  });

  it("keeps reasoning enabled while serializing instructions with the system role", async () => {
    const listed = parseModelsList({ data: [{ id: "Qwen3.8-27B" }] });
    const [model] = buildCatalog(listed, new Map(), "https://gateway.test/v1", 65_536);
    if (!model) throw new Error("Expected one discovered model");
    const chunk = JSON.stringify({
      id: "fixture-completion",
      object: "chat.completion.chunk",
      created: 0,
      model: model.id,
      choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    const fetchMock = vi.fn(async () => new Response(`data: ${chunk}\n\ndata: [DONE]\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }));
    let roles: string[] = [];

    const result = await completeSimple(model, {
      systemPrompt: "Reply to the user.",
      messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    }, {
      apiKey: "fixture-secret-never-a-real-token",
      fetch: fetchMock,
      reasoning: "medium",
      onPayload: (payload) => {
        const request = payload as { messages: Array<{ role: string }> };
        roles = request.messages.map((message) => message.role);
      },
    });

    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(model).toMatchObject({ reasoning: true, compat: { supportsDeveloperRole: false } });
    expect(roles).toEqual(["system", "user"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("ignores malformed optional info but rejects malformed authoritative models", () => {
    expect(parseModelInfo({ nope: true }).size).toBe(0);
    expect(() => parseModelsList({ data: [{ max_input_tokens: 100 }] })).toThrow(/valid id/);
    expect(() => parseModelsList({ data: [{ id: "bad", max_input_tokens: "NaN" }] })).toThrow(
      /max_input_tokens/,
    );
  });
});

describe("discovery failures and timeouts", () => {
  it.each([401, 403])("reports HTTP %i clearly without exposing the token or response body", async (status) => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: defaults.token }, status));
    const promise = new GatewayDiscoveryClient(fetchMock).discover(defaults);
    await expect(promise).rejects.toMatchObject({ status, name: "ExpDiscoveryError" });
    await expect(promise).rejects.toThrow(/\/login/);
    await expect(promise).rejects.not.toThrow(defaults.token);
  });

  it("rejects a successful HTTP response with invalid authoritative JSON", async () => {
    const fetchMock = vi.fn(async () => new Response("not-json"));
    await expect(new GatewayDiscoveryClient(fetchMock).discover(defaults)).rejects.toThrow(/invalid JSON/);
  });

  it("bounds stalled requests with an explicit timeout", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const started = Date.now();
    await expect(new GatewayDiscoveryClient(fetchMock).discover({ ...defaults, timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20 ms/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("honors caller cancellation", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const promise = new GatewayDiscoveryClient(fetchMock).discover({ ...defaults, signal: controller.signal });
    controller.abort(new ExpDiscoveryError("cancelled by test"));
    await expect(promise).rejects.toThrow("cancelled by test");
  });
});
