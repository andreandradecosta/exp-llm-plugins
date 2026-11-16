import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import {
  watchExpCredentialChanges,
  type AuthWatchListener,
} from "../src/credential-watcher.ts";
import type { ExpRefreshResult } from "../src/provider.ts";

function fakeWatch() {
  let listener: AuthWatchListener | undefined;
  const emitter = new EventEmitter();
  const watcher = Object.assign(emitter, {
    close: vi.fn(),
    unref: vi.fn(),
  }) as unknown as FSWatcher;
  const watch = vi.fn((_directory: string, callback: AuthWatchListener) => {
    listener = callback;
    return watcher;
  });
  return {
    watch,
    watcher,
    emit(eventType: string, filename: string | Buffer | null = "auth.json") {
      listener?.(eventType, filename);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EXP auth.json session watcher", () => {
  it("watches the parent directory and debounces create/rename/update events", async () => {
    vi.useFakeTimers();
    const source = fakeWatch();
    const refresh = vi.fn(async (): Promise<ExpRefreshResult> => ({ attempted: true }));
    const publish = vi.fn();
    const close = watchExpCredentialChanges({
      authPath: "/tmp/isolated/agent/auth.json",
      watch: source.watch,
      refresh,
      publish,
      onError: vi.fn(),
    });

    expect(source.watch).toHaveBeenCalledWith("/tmp/isolated/agent", expect.any(Function));
    expect(source.watcher.unref).toHaveBeenCalled();
    source.emit("rename");
    source.emit("change");
    source.emit("change", "settings.json");
    source.emit("change", "auth.json");
    await vi.advanceTimersByTimeAsync(99);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    close();
    expect(source.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up the debounce timer and watcher on shutdown", async () => {
    vi.useFakeTimers();
    const source = fakeWatch();
    const refresh = vi.fn(async (): Promise<ExpRefreshResult> => ({ attempted: true }));
    const close = watchExpCredentialChanges({
      authPath: "/tmp/isolated/auth.json",
      watch: source.watch,
      refresh,
      publish: vi.fn(),
      onError: vi.fn(),
    });

    source.emit("change");
    close();
    close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).not.toHaveBeenCalled();
    expect(source.watcher.close).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight refresh and does not republish after shutdown", async () => {
    vi.useFakeTimers();
    const source = fakeWatch();
    const pending = deferred<ExpRefreshResult>();
    const publish = vi.fn();
    let refreshSignal: AbortSignal | undefined;
    const close = watchExpCredentialChanges({
      authPath: "/tmp/isolated/auth.json",
      watch: source.watch,
      refresh: (signal) => {
        refreshSignal = signal;
        return pending.promise;
      },
      publish,
      onError: vi.fn(),
      debounceMs: 0,
    });

    source.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshSignal?.aborted).toBe(false);
    close();
    expect(refreshSignal?.aborted).toBe(true);
    pending.resolve({ attempted: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it("serializes refreshes and runs again for a credential change during discovery", async () => {
    vi.useFakeTimers();
    const source = fakeWatch();
    const first = deferred<ExpRefreshResult>();
    const refresh = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ attempted: true });
    const publish = vi.fn();
    const close = watchExpCredentialChanges({
      authPath: "/tmp/isolated/auth.json",
      watch: source.watch,
      refresh,
      publish,
      onError: vi.fn(),
      debounceMs: 0,
    });

    source.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    source.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    first.resolve({ attempted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    close();
  });

  it("reports refresh errors without closing the watcher", async () => {
    vi.useFakeTimers();
    const source = fakeWatch();
    const onError = vi.fn();
    const close = watchExpCredentialChanges({
      authPath: "/tmp/isolated/auth.json",
      watch: source.watch,
      refresh: async () => ({ attempted: true, error: new Error("HTTP 401 at mock endpoint") }),
      publish: vi.fn(),
      onError,
      debounceMs: 0,
    });
    source.emit("change");
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith("EXP credential refresh failed: HTTP 401 at mock endpoint");
    close();
  });

  it("degrades gracefully when watching is unavailable or the path cannot be watched", () => {
    const refresh = vi.fn(async (): Promise<ExpRefreshResult> => ({ attempted: false }));
    expect(() => watchExpCredentialChanges({
      authPath: "/tmp/missing/auth.json",
      watch: null,
      refresh,
      publish: vi.fn(),
      onError: vi.fn(),
    })()).not.toThrow();
    expect(() => watchExpCredentialChanges({
      authPath: "/tmp/missing/auth.json",
      watch: () => { throw new Error("ENOENT"); },
      refresh,
      publish: vi.fn(),
      onError: vi.fn(),
    })()).not.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });
});
