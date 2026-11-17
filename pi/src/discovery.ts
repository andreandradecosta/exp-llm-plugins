import type { Model } from "@earendil-works/pi-ai/compat";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PROVIDER_ID,
  UNKNOWN_COST,
} from "./constants.ts";
import { discoveryUrl, normalizeBaseUrl } from "./endpoint.ts";
import { ExpDiscoveryError } from "./errors.ts";
import { positiveInteger } from "./config.ts";

export interface DiscoveryOptions {
  baseUrl: string;
  token: string;
  defaultMaxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface DiscoveryClient {
  discover(options: DiscoveryOptions): Promise<readonly Model<"openai-completions">[]>;
}

export type FetchLike = typeof globalThis.fetch;

interface ModelsListEntry {
  id: string;
  max_input_tokens?: string | number;
}

interface ModelInfoEntry {
  model_name: string;
  model_info?: {
    max_input_tokens?: string | number;
    max_tokens?: string | number;
    max_output_tokens?: string | number;
    supports_vision?: unknown;
  };
}

export class GatewayDiscoveryClient implements DiscoveryClient {
  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch) {}

  async discover(options: DiscoveryOptions): Promise<readonly Model<"openai-completions">[]> {
    const headers = { Authorization: `Bearer ${options.token}` };
    const [modelsResult, infoResult] = await Promise.allSettled([
      this.fetchJson(discoveryUrl(options.baseUrl, "models"), headers, options.timeoutMs, options.signal),
      this.fetchJson(discoveryUrl(options.baseUrl, "model/info"), headers, options.timeoutMs, options.signal),
    ]);

    if (modelsResult.status === "rejected") throw modelsResult.reason;
    options.signal?.throwIfAborted();
    const listed = parseModelsList(modelsResult.value);
    const info = infoResult.status === "fulfilled" ? parseModelInfo(infoResult.value) : new Map<string, ModelInfoEntry>();
    return buildCatalog(listed, info, options.baseUrl, options.defaultMaxTokens);
  }

  private async fetchJson(
    url: string,
    headers: Record<string, string>,
    timeoutMs: number,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromParent = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new ExpDiscoveryError(`EXP discovery timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: { ...headers, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (error) {
        parentSignal?.throwIfAborted();
        if (timedOut) {
          throw new ExpDiscoveryError(`EXP discovery timed out after ${timeoutMs} ms`, undefined, {
            cause: error,
          });
        }
        throw new ExpDiscoveryError(`Cannot reach EXP discovery endpoint ${withoutQuery(url)}`, undefined, {
          cause: error,
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new ExpDiscoveryError(
          `EXP authentication failed (HTTP ${response.status}) at ${withoutQuery(url)}. Run /login and update the stored EXP token.`,
          response.status,
        );
      }
      if (!response.ok) {
        throw new ExpDiscoveryError(`EXP discovery failed with HTTP ${response.status} at ${withoutQuery(url)}`, response.status);
      }
      try {
        return await response.json();
      } catch (error) {
        throw new ExpDiscoveryError(`EXP discovery returned invalid JSON at ${withoutQuery(url)}`, undefined, {
          cause: error,
        });
      }
    } finally {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    }
  }
}

export function parseModelsList(payload: unknown): ModelsListEntry[] {
  const data = dataArray(payload, "/models");
  const seen = new Set<string>();
  const entries: ModelsListEntry[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ExpDiscoveryError("EXP /models contains an invalid model entry");
    }
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id.trim()) {
      throw new ExpDiscoveryError("EXP /models contains a model without a valid id");
    }
    const id = item.id.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const maxInput = item.max_input_tokens;
    if (maxInput !== undefined && positiveInteger(maxInput, 0) === 0) {
      throw new ExpDiscoveryError(`EXP /models contains invalid max_input_tokens for ${id}`);
    }
    entries.push({ id, ...(maxInput !== undefined ? { max_input_tokens: maxInput as string | number } : {}) });
  }
  return entries;
}

export function parseModelInfo(payload: unknown): Map<string, ModelInfoEntry> {
  const result = new Map<string, ModelInfoEntry>();
  let data: unknown[];
  try {
    data = dataArray(payload, "/model/info");
  } catch {
    return result;
  }

  for (const raw of data) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.model_name !== "string" || !item.model_name.trim()) continue;
    const rawInfo = item.model_info;
    const modelInfo = rawInfo !== null && typeof rawInfo === "object" && !Array.isArray(rawInfo)
      ? rawInfo as ModelInfoEntry["model_info"]
      : undefined;
    result.set(item.model_name.trim(), {
      model_name: item.model_name.trim(),
      ...(modelInfo ? { model_info: modelInfo } : {}),
    });
  }
  return result;
}

export function buildCatalog(
  listed: readonly ModelsListEntry[],
  info: ReadonlyMap<string, ModelInfoEntry>,
  baseUrl: string,
  defaultMaxTokens: number,
): Model<"openai-completions">[] {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const outputDefault = positiveInteger(defaultMaxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  return listed.map((entry) => {
    const metadata = info.get(entry.id)?.model_info;
    const contextWindow = positiveInteger(
      entry.max_input_tokens ?? metadata?.max_input_tokens ?? metadata?.max_tokens,
      DEFAULT_CONTEXT_WINDOW,
    );
    const maxTokens = Math.min(
      positiveInteger(metadata?.max_output_tokens, outputDefault),
      contextWindow,
    );
    return {
      id: entry.id,
      name: entry.id,
      provider: PROVIDER_ID,
      api: "openai-completions",
      baseUrl: normalizedBaseUrl,
      input: metadata?.supports_vision === true ? ["text", "image"] : ["text"],
      reasoning: true,
      // OpenAI compatibility does not imply support for the newer developer role.
      compat: { supportsDeveloperRole: false },
      cost: { ...UNKNOWN_COST },
      contextWindow,
      maxTokens,
    };
  });
}

function dataArray(payload: unknown, endpoint: string): unknown[] {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ExpDiscoveryError(`EXP ${endpoint} response must be an object`);
  }
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) throw new ExpDiscoveryError(`EXP ${endpoint} response must contain a data array`);
  return data;
}

function withoutQuery(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}
