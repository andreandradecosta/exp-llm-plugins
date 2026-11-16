import type { Plugin } from "@opencode/plugin"

type IntegrationConnection = Plugin.Context["integration"]["connection"]

export type GatewayConnection = NonNullable<Awaited<ReturnType<IntegrationConnection["active"]>>>
export type GatewayCredential = Awaited<ReturnType<IntegrationConnection["resolve"]>>

export type MetadataStatus = "unknown" | "available" | "unavailable"
export type RefreshStatus = "never" | "success" | "error"

export interface CatalogModel {
  readonly id: string
  readonly created: number
  readonly contextTokens: number
  readonly outputTokens: number
  readonly vision: boolean
}

export interface StoredCatalog {
  readonly version: 1
  readonly endpoint: string
  readonly connectionKey: string
  readonly updatedAt: string
  readonly metadataStatus: Exclude<MetadataStatus, "unknown">
  readonly models: readonly CatalogModel[]
}

export interface DiscoveryResult {
  readonly models: readonly CatalogModel[]
  readonly metadataStatus: Exclude<MetadataStatus, "unknown">
  readonly metadataWarning?: string
}

export interface ExpStatus {
  readonly configured: boolean
  readonly endpoint: string | null
  readonly connected: boolean
  readonly authenticated: boolean
  readonly refreshing: boolean
  readonly modelCount: number
  readonly cachedModelCount: number
  readonly catalogUpdatedAt: string | null
  readonly metadataStatus: MetadataStatus
  readonly lastRefresh: RefreshStatus
  readonly lastError: string | null
  readonly lastWarning: string | null
}

export function connectionKey(connection: GatewayConnection | undefined): string | undefined {
  if (!connection) return undefined
  return connection.type === "credential" ? `credential:${connection.id}` : `env:${connection.name}`
}

export function bearerToken(credential: GatewayCredential | undefined): string | undefined {
  if (credential?.type === "key") return nonEmpty(credential.key)
  if (credential?.type === "oauth") return nonEmpty(credential.access)
  return undefined
}

function nonEmpty(value: string): string | undefined {
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}
