/**
 * Proxy de busca ao vivo — Yahoo Finance.
 *
 * Este código roda no Cloudflare Workers (não no GitHub) — é uma "função
 * servidor" gratuita que existe só pra evitar que o navegador chame o Yahoo
 * direto (o Yahoo não libera CORS pra domínio arbitrário, então precisa
 * passar por um servidor no meio de qualquer forma).
 *
 * Como funciona:
 *   GET https://SEU-WORKER.workers.dev/quote/PETR4
 *   → busca PETR4.SA no endpoint público (não-oficial) do Yahoo Finance
 *   → devolve só os dados públicos (símbolo, preço, variação, nome)
 *
 * Não precisa de token nem de Secret configurado — é o mesmo endpoint
 * gratuito usado pelo script scripts/atualizar-cotacoes.mjs pra montar a
 * lista padrão. Antes esse arquivo usava a Brapi (com token pago); trocamos
 * pra unificar tudo numa fonte só e não depender de cota/token.
 */

const ALLOWED_ORIGINS = [
  "https://manymens.com.br",
  "https://www.manymens.com.br",
  "http://localhost:8080",
  "http://localhost:8123",
];

const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "public, max-age=60", // reduz chamadas repetidas em curto intervalo
  };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    const match = url.pathname.match(/^\/quote\/([A-Za-z0-9]{2,10})$/);
    if (!match) {
      return new Response(JSON.stringify({ error: "Use /quote/TICKER" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const ticker = match[1].toUpperCase();

    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.SA`;
      const r = await fetch(yahooUrl, { headers: { "User-Agent": YAHOO_UA } });

      if (!r.ok) {
        return new Response(JSON.stringify({ error: `Falha no Yahoo (${r.status})` }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const j = await r.json();
      const meta = j.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null) {
        return new Response(JSON.stringify({ error: "Ativo não encontrado" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose;
      const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;

      // Mesmo formato de sempre — o front-end não precisa mudar nada.
      const payload = {
        symbol: ticker,
        shortName: meta.longName ?? meta.shortName ?? null,
        regularMarketPrice: price,
        regularMarketChangePercent: changePct,
      };

      return new Response(JSON.stringify(payload), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Erro ao consultar o Yahoo" }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
