import assert from "node:assert/strict"
import test from "node:test"
import { ExpRpc, type ExpStatus } from "../src/rpc.ts"
import tuiPlugin from "../src/tui.ts"

type TuiContext = Parameters<typeof tuiPlugin.setup>[0]

const refreshed: ExpStatus = {
  configured: true,
  endpoint: "https://gateway.test/v1",
  connected: true,
  authenticated: true,
  refreshing: false,
  modelCount: 2,
  cachedModelCount: 2,
  catalogUpdatedAt: "2026-11-23T12:00:00.000Z",
  metadataStatus: "available",
  lastRefresh: "success",
  lastError: null,
  lastWarning: null,
}

test("abertura do TUI invalida e sincroniza o catálogo atualizado pelo server", { timeout: 1000 }, async () => {
  const location = { directory: "/tmp/opencode/tui-refresh" }
  const operations: string[] = []
  let complete!: () => void
  const synchronized = new Promise<void>((resolve) => {
    complete = resolve
  })

  const collection = (name: string) => ({
    invalidate: (actual: unknown) => {
      assert.deepEqual(actual, location)
      operations.push(`${name}:invalidate`)
    },
    sync: async (actual: unknown) => {
      assert.deepEqual(actual, location)
      operations.push(`${name}:sync`)
      if (name === "integration") complete()
    },
  })
  const context = {
    location,
    client: {
      rpc: (definition: unknown) => {
        assert.equal(definition, ExpRpc)
        return {
          refresh: async () => {
            operations.push("rpc:refresh")
            return refreshed
          },
        }
      },
    },
    data: {
      location: {
        default: () => location,
        model: collection("model"),
        provider: collection("provider"),
        integration: collection("integration"),
      },
    },
    keymap: {
      layer: (factory: () => unknown) => {
        factory()
      },
    },
    ui: { toast: { show: () => undefined } },
  } as unknown as TuiContext

  await tuiPlugin.setup(context)
  await synchronized

  assert.deepEqual(operations, [
    "rpc:refresh",
    "model:invalidate",
    "provider:invalidate",
    "integration:invalidate",
    "model:sync",
    "provider:sync",
    "integration:sync",
  ])
})
