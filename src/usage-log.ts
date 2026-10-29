import type { Usage } from './types.js';

export interface UsageEntry extends Usage {
  at: Date;
  provider: string;
  model?: string;
  costUsd: number;
  /** Rótulo da execução (ex.: "tools", "structured", "chat"). */
  label?: string;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Registro em memória de cada chamada ao provedor. */
export class UsageLog {
  private readonly items: UsageEntry[] = [];

  constructor(private readonly onEntry?: (entry: UsageEntry) => void) {}

  record(entry: UsageEntry): void {
    this.items.push(entry);
    this.onEntry?.(entry);
  }

  get entries(): readonly UsageEntry[] {
    return this.items;
  }

  summary(): UsageSummary {
    const s: UsageSummary = { calls: this.items.length, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    for (const e of this.items) {
      s.inputTokens += e.inputTokens;
      s.outputTokens += e.outputTokens;
      s.costUsd += e.costUsd;
    }
    s.totalTokens = s.inputTokens + s.outputTokens;
    return s;
  }

  clear(): void {
    this.items.length = 0;
  }
}
