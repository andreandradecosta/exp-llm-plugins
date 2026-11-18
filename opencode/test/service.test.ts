import assert from "node:assert/strict"
import test from "node:test"
import { STORAGE_CATALOG_KEY, STORAGE_ENDPOINT_KEY } from "../src/config.ts"
import { SafeError } from "../src/errors.ts"
import type { DiscoverInput } from "../src/gateway.ts"
import { ExpService, type ExpServiceDependencies, type ServerStorage } from "../src/service.ts"
import type { CatalogModel, DiscoveryResult, GatewayConnection, GatewayCredential } from "../src/types.ts"

const secret = "sk-service-secret"
const connection: GatewayConnection = {
  type: "credential",
  id: "credential-one",
  label: "Conta de teste",
  method: "key",
}
const credential: GatewayCredential = { type: "key", key: secret }
const options = { fallbackContextTokens: 128_000, fallbackOutputTokens: 16_384, requestTimeoutMs: 100 }

function model(id: string): CatalogModel {
  return { id, created: 1000, contextTokens: 100_000, outputTokens: 8000, vision: false }
}

function discovery(...ids: string[]): DiscoveryResult {
  return { models: ids.map(model), metadataStatus: "available" }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function harness(
  discover?: (input: DiscoverInput) => Promise<DiscoveryResult>,
  storedEndpoint: string | null = "https://one.test/v1",
) {
  const values = new Map<string, unknown>()
  const storage: Pick<ServerStorage, "get" | "set"> = {
    get: async (key) => values.get(key) as Awaited<ReturnType<ServerStorage["get"]>>,
    set: async (key, value) => {
      values.set(key, structuredClone(value))
    },
  }
  if (storedEndpoint !== null) await storage.set(STORAGE_ENDPOINT_KEY, storedEndpoint)
  let activeConnection: GatewayConnection | undefined = connection
  let activeCredential: GatewayCredential | undefined = credential
  let publications = 0
  const dependencies: ExpServiceDependencies = {
    storage,
    activeConnection: async () => activeConnection,
    resolveCredential: async () => activeCredential,
    publish: async () => {
      publications++
    },
    ...(discover ? { discover } : {}),
    now: () => new Date("2026-11-13T12:00:00.000Z"),
  }
  const service = new ExpService(dependencies, options)
  await service.initialize()
  return {
    service,
    values,
    publications: () => publications,
    setConnection: (next: GatewayConnection | undefined) => {
      activeConnection = next
    },
    setCredential: (next: GatewayCredential | undefined) => {
      activeCredential = next
    },
  }
}

test("instalação limpa orienta /exp-setup sem descobrir nem publicar catálogo", async () => {
  let calls = 0
  const { service, values, publications } = await harness(async () => {
    calls++
    return discovery("never")
  }, null)

  assert.match(service.status().lastError ?? "", /\/exp-setup/)
  const status = await service.refresh()
  assert.equal(calls, 0)
  assert.equal(publications(), 0)
  assert.equal(status.configured, false)
  assert.equal(status.endpoint, null)
  assert.equal(status.lastRefresh, "error")
  assert.match(status.lastError ?? "", /\/exp-setup/)
  assert.equal(status.modelCount, 0)
  assert.equal(service.providerSnapshot(), undefined)
  assert.equal(values.has(STORAGE_ENDPOINT_KEY), false)
})

test("endpoint configurado explicitamente é persistido e reutilizado na próxima execução", async () => {
  const { service, values } = await harness(async (request) => {
    assert.equal(request.endpoint, "https://explicito.test/proxy/v1")
    return discovery("configured")
  }, null)

  const configured = await service.configure("https://explicito.test/proxy/")
  assert.equal(configured.lastRefresh, "success")
  assert.equal(values.get(STORAGE_ENDPOINT_KEY), "https://explicito.test/proxy/v1")

  const restored = new ExpService({
    storage: {
      get: async (key) => values.get(key) as Awaited<ReturnType<ServerStorage["get"]>>,
      set: async (key, value) => {
        values.set(key, structuredClone(value))
      },
    },
    activeConnection: async () => connection,
    resolveCredential: async () => credential,
    publish: async () => undefined,
    discover: async (request) => {
      assert.equal(request.endpoint, "https://explicito.test/proxy/v1")
      return discovery("restored")
    },
  }, options)
  await restored.initialize()
  assert.equal(restored.status().endpoint, "https://explicito.test/proxy/v1")

  const status = await restored.refresh()
  assert.equal(status.lastRefresh, "success")
  assert.deepEqual(restored.providerSnapshot()?.models.map((item) => item.id), ["restored"])
  assert.equal(restored.providerSnapshot()?.info.settings?.baseURL, "https://explicito.test/proxy/v1")
})

test("endpoint persistido inválido orienta nova configuração sem consultar gateway", async () => {
  let calls = 0
  const { service } = await harness(async () => {
    calls++
    return discovery("never")
  }, "endpoint-sem-esquema")

  const status = await service.refresh()
  assert.equal(calls, 0)
  assert.equal(status.configured, false)
  assert.equal(status.endpoint, null)
  assert.equal(status.lastRefresh, "error")
  assert.match(status.lastError ?? "", /endpoint persistido é inválido.*\/exp-setup/)
  assert.equal(service.providerSnapshot(), undefined)
})

test("catálogo válido é publicado como exp/<id> sem credencial no provider", async () => {
  const { service, values } = await harness(async () => discovery("alpha", "beta"))
  const status = await service.refresh()
  const snapshot = service.providerSnapshot()

  assert.equal(status.lastRefresh, "success")
  assert.equal(status.refreshing, false)
  assert.equal(status.modelCount, 2)
  assert.deepEqual(snapshot?.models.map((item) => `${item.providerID}/${item.id}`), ["exp/alpha", "exp/beta"])
  assert.equal(snapshot?.info.settings?.baseURL, "https://one.test/v1")
  assert.equal(snapshot?.info.integrationID, "exp")
  assert.equal(snapshot?.info.package, "@opencode/ai/providers/openai-compatible")
  assert.equal(snapshot?.info.compatibility, undefined)
  assert.equal(snapshot?.models.every((item) => item.capabilities.tools), true)
  assert.equal(Object.hasOwn(snapshot?.info.settings ?? {}, "apiKey"), false)
  assert.equal(JSON.stringify(snapshot).includes("Authorization"), false)

  const persisted = JSON.stringify([...values.entries()])
  assert.equal(persisted.includes(secret), false)
  assert.equal(persisted.includes("sk-service"), false)
  assert.equal(JSON.stringify(status).includes(secret), false)
})

test("visão conservadora e limites entram nas definições nativas", async () => {
  const { service } = await harness(async () => ({
    metadataStatus: "available",
    models: [
      { id: "text", created: 1, contextTokens: 100, outputTokens: 20, vision: false },
      { id: "vision", created: 1, contextTokens: 200, outputTokens: 40, vision: true },
    ],
  }))
  await service.refresh()
  const models = service.providerSnapshot()?.models ?? []
  assert.deepEqual(models.find((item) => item.id === "text")?.capabilities.input, ["text"])
  assert.deepEqual(models.find((item) => item.id === "vision")?.capabilities.input, ["text", "image"])
  assert.deepEqual(models.find((item) => item.id === "vision")?.limit, { context: 200, output: 40 })
})

test("refresh concorrente na mesma revisão compartilha uma única descoberta", async () => {
  const pending = deferred<DiscoveryResult>()
  let calls = 0
  const { service } = await harness(async () => {
    calls++
    return pending.promise
  })
  const one = service.refresh()
  const two = service.refresh()
  const three = service.refresh()
  assert.equal(one, two)
  assert.equal(two, three)
  pending.resolve(discovery("alpha"))
  await Promise.all([one, two, three])
  assert.equal(calls, 1)
})

test("mudança de endpoint enfileira sem overlap e descarta resposta stale", async () => {
  const first = deferred<DiscoveryResult>()
  const started = deferred<void>()
  let calls = 0
  let inFlight = 0
  let maximumInFlight = 0
  const { service } = await harness(async (request) => {
    calls++
    inFlight++
    maximumInFlight = Math.max(maximumInFlight, inFlight)
    try {
      if (calls === 1) {
        started.resolve()
        return await first.promise
      }
      assert.equal(request.endpoint, "https://two.test/v1")
      return discovery("new")
    } finally {
      inFlight--
    }
  })

  const old = service.refresh()
  await started.promise
  const changed = service.configure("https://two.test")
  first.resolve(discovery("old", "old-duplicate"))
  await old
  const status = await changed

  assert.equal(calls, 2)
  assert.equal(maximumInFlight, 1)
  assert.equal(status.endpoint, "https://two.test/v1")
  assert.deepEqual(service.providerSnapshot()?.models.map((item) => item.id), ["new"])
  assert.equal(service.providerSnapshot()?.models.some((item) => item.id.startsWith("old")), false)
})

test("falha após sucesso preserva último catálogo e não sobrescreve cache", async () => {
  let fail = false
  const { service, values } = await harness(async () => {
    if (fail) throw new SafeError("Falha ao consultar /models (HTTP 500).")
    return discovery("stable")
  })
  await service.refresh()
  const before = structuredClone(values.get(STORAGE_CATALOG_KEY))

  fail = true
  const status = await service.refresh()
  assert.equal(status.lastRefresh, "error")
  assert.match(status.lastError ?? "", /último catálogo válido foi mantido/)
  assert.equal(status.modelCount, 1)
  assert.deepEqual(service.providerSnapshot()?.models.map((item) => item.id), ["stable"])
  assert.deepEqual(values.get(STORAGE_CATALOG_KEY), before)
})

test("primeira falha é explícita e não publica modelos", async () => {
  const { service } = await harness(async () => {
    throw new SafeError("Falha de rede ao consultar /models.")
  })
  const status = await service.refresh()
  assert.equal(status.modelCount, 0)
  assert.equal(status.cachedModelCount, 0)
  assert.match(status.lastError ?? "", /Nenhum catálogo válido está disponível/)
})

test("credencial ausente exige /connect e não consulta gateway", async () => {
  let calls = 0
  const { service, setConnection } = await harness(async () => {
    calls++
    return discovery("never")
  })
  setConnection(undefined)
  const status = await service.refresh()
  assert.equal(calls, 0)
  assert.equal(status.authenticated, false)
  assert.match(status.lastError ?? "", /\/connect/)
})

test("troca de conexão esconde o inventário da conta anterior e preserva somente o cache", async () => {
  let connected = true
  const established = await harness(async () => {
    if (!connected) throw new SafeError("Falha de rede ao consultar /models.")
    return discovery("account-one")
  })
  await established.service.refresh()
  assert.equal(established.service.status().modelCount, 1)

  connected = false
  established.setConnection({ ...connection, id: "credential-two" })
  const switched = await established.service.connectionChanged()
  assert.equal(switched.modelCount, 0)
  assert.equal(switched.cachedModelCount, 1)
  assert.equal(JSON.stringify(switched).includes(secret), false)
})

test("cache persistido só volta para a mesma combinação endpoint/conexão autenticada", async () => {
  const { service, values } = await harness(async () => discovery("cached"))
  await service.refresh()
  assert.ok(values.has(STORAGE_CATALOG_KEY))

  const restored = new ExpService({
    storage: {
      get: async (key) => values.get(key) as Awaited<ReturnType<ServerStorage["get"]>>,
      set: async (key, value) => {
        values.set(key, structuredClone(value))
      },
    },
    activeConnection: async () => connection,
    resolveCredential: async () => credential,
    publish: async () => undefined,
    discover: async () => {
      throw new SafeError("offline")
    },
  }, options)
  await restored.initialize()
  assert.equal(restored.status().cachedModelCount, 1)
  assert.equal(restored.status().modelCount, 0)
  const status = await restored.refresh()
  assert.equal(status.modelCount, 1)
  assert.equal(status.lastRefresh, "error")
  assert.match(status.lastError ?? "", /mantido/)
})
