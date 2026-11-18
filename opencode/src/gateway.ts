import { buildCatalogModels, type TokenFallbacks } from "./catalog.ts"
import { SafeError } from "./errors.ts"
import type { DiscoveryResult } from "./types.ts"

export interface DiscoverInput extends TokenFallbacks {
  readonly endpoint: string
  readonly token: string
  readonly timeoutMs: number
  readonly fetchImplementation?: typeof fetch
}

export async function discoverGateway(input: DiscoverInput): Promise<DiscoveryResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch

  const [modelsResponse, infoResponse] = await Promise.allSettled([
    getJson(input, "/models", fetchImplementation),
    getJson(input, "/model/info", fetchImplementation),
  ])

  if (modelsResponse.status === "rejected") throw modelsResponse.reason

  // Parsing is deliberately performed only after the authoritative request succeeds.
  let models
  try {
    models = buildCatalogModels(modelsResponse.value, { data: [] }, input)
  } catch {
    throw new SafeError("Resposta inválida de /models. Nenhum catálogo novo foi aplicado.")
  }

  if (infoResponse.status === "rejected") {
    const message = infoResponse.reason instanceof SafeError
      ? infoResponse.reason.message
      : "Metadados opcionais indisponíveis em /model/info."
    return {
      models,
      metadataStatus: "unavailable",
      metadataWarning: `${message} O catálogo básico de /models foi aplicado.`,
    }
  }

  let enriched
  try {
    enriched = buildCatalogModels(modelsResponse.value, infoResponse.value, input)
  } catch {
    return {
      models,
      metadataStatus: "unavailable",
      metadataWarning: "Metadados opcionais indisponíveis em /model/info. O catálogo básico de /models foi aplicado.",
    }
  }

  return {
    models: enriched,
    metadataStatus: "available",
  }
}

async function getJson(
  input: DiscoverInput,
  path: "/models" | "/model/info",
  fetchImplementation: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, input.timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchImplementation(`${input.endpoint}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.token}`,
        },
        redirect: "error",
        signal: controller.signal,
      })
    } catch {
      throw new SafeError(
        timedOut
          ? `Tempo esgotado ao consultar ${path}.`
          : `Falha de rede ao consultar ${path}.`,
      )
    }

    if (response.status === 401 || response.status === 403) {
      throw new SafeError(
        `Autenticação recusada (HTTP ${response.status}) em ${path}. Execute /connect, selecione exp e informe um token válido.`,
      )
    }
    if (!response.ok) {
      throw new SafeError(`Falha ao consultar ${path} (HTTP ${response.status}).`)
    }

    try {
      return await response.json()
    } catch {
      throw new SafeError(
        timedOut
          ? `Tempo esgotado ao consultar ${path}.`
          : `Resposta não JSON recebida de ${path}.`,
      )
    }
  } finally {
    clearTimeout(timer)
  }
}
