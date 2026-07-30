// Lê a taxa CDI já buscada pelo workflow do GitHub Actions (reserva/scripts/
// atualizar-taxa.mjs), gravada em dados/taxas.json — o navegador nunca
// chama a API do Banco Central diretamente (nem precisaria de chave, mas
// evita muitas chamadas repetidas de cada visitante).

const DATA_URL = "dados/taxas.json";
let cache = null;

export async function getTaxas({ force = false } = {}) {
  if (cache && !force) return cache;
  const r = await fetch(`${DATA_URL}?v=${Date.now()}`);
  if (!r.ok) throw new Error(`Não foi possível carregar a taxa CDI (${r.status})`);
  cache = await r.json();
  return cache;
}
