// Chat simples e streaming, sem chave e sem rede, com o MockProvider.
import { LlmClient, MockProvider } from '../src/index.js';

const client = new LlmClient({
  provider: new MockProvider({ script: ['Olá! Eu sou um provedor de mentirinha.'] }),
  pricing: { inputPer1k: 0.5, outputPer1k: 1.5 },
});

const resposta = await client.chat('Diga olá');
console.log(resposta.message.content);

console.log('--- streaming ---');
for await (const pedaco of client.stream('Conte até três')) {
  process.stdout.write(pedaco.delta);
}
process.stdout.write('\n');

console.log('--- uso registrado ---');
console.log(client.usage.summary());
