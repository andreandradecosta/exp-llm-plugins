import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import { parseStoredCatalog } from "./catalog.ts"
import {
  INTEGRATION_ID,
  PROVIDER_ID,
  PROVIDER_NAME,
  PROVIDER_PACKAGE,
  STORAGE_CATALOG_KEY,
  STORAGE_ENDPOINT_KEY,
  type ExpOptions,
} from "./config.ts"
import { EndpointError, normalizeEndpoint } from "./endpoint.ts"
import { SafeError, safeErrorMessage } from "./errors.ts"
import { discoverGateway, type DiscoverInput } from "./gateway.ts"
import {
  bearerToken,
  connectionKey,
  type DiscoveryResult,
  type ExpStatus,
  type GatewayConnection,
  type GatewayCredential,
  type RefreshStatus,
  type StoredCatalog,
} from "./types.ts"

export type ServerStorage = Plugin.Context["storage"]

export interface ExpServiceDependencies {
  readonly storage: Pick<ServerStorage, "get" | "set">
  readonly activeConnection: (integrationID: string) => Promise<GatewayConnection | undefined>
  readonly resolveCredential: (connection: GatewayConnection) => Promise<GatewayCredential | undefined>
  readonly publish: () => Promise<void>
  readonly discover?: (input: DiscoverInput) => Promise<DiscoveryResult>
  readonly now?: () => Date
}

export interface ExpProviderSnapshot {
  readonly info: Provider.Info
  readonly models: readonly Model.Info[]
  readonly sourceConnection?: GatewayConnection
}

interface ActiveRefresh {
  readonly revision: number
  readonly promise: Promise<ExpStatus>
}

export class ExpService {
  private readonly discover: NonNullable<ExpServiceDependencies["discover"]>
  private readonly now: () => Date
  private endpointValue: string | undefined
  private catalog: StoredCatalog | undefined
  private connection: GatewayConnection | undefined
  private authenticated = false
  private lastRefreshValue: RefreshStatus = "never"
  private lastErrorValue: string | undefined
  private lastWarningValue: string | undefined
  private revision = 0
  private active: ActiveRefresh | undefined
  private trailing: Promise<ExpStatus> | undefined
  private disposed = false
  private readonly dependencies: ExpServiceDependencies
  private readonly options: ExpOptions

  constructor(dependencies: ExpServiceDependencies, options: ExpOptions) {
    this.dependencies = dependencies
    this.options = options
    this.discover = dependencies.discover ?? discoverGateway
    this.now = dependencies.now ?? (() => new Date())
  }

  async initialize(): Promise<void> {
    try {
      const [endpoint, cached] = await Promise.all([
        this.dependencies.storage.get(STORAGE_ENDPOINT_KEY),
        this.dependencies.storage.get(STORAGE_CATALOG_KEY),
      ])
      this.catalog = parseStoredCatalog(cached)
      try {
        if (typeof endpoint === "string") {
          this.endpointValue = normalizeEndpoint(endpoint)
        } else {
          this.missingEndpoint()
        }
      } catch {
        this.endpointValue = undefined
        this.lastErrorValue = "O endpoint persistido é inválido. Execute /exp-setup para configurá-lo novamente."
        this.lastRefreshValue = "error"
      }
    } catch {
      this.lastErrorValue = "Não foi possível ler a configuração persistida do plugin."
      this.lastRefreshValue = "error"
    }
  }

  status(): ExpStatus {
    return {
      configured: this.endpointValue !== undefined,
      endpoint: this.endpointValue ?? null,
      connected: this.connection !== undefined,
      authenticated: this.authenticated,
      refreshing: this.active !== undefined || this.trailing !== undefined,
      modelCount: this.visibleModels().length,
      cachedModelCount: this.catalog?.models.length ?? 0,
      catalogUpdatedAt: this.catalog?.updatedAt ?? null,
      metadataStatus: this.catalog?.metadataStatus ?? "unknown",
      lastRefresh: this.lastRefreshValue,
      lastError: this.lastErrorValue ?? null,
      lastWarning: this.lastWarningValue ?? null,
    }
  }

