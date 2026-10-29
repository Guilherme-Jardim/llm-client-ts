// Saída estruturada: a primeira resposta vem quebrada, o cliente pede correção e a segunda passa no Zod.
import { z } from 'zod';
import { LlmClient, MockProvider } from '../src/index.js';

const Tarefa = z.object({
  titulo: z.string().min(3),
  prioridade: z.enum(['baixa', 'media', 'alta']),
  prazoDias: z.number().int().positive(),
});

const provider = new MockProvider({
  script: [
    '{"titulo":"Pagar boleto","prioridade":"urgente","prazoDias":2}', // enum inválido
    '```json\n{"titulo":"Pagar boleto","prioridade":"alta","prazoDias":2}\n```',
  ],
});

const client = new LlmClient({ provider });
const { data, attempts } = await client.structured('Extraia a tarefa: pagar o boleto em 2 dias', Tarefa);
console.log(data, `(tentativas: ${attempts})`);
