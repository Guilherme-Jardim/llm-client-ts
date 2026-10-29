import { ConfigError, LlmAbortError, LlmError, LlmHttpError } from './errors.js';
import type {
  ChatRequest,
  ChatResponse,
  FinishReason,
  LlmProvider,
  Message,
  StreamChunk,
  ToolCall,
  Usage,
} from './types.js';

export interface HttpProviderOptions {
  /** Modelo padrão, usado quando a requisição não traz um. */
  model?: string;
  /** URL base. Se ausente, lê da variável `baseUrlEnv`. */
  baseUrl?: string;
  /** Nome da variável de ambiente com a URL base. Padrão: LLM_BASE_URL. */
  baseUrlEnv?: string;
  /** Nome da variável de ambiente com a chave. Padrão: LLM_API_KEY. */
  apiKeyEnv?: string;
  /** Servidores locais podem dispensar chave. Padrão: true (exige). */
  requireKey?: boolean;
  /** Caminho do endpoint. Padrão: /chat/completions. */
  path?: string;
  headers?: Record<string, string>;
  /** Injetável para testes. Padrão: fetch global. */
  fetch?: typeof fetch;
  /** Injetável para testes. Padrão: process.env. */
  env?: Record<string, string | undefined>;
}

interface WireToolCall {
  id?: string;
  index?: number;
  function?: { name?: string; arguments?: string };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toWireMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): FinishReason {
  if (hasTools || reason === 'tool_calls') return 'tool_calls';
  if (reason === 'length') return 'length';
  return 'stop';
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Lê eventos SSE ("data: ...") de um corpo de resposta. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    const rest = buffer.trim();
    if (rest.startsWith('data:')) yield rest.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** Adaptador para APIs HTTP no formato chat/completions. */
export class HttpProvider implements LlmProvider {
  readonly name = 'http';

  constructor(private readonly options: HttpProviderOptions = {}) {}

  private endpoint(): { url: string; headers: Record<string, string> } {
    const env = this.options.env ?? process.env;
    const base = this.options.baseUrl ?? env[this.options.baseUrlEnv ?? 'LLM_BASE_URL'];
    if (!base) {
      throw new ConfigError(`URL base ausente: defina a variável ${this.options.baseUrlEnv ?? 'LLM_BASE_URL'}`);
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', ...this.options.headers };
    if (this.options.requireKey !== false) {
      const keyName = this.options.apiKeyEnv ?? 'LLM_API_KEY';
      const key = env[keyName];
      if (!key) throw new ConfigError(`Chave ausente: defina a variável ${keyName}`);
      headers.authorization = `Bearer ${key}`;
    }
    const url = base.replace(/\/+$/, '') + (this.options.path ?? '/chat/completions');
    return { url, headers };
  }

  private body(request: ChatRequest, stream: boolean): string {
    const model = request.model ?? this.options.model;
    const payload: Record<string, unknown> = {
      model,
      messages: request.messages.map(toWireMessage),
    };
    if (request.temperature !== undefined) payload.temperature = request.temperature;
    if (request.maxTokens !== undefined) payload.max_tokens = request.maxTokens;
    if (request.jsonMode) payload.response_format = { type: 'json_object' };
    if (request.tools?.length) {
      payload.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    if (stream) {
      payload.stream = true;
      payload.stream_options = { include_usage: true };
    }
    return JSON.stringify(payload);
  }

  private async post(request: ChatRequest, stream: boolean): Promise<Response> {
    const { url, headers } = this.endpoint();
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'POST', headers, body: this.body(request, stream), signal: request.signal });
    } catch (error) {
      if (request.signal?.aborted) throw new LlmAbortError();
      throw error;
    }
    if (!res.ok) {
      throw new LlmHttpError(res.status, await res.text(), parseRetryAfter(res.headers.get('retry-after')));
    }
    return res;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.post(request, false);
    let data: {
      model?: string;
      choices?: { message?: { content?: string | null; tool_calls?: WireToolCall[] }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch (error) {
      throw new LlmError('Resposta do servidor não é JSON válido', { cause: error });
    }
    const choice = data.choices?.[0];
    if (!choice?.message) throw new LlmError('Resposta sem "choices[0].message"');

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? '',
      arguments: parseArgs(c.function?.arguments),
    }));
    const message: Message = { role: 'assistant', content: choice.message.content ?? '' };
    if (toolCalls.length) message.toolCalls = toolCalls;
    return {
      message,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      finishReason: mapFinish(choice.finish_reason, toolCalls.length > 0),
      model: data.model,
    };
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamChunk> {
    const res = await this.post(request, true);
    if (!res.body) throw new LlmError('Resposta de streaming sem corpo');

    const partial = new Map<number, { id: string; name: string; args: string }>();
    let usage: Usage | undefined;

    for await (const data of readSse(res.body)) {
      if (data === '[DONE]') break;
      let json: {
        choices?: { delta?: { content?: string | null; tool_calls?: WireToolCall[] } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      try {
        json = JSON.parse(data);
      } catch {
        continue; // linha de comentário ou evento que não interessa
      }
      if (json.usage) {
        usage = { inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
      }
      const delta = json.choices?.[0]?.delta;
      for (const c of delta?.tool_calls ?? []) {
        const slot = partial.get(c.index ?? 0) ?? { id: '', name: '', args: '' };
        if (c.id) slot.id = c.id;
        if (c.function?.name) slot.name += c.function.name;
        if (c.function?.arguments) slot.args += c.function.arguments;
        partial.set(c.index ?? 0, slot);
      }
      if (delta?.content) yield { delta: delta.content };
    }

    const toolCalls = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, s]) => ({ id: s.id || `call_${i}`, name: s.name, arguments: parseArgs(s.args) }));
    yield { delta: '', done: true, usage, toolCalls: toolCalls.length ? toolCalls : undefined };
  }
}
