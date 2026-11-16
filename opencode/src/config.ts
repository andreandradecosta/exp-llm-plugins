export const PROVIDER_ID = "exp"
export const INTEGRATION_ID = "exp"
export const PROVIDER_NAME = "LiteLLM experimental"
export const PROVIDER_PACKAGE = "@opencode/ai/providers/openai-compatible"

export const DEFAULT_FALLBACK_CONTEXT_TOKENS = 128_000
export const DEFAULT_FALLBACK_OUTPUT_TOKENS = 16_384
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000

export const STORAGE_ENDPOINT_KEY = "gateway/endpoint"
export const STORAGE_CATALOG_KEY = "gateway/catalog"

export interface ExpOptions {
  readonly fallbackContextTokens: number
  readonly fallbackOutputTokens: number
  readonly requestTimeoutMs: number
}

export function readOptions(input: Readonly<Record<string, unknown>>): ExpOptions {
  return {
    fallbackContextTokens: positiveIntegerOption(
      input.fallbackContextTokens,
      DEFAULT_FALLBACK_CONTEXT_TOKENS,
      "fallbackContextTokens",
    ),
    fallbackOutputTokens: positiveIntegerOption(
      input.fallbackOutputTokens,
      DEFAULT_FALLBACK_OUTPUT_TOKENS,
      "fallbackOutputTokens",
    ),
    requestTimeoutMs: positiveIntegerOption(
      input.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    ),
  }
}

function positiveIntegerOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`A opção ${name} deve ser um inteiro positivo.`)
  }
  return value
}
