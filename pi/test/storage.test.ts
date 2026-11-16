import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { FileExpCatalogStore, FileExpConfigStore } from "../src/config.ts";
import { cachedModel } from "./fixtures.ts";
import { makeTempDir, removeTempDir } from "./temp.ts";

const directories: string[] = [];
async function temp(label: string): Promise<string> {
  const directory = await makeTempDir(label);
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTempDir));
});

describe("global-style injectable file storage", () => {
  it("lazily reads and atomically writes normalized global config", async () => {
    const directory = await temp("config");
    const path = join(directory, "agent", "exp-config.json");
    const store = new FileExpConfigStore(path);
    expect(await store.read()).toEqual({ defaultMaxTokens: 16_384, timeoutMs: 5_000 });

    await store.write({ baseUrl: "https://gateway.test/proxy/v1/", defaultMaxTokens: 8192, timeoutMs: 900 });
    expect(await store.read()).toEqual({
      baseUrl: "https://gateway.test/proxy/v1",
      defaultMaxTokens: 8192,
      timeoutMs: 900,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("token");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(directory, "agent"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("persists only model metadata in the EXP-only fallback cache", async () => {
    const directory = await temp("catalog");
    const path = join(directory, "agent", "exp-models.json");
    const store = new FileExpCatalogStore(path);
    await store.write("exp", { models: [cachedModel()], checkedAt: 42 }, {});
    const entry = await store.read("exp");
    expect(entry?.models.map((model) => model.id)).toEqual(["Kimi-K3"]);
    expect(entry?.checkedAt).toBe(42);

    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("fixture-token");
    expect(raw).not.toContain("Authorization");
    expect(JSON.parse(raw).exp.models[0]).not.toHaveProperty("apiKey");
  });

  it("keeps unrelated cache entries and remains valid under serialized writers", async () => {
    const directory = await temp("concurrent-storage");
    const path = join(directory, "exp-models.json");
    await writeFile(path, JSON.stringify({ other: { models: [], checkedAt: 7 } }));
    const store = new FileExpCatalogStore(path);
    await Promise.all([
      store.write("exp", { models: [cachedModel("one")], checkedAt: 1 }),
      store.write("exp", { models: [cachedModel("two")], checkedAt: 2 }),
    ]);
    const raw = JSON.parse(await readFile(path, "utf8"));
    expect(raw.other.checkedAt).toBe(7);
    expect(["one", "two"]).toContain(raw.exp.models[0].id);
    expect((await store.read("exp"))?.models).toHaveLength(1);
  });

  it("reads native auth only from the injected temporary auth.json", async () => {
    const directory = await temp("native-auth");
    const authPath = join(directory, "auth.json");
    await writeFile(authPath, JSON.stringify({
      exp: { type: "api_key", key: "temporary-test-token" },
      other: { type: "api_key", key: "other-token" },
    }));
    expect(readStoredCredential("exp", authPath)).toEqual({ type: "api_key", key: "temporary-test-token" });
    const raw = await readFile(authPath, "utf8");
    // This assertion controls the fixture only; production code never writes it.
    expect(JSON.parse(raw).exp.type).toBe("api_key");
  });

  it("does not create auth.json while reading a missing native credential", async () => {
    const directory = await temp("missing-auth");
    const authPath = join(directory, "auth.json");
    expect(readStoredCredential("exp", authPath)).toBeUndefined();
    await expect(stat(authPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
