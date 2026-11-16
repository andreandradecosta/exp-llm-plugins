import assert from "node:assert/strict"
import test from "node:test"
import { buildCatalogModels, parsePositiveTokenLimit, parseStoredCatalog } from "../src/catalog.ts"
import { readOptions } from "../src/config.ts"

const fallbacks = { fallbackContextTokens: 128_000, fallbackOutputTokens: 16_384 }

test("aceita limites numéricos e strings inteiras positivas", () => {
  assert.equal(parsePositiveTokenLimit(131_072), 131_072)
  assert.equal(parsePositiveTokenLimit("131072"), 131_072)
  assert.equal(parsePositiveTokenLimit(" 16384 "), 16_384)
  for (const value of ["12.5", 12.5, 0, -1, "", null, true, "not-a-number"]) {
    assert.equal(parsePositiveTokenLimit(value), undefined)
  }
})

test("fallbacks e timeout são configuráveis com inteiros positivos", () => {
  assert.deepEqual(readOptions({ fallbackOutputTokens: 8192 }), {
    fallbackContextTokens: 128_000,
    fallbackOutputTokens: 8192,
    requestTimeoutMs: 15_000,
  })
  assert.throws(() => readOptions({ fallbackOutputTokens: 0 }))
  assert.throws(() => readOptions({ requestTimeoutMs: "1000" }))
})

test("/models limita o catálogo e model/info só enriquece a interseção", () => {
  const models = buildCatalogModels({
    object: "list",
    data: [
      { id: "alpha", object: "model", created: 100, max_input_tokens: "200000" },
      { id: "beta", object: "model", created: 200, max_input_tokens: 300_000 },
      { id: "alpha", object: "model", created: 999, max_input_tokens: 1 },
      { id: "fallback", object: "model", created: "unknown" },
    ],
  }, {
    data: [
      { model_name: "alpha", model_info: { max_input_tokens: 1, max_output_tokens: "8192", max_tokens: 4096, supports_vision: true } },
      { model_name: "beta", model_info: { max_tokens: 4096, supports_vision: "true" } },
      { model_name: "extra-only-in-info", model_info: { max_input_tokens: 999_999, supports_vision: true } },
    ],
  }, fallbacks)

  assert.deepEqual(models.map((model) => model.id), ["alpha", "beta", "fallback"])
  assert.equal(models.find((model) => model.id === "alpha")?.contextTokens, 200_000)
  assert.equal(models.find((model) => model.id === "alpha")?.outputTokens, 8192)
  assert.equal(models.find((model) => model.id === "alpha")?.vision, true)
  assert.equal(models.find((model) => model.id === "alpha")?.created, 100_000)
  assert.equal(models.find((model) => model.id === "beta")?.contextTokens, 300_000)
  assert.equal(models.find((model) => model.id === "beta")?.outputTokens, 16_384)
  assert.equal(models.find((model) => model.id === "beta")?.vision, false)
  assert.equal(models.find((model) => model.id === "fallback")?.contextTokens, 128_000)
  assert.equal(models.find((model) => model.id === "fallback")?.outputTokens, 16_384)
  assert.equal(models.find((model) => model.id === "fallback")?.created, 0)
})

test("sem metadados, usa fallback e visão conservadora", () => {
  const [model] = buildCatalogModels({
    object: "list",
    data: [{ id: "plain", created: 1 }],
  }, { data: [] }, fallbacks)
  assert.deepEqual(model, {
    id: "plain",
    created: 1000,
    contextTokens: 128_000,
    outputTokens: 16_384,
    vision: false,
  })
})

test("resposta principal inválida não produz catálogo parcial", () => {
  assert.throws(() => buildCatalogModels({ object: "list", data: [{ id: "valid" }, { noID: true }] }, { data: [] }, fallbacks))
  assert.throws(() => buildCatalogModels({ object: "other", data: [] }, { data: [] }, fallbacks))
})

test("cache persistido é validado e devolve somente campos não sensíveis conhecidos", () => {
  const parsed = parseStoredCatalog({
    version: 1,
    endpoint: "https://gateway.test/v1/",
    connectionKey: "credential:one",
    updatedAt: "2026-11-13T00:00:00.000Z",
    metadataStatus: "unavailable",
    token: "must-not-survive",
    models: [{ id: "alpha", created: 1, contextTokens: 100, outputTokens: 20, vision: false, secret: "must-not-survive" }],
  })
  assert.ok(parsed)
  assert.equal(parsed.endpoint, "https://gateway.test/v1")
  assert.equal(JSON.stringify(parsed).includes("must-not-survive"), false)
  assert.equal(parseStoredCatalog({ ...parsed, version: 2 }), undefined)
})
