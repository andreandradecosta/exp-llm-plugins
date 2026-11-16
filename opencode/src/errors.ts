import { EndpointError } from "./endpoint.ts"

export class SafeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SafeError"
  }
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof SafeError || error instanceof EndpointError
    ? error.message
    : fallback
}
