import { normalizeEndpoint } from "./endpoint.ts"
import type { CatalogModel, StoredCatalog } from "./types.ts"

export interface TokenFallbacks {
  readonly fallbackContextTokens: number
  readonly fallbackOutputTokens: number
}

interface ListedModel {
  readonly id: string
  readonly created: number
  readonly maxInputTokens?: number
}

interface ModelMetadata {
  readonly maxInputTokens: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly maxTokens: number | undefined
  readonly vision: boolean
}

export function buildCatalogModels(
  modelsPayload: unknown,
  modelInfoPayload: unknown,
  fallbacks: TokenFallbacks,
): CatalogModel[] {
  const listed = parseModelsResponse(modelsPayload)
  const metadata = parseModelInfoResponse(modelInfoPayload)

  return listed.map((model) => {
    const info = metadata.get(model.id)
    const contextTokens = model.maxInputTokens ?? info?.maxInputTokens ?? info?.maxTokens ?? fallbacks.fallbackContextTokens
    const outputTokens = Math.min(info?.maxOutputTokens ?? fallbacks.fallbackOutputTokens, contextTokens)

    return {
      id: model.id,
      created: model.created,
      contextTokens,
      outputTokens,
      vision: info?.vision === true,
    }
  })
}

export function parsePositiveTokenLimit(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function parseModelsResponse(payload: unknown): ListedModel[] {
  const root = record(payload)
  if (!root || root.object !== "list" || !Array.isArray(root.data)) {
    throw new Error("Resposta inválida de /models.")
  }

  const unique = new Map<string, ListedModel>()
  for (const item of root.data) {
    const value = record(item)
    const id = value?.id
    if (!value || typeof id !== "string" || !id.trim()) {
      throw new Error("Resposta inválida de /models: modelo sem ID válido.")
    }
    if (unique.has(id)) continue

    const created = typeof value.created === "number" && Number.isFinite(value.created) && value.created >= 0
      ? Math.floor(value.created * 1000)
      : 0
    const maxInputTokens = parsePositiveTokenLimit(value.max_input_tokens)
    const model: ListedModel = {
      id,
      created,
      ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    }
    unique.set(id, model)
  }
  return [...unique.values()]
}

function parseModelInfoResponse(payload: unknown): Map<string, ModelMetadata> {
  const result = new Map<string, ModelMetadata>()
  const root = record(payload)
  if (!root || !Array.isArray(root.data)) throw new Error("Resposta inválida de /model/info.")

  for (const item of root.data) {
    const value = record(item)
    const name = value?.model_name
    if (typeof name !== "string" || !name || result.has(name)) continue
    const rawInfo = record(value.model_info) ?? {}
    result.set(name, {
      maxInputTokens: parsePositiveTokenLimit(rawInfo.max_input_tokens),
      maxOutputTokens: parsePositiveTokenLimit(rawInfo.max_output_tokens),
      maxTokens: parsePositiveTokenLimit(rawInfo.max_tokens),
      vision: rawInfo.supports_vision === true,
    })
  }
  return result
}

/** Reads only the explicitly persisted, non-secret cache schema. */
export function parseStoredCatalog(payload: unknown): StoredCatalog | undefined {
  const root = record(payload)
  if (
    !root || root.version !== 1 || typeof root.endpoint !== "string" ||
    typeof root.connectionKey !== "string" || !root.connectionKey ||
    typeof root.updatedAt !== "string" || !Number.isFinite(Date.parse(root.updatedAt)) ||
    (root.metadataStatus !== "available" && root.metadataStatus !== "unavailable") ||
    !Array.isArray(root.models)
  ) return undefined

  let endpoint: string
  try {
    endpoint = normalizeEndpoint(root.endpoint)
  } catch {
    return undefined
  }

  const models = new Map<string, CatalogModel>()
  for (const item of root.models) {
    const value = record(item)
    if (
      !value || typeof value.id !== "string" || !value.id ||
      typeof value.created !== "number" || !Number.isFinite(value.created) || value.created < 0 ||
      !isPositiveInteger(value.contextTokens) || !isPositiveInteger(value.outputTokens) ||
      typeof value.vision !== "boolean"
    ) return undefined
    if (models.has(value.id)) continue
    models.set(value.id, {
      id: value.id,
      created: value.created,
      contextTokens: value.contextTokens,
      outputTokens: value.outputTokens,
      vision: value.vision,
    })
  }

  return {
    version: 1,
    endpoint,
    connectionKey: root.connectionKey,
    updatedAt: root.updatedAt,
    metadataStatus: root.metadataStatus,
    models: [...models.values()],
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
