import { LlmAbortError, LlmHttpError, LlmTimeoutError } from './errors.js';

export interface RetryOptions {
  /** Total de tentativas, contando a primeira. Padrão: 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Fonte de aleatoriedade em [0, 1). Injetável para testes. */
  random?: () => number;
  /** Espera entre tentativas. Injetável para testes. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmAbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Tenta de novo em 408, 429, 5xx, timeout e falha de rede. Cancelamento nunca. */
export function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof LlmAbortError) return false;
  if (error instanceof LlmTimeoutError) return true;
  if (error instanceof LlmHttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError; // fetch lança TypeError em falha de rede
}

/** Backoff exponencial com "full jitter": sorteia entre 0 e o teto da tentativa. */
export function backoffDelay(
  attempt: number,
  opts: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'>,
): number {
  const base = opts.baseDelayMs ?? 200;
  const max = opts.maxDelayMs ?? 5000;
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor((opts.random ?? Math.random)() * ceiling);
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryable(error) || signal?.aborted) throw error;
      let delayMs = backoffDelay(attempt, options);
      // Respeita o Retry-After do servidor quando ele manda um valor maior.
      if (error instanceof LlmHttpError && error.retryAfterMs !== undefined) {
        delayMs = Math.max(delayMs, Math.min(error.retryAfterMs, options.maxDelayMs ?? 5000));
      }
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
}

/**
 * Roda `fn` com um sinal que dispara por timeout ou por cancelamento externo.
 * Converte o motivo em LlmTimeoutError ou LlmAbortError.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  external?: AbortSignal,
): Promise<T> {
  if (external?.aborted) throw new LlmAbortError();
  const controller = new AbortController();
  let timedOut = false;
  const onExternal = () => controller.abort();
  external?.addEventListener('abort', onExternal, { once: true });
  const timer =
    timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (timedOut) throw new LlmTimeoutError(timeoutMs ?? 0);
    if (external?.aborted) throw new LlmAbortError();
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternal);
  }
}
