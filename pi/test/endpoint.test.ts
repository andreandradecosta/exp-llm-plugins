import { describe, expect, it } from "vitest";
import { discoveryUrl, normalizeBaseUrl } from "../src/endpoint.ts";

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
});