  providerSnapshot(): ExpProviderSnapshot | undefined {
    const baseURL = this.endpointValue
    if (!baseURL) return undefined

    const providerID = Provider.ID.make(PROVIDER_ID)
    const models = this.visibleModels().map((model) => ({
      ...Model.Info.default(providerID, Model.ID.make(model.id)),
      name: model.id,
      capabilities: {
        tools: true,
        input: model.vision ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      limit: {
        context: model.contextTokens,
        output: model.outputTokens,
      },
      time: { released: model.created },
    }))

    return {
      // OpenCode resolves this integration at inference time and applies its native Bearer credential.
      // Credentials must never be copied into provider settings, model headers or the persisted catalog.
      info: {
        ...Provider.Info.empty(providerID),
        integrationID: Integration.ID.make(INTEGRATION_ID),
        name: PROVIDER_NAME,
        activation: "enabled",
        package: PROVIDER_PACKAGE,
        settings: { baseURL },
      },
      models,
      ...(this.connection ? { sourceConnection: this.connection } : {}),
    }
  }

  async configure(endpoint: string): Promise<ExpStatus> {
    if (this.disposed) return this.status()

    let normalized: string
    try {
      normalized = normalizeEndpoint(endpoint)
    } catch (error) {
      this.rememberError(error)
      return this.status()
    }

    const changed = normalized !== this.endpointValue
    this.revision++
    try {
      await this.dependencies.storage.set(STORAGE_ENDPOINT_KEY, normalized)
    } catch {
      this.lastRefreshValue = "error"
      this.lastErrorValue = "Não foi possível persistir o endpoint. A configuração anterior foi mantida."
      return this.status()
    }

    this.endpointValue = normalized
    this.lastErrorValue = undefined
    this.lastWarningValue = undefined
    if (changed) await this.publish()
    return this.refresh()
  }

  async connectionChanged(): Promise<ExpStatus> {
    if (this.disposed) return this.status()
    this.revision++
    this.connection = undefined
    this.authenticated = false
    await this.publish()
    return this.refresh()
  }

  refresh(): Promise<ExpStatus> {
    if (this.disposed) return Promise.resolve(this.status())
    const revision = this.revision

    if (!this.active) return this.start(revision)
    if (this.active.revision === revision && !this.trailing) return this.active.promise
    if (this.trailing) return this.trailing

    const previous = this.active.promise
    this.trailing = previous.then(() => {
      this.trailing = undefined
      return this.start(this.revision)
    })
    return this.trailing
  }

  dispose(): void {
    this.disposed = true
    this.revision++
  }

  private start(revision: number): Promise<ExpStatus> {
    const promise = this.performRefresh(revision)
      .catch(() => {
        if (revision === this.revision && !this.disposed) {
          this.lastRefreshValue = "error"
          this.lastErrorValue = "Falha interna ao atualizar o catálogo. O catálogo anterior foi mantido."
        }
      })
      .finally(() => {
        if (this.active?.promise === promise) this.active = undefined
      })
      // Recompute once after the active slot is cleared so `refreshing` is accurate.
      .then(() => this.status())
    this.active = { revision, promise }
    return promise
  }

  private async performRefresh(revision: number): Promise<ExpStatus> {
    const endpoint = this.endpointValue
    if (!endpoint) return this.missingEndpoint()

    const connection = await this.dependencies.activeConnection(INTEGRATION_ID)
    if (!this.isCurrent(revision)) return this.status()

    const credential = connection
      ? await this.dependencies.resolveCredential(connection)
      : undefined
    if (!this.isCurrent(revision)) return this.status()

    this.connection = connection
    this.authenticated = bearerToken(credential) !== undefined
    await this.publish()

    const token = bearerToken(credential)
    if (!connection || !token) {
      this.lastRefreshValue = "error"
      this.lastErrorValue = "Autentique o gateway por /connect, selecione exp e informe o token pelo fluxo nativo."
      this.lastWarningValue = undefined
      return this.status()
    }

    let result
    try {
      result = await this.discover({
        endpoint,
        token,
        timeoutMs: this.options.requestTimeoutMs,
        fallbackContextTokens: this.options.fallbackContextTokens,
        fallbackOutputTokens: this.options.fallbackOutputTokens,
      })
    } catch (error) {
      if (!this.isCurrent(revision)) return this.status()
      const currentCatalog = this.catalogFor(endpoint, connectionKey(connection))
      const detail = safeErrorMessage(error, "Falha desconhecida ao consultar o gateway.")
      this.lastRefreshValue = "error"
      this.lastErrorValue = currentCatalog
        ? `${detail} O último catálogo válido foi mantido.`
        : `${detail} Nenhum catálogo válido está disponível.`
      return this.status()
    }

    if (!this.isCurrent(revision)) return this.status()
    const key = connectionKey(connection)
    if (!key) {
      this.lastRefreshValue = "error"
      this.lastErrorValue = "Não foi possível identificar a conexão ativa. Reautentique por /connect."
      return this.status()
    }

    const next: StoredCatalog = {
      version: 1,
      endpoint,
      connectionKey: key,
      updatedAt: this.now().toISOString(),
      metadataStatus: result.metadataStatus,
      models: result.models.map((model) => ({ ...model })),
    }

    try {
      const persisted: Parameters<ServerStorage["set"]>[1] = {
        version: next.version,
        endpoint: next.endpoint,
        connectionKey: next.connectionKey,
        updatedAt: next.updatedAt,
        metadataStatus: next.metadataStatus,
        models: next.models.map((model) => ({
          id: model.id,
          created: model.created,
          contextTokens: model.contextTokens,
          outputTokens: model.outputTokens,
          vision: model.vision,
        })),
      }
      await this.dependencies.storage.set(STORAGE_CATALOG_KEY, persisted)
    } catch {
      this.lastRefreshValue = "error"
      this.lastErrorValue = "Não foi possível persistir o novo catálogo. O catálogo anterior foi mantido."
      return this.status()
    }
    if (!this.isCurrent(revision)) return this.status()

    this.catalog = next
    this.lastRefreshValue = "success"
    this.lastErrorValue = undefined
    this.lastWarningValue = result.metadataWarning
    await this.publish()
    return this.status()
  }

  private catalogFor(endpoint: string, key: string | undefined): StoredCatalog | undefined {
    return this.catalog?.endpoint === endpoint && this.catalog.connectionKey === key
      ? this.catalog
      : undefined
  }

  private visibleModels(): StoredCatalog["models"] {
    if (!this.endpointValue || !this.authenticated) return []
    return this.catalogFor(this.endpointValue, connectionKey(this.connection))?.models ?? []
  }

  private async publish(): Promise<void> {
    // Reload replays the provider transform from this single, immutable-at-commit snapshot.
    await this.dependencies.publish()
  }

  private isCurrent(revision: number): boolean {
    return !this.disposed && revision === this.revision
  }

  private missingEndpoint(): ExpStatus {
    this.lastRefreshValue = "error"
    this.lastErrorValue ??= "Endpoint não configurado. Execute /exp-setup para informar o endpoint do gateway."
    this.lastWarningValue = undefined
    return this.status()
  }

  private rememberError(error: unknown): void {
    this.lastRefreshValue = "error"
    this.lastWarningValue = undefined
    this.lastErrorValue = error instanceof EndpointError || error instanceof SafeError
      ? error.message
      : "Não foi possível configurar o endpoint."
  }
}
