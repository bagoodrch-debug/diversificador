import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const TIPOS_BEM = {
  imovel: { label: "Imóvel", valorizacaoAnualPct: 4 },
  veiculo: { label: "Veículo", valorizacaoAnualPct: -8 },
  outro: { label: "Outro", valorizacaoAnualPct: 0 },
};

const DEFAULTS = {
  valorBem: 100000,
  prazoMeses: 60,
  taxaAdministracaoPct: 18,
  reajusteAnualPct: 6,
  tipoBem: "imovel",
  valorizacaoBemAnualPct: TIPOS_BEM.imovel.valorizacaoAnualPct,
  taxaFinanciamentoAnualPct: 11,
  investimentoIsentoIR: false,
};

const state = { ...DEFAULTS, cdiAnualPct: null, cdiError: null, cdiDataRef: null };

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) Object.assign(state, DEFAULTS, saved);
}
function persist() {
  save(KEYS.STATE, {
    valorBem: state.valorBem,
    prazoMeses: state.prazoMeses,
    taxaAdministracaoPct: state.taxaAdministracaoPct,
    reajusteAnualPct: state.reajusteAnualPct,
    tipoBem: state.tipoBem,
    valorizacaoBemAnualPct: state.valorizacaoBemAnualPct,
    taxaFinanciamentoAnualPct: state.taxaFinanciamentoAnualPct,
    investimentoIsentoIR: state.investimentoIsentoIR,
  });
}

/** Tabela regressiva oficial de IR sobre renda fixa, por prazo (em dias). */
function aliquotaIRRegressiva(dias) {
  if (dias <= 180) return 0.225;
  if (dias <= 360) return 0.2;
  if (dias <= 720) return 0.175;
  return 0.15;
}

/**
 * Simula um consórcio mês a mês. O saldo devedor já nasce com a taxa de
 * administração embutida (aplicada sobre o valor original da carta, uma
 * única vez), e é reajustado uma vez por ano pelo índice informado (igual
 * IGPM/INCC fazem na vida real). A parcela de cada mês é sempre
 * saldo-devedor-atual dividido pelos meses restantes - por isso ela sobe
 * ao longo do tempo, mesmo o "juro" sendo zero por nome.
 *
 * Devolve também a decomposição do total pago em três partes bem
 * separadas — valor original, taxa de administração nominal, e o efeito
 * extra causado pelos reajustes anuais — porque essas são coisas
 * diferentes e não devem ser somadas e chamadas todas de "administração".
 */
function simularConsorcio({ valorBem, prazoMeses, taxaAdministracaoPct, reajusteAnualPct, valorizacaoBemAnualPct }) {
  let saldoDevedor = valorBem * (1 + taxaAdministracaoPct / 100);
  let mesesRestantes = prazoMeses;
  let totalPago = 0;
  const parcelas = [];
  const serieMensal = [];
  const valorizacaoMensal = Math.pow(1 + valorizacaoBemAnualPct / 100, 1 / 12) - 1;
  let valorBemAtual = valorBem;

  for (let mes = 1; mes <= prazoMeses; mes++) {
    if (mes > 1 && (mes - 1) % 12 === 0) {
      saldoDevedor *= 1 + reajusteAnualPct / 100;
    }
    const parcela = saldoDevedor / mesesRestantes;
    totalPago += parcela;
    saldoDevedor -= parcela;
    mesesRestantes -= 1;
    parcelas.push(parcela);
    valorBemAtual *= 1 + valorizacaoMensal;
    serieMensal.push(Math.max(valorBemAtual - Math.max(saldoDevedor, 0), 0));
  }

  const taxaAdministracaoNominal = valorBem * (taxaAdministracaoPct / 100);
  const efeitoReajustes = totalPago - valorBem - taxaAdministracaoNominal;

  return {
    totalPago,
    parcelas,
    serieMensal,
    primeiraParcela: parcelas[0],
    ultimaParcela: parcelas[parcelas.length - 1],
    valorOriginal: valorBem,
    taxaAdministracaoNominal,
    efeitoReajustes,
  };
}

