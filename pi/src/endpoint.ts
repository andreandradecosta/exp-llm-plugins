import { DEFAULT_EXP_BASE_URL } from "./constants.ts";
import { ExpConfigError } from "./errors.ts";

export interface ExpEndpointConfig {
  baseUrl?: string;
}

/** Resolve the runtime endpoint without allowing an invalid environment override to fall back. */
export function resolveExpBaseUrl(
  config: ExpEndpointConfig,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const environmentBaseUrl = environment.EXPLLM_HOST;
  if (environmentBaseUrl?.trim()) {
    try {
      return normalizeBaseUrl(environmentBaseUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "invalid URL";
      throw new ExpConfigError(`Invalid EXPLLM_HOST: ${detail}`, { cause: error });
    }
  }
  return normalizeBaseUrl(config.baseUrl ?? DEFAULT_EXP_BASE_URL);
}

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
