import assert from "node:assert/strict"
import test from "node:test"
import { discoverGateway, type DiscoverInput } from "../src/gateway.ts"
import { SafeError } from "../src/errors.ts"

const secret = "sk-test-never-persist"
const endpoint = "https://gateway.test/v1"
const options = {
  endpoint,
  token: secret,
  timeoutMs: 100,
  fallbackContextTokens: 128_000,
  fallbackOutputTokens: 16_384,
} as const

function input(fetchImplementation: typeof fetch, overrides: Partial<DiscoverInput> = {}): DiscoverInput {
  return { ...options, ...overrides, fetchImplementation }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch
}

test("contrato HTTP usa /v1/models, /v1/model/info e Bearer sem inferência", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const fetchImplementation = mockFetch((url, init) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") })
    if (url.endsWith("/models")) return json({
      object: "list",
      data: [{ id: "alpha", object: "model", created: 100, owned_by: "test", max_input_tokens: "200000" }],
    })
    if (url.endsWith("/model/info")) return json({
      data: [{ model_name: "alpha", model_info: { max_output_tokens: 9000, supports_vision: true } }],
    })
    throw new Error("unexpected")
  })

  const result = await discoverGateway(input(fetchImplementation))
  assert.deepEqual(calls, [
    { url: "https://gateway.test/v1/models", authorization: `Bearer ${secret}` },
    { url: "https://gateway.test/v1/model/info", authorization: `Bearer ${secret}` },
  ])
  assert.equal(result.models[0]?.outputTokens, 9000)
  assert.equal(result.models[0]?.vision, true)
  assert.equal(result.metadataStatus, "available")
})

test("falha 401 de model/info não bloqueia e orienta autenticação", async () => {
  const fetchImplementation = mockFetch((url) => url.endsWith("/models")
    ? json({ object: "list", data: [{ id: "alpha", created: 1 }] })
    : json({ error: "ignored sensitive body" }, 401))

  const result = await discoverGateway(input(fetchImplementation))
  assert.equal(result.models.length, 1)
  assert.equal(result.models[0]?.outputTokens, 16_384)
  assert.equal(result.models[0]?.vision, false)
  assert.equal(result.metadataStatus, "unavailable")
  assert.match(result.metadataWarning ?? "", /\/connect/)
  assert.equal(JSON.stringify(result).includes("ignored sensitive body"), false)
})

test("model/info malformado também conserva o catálogo básico", async () => {
  const fetchImplementation = mockFetch((url) => url.endsWith("/models")
    ? json({ object: "list", data: [{ id: "alpha", created: 1 }] })
    : json({ invalid: true }))
  const result = await discoverGateway(input(fetchImplementation))
  assert.equal(result.metadataStatus, "unavailable")
  assert.equal(result.models.length, 1)
})

test("erro principal e erro de rede nunca incluem token ou corpo sensível", async () => {
  await assert.rejects(discoverGateway(input(mockFetch(() => json({ token: secret }, 403)))), (error) => {
    assert.ok(error instanceof SafeError)
    assert.match(error.message, /\/connect/)
    assert.equal(error.message.includes(secret), false)
    return true
  })

  await assert.rejects(discoverGateway(input(mockFetch(() => {
    throw new Error(`Authorization Bearer ${secret}`)
  }))), (error) => {
    assert.ok(error instanceof SafeError)
    assert.match(error.message, /Falha de rede/)
    assert.equal(error.message.includes(secret), false)
    return true
  })
})

test("cada requisição tem timeout protegido contra descoberta pendente", async () => {
  const fetchImplementation = mockFetch((_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  }))
  await assert.rejects(discoverGateway(input(fetchImplementation, { timeoutMs: 5 })), /Tempo esgotado/)
})

test("timeout continua ativo enquanto o corpo JSON é lido", async () => {
  const fetchImplementation = mockFetch((_url, init) => ({
    status: 200,
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
    }),
  } as Response))
  await assert.rejects(discoverGateway(input(fetchImplementation, { timeoutMs: 5 })), /Tempo esgotado/)
})
