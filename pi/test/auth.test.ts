import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createModels,
} from "@earendil-works/pi-ai/compat";
import { createExpAuth } from "../src/auth.ts";
import { InMemoryExpConfigStore } from "../src/config.ts";
import { createExpIntegration } from "../src/provider.ts";
import { cachedModel } from "./fixtures.ts";
import { DEFAULT_EXP_BASE_URL } from "../src/constants.ts";

beforeEach(() => {
  vi.stubEnv("EXPLLM_HOST", "");
  vi.stubEnv("EXPLLM_KEY", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native EXP API key authentication", () => {
  it("uses a secret prompt and stores only through Pi's native login", async () => {
    const configStore = new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" });
    const auth = createExpAuth(configStore);
    const prompt = vi.fn(async () => "fixture-token");
    const notify = vi.fn();
    const credential = await auth.login?.({
      prompt,
      notify,
      signal: new AbortController().signal,
    });

    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret" }));
    expect(credential).toEqual({ type: "api_key", key: "fixture-token" });
    expect(JSON.stringify(await configStore.read())).not.toContain("fixture-token");
  });

  it("rejects an empty token and never reads EXPLLM_KEY as a credential", async () => {
    vi.stubEnv("EXPLLM_KEY", "ambient-token-must-not-be-used");
    const auth = createExpAuth(new InMemoryExpConfigStore());
    await expect(auth.login?.({
      prompt: async () => "   ",
      notify: () => {},
      signal: new AbortController().signal,
    })).rejects.toThrow(/cannot be empty/);

    const ctx = { env: vi.fn(async () => "must-not-be-used"), fileExists: vi.fn(async () => false) };
    await expect(auth.resolve({ ctx, signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(ctx.env).not.toHaveBeenCalled();
  });

  it("resolves the stored credential and the current normalized endpoint", async () => {
    const configStore = new InMemoryExpConfigStore({ baseUrl: "https://gateway.test/v1/" });
    const auth = createExpAuth(configStore);
    const ctx = { env: async () => undefined, fileExists: async () => false };
    const resolved = await auth.resolve({
      ctx,
      credential: { type: "api_key", key: "fixture-token" },
      signal: new AbortController().signal,
    });
    expect(resolved).toEqual({
      auth: { apiKey: "fixture-token", baseUrl: "https://gateway.test/v1" },
      source: "Pi stored credential",
    });
  });

  it("uses the default endpoint during inference without a saved endpoint", async () => {
    const auth = createExpAuth(new InMemoryExpConfigStore());
    const resolved = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: "fixture-token" },
      signal: new AbortController().signal,
    });
    expect(resolved?.auth).toEqual({ apiKey: "fixture-token", baseUrl: DEFAULT_EXP_BASE_URL });
  });

  it("uses EXPLLM_HOST during inference instead of the persisted endpoint", async () => {
    vi.stubEnv("EXPLLM_HOST", "http://environment.test:4001");
    const auth = createExpAuth(new InMemoryExpConfigStore({ baseUrl: "https://persisted.test" }));
    const resolved = await auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: "fixture-token" },
      signal: new AbortController().signal,
    });
    expect(resolved?.auth.baseUrl).toBe("http://environment.test:4001/v1");
  });

  it("rejects an invalid EXPLLM_HOST during inference without persisted fallback", async () => {
    vi.stubEnv("EXPLLM_HOST", "invalid-endpoint");
    const auth = createExpAuth(new InMemoryExpConfigStore({ baseUrl: "https://persisted.test" }));
    await expect(auth.resolve({
      ctx: { env: async () => undefined, fileExists: async () => false },
      credential: { type: "api_key", key: "fixture-token" },
      signal: new AbortController().signal,
    })).rejects.toThrow(/Invalid EXPLLM_HOST/);
  });

  it("integrates login, availability and native model refresh with injected storage", async () => {
    const credentials = new InMemoryCredentialStore();
    const modelsStore = new InMemoryModelsStore();
    const configStore = new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" });
    const integration = createExpIntegration({
      configStore,
      catalogStore: modelsStore,
      readCredential: () => credentials.read("exp"),
      discoveryClient: { discover: async () => [cachedModel()] },
    });
    const models = createModels({ credentials, modelsStore });
    models.setProvider(integration.provider);
    const interaction = {
      prompt: vi.fn(async () => "native-secret"),
      notify: vi.fn(),
    };
    await models.login("exp", "api_key", interaction);
    const result = await models.refresh({ providers: ["exp"], force: true });

    expect(result.errors.size).toBe(0);
    expect(models.getModels("exp").map((model) => model.id)).toEqual(["Kimi-K3"]);
    await expect(models.getAvailable("exp")).resolves.toHaveLength(1);
    expect(interaction.prompt).toHaveBeenCalledWith(expect.objectContaining({ type: "secret" }));
    expect(await credentials.read("exp")).toEqual({ type: "api_key", key: "native-secret" });
    expect(JSON.stringify(await modelsStore.read("exp"))).not.toContain("native-secret");
  });
});
