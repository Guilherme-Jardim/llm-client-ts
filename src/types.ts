export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: Role;
  content: string;
  /** Chamadas de ferramenta pedidas pelo modelo (só em respostas do modelo). */
  toolCalls?: ToolCall[];
  /** Id da chamada respondida (só em mensagens de papel "tool"). */
  toolCallId?: string;
}

/** Descrição de uma ferramenta, com parâmetros em JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length';

export interface ChatRequest {
  messages: Message[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Pede ao provedor que responda apenas JSON, quando houver suporte. */
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  message: Message;
  usage: Usage;
  finishReason: FinishReason;
  model?: string;
}

export interface StreamChunk {
  /** Trecho de texto novo. */
  delta: string;
  /** Presente apenas no último pedaço. */
  done?: boolean;
  usage?: Usage;
  toolCalls?: ToolCall[];
}

export interface LlmProvider {
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  /** Opcional: provedores sem streaming nativo são tratados pelo cliente. */
  stream?(request: ChatRequest): AsyncIterable<StreamChunk>;
}
