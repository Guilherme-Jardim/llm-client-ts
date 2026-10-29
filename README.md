# llm-client-ts

[![CI](https://github.com/Guilherme-Jardim/llm-client-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/Guilherme-Jardim/llm-client-ts/actions/workflows/ci.yml)

Cliente de LLM em TypeScript que não amarra seu código a nenhum provedor. Você escreve contra uma interface pequena (`LlmProvider`) e troca o adaptador sem mexer na lógica.

## O problema

Todo projeto que chama um LLM acaba reescrevendo as mesmas peças: o loop de ferramentas que não pode rodar para sempre, o JSON que o modelo devolve quebrado, o timeout, o retry quando a API responde 429, a conta de quanto foi gasto. Quando essas peças ficam coladas no SDK de um provedor, testar sem rede e sem chave vira um sofrimento.

Esta biblioteca junta essas peças em um lugar só e traz um provedor falso e determinístico, para você testar e fazer demo sem chave nenhuma.

## Instalação

Requer Node 20 ou mais novo. O pacote ainda não está no npm, então use direto do repositório:

```bash
git clone https://github.com/Guilherme-Jardim/llm-client-ts.git
cd llm-client-ts
npm install
npm run build
```

`zod` é a única dependência de execução.

## Uso

### Chat e streaming

```ts
import { LlmClient, MockProvider } from 'llm-client-ts';

const client = new LlmClient({ provider: new MockProvider({ script: ['Olá!'] }) });

const r = await client.chat('Diga olá');
console.log(r.message.content);

for await (const pedaco of client.stream('Conte uma história')) {
  process.stdout.write(pedaco.delta);
}
```

### Ferramentas com limite de passos

```ts
import { z } from 'zod';
import { defineTool } from 'llm-client-ts';

const clima = defineTool({
  name: 'clima',
  description: 'Temperatura atual de uma cidade',
  schema: z.object({ cidade: z.string() }),
  handler: ({ cidade }) => ({ cidade, graus: 14 }),
});

const r = await client.runTools('Está frio em Curitiba?', [clima], { maxSteps: 4 });
```

O schema Zod vira o JSON Schema enviado ao modelo e também valida os argumentos que voltam. Se o modelo pedir uma ferramenta que não existe, mandar argumento inválido ou se o handler lançar erro, o erro volta para ele como resultado da ferramenta, e ele pode corrigir a chamada. Passou de `maxSteps` sem uma resposta final, lança `MaxStepsError`.

### Saída estruturada

```ts
const Tarefa = z.object({ titulo: z.string(), prioridade: z.enum(['baixa', 'alta']) });
const { data, attempts } = await client.structured('Extraia a tarefa: ...', Tarefa, { maxRepairs: 2 });
```

Se o JSON vier inválido ou fora do schema, o cliente devolve o erro ao modelo e pede de novo, até `maxRepairs` vezes. Depois disso lança `StructuredOutputError` com a última saída. Cerca de código (` ```json `) e texto em volta do JSON são tolerados.

### Timeout, cancelamento, retry e orçamento

```ts
const client = new LlmClient({
  provider,
  timeoutMs: 30_000,                          // por tentativa
  retry: { maxAttempts: 4, baseDelayMs: 300 },  // backoff exponencial com jitter
  pricing: { inputPer1k: 0.5, outputPer1k: 1.5 },
  budget: { maxTokens: 20_000, maxCostUsd: 0.10 }, // vale por execução
});

const ctrl = new AbortController();
await client.chat('...', { signal: ctrl.signal });

client.usage.summary(); // { calls, inputTokens, outputTokens, totalTokens, costUsd }
```

Cada chamada de `chat`, `stream`, `runTools` e `structured` é uma execução com seu próprio orçamento. Num `runTools` ou `structured`, todos os passos e reparos contam no mesmo limite.

### Adaptador HTTP

```ts
import { HttpProvider } from 'llm-client-ts';

const provider = new HttpProvider({ model: 'meu-modelo' });
```

Lê `LLM_BASE_URL` e `LLM_API_KEY` do ambiente (os nomes são configuráveis). Fala o formato de chat/completions: `POST {base}/chat/completions`, ferramentas via `tools`/`tool_calls`, streaming por SSE. Sem a variável de chave, lança `ConfigError`. Servidores locais sem autenticação usam `requireKey: false`.

Exemplos rodáveis em [`exemplos/`](exemplos), todos sem rede, menos o `http.ts`:

```bash
npx tsx exemplos/basico.ts
npx tsx exemplos/ferramentas.ts
npx tsx exemplos/estruturado.ts
```

## Decisões de projeto

- **Interface mínima.** `LlmProvider` tem `chat` e, opcionalmente, `stream`. Quem não tem streaming nativo ainda funciona: o cliente entrega a resposta inteira como um pedaço só.
- **Erros de ferramenta voltam para o modelo.** Derrubar o loop por um argumento errado desperdiça a chamada. Cancelamento é a exceção: nunca é engolido.
- **Retry só onde faz sentido.** 408, 429, 5xx, timeout e falha de rede. 4xx de cliente (chave errada, requisição inválida) não repete. Cancelamento nunca repete. O `Retry-After` do servidor é respeitado até o teto configurado.
- **Jitter total.** O atraso é sorteado entre 0 e o teto exponencial da tentativa, o que evita vários clientes batendo juntos no servidor.
- **Orçamento checado antes e depois.** Antes de cada chamada confere se ainda há saldo; depois de cada resposta confere se estourou. A última chamada pode passar do limite, porque o custo só se conhece depois.
- **Streaming com timeout ocioso.** `timeoutMs` no stream é o tempo máximo entre pedaços, não a duração total. Retry só vale até o primeiro pedaço chegar; depois disso repetir duplicaria texto já entregue.
- **Mock determinístico.** Sem aleatoriedade e sem relógio: roteiro de respostas em ordem, ou eco. Tokens são estimados em 1 a cada 4 caracteres.
- **Dependências injetáveis.** `fetch`, `env`, `sleep` e `random` podem ser trocados, e é assim que os testes rodam rápido.

## Limites

- **O adaptador HTTP foi validado apenas contra um servidor falso local**, que escrevi seguindo o formato de chat/completions. Nenhum provedor real foi chamado. Diferenças de campos, de erros ou de streaming entre provedores reais podem aparecer.
- Contagem de tokens e custo dependem do que o servidor informa (`usage`). Se ele não informar, o uso fica zerado no registro, exceto no streaming, onde há uma estimativa por tamanho de texto.
- Em streaming com ferramentas, as chamadas são entregues no último pedaço; o `stream` do cliente não executa ferramentas, só o `runTools` faz isso.
- `runTools` executa as ferramentas de um passo em sequência, não em paralelo.
- Sem cache, sem fila de requisições e sem limite de concorrência.
- O registro de uso fica em memória.

## Desenvolvimento

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Os testes (mais de 70) não usam rede: rodam com o `MockProvider` e com um servidor HTTP local em `127.0.0.1`.

## Licença

MIT. Veja [LICENSE](LICENSE).