/** Quem não faz consórcio investe, mês a mês, o mesmo valor que estaria
 *  pagando de parcela naquele mês (fluxo de caixa igual, pra comparação
 *  justa) - rendendo à taxa informada, mês a mês (juros compostos reais,
 *  não uma multiplicação anual simplificada). O Imposto de Renda, quando
 *  não isento, incide só sobre o rendimento acumulado (nunca sobre o
 *  capital aportado), usando a alíquota regressiva pelo prazo total. */
function simularInvestirEquivalente({ parcelasConsorcio, taxaAnualPct, prazoMeses, isentoIR }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = 0;
  let totalAportado = 0;
  const serieMensal = [];
  for (const parcela of parcelasConsorcio) {
    saldo = saldo * (1 + taxaMensal) + parcela;
    totalAportado += parcela;
    serieMensal.push(saldo);
  }

  const rendimentoBruto = saldo - totalAportado;
  const aliquotaIR = isentoIR ? 0 : aliquotaIRRegressiva(prazoMeses * 30);
  const ir = Math.max(rendimentoBruto, 0) * aliquotaIR;
  const rendimentoLiquido = rendimentoBruto - ir;
  const saldoFinalLiquido = totalAportado + rendimentoLiquido;

  // A série mensal (pro gráfico) é ajustada proporcionalmente pra refletir
  // o líquido também, sem precisar re-simular mês a mês o IR.
  const fatorLiquido = saldo > 0 ? saldoFinalLiquido / saldo : 1;
  const serieMensalLiquida = serieMensal.map((v) => v * fatorLiquido);

  return {
    saldoFinalBruto: saldo,
    saldoFinalLiquido,
    totalAportado,
    rendimentoBruto,
    aliquotaIR,
    ir,
    rendimentoLiquido,
    serieMensal: serieMensalLiquida,
  };
}

/** Financiamento SAC padrão: amortização constante, parcela decrescente. */
function simularFinanciamentoSAC({ valorBem, prazoMeses, taxaAnualPct, valorizacaoBemAnualPct }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  const amortizacaoConstante = valorBem / prazoMeses;
  const valorizacaoMensal = Math.pow(1 + valorizacaoBemAnualPct / 100, 1 / 12) - 1;
  let saldoDevedor = valorBem;
  let valorBemAtual = valorBem;
  let totalJuros = 0;
  let totalPago = 0;
  let primeiraParcela = null;
  const serieMensal = [];

  for (let mes = 1; mes <= prazoMeses; mes++) {
    const juros = saldoDevedor * taxaMensal;
    const parcela = amortizacaoConstante + juros;
    if (primeiraParcela == null) primeiraParcela = parcela;
    totalJuros += juros;
    totalPago += parcela;
    saldoDevedor -= amortizacaoConstante;
    valorBemAtual *= 1 + valorizacaoMensal;
    serieMensal.push(Math.max(valorBemAtual - Math.max(saldoDevedor, 0), 0));
  }

  return {
    totalPago,
    totalJuros,
    primeiraParcela,
    ultimaParcela: amortizacaoConstante + Math.max(saldoDevedor + amortizacaoConstante, 0) * taxaMensal,
    serieMensal,
  };
}

export function initConsorcioApp() {
  loadPersisted();
  const root = qs("#consorcio-root");
  if (!root) return;
  render(root);
  fetchTaxaCdi(root);
}

async function fetchTaxaCdi(root) {
  try {
    const data = await getTaxas();
    if (data.cdi) {
      state.cdiAnualPct = data.cdi.taxaAnualPct;
      state.cdiDataRef = data.cdi.dataReferencia;
      state.cdiError = null;
    } else {
      state.cdiError = data.error ?? "CDI indisponível no momento.";
    }
  } catch (e) {
    state.cdiError = e instanceof Error ? e.message : "Erro ao buscar a taxa CDI.";
  }
  renderCdiInfo(root);
  renderResultado(root);
}

