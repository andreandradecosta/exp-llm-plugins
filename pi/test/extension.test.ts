import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore, type Credential } from "@earendil-works/pi-ai/compat";
import { createExpExtension } from "../src/extension.ts";
import type { AuthWatchListener } from "../src/credential-watcher.ts";
import { InMemoryExpConfigStore } from "../src/config.ts";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { createExpIntegration } from "../src/provider.ts";
import { cachedModel } from "./fixtures.ts";

interface Command {
  handler: (args: string, ctx: never) => Promise<void>;
}

function fakePi() {
  const providers: unknown[] = [];
  const commands = new Map<string, Command>();
  const events = new Map<string, Array<(event: object, ctx: never) => unknown>>();
  const on = vi.fn((name: string, handler: (event: object, ctx: never) => unknown) => {
    const handlers = events.get(name) ?? [];
    handlers.push(handler);
    events.set(name, handlers);
    return () => {};
  });
  const pi = {
    registerProvider: vi.fn((provider: unknown) => { providers.push(provider); }),
    registerCommand: vi.fn((name: string, command: Command) => { commands.set(name, command); }),
    on,
  } as unknown as ExtensionAPI;
  return {
    pi,
    on,
    providers,
    commands,
    events,
    async emit(name: string, ctx: never): Promise<void> {
      for (const handler of events.get(name) ?? []) await handler({}, ctx);
    },
  };
}

beforeEach(() => {
  vi.stubEnv("EXPLLM_HOST", "");
  vi.stubEnv("EXPLLM_KEY", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function commandContext(inputs: string[], hasUI = true) {
  const notifications: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI,
    signal: new AbortController().signal,
    ui: {
      input: vi.fn(async () => inputs.shift()),
      notify: vi.fn((message: string, type?: string) => { notifications.push({ message, ...(type ? { type } : {}) }); }),
    },
  };
  return { ctx: ctx as never, notifications };
}

describe("extension initialization and /exp-configure", () => {
  async function extensionFixture(credential?: Credential) {
    const configStore = new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" });
    const integration = createExpIntegration({
      configStore,
      catalogStore: new InMemoryModelsStore(),
      readCredential: () => credential,
      discoveryClient: { discover: async () => [cachedModel()] },
    });
    const mock = fakePi();
    await createExpExtension(integration)(mock.pi);
    return { configStore, integration, ...mock };
  }

  it("registers exp models before the awaited startup factory returns", async () => {
    const fixture = await extensionFixture({ type: "api_key", key: "extension-test-token" });
    expect(fixture.providers).toEqual([fixture.integration.provider]);
    expect(fixture.integration.provider.getModels().map((model) => model.id)).toEqual(["Kimi-K3"]);
    expect(fixture.commands.has("exp-configure")).toBe(true);
  });

  it("does not request UI, start watchers or call the gateway in headless use", async () => {
    const configStore = new InMemoryExpConfigStore();
    const discover = vi.fn(async () => [cachedModel()]);
    const integration = createExpIntegration({
      configStore,
      catalogStore: new InMemoryModelsStore(),
      readCredential: () => undefined,
      discoveryClient: { discover },
    });
    const watch = vi.fn();
    const mock = fakePi();
    await createExpExtension(integration, { watch, authPath: "/tmp/headless/auth.json" })(mock.pi);
    expect(mock.providers).toHaveLength(1);
    expect(mock.commands.has("exp-configure")).toBe(true);
    expect(discover).not.toHaveBeenCalled();
    expect(watch).not.toHaveBeenCalled();

    await mock.emit("session_start", commandContext([], false).ctx);
    expect(watch).not.toHaveBeenCalled();
  });

  it("saves only endpoint metadata interactively and directs token entry to /login", async () => {
    const fixture = await extensionFixture();
    const { ctx, notifications } = commandContext(["https://new-gateway.test/proxy/", "8192"]);
    const command = fixture.commands.get("exp-configure");
    await command?.handler("ignored arguments must never be used for a token", ctx);

    expect(await fixture.configStore.read()).toMatchObject({
      baseUrl: "https://new-gateway.test/proxy/v1",
      defaultMaxTokens: 8192,
    });
    expect(notifications.at(-1)?.message).toContain("/login");
    expect(notifications.at(-1)?.message).toContain("automatically");
    expect(notifications.at(-1)?.message).not.toContain("/reload");
    expect(notifications.at(-1)?.message).not.toContain("fixture-token");
  });

  it("ignores EXPLLM_HOST and presents the saved endpoint as active", async () => {
    vi.stubEnv("EXPLLM_HOST", "https://environment.test");
    const fixture = await extensionFixture();
    const { ctx, notifications } = commandContext(["https://saved.test", "8192"]);
    await fixture.commands.get("exp-configure")?.handler("", ctx);

    expect(await fixture.configStore.read()).toMatchObject({
      baseUrl: "https://saved.test/v1",
      defaultMaxTokens: 8192,
    });
    expect(notifications.at(-1)?.message).toContain("Endpoint saved.");
    expect(notifications.at(-1)?.message).not.toContain("EXPLLM_HOST remains active");
    expect(notifications.at(-1)?.message).not.toContain("only when it is unset");
  });

  it("refreshes after simulated login, token replacement and removal, then cleans up reload resources", async () => {
    vi.useFakeTimers();
    let credential: Credential | undefined;
    const discover = vi.fn(async () => [cachedModel()]);
    const integration = createExpIntegration({
      configStore: new InMemoryExpConfigStore({ baseUrl: "https://gateway.test" }),
      catalogStore: new InMemoryModelsStore(),
      readCredential: () => credential,
      discoveryClient: { discover },
    });
    let listener: AuthWatchListener | undefined;
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      unref: vi.fn(),
    }) as unknown as FSWatcher;
    const watch = vi.fn((_directory: string, callback: AuthWatchListener) => {
      listener = callback;
      return watcher;
    });
    const mock = fakePi();
    await createExpExtension(integration, {
      authPath: "/tmp/login-flow/auth.json",
      watch,
      debounceMs: 0,
    })(mock.pi);
    expect(discover).not.toHaveBeenCalled();
    expect(mock.providers).toHaveLength(1);

    const { ctx, notifications } = commandContext([]);
    await mock.emit("session_start", ctx);
    expect(watch).toHaveBeenCalledWith("/tmp/login-flow", expect.any(Function));

    credential = { type: "api_key", key: "first-test-token" };
    listener?.("rename", "auth.json");
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(mock.providers).toHaveLength(2);
    expect(integration.provider.getModels()).toHaveLength(1);

    credential = { type: "api_key", key: "replacement-test-token" };
    listener?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(mock.providers).toHaveLength(3);

    credential = undefined;
    listener?.("rename", "auth.json");
    await vi.advanceTimersByTimeAsync(0);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(mock.providers).toHaveLength(4);
    expect(notifications.some((entry) => entry.message.includes("token"))).toBe(false);

    await mock.emit("session_shutdown", ctx);
    expect(watcher.close).toHaveBeenCalledTimes(1);
    credential = { type: "api_key", key: "after-shutdown-test-token" };
    listener?.("change", "auth.json");
    await vi.advanceTimersByTimeAsync(10);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(mock.providers).toHaveLength(4);
  });

  it("refuses dialogs in headless command execution", async () => {
    const fixture = await extensionFixture();
    const { ctx } = commandContext([], false);
    await fixture.commands.get("exp-configure")?.handler("", ctx);
    expect((ctx as { ui: { input: ReturnType<typeof vi.fn> } }).ui.input).not.toHaveBeenCalled();
  });
});
