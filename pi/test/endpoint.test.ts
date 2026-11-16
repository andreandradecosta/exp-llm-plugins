import { describe, expect, it } from "vitest";
import { DEFAULT_EXP_BASE_URL } from "../src/constants.ts";
import { discoveryUrl, normalizeBaseUrl, resolveExpBaseUrl } from "../src/endpoint.ts";

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

  it("uses the built-in normalized endpoint for a clean installation", () => {
    expect(DEFAULT_EXP_BASE_URL).toBe("http://pgeodsv1.ep.petrobras.com.br:4001/v1");
    expect(resolveExpBaseUrl({}, {})).toBe("http://pgeodsv1.ep.petrobras.com.br:4001/v1");
  });

  it.each([undefined, "", "   "])("uses the persisted endpoint when EXPLLM_HOST is empty (%s)", (host) => {
    expect(resolveExpBaseUrl(
      { baseUrl: "https://persisted.test/proxy" },
      { ...(host === undefined ? {} : { EXPLLM_HOST: host }) },
    )).toBe("https://persisted.test/proxy/v1");
  });

  it("gives a non-empty EXPLLM_HOST precedence and normalizes it", () => {
    expect(resolveExpBaseUrl(
      { baseUrl: "https://persisted.test/v1" },
      { EXPLLM_HOST: " http://environment.test:4001/proxy/ " },
    )).toBe("http://environment.test:4001/proxy/v1");
  });

  it("rejects an invalid EXPLLM_HOST instead of using a persisted fallback", () => {
    expect(() => resolveExpBaseUrl(
      { baseUrl: "https://persisted.test/v1" },
      { EXPLLM_HOST: "not-an-absolute-url" },
    )).toThrow(/Invalid EXPLLM_HOST/);
  });
});