function render(root) {
  clear(root);

  const dadosCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Os dados do seu consórcio"),
    moneyField("Valor do bem / carta de crédito", "valorBem", root),
    numberField("Prazo (meses)", "prazoMeses", root),
    percentField("Taxa de administração total (%)", "taxaAdministracaoPct", root, "Aplicada sobre o valor original da carta, uma única vez — o valor total é diluído nas parcelas ao longo do prazo, não cobrado de uma vez."),
    percentField("Reajuste anual do saldo (%)", "reajusteAnualPct", root, "IGPM, INCC ou IPCA, dependendo do bem — confira no seu contrato."),
  ]);

  const tipoBotoes = [];
  const tipoToggle = el(
    "div",
    { class: "freq-toggle" },
    Object.entries(TIPOS_BEM).map(([valor, info]) => {
      const btn = el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(state.tipoBem === valor),
          onClick: () => {
            state.tipoBem = valor;
            state.valorizacaoBemAnualPct = TIPOS_BEM[valor].valorizacaoAnualPct;
            tipoBotoes.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.valor === valor)));
            persist();
            render(root);
          },
        },
        info.label,
      );
      btn.dataset.valor = valor;
      tipoBotoes.push(btn);
      return btn;
    }),
  );

  const bemCard = el("section", { class: "panel card" }, [
    el("h2", {}, "O bem que você quer comprar"),
    el("div", { class: "field-group" }, [
      el("label", { class: "field-label" }, "Tipo de bem"),
      tipoToggle,
      el(
        "p",
        { class: "field-ajuda" },
        "Imóvel costuma se valorizar; veículo costuma perder valor com o tempo — por isso cada tipo já vem com uma estimativa diferente abaixo (mas você pode mudar o número).",
      ),
    ]),
    percentField(
      "Valorização anual do bem (%)",
      "valorizacaoBemAnualPct",
      root,
      "Use negativo pra depreciação (ex: -8 para um carro perdendo valor). Aplicado do mesmo jeito nas três alternativas, pra manter a comparação justa.",
    ),
  ]);

  const financiamentoCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Se você financiasse no banco, em vez de consorciar"),
    el(
      "p",
      { class: "panel-lead" },
      "Usa o mesmo valor e o mesmo prazo do consórcio acima — só muda a taxa de juros, no sistema SAC (parcela decrescente). Não inclui eventuais seguros ou tarifas do banco, que variam por instituição.",
    ),
    percentField("Taxa do financiamento (% ao ano)", "taxaFinanciamentoAnualPct", root),
  ]);

  const irBotoes = [];
  const irToggle = el(
    "div",
    { class: "freq-toggle" },
    [
      [false, "Tributado (regra regressiva)"],
      [true, "Isento (ex: LCI/LCA)"],
    ].map(([valor, label]) => {
      const btn = el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(state.investimentoIsentoIR === valor),
          onClick: () => {
            state.investimentoIsentoIR = valor;
            irBotoes.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.valor === String(valor))));
            persist();
            renderResultado(root);
          },
        },
        label,
      );
      btn.dataset.valor = String(valor);
      irBotoes.push(btn);
      return btn;
    }),
  );

  const investirCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Se você investisse, em vez de consorciar"),
    el(
      "p",
      { class: "panel-lead" },
      "Investe, todo mês, o mesmo valor que seria a parcela do consórcio naquele mês, rendendo a taxa abaixo, mês a mês.",
    ),
    el("div", { class: "cdi-info-compacta", id: "cdi-info" }),
    el("div", { class: "field-group" }, [
      el("label", { class: "field-label" }, "Imposto de Renda sobre o rendimento"),
      irToggle,
    ]),
  ]);

  root.append(dadosCard, bemCard, financiamentoCard, investirCard, el("div", { id: "resultado-host" }));
  renderCdiInfo(root);
  renderResultado(root);
}

