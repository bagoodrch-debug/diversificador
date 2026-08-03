// Reaproveita a taxa CDI já buscada pelo workflow do "Reserva de Emergência"
// (reserva/scripts/atualizar-taxa.mjs), gravada em reserva/dados/taxas.json.
// Evita duplicar a chamada à API do Banco Central para a mesma informação.

const DATA_URL = "../reserva/dados/taxas.json";
let cache = null;

export async function getTaxas() {
  if (cache) return cache;
  const r = await fetch(`${DATA_URL}?v=${Date.now()}`);
  if (!r.ok) throw new Error(`Não foi possível carregar a taxa CDI (${r.status})`);
  cache = await r.json();
  return cache;
}
