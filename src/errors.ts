export class LlmError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Resposta HTTP fora da faixa 2xx. */
export class LlmHttpError extends LlmError {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly retryAfterMs?: number,
  ) {
    super(`Falha HTTP ${status}: ${body.slice(0, 200)}`);
  }
}

export class LlmTimeoutError extends LlmError {
  constructor(readonly timeoutMs: number) {
    super(`Tempo esgotado após ${timeoutMs} ms`);
  }
}

export class LlmAbortError extends LlmError {
  constructor() {
    super('Operação cancelada');
  }
}

export class BudgetExceededError extends LlmError {
  constructor(
    readonly kind: 'tokens' | 'custo',
    readonly limit: number,
    readonly used: number,
  ) {
    super(`Orçamento de ${kind} estourado: usado ${used}, limite ${limit}`);
  }
}

export class MaxStepsError extends LlmError {
  constructor(readonly maxSteps: number) {
    super(`O modelo não terminou em ${maxSteps} passos`);
  }
}

export class StructuredOutputError extends LlmError {
  constructor(
    message: string,
    readonly attempts: number,
    readonly lastOutput: string,
  ) {
    super(message);
  }
}

export class ConfigError extends LlmError {}
