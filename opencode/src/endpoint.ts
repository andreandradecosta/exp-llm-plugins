export class EndpointError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EndpointError"
  }
}

/** Returns the canonical OpenAI API root, including exactly one trailing /v1 segment. */
export function normalizeEndpoint(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new EndpointError("Informe o endpoint do gateway.")

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new EndpointError("Endpoint inválido. Informe uma URL absoluta com http:// ou https://.")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EndpointError("Endpoint inválido. Somente URLs http:// ou https:// são aceitas.")
  }
  if (!url.hostname) throw new EndpointError("Endpoint inválido: o host está ausente.")
  if (url.username || url.password || url.search || url.hash) {
    throw new EndpointError("Endpoint inválido. Não use credenciais, query string nem fragmento na URL.")
  }

  const path = url.pathname.replace(/\/+$/, "")
  const canonicalPath = path.endsWith("/v1") ? path : `${path}/v1`
  return `${url.origin}${canonicalPath || "/v1"}`
}