function moneyField(label, key, root) {
  const input = el("input", {
    class: "field",
    inputmode: "numeric",
    value: formatCurrencyInput(state[key]),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseCurrencyInput(e.target.value);
      e.target.value = formatCurrencyInput(n);
      state[key] = n;
      persist();
      renderResultado(root);
    },
  });
  return el("div", { class: "field-group" }, [el("label", { class: "field-label" }, label), input]);
}

function percentField(label, key, root, ajuda) {
  const input = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state[key]),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.-]/g, ""));
      state[key] = Number.isFinite(n) ? n : 0;
      persist();
      renderResultado(root);
    },
  });
  return el("div", { class: "field-group" }, [
    el("label", { class: "field-label" }, label),
    input,
    ajuda ? el("p", { class: "field-ajuda" }, ajuda) : null,
  ]);
}

function numberField(label, key, root) {
  const input = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state[key]),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
      state[key] = Number.isFinite(n) && n > 0 ? n : 1;
      persist();
      renderResultado(root);
    },
  });
  return el("div", { class: "field-group" }, [el("label", { class: "field-label" }, label), input]);
}

function renderCdiInfo(root) {
  const box = qs("#cdi-info", root);
  if (!box) return;
  clear(box);
  if (state.cdiAnualPct != null) {
    box.append(
      el(
        "p",
        { class: "cdi-info-compacta__linha" },
        `Rentabilidade: CDI ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% a.a. · referência ${state.cdiDataRef ?? "—"}`,
      ),
    );
  } else if (state.cdiError) {
    box.append(el("p", { class: "cdi-info-compacta__linha cdi-info-compacta__linha--erro" }, `CDI indisponível: ${state.cdiError}`));
  } else {
    box.append(el("p", { class: "cdi-info-compacta__linha" }, "Buscando taxa CDI…"));
  }
}

