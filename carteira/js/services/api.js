// Camada de acesso a dados do site.
//
// Duas fontes de cotação, as duas vindas do Yahoo Finance (grátis, sem
// token nenhum):
// 1. dados/cotacoes.json — gerado periodicamente pelo GitHub Actions, usado
//    nas sugestões padrão de cada categoria.
// 2. Cloudflare Worker (WORKER_URL) — usado só na busca manual por ticker,
//    pra achar ativos que não estão na lista pré-carregada. Existe só pra
//    evitar bloqueio de CORS (o Yahoo não libera chamada direta do
//    navegador) — não guarda nenhuma credencial, porque não precisa de
//    nenhuma.

const DATA_URL = "dados/cotacoes.json";
const WORKER_URL = "https://brapi-proxy.manymens777.workers.dev";

let cache = null;
let inflight = null;

export async function getQuotes({ force = false } = {}) {
  if (cache && !force) return cache;
  if (inflight) return inflight;
  inflight = fetch(`${DATA_URL}?v=${Date.now()}`)
    .then((r) => {
      if (!r.ok) throw new Error(`Não foi possível carregar as cotações (${r.status})`);
      return r.json();
    })
    .then((data) => {
      cache = data;
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Busca um ticker. Primeiro tenta na base já carregada (instantâneo); se
 * não achar, busca ao vivo no Yahoo Finance via Cloudflare Worker.
 */
export async function lookupTicker(rawTicker) {
  const ticker = String(rawTicker || "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(ticker)) {
    throw new Error("Ticker inválido");
  }

  const data = await getQuotes();
  const all = [
    ...(data.stocks || []),
    ...(data.bdrs || []),
    ...(data.fiis || []),
    ...(data.goldEtf || []),
  ];
  const found = all.find((q) => q.symbol === ticker);
  if (found) {
    return {
      symbol: found.symbol,
      shortName: found.name,
      regularMarketPrice: found.price,
      regularMarketChangePercent: found.changePct,
    };
  }

  // Não estava na base pré-carregada — tenta ao vivo.
  const r = await fetch(`${WORKER_URL}/quote/${encodeURIComponent(ticker)}`);
  if (!r.ok) {
    throw new Error("Ativo não encontrado");
  }
  return r.json();
}
