import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  createModels,
} from "@earendil-works/pi-ai/compat";
import type { DiscoveryClient, DiscoveryOptions } from "../src/discovery.ts";
import { InMemoryExpConfigStore } from "../src/config.ts";
import { createExpIntegration } from "../src/provider.ts";
import { cachedModel } from "./fixtures.ts";

async function authenticatedRuntime(
  discoveryClient: DiscoveryClient,
  modelsStore = new InMemoryModelsStore(),
) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("exp", async () => ({ type: "api_key", key: "provider-fixture-token" }));
  const integration = createExpIntegration({
    configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" }),
    catalogStore: modelsStore,
    readCredential: () => credentials.read("exp"),
    discoveryClient,
  });
  const runtime = createModels({ credentials, modelsStore });
  runtime.setProvider(integration.provider);
  return { runtime, integration, credentials, modelsStore };
}

describe("EXP dynamic provider contract", () => {
  it("restores the last valid native cache on failure and emits a clear error", async () => {
    const modelsStore = new InMemoryModelsStore();
    await modelsStore.write("exp", { models: [cachedModel("cached-model")], checkedAt: 1 });
    const { runtime } = await authenticatedRuntime(
      { discover: async () => { throw new Error("fixture endpoint unavailable"); } },
      modelsStore,
    );

    const result = await runtime.refresh({ providers: ["exp"], force: true });
    expect(result.errors.get("exp")?.message).toMatch(/fixture endpoint unavailable/);
    expect(runtime.getModels("exp").map((model) => model.id)).toEqual(["cached-model"]);
    expect(await modelsStore.read("exp")).toMatchObject({ checkedAt: 1 });
  });

  it("keeps the previous live catalog after a later failed refresh", async () => {
    let fail = false;
    const { runtime, modelsStore } = await authenticatedRuntime({
      discover: async () => {
        if (fail) throw new Error("new refresh failed");
        return [cachedModel("first-valid")];
      },
    });
    expect((await runtime.refresh({ providers: ["exp"] })).errors.size).toBe(0);
    fail = true;
    expect((await runtime.refresh({ providers: ["exp"], force: true })).errors.size).toBe(1);
    expect(runtime.getModels("exp").map((model) => model.id)).toEqual(["first-valid"]);
    expect(JSON.stringify(await modelsStore.read("exp"))).toContain("first-valid");
    expect(JSON.stringify(await modelsStore.read("exp"))).not.toContain("provider-fixture-token");
  });

  it("fails clearly when the endpoint or first discovery is missing", async () => {
    const { runtime } = await authenticatedRuntime({
      discover: async () => { throw new Error("first discovery failed"); },
    });
    const result = await runtime.refresh({ providers: ["exp"] });
    expect(result.errors.get("exp")?.message).toBe("first discovery failed");
    expect(runtime.getModels("exp")).toEqual([]);
  });

  it("publishes startup models before registration-time host refreshes", async () => {
    const discoveryClient = { discover: vi.fn(async () => [cachedModel("startup-model")]) };
    const modelsStore = new InMemoryModelsStore();
    const integration = createExpIntegration({
      configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test/v1/" }),
      catalogStore: modelsStore,
      readCredential: () => ({ type: "api_key", key: "startup-token" }),
      discoveryClient,
      now: () => 1234,
    });

    const startup = await integration.refresh();
    expect(startup).toEqual({ attempted: true });
    expect(integration.provider.getModels().map((model) => model.id)).toEqual(["startup-model"]);
    await expect(modelsStore.read("exp")).resolves.toMatchObject({ checkedAt: 1234 });
    // Equivalent to Pi's offline restoration after an async factory registers.
    const runtime = createModels({
      credentials: new InMemoryCredentialStore(),
      modelsStore: new InMemoryModelsStore(),
    });
    runtime.setProvider(integration.provider);
    await runtime.refresh({ providers: ["exp"], allowNetwork: false });
    expect(integration.provider.getModels().map((model) => model.id)).toEqual(["startup-model"]);
  });

  it("uses the startup fallback cache when a configured gateway is down", async () => {
    const modelsStore = new InMemoryModelsStore();
    await modelsStore.write("exp", { models: [cachedModel("offline-cache")] });
    const integration = createExpIntegration({
      configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" }),
      catalogStore: modelsStore,
      readCredential: () => ({ type: "api_key", key: "startup-token" }),
      discoveryClient: { discover: async () => { throw new Error("offline"); } },
    });
    const result = await integration.refresh();
    expect(result).toMatchObject({ attempted: true });
    expect(result.error?.message).toBe("offline");
    expect(integration.provider.getModels().map((model) => model.id)).toEqual(["offline-cache"]);
  });

  it("prevents an older concurrent refresh from replacing a newer catalog", async () => {
    let firstStartedResolve: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { firstStartedResolve = resolve; });
    let call = 0;
    const discoveryClient: DiscoveryClient = {
      discover: async (options: DiscoveryOptions) => {
        call += 1;
        const thisCall = call;
        if (thisCall === 1) {
          firstStartedResolve?.();
          return await new Promise<ReturnType<typeof cachedModel>[]>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
          });
        }
        return [cachedModel(`new-catalog-${thisCall}`)];
      },
    };
    const { runtime } = await authenticatedRuntime(discoveryClient);
    const slow = runtime.refresh({ providers: ["exp"], force: true });
    await firstStarted;
    const newer = runtime.refresh({ providers: ["exp"], force: true });
    await Promise.all([slow, newer]);

    expect(runtime.getModels("exp").map((model) => model.id)).toEqual(["new-catalog-2"]);
    expect(call).toBe(2);
  });

  it("does not let native cache-only login synchronization cancel a credential-watch refresh", async () => {
    let startDiscovery!: () => void;
    let finishDiscovery!: (models: ReturnType<typeof cachedModel>[]) => void;
    const started = new Promise<void>((resolve) => { startDiscovery = resolve; });
    const discovery = new Promise<ReturnType<typeof cachedModel>[]>((resolve) => { finishDiscovery = resolve; });
    const integration = createExpIntegration({
      configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" }),
      catalogStore: new InMemoryModelsStore(),
      readCredential: () => ({ type: "api_key", key: "watch-token" }),
      discoveryClient: { discover: async () => {
        startDiscovery();
        return discovery;
      } },
    });
    const liveRuntime = createModels();
    liveRuntime.setProvider(integration.provider);

    const watcherRefresh = integration.refresh();
    await started;
    await liveRuntime.refresh({ providers: ["exp"], allowNetwork: false });
    finishDiscovery([cachedModel("discovered-after-login")]);
    expect((await watcherRefresh).error).toBeUndefined();
    expect(integration.provider.getModels().map((model) => model.id)).toEqual(["discovered-after-login"]);
  });

  it("does not call the network at startup without both endpoint and native token", async () => {
    const discover = vi.fn(async () => [cachedModel()]);
    const integration = createExpIntegration({
      configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" }),
      catalogStore: new InMemoryModelsStore(),
      readCredential: () => undefined,
      discoveryClient: { discover },
    });
    expect(await integration.refresh()).toEqual({ attempted: false });
    expect(discover).not.toHaveBeenCalled();
  });
});
