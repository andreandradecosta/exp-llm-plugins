import { afterEach, describe, expect, it, vi } from "vitest";
import { discoveryUrl, normalizeBaseUrl, resolveExpBaseUrl } from "../src/endpoint.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("EXP endpoint normalization", () => {
  it.each([
    ["https://gateway.test", "https://gateway.test/v1"],
    ["https://gateway.test/", "https://gateway.test/v1"],
    ["https://gateway.test/v1", "https://gateway.test/v1"],
    ["https://gateway.test/v1/", "https://gateway.test/v1"],
    ["https://gateway.test/proxy/", "https://gateway.test/proxy/v1"],
    ["https://gateway.test/proxy/v1///", "https://gateway.test/proxy/v1"],
    [" http://localhost:4000 ", "http://localhost:4000/v1"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it("builds both discovery routes from the same normalized base", () => {
    expect(discoveryUrl("https://gateway.test/proxy/v1/", "models")).toBe(
      "https://gateway.test/proxy/v1/models",
    );
    expect(discoveryUrl("https://gateway.test/proxy", "model/info")).toBe(
      "https://gateway.test/proxy/v1/model/info",
    );
  });

  it.each([
    "",
    "gateway.test/v1",
    "ftp://gateway.test",
    "https://user:secret@gateway.test",
    "https://gateway.test/v1?token=secret",
    "https://gateway.test/v1#secret",
  ])("rejects unsafe or invalid endpoint %s", (input) => {
    expect(() => normalizeBaseUrl(input)).toThrow();
  });

  it("requires an explicitly configured endpoint on a clean installation", () => {
    expect(() => resolveExpBaseUrl({})).toThrow(/EXP endpoint is required.*\/exp-configure/);
  });

  it("uses and normalizes only the persisted endpoint", () => {
    expect(resolveExpBaseUrl({ baseUrl: "https://persisted.test/proxy" })).toBe(
      "https://persisted.test/proxy/v1",
    );
  });

  it("ignores a non-empty EXPLLM_HOST instead of overriding the persisted endpoint", () => {
    vi.stubEnv("EXPLLM_HOST", " http://environment.test:4001/proxy/ ");
    expect(resolveExpBaseUrl({ baseUrl: "https://persisted.test/v1" })).toBe(
      "https://persisted.test/v1",
    );
  });

  it("ignores an invalid EXPLLM_HOST without rejecting the persisted endpoint", () => {
    vi.stubEnv("EXPLLM_HOST", "not-an-absolute-url");
    expect(resolveExpBaseUrl({ baseUrl: "https://persisted.test/v1" })).toBe(
      "https://persisted.test/v1",
    );
  });
});
