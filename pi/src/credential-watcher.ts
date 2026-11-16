import { watch as nodeWatch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { errorMessage } from "./errors.ts";
import type { ExpRefreshResult } from "./provider.ts";

export type AuthWatchListener = (eventType: string, filename: string | Buffer | null) => void;
export type AuthWatchFunction = (directory: string, listener: AuthWatchListener) => FSWatcher;

export interface ExpCredentialWatchOptions {
  authPath: string;
  refresh: (signal: AbortSignal) => Promise<ExpRefreshResult>;
  publish: () => void;
  onError: (message: string) => void;
  watch?: AuthWatchFunction | null;
  debounceMs?: number;
}

export const AUTH_REFRESH_DEBOUNCE_MS = 100;

/**
 * Watches the agent directory, rather than the auth file inode, so native
 * login/logout writes that create or rename auth.json are observed as well.
 * The returned disposer owns every watcher, timer and in-flight refresh.
 */
export function watchExpCredentialChanges(options: ExpCredentialWatchOptions): () => void {
  let closed = false;
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let refreshPromise: Promise<void> | undefined;
  let activeController: AbortController | undefined;
  let queued = false;
  const watchedFilename = basename(options.authPath);
  const watchImpl = options.watch === undefined ? nodeWatch : options.watch;

  const clearDebounce = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    queued = false;
    clearDebounce();
    watcher?.close();
    watcher = undefined;
    activeController?.abort(new Error("EXP session ended"));
    activeController = undefined;
  };

  const run = async (): Promise<void> => {
    if (closed) return;
    if (refreshPromise) {
      queued = true;
      return refreshPromise;
    }

    const operation = (async () => {
      do {
        queued = false;
        const controller = new AbortController();
        activeController = controller;
        let result: ExpRefreshResult;
        try {
          result = await options.refresh(controller.signal);
          if (closed || controller.signal.aborted) break;
          options.publish();
        } catch (error) {
          if (!closed && !controller.signal.aborted) {
            options.onError(`EXP credential refresh failed: ${errorMessage(error)}`);
          }
          break;
        } finally {
          if (activeController === controller) activeController = undefined;
        }
        if (result.error) {
          options.onError(`EXP credential refresh failed: ${errorMessage(result.error)}`);
        }
      } while (queued && !closed);
    })();

    refreshPromise = operation;
    try {
      await operation;
    } finally {
      if (refreshPromise === operation) refreshPromise = undefined;
    }
  };

  const schedule = (): void => {
    if (closed) return;
    clearDebounce();
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, options.debounceMs ?? AUTH_REFRESH_DEBOUNCE_MS);
    timer.unref();
  };

  if (!watchImpl) return close;

  try {
    watcher = watchImpl(dirname(options.authPath), (_eventType, filename) => {
      if (filename !== null && filename.toString() !== watchedFilename) return;
      schedule();
    });
    watcher.on("error", close);
    watcher.unref();
  } catch {
    // A missing directory/auth file or unsupported fs.watch disables only live
    // updates. Startup discovery and native refreshModels remain available.
    close();
  }

  return close;
}
