// Roda em Node (GitHub Actions), NUNCA no navegador.
// Grava dados/cotacoes.json — um arquivo público, sem nenhuma credencial.
//
// Fontes de dados, todas gratuitas e sem token:
// - Ações/BDRs/FIIs/ETF de ouro: endpoint "não-oficial" v8/finance/chart do
//   Yahoo Finance (o mesmo que o site deles usa por trás dos panos). Não tem
//   cota paga, mas também não é uma API com contrato/SLA — o Yahoo pode
//   mudar ou bloquear isso sem aviso. Por isso mantemos a atualização de
//   hora em hora (não mais frequente), pra não parecer abuso.
// - Ouro spot: AwesomeAPI (gratuita, sem token).
// - Tesouro Direto: sandbox público da Brapi (gratuito, sem token — ver
//   comentário mais abaixo).
//
// Observação: os tickers acompanhados aqui espelham
// js/data/ativos.data.js (mantidos separados de propósito para que este
// script funcione de forma independente, sem depender de resolução de
// módulos ESM/CJS entre ambientes diferentes). Se adicionar um ticker em um
// arquivo, adicione no outro também.

const TROY_OUNCE_G = 31.1034768;
const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const STOCK_TICKERS = ["PETR4", "ITUB4", "VALE3", "WEGE3", "BBAS3", "BBDC4", "ABEV3"];
const BDR_TICKERS = ["IVVB11", "AAPL34", "MSFT34", "GOGL34", "AMZO34"];
const FII_TICKERS = ["HGLG11", "KNRI11", "MXRF11", "XPML11", "VISC11"];
const GOLD_ETF_TICKER = "GOLD11";

async function fetchYahooOne(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}.SA`;
  const r = await fetch(url, { headers: { "User-Agent": YAHOO_UA } });
  if (!r.ok) throw new Error(`yahoo ${ticker} ${r.status}`);
  const j = await r.json();
  const meta = j.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const changePct = prevClose ? ((price - prevClose) / prevClose) * 100 : null;
  return {
    symbol: ticker,
    price,
    changePct,
    name: meta.longName ?? meta.shortName ?? null,
  };
}

async function fetchYahoo(tickers) {
  const out = [];
  const errors = [];
  // Uma de cada vez, com uma pequena pausa — o Yahoo não tem cota paga, mas
  // rajadas de requisições em paralelo aumentam a chance de bloqueio por IP.
  for (const ticker of tickers) {
    try {
      const item = await fetchYahooOne(ticker);
      if (item) out.push(item);
    } catch (e) {
      errors.push(`${ticker}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  return { out, errors };
}

async function fetchGold() {
  const r = await fetch("https://economia.awesomeapi.com.br/json/last/XAU-BRL", {
    headers: { "User-Agent": "DistribuiRico/1.0" },
  });
  if (!r.ok) throw new Error(`gold ${r.status}`);
  const j = await r.json();
  const ounce = parseFloat(j.XAUBRL.bid);
  return {
    pricePerOunceBRL: ounce,
    pricePerGramBRL: ounce / TROY_OUNCE_G,
    updatedAt: j.XAUBRL.create_date,
  };
}

// Renda Fixa: o site oficial do Tesouro Direto passou a bloquear chamadas
// automatizadas (proteção anti-robô da Cloudflare, aconteceu com todo mundo
// que faz esse tipo de integração, não só com a gente). Em vez de brigar com
// isso, usamos o "sandbox" público da API de Tesouro Direto da Brapi: 3
// títulos fixos (um de cada tipo — Selic, Prefixado, IPCA+) que funcionam
// sem token e sem exigir plano pago. Ver:
// https://brapi.dev/blog/api-tesouro-direto-brasil-como-consultar-2026
const TREASURY_SANDBOX_SYMBOLS = [
  "tesouro-selic-01032031",
  "tesouro-prefixado-com-juros-semestrais-01012037",
  "tesouro-ipca-com-juros-semestrais-15082060",
];

function treasuryTypeLabel(item) {
  switch (item.rateInfo?.rateType) {
    case "spreadOverSelic":
      return "Pós-fixado (Selic + spread)";
    case "nominalAnnualRate":
      return "Prefixado (taxa nominal)";
    case "realAnnualRateOverIpca":
      return "Híbrido (IPCA + taxa real)";
    default:
      return item.bondType ?? "Tesouro Direto";
  }
}

async function fetchTreasury() {
  const symbols = TREASURY_SANDBOX_SYMBOLS.join(",");
  const r = await fetch(`https://brapi.dev/api/v2/treasury/indicators?symbols=${encodeURIComponent(symbols)}`);
  if (!r.ok) throw new Error(`treasury ${r.status}`);
  const j = await r.json();
  return (j.results || []).map((item) => ({
    name: `${item.bondType ?? "Tesouro Direto"} ${item.maturityDate?.slice(0, 4) ?? ""}`.trim(),
    rate: item.buyRate,
    unitPrice: item.buyPrice,
    minAmount: item.buyPrice * 0.01,
    maturity: item.maturityDate ?? null,
    type: treasuryTypeLabel(item),
  }));
}

async function safe(label, promise, fallback, errors) {
  try {
    return await promise;
  } catch (e) {
    errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    return fallback;
  }
}

async function main() {
  const errors = [];

  const stocksR = await safe("stocks", fetchYahoo(STOCK_TICKERS), { out: [], errors: [] }, errors);
  const bdrsR = await safe("bdrs", fetchYahoo(BDR_TICKERS), { out: [], errors: [] }, errors);
  const fiisR = await safe("fiis", fetchYahoo(FII_TICKERS), { out: [], errors: [] }, errors);
  const goldEtfR = await safe("goldEtf", fetchYahoo([GOLD_ETF_TICKER]), { out: [], errors: [] }, errors);
  const gold = await safe("gold", fetchGold(), null, errors);
  const treasury = await safe("treasury", fetchTreasury(), [], errors);

  [stocksR, bdrsR, fiisR, goldEtfR].forEach((r) => errors.push(...r.errors));

  const payload = {
    updatedAt: new Date().toISOString(),
    stocks: stocksR.out,
    bdrs: bdrsR.out,
    fiis: fiisR.out,
    goldEtf: goldEtfR.out,
    gold,
    treasury,
    errors,
  };

  const fs = await import("node:fs/promises");
  await fs.mkdir("dados", { recursive: true });
  await fs.writeFile("dados/cotacoes.json", JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log("dados/cotacoes.json atualizado.");
  if (errors.length) console.warn("Avisos:", errors);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
