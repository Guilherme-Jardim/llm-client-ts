// Tool calling com limite de passos e orçamento. O roteiro do mock faz o papel do modelo.
import { z } from 'zod';
import { LlmClient, MockProvider, defineTool } from '../src/index.js';

const clima = defineTool({
  name: 'clima',
  description: 'Temperatura atual de uma cidade',
  schema: z.object({ cidade: z.string() }),
  handler: ({ cidade }) => ({ cidade, graus: cidade === 'Curitiba' ? 14 : 27 }),
});

const provider = new MockProvider({
  script: [
    { toolCalls: [{ id: 'a', name: 'clima', arguments: { cidade: 'Curitiba' } }] },
    (req) => `Resultado da ferramenta: ${req.messages.at(-1)?.content}`,
  ],
});

const client = new LlmClient({ provider });
const r = await client.runTools('Está frio em Curitiba?', [clima], {
  maxSteps: 4,
  budget: { maxTokens: 2000 },
});

console.log(r.text);
console.log(`passos: ${r.steps}, tokens: ${r.usage.tokens}`);