function renderResultado(root) {
  const host = qs("#resultado-host", root);
  if (!host) return;
  clear(host);

  if (state.cdiAnualPct == null) {
    host.append(el("p", { class: "disclaimer" }, "Aguardando a taxa CDI carregar para calcular…"));
    return;
  }

  const consorcio = simularConsorcio({
    valorBem: state.valorBem,
    prazoMeses: state.prazoMeses,
    taxaAdministracaoPct: state.taxaAdministracaoPct,
    reajusteAnualPct: state.reajusteAnualPct,
    valorizacaoBemAnualPct: state.valorizacaoBemAnualPct,
  });

  const investir = simularInvestirEquivalente({
    parcelasConsorcio: consorcio.parcelas,
    taxaAnualPct: state.cdiAnualPct,
    prazoMeses: state.prazoMeses,
    isentoIR: state.investimentoIsentoIR,
  });

  const financiamento = simularFinanciamentoSAC({
    valorBem: state.valorBem,
    prazoMeses: state.prazoMeses,
    taxaAnualPct: state.taxaFinanciamentoAnualPct,
    valorizacaoBemAnualPct: state.valorizacaoBemAnualPct,
  });

  const valorBemFinal = state.valorBem * Math.pow(1 + state.valorizacaoBemAnualPct / 100, state.prazoMeses / 12);

  const patrimonioConsorcio = consorcio.serieMensal[consorcio.serieMensal.length - 1];
  const patrimonioInvestir = investir.saldoFinalLiquido;
  const patrimonioFinanciamento = financiamento.serieMensal[financiamento.serieMensal.length - 1];

  const dinheiroQueSobra = patrimonioInvestir - valorBemFinal;

  const cards = [
    {
      nome: "Consórcio",
      cor: "#ff3b30",
      patrimonioFinal: patrimonioConsorcio,
      serieMensal: consorcio.serieMensal,
      linhas: [
        ["Total pago", brl(consorcio.totalPago)],
        ["Parcela inicial", brl(consorcio.primeiraParcela)],
        ["Parcela final", brl(consorcio.ultimaParcela)],
        ["Taxa de administração", brl(consorcio.taxaAdministracaoNominal)],
        ["Efeito dos reajustes", brl(consorcio.efeitoReajustes)],
        ["Valor do bem no final", brl(valorBemFinal)],
      ],
      nota: "Presume contemplação a tempo de usar o bem durante o prazo considerado — a contemplação em si depende de sorteio ou lance, sem data garantida.",
    },
    {
      nome: "Investir e comprar à vista depois",
      cor: "#22e0e0",
      patrimonioFinal: patrimonioInvestir,
      serieMensal: investir.serieMensal,
      linhas: [
        ["Total aportado", brl(investir.totalAportado)],
        ["Rendimento bruto", brl(investir.rendimentoBruto)],
        ["IR pago" + (state.investimentoIsentoIR ? " (isento)" : ` (${(investir.aliquotaIR * 100).toFixed(1).replace(".", ",")}%)`), brl(investir.ir)],
        ["Rendimento líquido", brl(investir.rendimentoLiquido)],
        ["Valor do bem comprado", brl(Math.min(patrimonioInvestir, valorBemFinal))],
        [dinheiroQueSobra >= 0 ? "Dinheiro que sobra" : "Ainda faltaria", brl(Math.abs(dinheiroQueSobra))],
      ],
      nota: "Patrimônio total = dinheiro que renderia investindo o equivalente à parcela do consórcio, mês a mês. O bem não está subtraído — está incluído dentro desse total, como se fosse comprado à vista no final.",
    },
    {
      nome: "Financiamento (SAC)",
      cor: "#f5b942",
      patrimonioFinal: patrimonioFinanciamento,
      serieMensal: financiamento.serieMensal,
      linhas: [
        ["Total pago", brl(financiamento.totalPago)],
        ["Parcela inicial", brl(financiamento.primeiraParcela)],
        ["Parcela final", brl(financiamento.ultimaParcela)],
        ["Total de juros", brl(financiamento.totalJuros)],
        ["Valor do bem no final", brl(valorBemFinal)],
      ],
      nota: "Posse do bem imediata, desde o mês 1 — diferente do consórcio, não depende de sorteio nem lance.",
    },
  ];

  const melhor = cards.reduce((a, b) => (b.patrimonioFinal > a.patrimonioFinal ? b : a));

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Comparação ao final do prazo"),
      el("div", { class: "comparacao-grid" }, cards.map((c) => cardResultado(c, c === melhor))),
      el(
        "p",
        { class: "disclaimer" },
        "Resultado baseado nas premissas informadas acima — mude qualquer campo e a comparação recalcula na hora. Consórcio não tem juros tradicionais, mas tem taxa de administração e reajustes; a contemplação não tem data garantida. Investimento tem risco e rentabilidade futura não garantida. Financiamento garante posse imediata, mas cobra juros. Taxas de administração, seguros e regras variam entre instituições — confira sempre o contrato real. Não é recomendação financeira.",
      ),
    ]),
  );

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Evolução do patrimônio ao longo do tempo"),
      el(
        "p",
        { class: "panel-lead" },
        "Cada linha mostra o patrimônio líquido projetado mês a mês: no consórcio e no financiamento, é o valor do bem (já valorizado ou depreciado) menos o que ainda falta pagar; em investir, é o saldo acumulado líquido de IR — que já inclui o valor do bem, caso comprado à vista ao final.",
      ),
      el("div", { class: "grafico-legenda" }, cards.map((c) => legendaItem(c))),
      graficoLinhas(cards, state.prazoMeses),
    ]),
  );
}

