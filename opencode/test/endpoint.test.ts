import assert from "node:assert/strict"
import test from "node:test"
import { normalizeEndpoint } from "../src/endpoint.ts"

const cases = [
  ["http://pgeodsv1.ep.petrobras.com.br:4001", "http://pgeodsv1.ep.petrobras.com.br:4001/v1"],
  ["http://pgeodsv1.ep.petrobras.com.br:4001/", "http://pgeodsv1.ep.petrobras.com.br:4001/v1"],
  ["http://pgeodsv1.ep.petrobras.com.br:4001/v1", "http://pgeodsv1.ep.petrobras.com.br:4001/v1"],
  ["http://pgeodsv1.ep.petrobras.com.br:4001/v1///", "http://pgeodsv1.ep.petrobras.com.br:4001/v1"],
  ["https://gateway.test/gateway", "https://gateway.test/gateway/v1"],
  ["https://gateway.test/gateway/v1/", "https://gateway.test/gateway/v1"],
] as const

test("normaliza endpoint com ou sem /v1 e barras finais", () => {
  for (const [input, expected] of cases) assert.equal(normalizeEndpoint(`  ${input}  `), expected)
})

test("recusa endpoint relativo, esquema indevido e dados sensíveis na URL", () => {
  for (const input of [
    "gateway.test:4001",
    "ftp://gateway.test",
    "https://user:password@gateway.test",
    "https://gateway.test/?api_key=secret",
    "https://gateway.test/#secret",
    "",
  ]) assert.throws(() => normalizeEndpoint(input))
})
