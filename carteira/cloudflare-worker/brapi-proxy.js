/**
 * Proxy de busca ao vivo para a Brapi.
 *
 * Este código roda no Cloudflare Workers (não no GitHub) — é uma "função
 * servidor" gratuita que existe só pra guardar o token da Brapi em segurança
 * e repassar a consulta. O token nunca fica visível pra quem acessa o site.
 *
 * Como funciona:
 *   GET https://SEU-WORKER.workers.dev/quote/PETR4
 *   → busca o ticker na Brapi usando o token guardado no Cloudflare
 *   → devolve só os dados públicos (símbolo, preço, variação, nome)
 *
 * O token (BRAPI_TOKEN) é configurado como "Secret" direto no painel do
 * Cloudflare — não fica em nenhum lugar deste arquivo nem do repositório.
 *
 * IMPORTANTE — sobre custo/cota:
 * Cada chamada aqui consome 1 requisição da sua cota mensal da Brapi (a
 * mesma cota usada pelo workflow do GitHub Actions). Ver README para a
 * conta de quanto isso deixa disponível por mês.
 */

// Troque pelo endereço real do seu site depois de publicar (ver README).
// Pode listar mais de uma origem (ex: produção + teste local).
const ALLOWED_ORIGINS = [
  "https://SEU-USUARIO.github.io",
  "http://localhost:8080",
];

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
  async fetch(request, env) {
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
    const token = env.BRAPI_TOKEN; // vem do secret configurado no Cloudflare
    if (!token) {
      return new Response(JSON.stringify({ error: "BRAPI_TOKEN não configurado no Worker" }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    try {
      const brapiUrl = `https://brapi.dev/api/quote/${encodeURIComponent(ticker)}?token=${encodeURIComponent(token)}`;
      const r = await fetch(brapiUrl);
      if (r.status === 404) {
        return new Response(JSON.stringify({ error: "Ativo não encontrado" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      if (!r.ok) {
        return new Response(JSON.stringify({ error: `Falha na Brapi (${r.status})` }), {
          status: 502,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }
      const j = await r.json();
      const item = j.results?.[0];
      if (!item || !item.regularMarketPrice) {
        return new Response(JSON.stringify({ error: "Ativo não encontrado" }), {
          status: 404,
          headers: { ...headers, "Content-Type": "application/json" },
        });
      }

      // Só devolve o que é necessário — nunca o token, nunca o payload cru da Brapi.
      const payload = {
        symbol: item.symbol,
        shortName: item.shortName ?? item.longName ?? null,
        regularMarketPrice: item.regularMarketPrice,
        regularMarketChangePercent: item.regularMarketChangePercent ?? null,
      };

      return new Response(JSON.stringify(payload), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Erro ao consultar a Brapi" }), {
        status: 500,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
