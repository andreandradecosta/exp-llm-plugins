import {
  createProvider,
  openAICompletionsApi,
  type Credential,
  type Model,
  type ModelsPublication,
  type ModelsStore,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai/compat";
import { apiKeyFromCredential, createExpAuth } from "./auth.ts";
import { FileExpCatalogStore, FileExpConfigStore, type ExpConfig, type ExpConfigStore } from "./config.ts";
import { PROVIDER_ID, PROVIDER_NAME } from "./constants.ts";
import { resolveExpBaseUrl } from "./endpoint.ts";
import { ExpDiscoveryError } from "./errors.ts";
import { GatewayDiscoveryClient, type DiscoveryClient } from "./discovery.ts";

export type ExpProvider = Provider<"openai-completions">;
export type ReadExpCredential = () => Promise<Credential | undefined> | Credential | undefined;

export interface ExpIntegrationOptions {
  configStore: ExpConfigStore;
  catalogStore: ModelsStore;
  readCredential: ReadExpCredential;
  discoveryClient?: DiscoveryClient;
  now?: () => number;
}

export interface ExpRefreshResult {
  attempted: boolean;
  error?: Error;
}

export interface ExpIntegration {
  provider: ExpProvider;
  configStore: ExpConfigStore;
  /** Restore the last valid EXP cache and, when configured, refresh it before registration. */
  refresh(signal?: AbortSignal): Promise<ExpRefreshResult>;
}

export function createExpIntegration(options: ExpIntegrationOptions): ExpIntegration {
  const discoveryClient = options.discoveryClient ?? new GatewayDiscoveryClient();
  const now = options.now ?? Date.now;
  const auth = createExpAuth(options.configStore);
  let models: readonly Model<"openai-completions">[] = [];
  let hasUsableCatalog = false;
  let catalogBaseUrl: string | undefined;
  let generation = 0;

  // Streaming and auth stay in Pi's native provider implementation. Only the
  // dynamic catalog is wrapped so startup and native refreshes share one state.
  const delegate = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    auth: { apiKey: auth },
    models: [],
    api: openAICompletionsApi(),
  });

  const provider: ExpProvider = {
    ...delegate,
    getModels: () => models,
    getAllModels: () => models,
    refreshModels: async (context) => {
      const config = await options.configStore.read();
      const baseUrl = resolveExpBaseUrl(config);
      if (!hasUsableCatalog || catalogBaseUrl !== baseUrl) {
        const restored = context.stored?.models.filter(
          (model): model is Model<"openai-completions"> =>
            model.provider === PROVIDER_ID &&
            (model.type === undefined || model.type === "chat") &&
            model.api === "openai-completions" &&
            model.baseUrl === baseUrl,
        ) ?? [];
        const published = await context.publish({
          update: () => {
            models = restored;
            hasUsableCatalog = context.stored !== undefined;
            catalogBaseUrl = baseUrl;
          },
        });
        if (!published) return;
      }
      if (!context.allowNetwork || context.signal.aborted) return;

      // Cache-only synchronization (including native /login) must not cancel a
      // watcher-initiated network refresh without providing a newer catalog.
      const currentGeneration = ++generation;
      const token = apiKeyFromCredential(context.credential);
      if (!token) {
        throw new ExpDiscoveryError("EXP token is not configured; use /login with the EXP provider", 401);
      }

      const fetched = await discoveryClient.discover({
        baseUrl,
        token,
        defaultMaxTokens: config.defaultMaxTokens,
        timeoutMs: config.timeoutMs,
        signal: context.signal,
      });
      if (context.signal.aborted || generation !== currentGeneration) return;

      await context.publish({
        persist: { models: fetched, checkedAt: now() },
        update: () => {
          // This single synchronous replacement is the only catalog mutation.
          // Revalidate because persistence may have yielded to a newer refresh.
          if (context.signal.aborted || generation !== currentGeneration) return;
          models = fetched;
          hasUsableCatalog = true;
          catalogBaseUrl = baseUrl;
        },
      });
    },
  };

  return {
    provider,
    configStore: options.configStore,
    async refresh(signal = new AbortController().signal): Promise<ExpRefreshResult> {
      let stored;
      try {
        stored = await options.catalogStore.read(PROVIDER_ID, { signal });
      } catch {
        // A damaged or unreadable cache must not prevent a fresh network read.
        stored = undefined;
      }

      let setupError: Error | undefined;
      let credential: Credential | undefined;
      try {
        credential = await options.readCredential();
      } catch {
        setupError = new Error("Cannot read the EXP credential from Pi storage");
      }
      let config: ExpConfig | undefined;
      try {
        config = await options.configStore.read();
        resolveExpBaseUrl(config);
      } catch (error) {
        setupError = asError(error);
      }
      const attempted = !setupError && Boolean(apiKeyFromCredential(credential)) && !signal.aborted;
      const publications = createStartupPublisher(options.catalogStore, signal);

      try {
        await provider.refreshModels?.({
          ...(credential ? { credential } : {}),
          ...(stored ? { stored } : {}),
          allowNetwork: attempted,
          signal,
          publish: publications,
        });
        return setupError ? { attempted, error: setupError } : { attempted };
      } catch (error) {
        // The successfully restored or previously fetched catalog remains live.
        return { attempted, error: asError(error) };
      }
    },
  };
}

export function createDefaultExpIntegration(readCredential: ReadExpCredential): ExpIntegration {
  return createExpIntegration({
    configStore: new FileExpConfigStore(),
    catalogStore: new FileExpCatalogStore(),
    readCredential,
  });
}

function createStartupPublisher(
  store: ModelsStore,
  signal: AbortSignal,
): (publication: ModelsPublication) => Promise<boolean> {
  let chain: Promise<unknown> = Promise.resolve();
  return (publication: ModelsPublication): Promise<boolean> => {
    const operation = chain.then(async () => {
      signal.throwIfAborted();
      if (publication.persist === null) {
        await store.delete(PROVIDER_ID, { signal });
      } else if (publication.persist !== undefined) {
        await store.write(PROVIDER_ID, publication.persist, { signal });
      }
      signal.throwIfAborted();
      publication.update?.();
      return true;
    });
    chain = operation.catch(() => {});
    return operation;
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Unknown EXP provider error");
}

/** Convenience for tests and embedders that invoke the native refresh directly. */
export async function refreshExpProvider(provider: ExpProvider, context: RefreshModelsContext): Promise<void> {
  await provider.refreshModels?.(context);
}
