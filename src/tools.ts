import { z } from 'zod';
import type { ToolCall, ToolSpec } from './types.js';

export interface ToolContext {
  signal?: AbortSignal;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  /** Schema Zod dos argumentos. Também gera o JSON Schema enviado ao modelo. */
  schema: S;
  handler(args: z.infer<S>, ctx: ToolContext): unknown | Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}

export function toToolSpec(tool: Tool): ToolSpec {
  const parameters = { ...(z.toJSONSchema(tool.schema) as Record<string, unknown>) };
  delete parameters.$schema;
  return { name: tool.name, description: tool.description, parameters };
}

export interface ExecutedToolCall {
  call: ToolCall;
  output: string;
  ok: boolean;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null);
}

/**
 * Executa uma chamada pedida pelo modelo. Erros de validação e de execução
 * viram texto de volta para o modelo, que pode corrigir a chamada.
 * Cancelamento não é engolido.
 */
export async function executeToolCall(
  call: ToolCall,
  tools: Map<string, Tool>,
  ctx: ToolContext,
): Promise<ExecutedToolCall> {
  const tool = tools.get(call.name);
  if (!tool) {
    return { call, ok: false, output: JSON.stringify({ error: `ferramenta desconhecida: ${call.name}` }) };
  }
  const parsed = tool.schema.safeParse(call.arguments);
  if (!parsed.success) {
    const detalhes = parsed.error.issues.map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`).join('; ');
    return { call, ok: false, output: JSON.stringify({ error: `argumentos inválidos: ${detalhes}` }) };
  }
  try {
    return { call, ok: true, output: serialize(await tool.handler(parsed.data, ctx)) };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    return { call, ok: false, output: JSON.stringify({ error: msg }) };
  }
}
