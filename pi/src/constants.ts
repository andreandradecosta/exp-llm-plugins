export const PROVIDER_ID = "exp";
export const PROVIDER_NAME = "EXP Gateway";
export const CONFIG_FILE_NAME = "exp-config.json";
export const CATALOG_FILE_NAME = "exp-models.json";

export const DEFAULT_EXP_BASE_URL = "http://pgeodsv1.ep.petrobras.com.br:4001/v1";
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_TIMEOUT_MS = 5_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 30_000;

/** Zero means "not supplied by the gateway", not a price quote. */
export const UNKNOWN_COST = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});
