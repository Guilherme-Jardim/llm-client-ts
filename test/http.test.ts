import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, LlmAbortError, LlmHttpError } from '../src/errors.js';
import { HttpProvider } from '../src/http.js';
import { completion, json, startFakeServer } from './fake-server.js';

type Fake = Awaited<ReturnType<typeof startFakeServer>>;
let fake: Fake | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const user = (content: string) => ({ role: 'user' as const, content });
const envFor = (url: string) => ({ LLM_BASE_URL: url, LLM_API_KEY: 'chave-de-teste' });

describe('HttpProvider contra servidor falso local', () => {
  it('envia o pedido no formato chat/completions com a chave no cabeçalho', async () => {
    fake = await startFakeServer((_, res) => json(res, 200, completion('olá')));
    const p = new HttpProvider({ model: 'm1', env: envFor(fake.url) });
    const r = await p.chat({ messages: [user('oi')], temperature: 0.2, maxTokens: 50 });
    expect(r.message.content).toBe('olá');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const req = fake.requests[0]!;
    expect(req.url).toBe('/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer chave-de-teste');
    expect(req.body).toMatchObject({ model: 'm1', temperature: 0.2, max_tokens: 50, messages: [{ role: 'user', content: 'oi' }] });
  });

  it('falha com ConfigError se a chave não estiver no ambiente', async () => {
    const p = new HttpProvider({ env: { LLM_BASE_URL: 'http://127.0.0.1:1' } });
    await expect(p.chat({ messages: [user('x')] })).rejects.toBeInstanceOf(ConfigError);
  });

  it('falha com ConfigError se a URL base não estiver definida', async () => {
    const p = new HttpProvider({ env: { LLM_API_KEY: 'k' } });
    await expect(p.chat({ messages: [user('x')] })).rejects.toThrow(/LLM_BASE_URL/);
  });

  it('aceita nomes de variável personalizados e dispensa chave quando pedido', async () => {
    fake = await startFakeServer((_, res) => json(res, 200, completion('ok')));
    const p = new HttpProvider({ baseUrlEnv: 'MEU_HOST', requireKey: false, env: { MEU_HOST: fake.url } });
    await p.chat({ messages: [user('x')] });
    expect(fake.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('converte chamadas de ferramenta da resposta', async () => {
    fake = await startFakeServer((_, res) =>
      json(res, 200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'soma', arguments: '{"a":1,"b":2}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      }),
    );
    const p = new HttpProvider({ env: envFor(fake.url) });
    const r = await p.chat({ messages: [user('x')], tools: [{ name: 'soma', description: 'soma', parameters: { type: 'object' } }] });
    expect(r.finishReason).toBe('tool_calls');
    expect(r.message.toolCalls).toEqual([{ id: 'c1', name: 'soma', arguments: { a: 1, b: 2 } }]);
    expect(fake.requests[0]!.body.tools[0].function.name).toBe('soma');
  });

  it('serializa o histórico com chamadas e resultados de ferramenta', async () => {
    fake = await startFakeServer((_, res) => json(res, 200, completion('fim')));
    const p = new HttpProvider({ env: envFor(fake.url) });
    await p.chat({
      messages: [
        user('x'),
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'f', arguments: { k: 1 } }] },
        { role: 'tool', content: '42', toolCallId: 'c1' },
      ],
      jsonMode: true,
    });
    const body = fake.requests[0]!.body;
    expect(body.messages[1].tool_calls[0].function.arguments).toBe('{"k":1}');
    expect(body.messages[2]).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('lança LlmHttpError com status e Retry-After', async () => {
    fake = await startFakeServer((_, res) => json(res, 429, { error: 'devagar' }, { 'retry-after': '2' }));
    const p = new HttpProvider({ env: envFor(fake.url) });
    const err = await p.chat({ messages: [user('x')] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(2000);
  });

  it('rejeita resposta sem choices', async () => {
    fake = await startFakeServer((_, res) => json(res, 200, { choices: [] }));
    const p = new HttpProvider({ env: envFor(fake.url) });
    await expect(p.chat({ messages: [user('x')] })).rejects.toThrow(/choices/);
  });

  it('cancela a requisição em andamento', async () => {
    fake = await startFakeServer(() => {
      /* nunca responde */
    });
    const p = new HttpProvider({ env: envFor(fake.url) });
    const ctrl = new AbortController();
    const pr = p.chat({ messages: [user('x')], signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 30);
    await expect(pr).rejects.toBeInstanceOf(LlmAbortError);
  });

  it('faz streaming SSE de texto e uso', async () => {
    fake = await startFakeServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { content: 'Olá, ' } }] });
      send({ choices: [{ delta: { content: 'mundo' } }] });
      send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const p = new HttpProvider({ env: envFor(fake.url) });
    const chunks = [];
    for await (const c of p.stream({ messages: [user('x')] })) chunks.push(c);
    expect(chunks.map((c) => c.delta).join('')).toBe('Olá, mundo');
    expect(chunks.at(-1)).toMatchObject({ done: true, usage: { inputTokens: 7, outputTokens: 2 } });
    expect(fake.requests[0]!.body.stream).toBe(true);
  });

  it('monta chamadas de ferramenta fragmentadas no streaming', async () => {
    fake = await startFakeServer((_, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c9', function: { name: 'soma', arguments: '{"a":' } }] } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '5}' } }] } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const p = new HttpProvider({ env: envFor(fake.url) });
    const chunks = [];
    for await (const c of p.stream({ messages: [user('x')] })) chunks.push(c);
    expect(chunks.at(-1)?.toolCalls).toEqual([{ id: 'c9', name: 'soma', arguments: { a: 5 } }]);
  });
});
