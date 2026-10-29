import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BudgetExceededError,
  HttpProvider,
  LlmAbortError,
  LlmClient,
  LlmHttpError,
  LlmTimeoutError,
  MaxStepsError,
  MockProvider,
  StructuredOutputError,
  defineTool,
  extractJson,
} from '../src/index.js';
import { completion, json, startFakeServer } from './fake-server.js';

const fast = { maxAttempts: 3, sleep: async () => {} };
const call = (name: string, args: Record<string, unknown>, id = name) => ({ id, name, arguments: args });

const soma = defineTool({
  name: 'soma',
  description: 'Soma dois números',
  schema: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => ({ resultado: a + b }),
});

describe('LlmClient.chat', () => {
  it('aceita texto simples e registra o uso', async () => {
    const c = new LlmClient({ provider: new MockProvider(), pricing: { inputPer1k: 1, outputPer1k: 1 } });
    const r = await c.chat('olá');
    expect(r.message.content).toBe('eco: olá');
    expect(c.usage.summary().calls).toBe(1);
    expect(c.usage.entries[0]?.provider).toBe('mock');
    expect(c.usage.summary().costUsd).toBeGreaterThan(0);
  });

  it('chama onUsage a cada resposta', async () => {
    const seen: string[] = [];
    const c = new LlmClient({ provider: new MockProvider(), onUsage: (e) => seen.push(e.label ?? '') });
    await c.chat('a');
    expect(seen).toEqual(['chat']);
  });

  it('repete após erro 503 e depois dá certo', async () => {
    const p = new MockProvider({ script: [new LlmHttpError(503, 'x'), new LlmHttpError(500, 'y'), 'ok'] });
    const c = new LlmClient({ provider: p, retry: fast });
    expect((await c.chat('a')).message.content).toBe('ok');
    expect(p.calls).toHaveLength(3);
  });

  it('não repete erro 401', async () => {
    const p = new MockProvider({ script: [new LlmHttpError(401, 'sem acesso'), 'ok'] });
    const c = new LlmClient({ provider: p, retry: fast });
    await expect(c.chat('a')).rejects.toBeInstanceOf(LlmHttpError);
    expect(p.calls).toHaveLength(1);
  });

  it('estoura o timeout por tentativa', async () => {
    const c = new LlmClient({ provider: new MockProvider({ delayMs: 300 }), timeoutMs: 20, retry: { maxAttempts: 1 } });
    await expect(c.chat('a')).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('tenta de novo depois de timeout', async () => {
    const p = new MockProvider({ script: [{ content: 'lento', delayMs: 300 }, 'rápido'] });
    const c = new LlmClient({ provider: p, timeoutMs: 30, retry: fast });
    expect((await c.chat('a')).message.content).toBe('rápido');
  });

  it('cancela via AbortSignal sem repetir', async () => {
    const p = new MockProvider({ delayMs: 500 });
    const c = new LlmClient({ provider: p, retry: fast });
    const ctrl = new AbortController();
    const pr = c.chat('a', { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(pr).rejects.toBeInstanceOf(LlmAbortError);
    expect(p.calls).toHaveLength(1);
  });

  it('recusa começar com sinal já cancelado', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(new LlmClient({ provider: new MockProvider() }).chat('a', { signal: ctrl.signal })).rejects.toBeInstanceOf(
      LlmAbortError,
    );
  });

  it('passa modelo, temperatura e maxTokens ao provedor', async () => {
    const p = new MockProvider();
    const c = new LlmClient({ provider: p, model: 'padrao' });
    await c.chat('a', { temperature: 0.3, maxTokens: 9 });
    await c.chat('b', { model: 'outro' });
    expect(p.calls[0]).toMatchObject({ model: 'padrao', temperature: 0.3, maxTokens: 9 });
    expect(p.calls[1]?.model).toBe('outro');
  });
});

describe('LlmClient.stream', () => {
  it('entrega pedaços e registra o uso no fim', async () => {
    const c = new LlmClient({ provider: new MockProvider({ script: ['abcdefgh'], chunkSize: 3 }) });
    let text = '';
    for await (const ch of c.stream('x')) text += ch.delta;
    expect(text).toBe('abcdefgh');
    expect(c.usage.entries[0]?.label).toBe('stream');
  });

  it('usa chat como reserva quando o provedor não tem stream', async () => {
    const base = new MockProvider({ script: ['sem stream'] });
    const semStream = { name: 'sem', chat: (r: Parameters<MockProvider['chat']>[0]) => base.chat(r) };
    const c = new LlmClient({ provider: semStream });
    let text = '';
    for await (const ch of c.stream('x')) text += ch.delta;
    expect(text).toBe('sem stream');
  });

  it('cancela no meio do streaming', async () => {
    const c = new LlmClient({ provider: new MockProvider({ script: ['a'.repeat(100)], chunkSize: 2 }) });
    const ctrl = new AbortController();
    const run = async () => {
      let n = 0;
      for await (const ch of c.stream('x', { signal: ctrl.signal })) if (ch.delta !== undefined && ++n === 3) ctrl.abort();
    };
    await expect(run()).rejects.toBeInstanceOf(LlmAbortError);
  });

  it('repete a abertura do stream se o primeiro pedaço falhar', async () => {
    const p = new MockProvider({ script: [new LlmHttpError(502, 'x'), 'depois'] });
    const c = new LlmClient({ provider: p, retry: fast });
    let text = '';
    for await (const ch of c.stream('x')) text += ch.delta;
    expect(text).toBe('depois');
  });

  it('respeita o orçamento antes de começar', async () => {
    const c = new LlmClient({ provider: new MockProvider(), budget: { maxTokens: 0 } });
    await expect(c.stream('x')[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('LlmClient.runTools', () => {
  it('executa a ferramenta e devolve a resposta final', async () => {
    const p = new MockProvider({
      script: [{ toolCalls: [call('soma', { a: 2, b: 3 })] }, (req) => `deu ${req.messages.at(-1)?.content}`],
    });
    const r = await new LlmClient({ provider: p }).runTools('quanto é 2+3?', [soma]);
    expect(r.text).toBe('deu {"resultado":5}');
    expect(r.steps).toBe(2);
    expect(r.toolCalls[0]).toMatchObject({ ok: true });
    expect(p.calls[0]?.tools?.[0]?.name).toBe('soma');
  });

  it('gera JSON Schema a partir do Zod', async () => {
    const p = new MockProvider();
    await new LlmClient({ provider: p }).runTools('x', [soma]);
    const params = p.calls[0]?.tools?.[0]?.parameters as { properties: Record<string, unknown>; $schema?: string };
    expect(Object.keys(params.properties)).toEqual(['a', 'b']);
    expect(params.$schema).toBeUndefined();
  });

  it('devolve ao modelo o erro de argumentos inválidos', async () => {
    const p = new MockProvider({ script: [{ toolCalls: [call('soma', { a: 'dois' })] }, 'ok'] });
    const r = await new LlmClient({ provider: p }).runTools('x', [soma]);
    expect(r.toolCalls[0]?.ok).toBe(false);
    expect(r.messages.find((m) => m.role === 'tool')?.content).toMatch(/argumentos inválidos/);
  });

  it('informa ferramenta desconhecida sem quebrar o loop', async () => {
    const p = new MockProvider({ script: [{ toolCalls: [call('nada', {})] }, 'tudo bem'] });
    const r = await new LlmClient({ provider: p }).runTools('x', [soma]);
    expect(r.text).toBe('tudo bem');
    expect(r.messages.find((m) => m.role === 'tool')?.content).toMatch(/desconhecida/);
  });

  it('converte exceção do handler em resultado de erro', async () => {
    const quebra = defineTool({ name: 'quebra', description: 'x', schema: z.object({}), handler: () => { throw new Error('boom'); } });
    const p = new MockProvider({ script: [{ toolCalls: [call('quebra', {})] }, 'fim'] });
    const r = await new LlmClient({ provider: p }).runTools('x', [quebra]);
    expect(r.toolCalls[0]).toMatchObject({ ok: false, output: '{"error":"boom"}' });
  });

  it('aceita várias chamadas no mesmo passo e handlers assíncronos', async () => {
    const dobro = defineTool({ name: 'dobro', description: 'x', schema: z.object({ n: z.number() }), handler: async ({ n }) => n * 2 });
    const p = new MockProvider({ script: [{ toolCalls: [call('dobro', { n: 1 }, 'a'), call('dobro', { n: 2 }, 'b')] }, 'fim'] });
    const r = await new LlmClient({ provider: p }).runTools('x', [dobro]);
    expect(r.messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['a', 'b']);
  });

  it('lança MaxStepsError se o modelo nunca termina', async () => {
    const loop = (): { toolCalls: ReturnType<typeof call>[] } => ({ toolCalls: [call('soma', { a: 1, b: 1 })] });
    const p = new MockProvider({ script: [loop, loop, loop, loop, loop] });
    const err = await new LlmClient({ provider: p }).runTools('x', [soma], { maxSteps: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(MaxStepsError);
    expect(p.calls).toHaveLength(3);
  });

  it('para quando o orçamento de tokens acaba', async () => {
    const loop = () => ({ toolCalls: [call('soma', { a: 1, b: 1 })], usage: { inputTokens: 60, outputTokens: 0 } });
    const p = new MockProvider({ script: [loop, loop, loop, loop] });
    const run = new LlmClient({ provider: p }).runTools('x', [soma], { budget: { maxTokens: 100 } });
    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
    expect(p.calls).toHaveLength(2);
  });

  it('para quando o custo estoura', async () => {
    const c = new LlmClient({ provider: new MockProvider({ script: [{ content: 'x', usage: { inputTokens: 1000, outputTokens: 0 } }] }), pricing: { inputPer1k: 1, outputPer1k: 1 } });
    await expect(c.chat('a', { budget: { maxCostUsd: 0.5 } })).rejects.toThrow(/custo/);
  });
});

describe('LlmClient.structured', () => {
  const schema = z.object({ nome: z.string(), idade: z.number().int() });

  it('valida e devolve o objeto tipado', async () => {
    const p = new MockProvider({ script: ['{"nome":"Ana","idade":30}'] });
    const r = await new LlmClient({ provider: p }).structured('quem?', schema);
    expect(r.data).toEqual({ nome: 'Ana', idade: 30 });
    expect(r.attempts).toBe(1);
    expect(p.calls[0]?.jsonMode).toBe(true);
    expect(p.calls[0]?.messages[0]?.content).toContain('JSON Schema');
  });

  it('aceita JSON dentro de cerca de código', async () => {
    const p = new MockProvider({ script: ['Aqui:\n```json\n{"nome":"Bia","idade":4}\n```'] });
    expect((await new LlmClient({ provider: p }).structured('x', schema)).data.nome).toBe('Bia');
  });

  it('repara quando o JSON é inválido', async () => {
    const p = new MockProvider({ script: ['isso não é json', '{"nome":"Caio","idade":7}'] });
    const r = await new LlmClient({ provider: p }).structured('x', schema);
    expect(r.attempts).toBe(2);
    expect(p.calls[1]?.messages.at(-1)?.content).toMatch(/não é JSON válido/);
  });

  it('repara quando o JSON viola o schema e cita o campo', async () => {
    const p = new MockProvider({ script: ['{"nome":"Dani","idade":"velha"}', '{"nome":"Dani","idade":50}'] });
    const r = await new LlmClient({ provider: p }).structured('x', schema);
    expect(r.data.idade).toBe(50);
    expect(p.calls[1]?.messages.at(-1)?.content).toContain('idade');
  });

  it('desiste depois de maxRepairs e guarda a última saída', async () => {
    const p = new MockProvider({ script: ['ruim 1', 'ruim 2', 'ruim 3', 'ruim 4'] });
    const err = await new LlmClient({ provider: p }).structured('x', schema, { maxRepairs: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect(err.attempts).toBe(2);
    expect(err.lastOutput).toBe('ruim 2');
    expect(p.calls).toHaveLength(2);
  });

  it('conta o gasto de todas as tentativas no mesmo orçamento', async () => {
    const big = { inputTokens: 80, outputTokens: 0 };
    const p = new MockProvider({ script: [{ content: 'x', usage: big }, { content: 'y', usage: big }] });
    const run = new LlmClient({ provider: p }).structured('x', schema, { budget: { maxTokens: 100 } });
    await expect(run).rejects.toBeInstanceOf(BudgetExceededError);
  });
});

describe('extractJson', () => {
  it('lê JSON puro, com texto em volta e arrays', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('claro! {"a":1} pronto')).toEqual({ a: 1 });
    expect(extractJson('lista: [1,2,3]')).toEqual([1, 2, 3]);
  });

  it('lança quando não há JSON', () => {
    expect(() => extractJson('nada aqui')).toThrow();
  });
});

describe('integração: LlmClient + HttpProvider + servidor falso', () => {
  it('faz o loop de ferramentas completo por HTTP', async () => {
    const fake = await startFakeServer((_, res, n) =>
      n === 1
        ? json(res, 200, completion('', {
            tool_calls: [{ id: 't1', type: 'function', function: { name: 'soma', arguments: '{"a":4,"b":5}' } }],
          }))
        : json(res, 200, completion('o total é 9')),
    );
    try {
      const provider = new HttpProvider({ env: { LLM_BASE_URL: fake.url, LLM_API_KEY: 'k' } });
      const r = await new LlmClient({ provider }).runTools('4+5?', [soma]);
      expect(r.text).toBe('o total é 9');
      expect(fake.requests[1]?.body.messages.at(-1)).toMatchObject({ role: 'tool', content: '{"resultado":9}' });
    } finally {
      await fake.close();
    }
  });

  it('faz retry real após 503 e respeita o timeout do servidor travado', async () => {
    const fake = await startFakeServer((_, res, n) => {
      if (n === 1) return json(res, 503, { error: 'indisponível' });
      if (n === 2) return; // trava: o timeout do cliente resolve
      json(res, 200, completion('recuperou'));
    });
    try {
      const provider = new HttpProvider({ env: { LLM_BASE_URL: fake.url, LLM_API_KEY: 'k' } });
      const c = new LlmClient({ provider, timeoutMs: 100, retry: fast });
      expect((await c.chat('x')).message.content).toBe('recuperou');
      expect(fake.requests).toHaveLength(3);
    } finally {
      await fake.close();
    }
  });
});
