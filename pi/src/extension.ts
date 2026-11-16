import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai/compat";
import { LOGIN_INSTRUCTIONS, apiKeyFromCredential } from "./auth.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, PROVIDER_ID } from "./constants.ts";
import { normalizeBaseUrl } from "./endpoint.ts";
import { errorMessage } from "./errors.ts";
import { positiveInteger } from "./config.ts";
import {
  createDefaultExpIntegration,
  type ExpIntegration,
} from "./provider.ts";
import { watchExpCredentialChanges, type AuthWatchFunction } from "./credential-watcher.ts";

export interface ExpExtensionOptions {
  authPath?: string;
  watch?: AuthWatchFunction | null;
  debounceMs?: number;
}

export function createExpExtension(
  integration: ExpIntegration,
  options: ExpExtensionOptions = {},
): (pi: ExtensionAPI) => Promise<void> {
  return async function expExtension(pi: ExtensionAPI): Promise<void> {
    const startup = await integration.refresh();

    // Registration happens before the awaited factory returns, including when
    // startup used the fallback catalog. No default model is selected here.
    pi.registerProvider(integration.provider);
    registerConfigureCommand(pi, integration);

    let stopCredentialWatch: (() => void) | undefined;
    pi.on("session_start", (_event, ctx) => {
      stopCredentialWatch?.();
      stopCredentialWatch = undefined;
      if (!ctx.hasUI) return;

      stopCredentialWatch = watchExpCredentialChanges({
        authPath: options.authPath ?? join(getAgentDir(), "auth.json"),
        ...(options.watch !== undefined ? { watch: options.watch } : {}),
        ...(options.debounceMs !== undefined ? { debounceMs: options.debounceMs } : {}),
        refresh: (signal) => integration.refresh(signal),
        publish: () => pi.registerProvider(integration.provider),
        onError: (message) => ctx.ui.notify(message, "warning"),
      });
    });
    pi.on("session_shutdown", () => {
      stopCredentialWatch?.();
      stopCredentialWatch = undefined;
    });

    if (startup.error) {
      // Discovery errors contain status/URL metadata only, never response
      // bodies, credentials, or request headers. This also makes list-models
      // and other non-interactive startup failures visible.
      console.error(`[exp] ${errorMessage(startup.error)}`);
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.notify(`EXP catalog refresh failed: ${errorMessage(startup.error)}`, "warning");
      });
    }
  };
}

function registerConfigureCommand(pi: ExtensionAPI, integration: ExpIntegration): void {
  pi.registerCommand("exp-configure", {
    description: "Configure the global EXP endpoint, then use native /login for the token",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Use /exp-configure in interactive Pi; do not put tokens in commands or files.", "warning");
        return;
      }

      const current = await integration.configStore.read();
      const endpointInput = await ctx.ui.input(
        "EXP gateway base URL (with or without /v1)",
        current.baseUrl ?? "https://gateway.example.com/v1",
      );
      if (endpointInput === undefined) return;

      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(endpointInput);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      const maxInput = await ctx.ui.input(
        "Default max output tokens (blank keeps the current/default value)",
        String(current.defaultMaxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
      );
      if (maxInput === undefined) return;
      const defaultMaxTokens = maxInput.trim()
        ? positiveInteger(maxInput, 0)
        : current.defaultMaxTokens;
      if (defaultMaxTokens === 0) {
        ctx.ui.notify("Max output tokens must be a positive integer", "error");
        return;
      }

      try {
        await integration.configStore.write({ ...current, baseUrl, defaultMaxTokens });
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
        return;
      }

      const refreshed = await integration.refresh(ctx.signal);
      pi.registerProvider(integration.provider);
      if (refreshed.error) {
        ctx.ui.notify(`Endpoint saved; catalog refresh failed: ${errorMessage(refreshed.error)}`, "warning");
      } else if (refreshed.attempted) {
        ctx.ui.notify(`EXP configured: ${integration.provider.getModels().length} models available`, "info");
        return;
      }

      // Native /login stores the token securely. The interactive session's
      // auth watcher discovers newly saved, replaced or removed credentials.
      ctx.ui.notify(
        `Endpoint saved. ${LOGIN_INSTRUCTIONS} The catalog refreshes automatically after login.`,
        "info",
      );
    },
  });
}

export async function readNativeExpCredential(): Promise<Credential | undefined> {
  return readStoredCredential(PROVIDER_ID);
}

export function hasNativeExpCredential(credential: Awaited<ReturnType<typeof readNativeExpCredential>>): boolean {
  return apiKeyFromCredential(credential) !== undefined;
}

export type { ExtensionCommandContext };

export default createExpExtension(createDefaultExpIntegration(readNativeExpCredential));
