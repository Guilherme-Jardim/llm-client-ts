// Adaptador HTTP genérico. Exige LLM_BASE_URL e LLM_API_KEY no ambiente (nada de chave no código).
//   LLM_BASE_URL=https://seu-servidor/v1 LLM_API_KEY=... npx tsx exemplos/http.ts
import { HttpProvider, LlmClient } from '../src/index.js';

const client = new LlmClient({
  provider: new HttpProvider({ model: process.env.LLM_MODEL ?? 'meu-modelo' }),
  timeoutMs: 30_000,
  retry: { maxAttempts: 4, baseDelayMs: 300 },
});

const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const r = await client.chat('Resuma em uma frase o que é backoff exponencial.', { signal: controller.signal });
console.log(r.message.content);
console.log(client.usage.summary());
