import { Plugin } from "@opencode/plugin"
import { INTEGRATION_ID, readOptions } from "./config.ts"
import { ExpRpc } from "./rpc.ts"
import { ExpService } from "./service.ts"

export default Plugin.define({
  id: "exp.gateway",
  async setup(ctx) {
    const service = new ExpService({
      storage: ctx.storage,
      environment: process.env,
      activeConnection: (integrationID) => ctx.integration.connection.active(integrationID),
      resolveCredential: (connection) => ctx.integration.connection.resolve(connection),
      publish: () => ctx.provider.reload(),
    }, readOptions(ctx.options))

    await service.initialize()

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: INTEGRATION_ID,
        method: { type: "key", label: "Token do gateway" },
      })
      editor.update(INTEGRATION_ID, (integration) => {
        integration.name = "Gateway experimental (exp)"
      })
    })

    await ctx.provider.transform((editor) => {
      const snapshot = service.providerSnapshot()
      if (snapshot) editor.add(snapshot)
    })

    await ctx.rpc.register(ExpRpc, {
      configure: async (input) => {
        const endpoint = typeof input === "object" && input !== null && "endpoint" in input
          ? (input as { endpoint?: unknown }).endpoint
          : undefined
        return service.configure(typeof endpoint === "string" ? endpoint : "")
      },
      refresh: () => service.refresh(),
      status: async () => service.status(),
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["credential.updated", "credential.switched"],
          signal: controller.signal,
        })) {
          if (event.data.integrationID !== INTEGRATION_ID) continue
          await service.connectionChanged().catch(() => undefined)
        }
      } catch {
        // Abort is the normal shutdown path; event stream failures remain non-fatal.
      }
    })()

    await service.refresh()

    return () => {
      controller.abort()
      service.dispose()
    }
  },
})
