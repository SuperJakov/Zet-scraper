import { logger } from "./logger";

export interface FetchWithRetryOptions {
  retries?: number;
  retryDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  logWarning?: boolean;
}

/**
 * Executes an HTTP fetch request with robust retries, generous backoff delays, and per-attempt timeout limits.
 */
export async function fetchWithRetry(
  url: string,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const retries = options.retries ?? 10;
  const retryDelayMs = options.retryDelayMs ?? 5000;
  const maxDelayMs = options.maxDelayMs ?? 30000;
  const timeoutMs = options.timeoutMs ?? 15000;
  const headers = options.headers;
  const logWarning = options.logWarning ?? true;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`HTTP status ${response.status} ${response.statusText}`);
      }

      return response;
    } catch (err) {
      lastError = err;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const rawDelay = retryDelayMs * Math.pow(1.3, attempt - 1);
        const delay = Math.min(maxDelayMs, Math.round(rawDelay));
        if (logWarning) {
          logger.warn(
            `[Fetch Retry] Attempt ${attempt}/${retries} failed for ${url} (${errMsg}). Retrying in ${(delay / 1000).toFixed(1)}s...`
          );
        }
        await Bun.sleep(delay);
      }
    }
  }

  throw lastError;
}
