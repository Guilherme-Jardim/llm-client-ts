import { describe, expect, it } from 'vitest';
import { LlmAbortError } from '../src/errors.js';
import { MockProvider, estimateTokens } from '../src/mock.js';

const user = (content: string) => ({ role: 'user' as const, content });

describe('MockProvider', () => {
  it('faz eco da última mensagem do usuário por padrão', async () => {
    const r = await new MockProvider().chat({ messages: [user('oi')] });
    expect(r.message.content).toBe('eco: oi');
    expect(r.finishReason).toBe('stop');
  });

  it('é determinístico: mesma entrada, mesma saída e mesmo uso', async () => {
    const a = await new MockProvider().chat({ messages: [user('abc')] });
    const b = await new MockProvider().chat({ messages: [user('abc')] });
    expect(a).toEqual(b);
  });

  it('segue o roteiro em ordem e volta ao eco no fim', async () => {
    const m = new MockProvider({ script: ['um', 'dois'] });
    const out = [];
    for (let i = 0; i < 3; i++) out.push((await m.chat({ messages: [user('x')] })).message.content);
    expect(out).toEqual(['um', 'dois', 'eco: x']);
  });

  it('lança erros do roteiro', async () => {
    const m = new MockProvider({ script: [new Error('falhou')] });
    await expect(m.chat({ messages: [user('x')] })).rejects.toThrow('falhou');
  });

  it('aceita função no roteiro e vê a requisição', async () => {
    const m = new MockProvider({ script: [(req) => `msgs=${req.messages.length}`] });
    expect((await m.chat({ messages: [user('a'), user('b')] })).message.content).toBe('msgs=2');
  });

  it('devolve chamadas de ferramenta com finishReason tool_calls', async () => {
    const m = new MockProvider({ script: [{ toolCalls: [{ id: '1', name: 'soma', arguments: { a: 1 } }] }] });
    const r = await m.chat({ messages: [user('x')] });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.message.toolCalls?.[0]?.name).toBe('soma');
  });

  it('guarda as requisições recebidas', async () => {
    const m = new MockProvider();
    await m.chat({ messages: [user('a')] });
    expect(m.calls).toHaveLength(1);
  });

  it('estima tokens por tamanho do texto', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('faz streaming em pedaços e termina com done e uso', async () => {
    const m = new MockProvider({ script: ['abcdefghij'], chunkSize: 4 });
    const chunks = [];
    for await (const c of m.stream({ messages: [user('x')] })) chunks.push(c);
    expect(chunks.map((c) => c.delta).join('')).toBe('abcdefghij');
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.at(-1)?.usage).toBeDefined();
  });

  it('respeita cancelamento durante o atraso', async () => {
    const m = new MockProvider({ delayMs: 500 });
    const ctrl = new AbortController();
    const p = m.chat({ messages: [user('x')], signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(LlmAbortError);
  });
});
