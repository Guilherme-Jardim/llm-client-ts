/**
 * Tira o JSON de uma resposta de texto: aceita cerca de código (```json),
 * texto antes e depois, e devolve o valor já interpretado.
 */
export function extractJson(text: string): unknown {
  let body = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fence?.[1]) body = fence[1].trim();
  try {
    return JSON.parse(body);
  } catch (first) {
    const start = body.search(/[{[]/);
    if (start < 0) throw first;
    const close = body[start] === '{' ? '}' : ']';
    const end = body.lastIndexOf(close);
    if (end <= start) throw first;
    return JSON.parse(body.slice(start, end + 1));
  }
}
