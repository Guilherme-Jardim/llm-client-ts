import { BudgetExceededError } from './errors.js';
import type { Usage } from './types.js';

export interface Pricing {
  /** Dólares por mil tokens de entrada. */
  inputPer1k: number;
  /** Dólares por mil tokens de saída. */
  outputPer1k: number;
}

export interface BudgetLimits {
  maxTokens?: number;
  maxCostUsd?: number;
}

export function costOf(usage: Usage, pricing?: Pricing): number {
  if (!pricing) return 0;
  return (usage.inputTokens / 1000) * pricing.inputPer1k + (usage.outputTokens / 1000) * pricing.outputPer1k;
}

/** Acumula o gasto de uma execução e avisa quando passa do limite. */
export class BudgetTracker {
  tokens = 0;
  costUsd = 0;

  constructor(
    private readonly limits: BudgetLimits = {},
    private readonly pricing?: Pricing,
  ) {}

  add(usage: Usage): void {
    this.tokens += usage.inputTokens + usage.outputTokens;
    this.costUsd += costOf(usage, this.pricing);
  }

  /** Lança se o limite já foi atingido. Chamado antes de cada nova chamada. */
  assertAvailable(): void {
    const { maxTokens, maxCostUsd } = this.limits;
    if (maxTokens !== undefined && this.tokens >= maxTokens) {
      throw new BudgetExceededError('tokens', maxTokens, this.tokens);
    }
    if (maxCostUsd !== undefined && this.costUsd >= maxCostUsd) {
      throw new BudgetExceededError('custo', maxCostUsd, this.costUsd);
    }
  }

  /** Lança se o gasto já passou do limite. Chamado depois de cada resposta. */
  assertNotExceeded(): void {
    const { maxTokens, maxCostUsd } = this.limits;
    if (maxTokens !== undefined && this.tokens > maxTokens) {
      throw new BudgetExceededError('tokens', maxTokens, this.tokens);
    }
    if (maxCostUsd !== undefined && this.costUsd > maxCostUsd) {
      throw new BudgetExceededError('custo', maxCostUsd, this.costUsd);
    }
  }
}
