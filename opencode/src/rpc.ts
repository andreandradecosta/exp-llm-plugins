import { Rpc } from "@opencode/plugin/rpc"
import type { ExpStatus } from "./types.ts"

export type { ExpStatus } from "./types.ts"

const nullableString = {
  anyOf: [{ type: "string" }, { type: "null" }],
} as const

export const statusSchema = {
  type: "object",
  properties: {
    configured: { type: "boolean" },
    endpoint: nullableString,
    connected: { type: "boolean" },
    authenticated: { type: "boolean" },
    refreshing: { type: "boolean" },
    modelCount: { type: "integer", minimum: 0 },
    cachedModelCount: { type: "integer", minimum: 0 },
    catalogUpdatedAt: nullableString,
    metadataStatus: { type: "string", enum: ["unknown", "available", "unavailable"] },
    lastRefresh: { type: "string", enum: ["never", "success", "error"] },
    lastError: nullableString,
    lastWarning: nullableString,
  },
  required: [
    "configured",
    "endpoint",
    "connected",
    "authenticated",
    "refreshing",
    "modelCount",
    "cachedModelCount",
    "catalogUpdatedAt",
    "metadataStatus",
    "lastRefresh",
    "lastError",
    "lastWarning",
  ],
  additionalProperties: false,
} as const

export const ExpRpc = Rpc.define({
  id: "exp.gateway",
  methods: {
    configure: {
      input: {
        type: "object",
        properties: { endpoint: { type: "string", minLength: 1 } },
        required: ["endpoint"],
        additionalProperties: false,
      },
      output: statusSchema,
    },
    refresh: {
      input: { type: "object", additionalProperties: false },
      output: statusSchema,
    },
    status: {
      input: { type: "object", additionalProperties: false },
      output: statusSchema,
    },
  },
  events: {},
})

export function asExpStatus(value: unknown): ExpStatus {
  return value as ExpStatus
}
