import { z } from 'zod';
import { BudgetTracker, costOf, type BudgetLimits, type Pricing } from './budget.js';
import { LlmAbortError, LlmTimeoutError, MaxStepsError, StructuredOutputError } from './errors.js';
import { estimateTokens } from './mock.js';
import { withRetry, withTimeout, type RetryOptions } from './retry.js';
import { extractJson } from './structured.js';
import { executeToolCall, toToolSpec, type ExecutedToolCall, type Tool } from './tools.js';
import type { ChatRequest, ChatResponse, LlmProvider, Message, StreamChunk, Usage } from './types.js';
import { UsageLog, type UsageEntry } from './usage-log.js';

export interface ClientOptions {
  provider: LlmProvider;
  model?: string;
  retry?: RetryOptions;
  /** Limite por tentativa de chamada ao provedor (no streaming, tempo ocioso entre pedaços). */
  timeoutMs?: number;
  pricing?: Pricing;
  /** Orçamento padrão de cada execução. Pode ser trocado em cada chamada. */
  budget?: BudgetLimits;
  onUsage?: (entry: UsageEntry) => void;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  budget?: BudgetLimits;
}

export type Input = string | Message[];

export interface RunSummary {
  tokens: number;
  costUsd: number;
}

export interface ToolRunResult {
  text: string;
  /** Quantas chamadas ao modelo foram feitas. */
  steps: number;
  messages: Message[];
  toolCalls: ExecutedToolCall[];
  usage: RunSummary;
}

export interface StructuredResult<T> {
  data: T;
  /** Tentativas até o JSON valer, contando a primeira. */
  attempts: number;
  usage: RunSummary;
}

function toMessages(input: Input): Message[] {
  return typeof input === 'string' ? [{ role: 'user', content: input }] : [...input];
}

export class LlmClient {
  readonly usage: UsageLog;

  constructor(private readonly options: ClientOptions) {
    this.usage = new UsageLog(options.onUsage);
  }

  private tracker(call: CallOptions): BudgetTracker {
    return new BudgetTracker(call.budget ?? this.options.budget, this.options.pricing);
  }

  private request(messages: Message[], call: CallOptions, extra: Partial<ChatRequest> = {}): ChatRequest {
    return {
      messages,
      model: call.model ?? this.options.model,
      temperature: call.temperature,
      maxTokens: call.maxTokens,
      ...extra,
    };
  }

  private record(usage: Usage, label: string, model: string | undefined, tracker: BudgetTracker): void {
    tracker.add(usage);
    this.usage.record({
      at: new Date(),
      provider: this.options.provider.name,
      model,
      label,
      ...usage,
      costUsd: costOf(usage, this.options.pricing),
    });
    tracker.assertNotExceeded();
  }

  /** Uma chamada ao provedor, com orçamento, retry, timeout e registro de uso. */
  private async call(
    request: ChatRequest,
    call: CallOptions,
    tracker: BudgetTracker,
    label: string,
  ): Promise<ChatResponse> {
    tracker.assertAvailable();
    const timeoutMs = call.timeoutMs ?? this.options.timeoutMs;
    const response = await withRetry(
      () => withTimeout((signal) => this.options.provider.chat({ ...request, signal }), timeoutMs, call.signal),
      this.options.retry,
      call.signal,
    );
    this.record(response.usage, label, response.model ?? request.model, tracker);
    return response;
  }

  async chat(input: Input, call: CallOptions = {}): Promise<ChatResponse> {
    return this.call(this.request(toMessages(input), call), call, this.tracker(call), 'chat');
  }

  /** Streaming por AsyncIterable. Retry só vale até o primeiro pedaço chegar. */
  async *stream(input: Input, call: CallOptions = {}): AsyncIterable<StreamChunk> {
    const tracker = this.tracker(call);
    tracker.assertAvailable();
    const messages = toMessages(input);
    const provider = this.options.provider;
    const idleMs = call.timeoutMs ?? this.options.timeoutMs;
    let controller = new AbortController();
    const onExternal = () => controller.abort();
    call.signal?.addEventListener('abort', onExternal);

    const next = async (it: AsyncIterator<StreamChunk>): Promise<IteratorResult<StreamChunk>> => {
      if (call.signal?.aborted) throw new LlmAbortError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        if (!idleMs) return;
        timer = setTimeout(() => {
          controller.abort();
          reject(new LlmTimeoutError(idleMs));
        }, idleMs);
      });
      try {
        return await Promise.race([it.next(), idle]);
      } catch (error) {
        if (call.signal?.aborted) throw new LlmAbortError();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    };