function legendaItem(c) {
  return el("span", { class: "grafico-legenda__item" }, [
    el("span", { class: "grafico-legenda__cor", style: `background:${c.cor}` }),
    c.nome,
  ]);
}

/** Gráfico de linhas simples, em SVG puro (sem biblioteca) - cada série vira
 *  um polyline, escalado pro maior valor entre as três, com marcações de
 *  ano no eixo horizontal. */
function graficoLinhas(cards, prazoMeses) {
  const larguraTotal = 720;
  const alturaTotal = 320;
  const margem = { topo: 20, direita: 20, baixo: 36, esquerda: 76 };
  const larguraUtil = larguraTotal - margem.esquerda - margem.direita;
  const alturaUtil = alturaTotal - margem.topo - margem.baixo;

  const maiorValor = Math.max(1, ...cards.flatMap((c) => c.serieMensal));

  const x = (mesIndex) => margem.esquerda + (mesIndex / (prazoMeses - 1)) * larguraUtil;
  const y = (valor) => margem.topo + alturaUtil - (valor / maiorValor) * alturaUtil;

  const linhas = cards
    .map((c) => {
      const pontos = c.serieMensal.map((valor, i) => `${x(i).toFixed(1)},${y(valor).toFixed(1)}`).join(" ");
      return `<polyline points="${pontos}" fill="none" stroke="${c.cor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join("");

  const guias = [0, 0.5, 1]
    .map((frac) => {
      const valor = maiorValor * frac;
      const posY = y(valor);
      return `<line x1="${margem.esquerda}" y1="${posY.toFixed(1)}" x2="${larguraTotal - margem.direita}" y2="${posY.toFixed(1)}" stroke="var(--color-border)" stroke-width="1" /><text x="${(margem.esquerda - 10).toFixed(1)}" y="${(posY + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--color-muted-foreground)">${brlCompacto(valor)}</text>`;
    })
    .join("");

  const totalAnos = Math.round(prazoMeses / 12);
  const passoAnos = totalAnos > 10 ? 2 : 1;
  const marcasAno = [];
  for (let ano = 0; ano <= totalAnos; ano += passoAnos) {
    const mesIndex = Math.min(ano * 12, prazoMeses - 1);
    marcasAno.push(
      `<text x="${x(mesIndex).toFixed(1)}" y="${alturaTotal - 10}" text-anchor="middle" font-size="11" fill="var(--color-muted-foreground)">${ano}a</text>`,
    );
  }

  const svg = `<svg viewBox="0 0 ${larguraTotal} ${alturaTotal}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gráfico comparando o patrimônio líquido projetado nos três cenários">${guias}${linhas}${marcasAno.join("")}</svg>`;

  return el("div", { class: "grafico-wrap", html: svg });
}

function brlCompacto(valor) {
  if (valor >= 1000000) return `R$ ${(valor / 1000000).toFixed(1)}M`;
  if (valor >= 1000) return `R$ ${(valor / 1000).toFixed(0)}k`;
  return brl(valor);
}

function cardResultado(c, destaque) {
  return el("div", { class: `card-resultado${destaque ? " card-resultado--destaque" : ""}` }, [
    destaque ? el("span", { class: "card-resultado__selo" }, "Maior patrimônio projetado") : null,
    el("h3", {}, [el("span", { class: "card-resultado__dot", style: `background:${c.cor}` }), c.nome]),
    el("div", { class: "card-resultado__stat card-resultado__stat--total" }, [
      el("span", { class: "card-resultado__label" }, "Patrimônio final"),
      el("span", { class: "card-resultado__value" }, brl(c.patrimonioFinal)),
    ]),
    ...c.linhas.map(([label, value]) =>
      el("div", { class: "card-resultado__stat" }, [
        el("span", { class: "card-resultado__label" }, label),
        el("span", { class: "card-resultado__value" }, value),
      ]),
    ),
    el("p", { class: "card-resultado__nota" }, c.nota),
  ]);
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initConsorcioApp();
});