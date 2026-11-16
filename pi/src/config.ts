import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  CATALOG_FILE_NAME,
  CONFIG_FILE_NAME,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "./constants.ts";
import { normalizeBaseUrl } from "./endpoint.ts";
import { ExpConfigError } from "./errors.ts";
import type { Model, ModelsStore, ModelsStoreEntry, ModelsStoreOperationOptions } from "@earendil-works/pi-ai/compat";

export interface ExpConfig {
  baseUrl?: string;
  defaultMaxTokens: number;
  timeoutMs: number;
}

export interface ExpConfigStore {
  read(): Promise<ExpConfig>;
  write(config: ExpConfig): Promise<void>;
  readonly path: string;
}

export const DEFAULT_EXP_CONFIG: Readonly<ExpConfig> = Object.freeze({
  defaultMaxTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

export function positiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim()) value = Number(value);
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseConfig(value: unknown): ExpConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExpConfigError("EXP configuration must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  const baseUrl = input.baseUrl === undefined ? undefined : normalizeBaseUrl(String(input.baseUrl));
  const defaultMaxTokens = positiveInteger(input.defaultMaxTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  const candidateTimeout = positiveInteger(input.timeoutMs, DEFAULT_TIMEOUT_MS);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, candidateTimeout));
  return { ...(baseUrl ? { baseUrl } : {}), defaultMaxTokens, timeoutMs };
}

export class FileExpConfigStore implements ExpConfigStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly path = join(getAgentDir(), CONFIG_FILE_NAME)) {}

  async read(): Promise<ExpConfig> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_EXP_CONFIG };
      throw new ExpConfigError(`Cannot read EXP configuration at ${this.path}`, { cause: error });
    }

    try {
      return parseConfig(JSON.parse(source));
    } catch (error) {
      if (error instanceof ExpConfigError) throw error;
      throw new ExpConfigError(`Invalid JSON in EXP configuration at ${this.path}`, { cause: error });
    }
  }

  write(config: ExpConfig): Promise<void> {
    const clean = parseConfig(config);
    const operation = this.writeChain.then(async () => {
      await writeJsonAtomic(this.path, clean);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }
}

/** EXP-only fallback cache, separate from Pi's native models-store.json. */
export class FileExpCatalogStore implements ModelsStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly path = join(getAgentDir(), CATALOG_FILE_NAME)) {}

  async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ExpConfigError(`Cannot read EXP catalog cache at ${this.path}`, { cause: error });
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source);
    } catch (error) {
      throw new ExpConfigError(`Invalid JSON in EXP catalog cache at ${this.path}`, { cause: error });
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ExpConfigError(`Invalid EXP catalog cache at ${this.path}`);
    }
    const entry = (raw as Record<string, unknown>)[providerId];
    if (entry === undefined) return undefined;
    return validateCatalogEntry(entry, providerId);
  }

  write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
    const snapshot = validateCatalogEntry(entry, providerId);
    const operation = this.writeChain.then(async () => {
      options?.signal?.throwIfAborted();
      let current: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
          current = raw as Record<string, unknown>;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // A valid new catalog can repair the EXP-only cache; no other Pi files are touched.
          current = {};
        }
      }
      current[providerId] = snapshot;
      await writeJsonAtomic(this.path, current);
      options?.signal?.throwIfAborted();
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }

  delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    const operation = this.writeChain.then(async () => {
      options?.signal?.throwIfAborted();
      let current: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(await readFile(this.path, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return;
        current = raw as Record<string, unknown>;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      delete current[providerId];
      await writeJsonAtomic(this.path, current);
    });
    this.writeChain = operation.catch(() => {});
    return operation;
  }
}

export class InMemoryExpConfigStore implements ExpConfigStore {
  readonly path = "<memory>";
  private config: ExpConfig;

  constructor(config: Partial<ExpConfig> = {}) {
    this.config = { ...DEFAULT_EXP_CONFIG, ...config };
    if (this.config.baseUrl) this.config.baseUrl = normalizeBaseUrl(this.config.baseUrl);
  }

  async read(): Promise<ExpConfig> {
    return { ...this.config };
  }

  async write(config: ExpConfig): Promise<void> {
    this.config = parseConfig(config);
  }
}

function validateCatalogEntry(value: unknown, providerId: string): ModelsStoreEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ExpConfigError(`Invalid cached catalog for ${providerId}`);
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.models) || !input.models.every((model) => isCachedModel(model, providerId))) {
    throw new ExpConfigError(`Invalid cached models for ${providerId}`);
  }
  const entry: ModelsStoreEntry = { models: structuredClone(input.models) as Model<"openai-completions">[] };
  if (typeof input.checkedAt === "number" && Number.isFinite(input.checkedAt)) entry.checkedAt = input.checkedAt;
  if (typeof input.lastModified === "number" && Number.isFinite(input.lastModified)) {
    entry.lastModified = input.lastModified;
  }
  return entry;
}

function isCachedModel(value: unknown, providerId: string): value is Model<"openai-completions"> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const model = value as Record<string, unknown>;
  const cost = model.cost as Record<string, unknown> | undefined;
  return (
    model.id !== undefined && typeof model.id === "string" && model.id.length > 0 &&
    typeof model.name === "string" &&
    model.provider === providerId &&
    model.api === "openai-completions" &&
    typeof model.baseUrl === "string" &&
    Array.isArray(model.input) && model.input.every((item) => item === "text" || item === "image") &&
    typeof model.reasoning === "boolean" &&
    typeof model.contextWindow === "number" && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0 &&
    typeof model.maxTokens === "number" && Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0 &&
    cost !== null && typeof cost === "object" &&
    ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof cost[key] === "number")
  );
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.exp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // The atomic rename already committed the non-secret destination.
      }
    }
  }
}
