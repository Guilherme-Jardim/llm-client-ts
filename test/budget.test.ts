import { describe, expect, it } from 'vitest';
import { BudgetTracker, costOf } from '../src/budget.js';
import { BudgetExceededError } from '../src/errors.js';
import { UsageLog } from '../src/usage-log.js';

const pricing = { inputPer1k: 1, outputPer1k: 2 };

describe('BudgetTracker', () => {
  it('calcula custo por mil tokens', () => {
    expect(costOf({ inputTokens: 1000, outputTokens: 500 }, pricing)).toBe(2);
    expect(costOf({ inputTokens: 1000, outputTokens: 500 })).toBe(0);
  });

  it('acumula tokens e custo', () => {
    const b = new BudgetTracker({}, pricing);
    b.add({ inputTokens: 100, outputTokens: 50 });
    b.add({ inputTokens: 100, outputTokens: 50 });
    expect(b.tokens).toBe(300);
    expect(b.costUsd).toBeCloseTo(0.4);
  });

  it('bloqueia nova chamada ao atingir o limite de tokens', () => {
    const b = new BudgetTracker({ maxTokens: 100 });
    b.assertAvailable();
    b.add({ inputTokens: 60, outputTokens: 40 });
    expect(() => b.assertAvailable()).toThrow(BudgetExceededError);
  });

  it('acusa estouro de custo depois da resposta', () => {
    const b = new BudgetTracker({ maxCostUsd: 0.001 }, pricing);
    b.add({ inputTokens: 1000, outputTokens: 0 });
    expect(() => b.assertNotExceeded()).toThrow(/custo/);
  });

  it('não acusa quando fica exatamente no limite', () => {
    const b = new BudgetTracker({ maxTokens: 10 });
    b.add({ inputTokens: 5, outputTokens: 5 });
    expect(() => b.assertNotExceeded()).not.toThrow();
  });
});

describe('UsageLog', () => {
  it('soma o resumo e chama o callback', () => {
    const seen: number[] = [];
    const log = new UsageLog((e) => seen.push(e.inputTokens));
    log.record({ at: new Date(), provider: 'mock', inputTokens: 10, outputTokens: 5, costUsd: 0.1 });
    log.record({ at: new Date(), provider: 'mock', inputTokens: 20, outputTokens: 5, costUsd: 0.2 });
    expect(log.summary()).toMatchObject({ calls: 2, totalTokens: 40 });
    expect(log.summary().costUsd).toBeCloseTo(0.3);
    expect(seen).toEqual([10, 20]);
    log.clear();
    expect(log.entries).toHaveLength(0);
  });
});
