import type { ApiKeyAuth, Credential } from "@earendil-works/pi-ai/compat";
import type { ExpConfigStore } from "./config.ts";
import { PROVIDER_ID } from "./constants.ts";
import { resolveExpBaseUrl } from "./endpoint.ts";

export function createExpAuth(configStore: ExpConfigStore): ApiKeyAuth {
  return {
    name: "EXP gateway token",
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = await interaction.prompt({
        type: "secret",
        message: "Enter the EXP gateway token (stored by Pi, never shown)",
      });
      interaction.signal.throwIfAborted();
      if (!key.trim()) throw new Error("EXP token cannot be empty");
      return { type: "api_key", key };
    },
    check: async ({ credential, signal }) => {
      signal.throwIfAborted();
      return credential?.key?.trim()
        ? { type: "api_key", source: "Pi stored credential" }
        : undefined;
    },
    resolve: async ({ credential, signal }) => {
      signal.throwIfAborted();
      if (!credential?.key?.trim()) return undefined;
      const config = await configStore.read();
      signal.throwIfAborted();
      return {
        auth: {
          apiKey: credential.key,
          baseUrl: resolveExpBaseUrl(config),
        },
        source: "Pi stored credential",
      };
    },
  };
}

export function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
  return credential?.type === "api_key" && credential.key?.trim() ? credential.key : undefined;
}

export const LOGIN_INSTRUCTIONS = `Run /login, choose "${PROVIDER_ID}", and enter the gateway token in the secret prompt.`;
