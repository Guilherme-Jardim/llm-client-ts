import { LlmAbortError } from './errors.js';
import type {
  ChatRequest,
  ChatResponse,
  LlmProvider,
  Message,
  StreamChunk,
  ToolCall,
  Usage,
} from './types.js';

/** O que um passo do roteiro pode ser: texto, resposta parcial, erro ou função. */
export type MockStep =
  | string
  | { content?: string; toolCalls?: ToolCall[]; usage?: Usage; delayMs?: number }
  | Error
  | ((request: ChatRequest) => MockStep);

export interface MockOptions {
  /** Respostas entregues em ordem, uma por chamada. Acabou o roteiro: usa o eco. */
  script?: MockStep[];
  /** Atraso artificial por chamada, útil para testar timeout e cancelamento. */
  delayMs?: number;
  /** Quantos caracteres por pedaço no streaming. Padrão: 4. */
  chunkSize?: number;
}

/** Aproximação grosseira e estável: 1 token a cada 4 caracteres. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new LlmAbortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Provedor determinístico: mesma entrada, mesma saída, sem rede e sem chave. */
export class MockProvider implements LlmProvider {
  readonly name = 'mock';
  /** Todas as requisições recebidas, na ordem. */
  readonly calls: ChatRequest[] = [];
  private cursor = 0;

  constructor(private readonly options: MockOptions = {}) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.calls.push(request);
    if (request.signal?.aborted) throw new LlmAbortError();

    let step: MockStep | undefined = this.options.script?.[this.cursor];
    if (step !== undefined) this.cursor += 1;
    while (typeof step === 'function') step = step(request);
    if (step instanceof Error) throw step;

    const delay = (typeof step === 'object' ? step.delayMs : undefined) ?? this.options.delayMs ?? 0;
    if (delay > 0) await sleep(delay, request.signal);

    const partial = step === undefined ? { content: this.echo(request.messages) } : typeof step === 'string' ? { content: step } : step;
    const toolCalls = partial.toolCalls;
    const content = partial.content ?? '';
    const message: Message = { role: 'assistant', content };
    if (toolCalls?.length) message.toolCalls = toolCalls;

    const inputTokens = estimateTokens(request.messages.map((m) => m.content).join('\n'));
    const usage = partial.usage ?? {
      inputTokens,
      outputTokens: estimateTokens(content + JSON.stringify(toolCalls ?? [])),
    };
    return { message, usage, finishReason: toolCalls?.length ? 'tool_calls' : 'stop', model: request.model ?? 'mock-1' };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const response = await this.chat(request);
    const size = this.options.chunkSize ?? 4;
    const text = response.message.content;
    for (let i = 0; i < text.length; i += size) {
      if (request.signal?.aborted) throw new LlmAbortError();
      yield { delta: text.slice(i, i + size) };
    }
    yield { delta: '', done: true, usage: response.usage, toolCalls: response.message.toolCalls };
  }

  private echo(messages: Message[]): string {
    const last = [...messages].reverse().find((m) => m.role === 'user' || m.role === 'tool');
    return `eco: ${last?.content ?? ''}`;
  }
}
