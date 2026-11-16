export { default, createExpExtension, readNativeExpCredential } from "./extension.ts";
export type { ExpExtensionOptions } from "./extension.ts";
export { watchExpCredentialChanges, AUTH_REFRESH_DEBOUNCE_MS } from "./credential-watcher.ts";
export type { AuthWatchFunction, AuthWatchListener, ExpCredentialWatchOptions } from "./credential-watcher.ts";
export { createExpIntegration, refreshExpProvider } from "./provider.ts";
export type {
  ExpIntegration,
  ExpIntegrationOptions,
  ExpProvider,
  ExpRefreshResult,
  ReadExpCredential,
} from "./provider.ts";
export { GatewayDiscoveryClient, buildCatalog, parseModelInfo, parseModelsList } from "./discovery.ts";
export type { DiscoveryClient, DiscoveryOptions, FetchLike } from "./discovery.ts";
export {
  FileExpCatalogStore,
  FileExpConfigStore,
  InMemoryExpConfigStore,
} from "./config.ts";
export type { ExpConfig, ExpConfigStore } from "./config.ts";
export { normalizeBaseUrl, discoveryUrl } from "./endpoint.ts";
export { createExpAuth, apiKeyFromCredential } from "./auth.ts";
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  PROVIDER_ID,
  PROVIDER_NAME,
  UNKNOWN_COST,
} from "./constants.ts";
