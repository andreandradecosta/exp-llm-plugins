export class ExpConfigError extends Error {
  override readonly name = "ExpConfigError";
}

export class ExpDiscoveryError extends Error {
  override readonly name = "ExpDiscoveryError";

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown EXP provider error";
}
