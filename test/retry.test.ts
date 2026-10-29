import { describe, expect, it, vi } from 'vitest';
import { LlmAbortError, LlmHttpError, LlmTimeoutError } from '../src/errors.js';
import { backoffDelay, defaultIsRetryable, withRetry, withTimeout } from '../src/retry.js';

const noSleep = async () => {};
const waitAbort = (signal: AbortSignal) =>
  new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('abortado'))));

describe('backoffDelay', () => {
  it('cresce exponencialmente até o teto, com jitter', () => {
    const full = { baseDelayMs: 100, maxDelayMs: 1000, random: () => 0.999 };
    expect(backoffDelay(1, full)).toBe(99);
    expect(backoffDelay(2, full)).toBe(199);
    expect(backoffDelay(10, full)).toBe(999);
    expect(backoffDelay(3, { ...full, random: () => 0 })).toBe(0);
  });
});

describe('defaultIsRetryable', () => {
  it('classifica erros', () => {
    expect(defaultIsRetryable(new LlmHttpError(429, ''))).toBe(true);
    expect(defaultIsRetryable(new LlmHttpError(503, ''))).toBe(true);
    expect(defaultIsRetryable(new LlmHttpError(400, ''))).toBe(false);
    expect(defaultIsRetryable(new LlmHttpError(401, ''))).toBe(false);
    expect(defaultIsRetryable(new LlmTimeoutError(10))).toBe(true);
    expect(defaultIsRetryable(new LlmAbortError())).toBe(false);
    expect(defaultIsRetryable(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('withRetry', () => {
  it('tenta de novo até dar certo', async () => {
    let n = 0;
    const r = await withRetry(
      async () => {
        if (++n < 3) throw new LlmHttpError(500, 'x');
        return 'ok';
      },
      { sleep: noSleep },
    );
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });

  it('desiste após maxAttempts e lança o último erro', async () => {
    const fn = vi.fn(async () => {
      throw new LlmHttpError(502, 'ruim');
    });
    await expect(withRetry(fn, { maxAttempts: 2, sleep: noSleep })).rejects.toBeInstanceOf(LlmHttpError);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('não repete erro não recuperável', async () => {
    const fn = vi.fn(async () => {
      throw new LlmHttpError(400, 'ruim');
    });
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('usa Retry-After quando maior que o backoff', async () => {
    const delays: number[] = [];
    let n = 0;
    await withRetry(
      async () => {
        if (++n < 2) throw new LlmHttpError(429, '', 800);
        return 1;
      },
      { random: () => 0, maxDelayMs: 5000, sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([800]);
  });

  it('não repete se o sinal já foi cancelado', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fn = vi.fn(async () => {
      throw new LlmHttpError(500, '');
    });
    await expect(withRetry(fn, { sleep: noSleep }, ctrl.signal)).rejects.toBeInstanceOf(LlmHttpError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withTimeout', () => {
  it('lança LlmTimeoutError quando estoura', async () => {
    await expect(withTimeout(waitAbort, 20)).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('lança LlmAbortError no cancelamento externo', async () => {
    const ctrl = new AbortController();
    const p = withTimeout(waitAbort, 5000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(LlmAbortError);
  });

  it('devolve o valor quando termina a tempo', async () => {
    expect(await withTimeout(async () => 7, 1000)).toBe(7);
  });
});
