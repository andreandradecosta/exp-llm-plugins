import { ExpConfigError } from "./errors.ts";

/** Canonicalize an EXP URL to the OpenAI-compatible /v1 base. */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ExpConfigError("EXP endpoint is required");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ExpConfigError("EXP endpoint must be an absolute HTTP(S) URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ExpConfigError("EXP endpoint must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new ExpConfigError("EXP endpoint must not contain credentials; use /login for the token");
  }
  if (url.search || url.hash) {
    throw new ExpConfigError("EXP endpoint must not contain a query string or fragment");
  }

  const path = url.pathname.replace(/\/+$/, "");
  const withoutVersion = path.endsWith("/v1") ? path.slice(0, -3) : path;
  url.pathname = `${withoutVersion}/v1`.replace(/\/{2,}/g, "/");
  return url.toString().replace(/\/$/, "");
}

export function discoveryUrl(baseUrl: string, resource: "models" | "model/info"): string {
  return `${normalizeBaseUrl(baseUrl)}/${resource}`;
}
