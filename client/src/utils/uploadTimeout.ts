export type FetchImplementation = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Abort a fetch and reject even if a custom fetcher ignores AbortSignal. */
export function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
  fetcher: FetchImplementation = fetch,
): Promise<Response> {
  const boundedTimeoutMs = Math.max(1, timeoutMs);
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Request timed out after ${boundedTimeoutMs}ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, boundedTimeoutMs);
  });
  const request = Promise.resolve().then(() => fetcher(input, { ...init, signal: controller.signal }));
  return Promise.race([request, timedOut]).finally(() => {
    if (timeout !== undefined) clearTimeout(timeout);
  });
}