    const open = async () => {
      controller = new AbortController();
      if (call.signal?.aborted) controller.abort();
      const req = this.request(messages, call, { signal: controller.signal });
      const source: AsyncIterable<StreamChunk> = provider.stream
        ? provider.stream(req)
        : (async function* () {
            const r = await provider.chat(req);
            yield { delta: r.message.content };
            yield { delta: '', done: true, usage: r.usage, toolCalls: r.message.toolCalls };
          })();
      const it = source[Symbol.asyncIterator]();
      return { it, first: await next(it) };
    };

    try {
      const { it, first } = await withRetry(open, this.options.retry, call.signal);
      let text = '';
      let finalUsage: Usage | undefined;
      for (let r = first; !r.done; r = await next(it)) {
        text += r.value.delta;
        if (r.value.usage) finalUsage = r.value.usage;
        yield r.value;
      }
      const usage = finalUsage ?? {
        inputTokens: estimateTokens(messages.map((m) => m.content).join('\n')),
        outputTokens: estimateTokens(text),
      };
      this.record(usage, 'stream', call.model ?? this.options.model, tracker);
    } finally {
      call.signal?.removeEventListener('abort', onExternal);
      controller.abort();
    }
  }

  /** Loop de ferramentas: o modelo pede, o código executa, até uma resposta final ou o limite de passos. */
  async runTools(
    input: Input,
    tools: Tool[],
    call: CallOptions & { maxSteps?: number } = {},
  ): Promise<ToolRunResult> {
    const maxSteps = call.maxSteps ?? 8;
    const tracker = this.tracker(call);
    const registry = new Map(tools.map((t) => [t.name, t]));
    const specs = tools.map(toToolSpec);
    const messages = toMessages(input);
    const executed: ExecutedToolCall[] = [];

    for (let step = 1; step <= maxSteps; step++) {
      const response = await this.call(this.request(messages, call, { tools: specs }), call, tracker, 'tools');
      messages.push(response.message);
      const calls = response.message.toolCalls ?? [];
      if (calls.length === 0) {
        return {
          text: response.message.content,
          steps: step,
          messages,
          toolCalls: executed,
          usage: { tokens: tracker.tokens, costUsd: tracker.costUsd },
        };
      }
      if (step === maxSteps) break;
      for (const c of calls) {
        const result = await executeToolCall(c, registry, { signal: call.signal });
        executed.push(result);
        messages.push({ role: 'tool', content: result.output, toolCallId: c.id });
      }
    }
    throw new MaxStepsError(maxSteps);
  }

  /** Pede JSON, valida com Zod e, se falhar, devolve o erro ao modelo para corrigir. */
  async structured<S extends z.ZodType>(
    input: Input,
    schema: S,
    call: CallOptions & { maxRepairs?: number } = {},
  ): Promise<StructuredResult<z.infer<S>>> {
    const maxRepairs = call.maxRepairs ?? 2;
    const tracker = this.tracker(call);
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    const messages: Message[] = [
      { role: 'system', content: `Responda somente com JSON válido que siga este JSON Schema, sem texto extra: ${jsonSchema}` },
      ...toMessages(input),
    ];

    let lastOutput = '';
    let lastProblem = '';
    for (let attempt = 1; attempt <= maxRepairs + 1; attempt++) {
      const response = await this.call(this.request(messages, call, { jsonMode: true }), call, tracker, 'structured');
      lastOutput = response.message.content;
      try {
        const parsed = schema.safeParse(extractJson(lastOutput));
        if (parsed.success) {
          return { data: parsed.data, attempts: attempt, usage: { tokens: tracker.tokens, costUsd: tracker.costUsd } };
        }
        lastProblem = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
      } catch {
        lastProblem = 'a resposta não é JSON válido';
      }
      messages.push(response.message, {
        role: 'user',
        content: `Sua resposta anterior foi recusada: ${lastProblem}. Responda de novo apenas com o JSON corrigido.`,
      });
    }
    throw new StructuredOutputError(
      `Saída fora do schema após ${maxRepairs + 1} tentativas: ${lastProblem}`,
      maxRepairs + 1,
      lastOutput,
    );
  }
}
