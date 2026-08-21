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
  valorInicialInvestido: 0,
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
    valorInicialInvestido: state.valorInicialInvestido,
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
 *  não uma multiplicação anual simplificada), começando de um valor que a
 *  pessoa já tinha guardado. Imposto de Renda incide só sobre o
 *  rendimento (nunca sobre o capital), usando a alíquota regressiva pelo
 *  prazo total — modelo simples: CDB básico, 100% do CDI. */
function simularInvestirEquivalente({ parcelasConsorcio, taxaAnualPct, prazoMeses, valorInicial }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = valorInicial;
  let totalAportado = 0;
  const serieMensal = [];
  for (const parcela of parcelasConsorcio) {
    saldo = saldo * (1 + taxaMensal) + parcela;
    totalAportado += parcela;
    serieMensal.push(saldo);
  }

  const totalInvestido = totalAportado + valorInicial;
  const rendimentoBruto = saldo - totalInvestido;
  const aliquotaIR = aliquotaIRRegressiva(prazoMeses * 30);
  const ir = Math.max(rendimentoBruto, 0) * aliquotaIR;
  const rendimentoLiquido = rendimentoBruto - ir;
  const saldoFinalLiquido = totalInvestido + rendimentoLiquido;

  // A série mensal (pro gráfico) é ajustada proporcionalmente pra refletir
  // o líquido também, sem precisar re-simular mês a mês o IR.
  const fatorLiquido = saldo > 0 ? saldoFinalLiquido / saldo : 1;
  const serieMensalLiquida = serieMensal.map((v) => v * fatorLiquido);

  // Quanto tempo a mais seria preciso pra chegar no mesmo patrimônio final
  // aportando a mesma média mensal, mas sem nenhum rendimento — essa
  // diferença é "o tempo que os juros economizaram" pra você.
  const mediaAporteMensal = totalAportado / prazoMeses;
  const mesesSemJuros = mediaAporteMensal > 0 ? (saldoFinalLiquido - valorInicial) / mediaAporteMensal : prazoMeses;
  const tempoEconomizadoMeses = Math.max(Math.round(mesesSemJuros - prazoMeses), 0);

  return {
    saldoFinalBruto: saldo,
    saldoFinalLiquido,
    totalAportado,
    valorInicial,
    totalInvestido,
    rendimentoBruto,
    aliquotaIR,
    ir,
    rendimentoLiquido,
    tempoEconomizadoMeses,
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
    percentField("Taxa de administração total (%)", "taxaAdministracaoPct", root, "Costuma ficar entre 15% e 25% — confira no contrato."),
    percentField("Reajuste anual do saldo (%)", "reajusteAnualPct", root, "IGPM, INCC ou IPCA, dependendo do bem."),
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
      el("p", { class: "field-ajuda" }, "Já sugerimos uma valorização típica pra cada tipo — ajuste se quiser."),
    ]),
    percentField("Valorização anual do bem (%)", "valorizacaoBemAnualPct", root, "Negativo pra depreciação (ex: -8 pra um carro)."),
  ]);

  const financiamentoSub = el("div", { class: "premissa-sub" }, [
    el("h3", {}, "Se financiasse no banco"),
    el("p", { class: "panel-lead" }, "Mesmo valor e prazo do consórcio, no sistema SAC (parcela decrescente)."),
    percentField("Taxa do financiamento (% ao ano)", "taxaFinanciamentoAnualPct", root),
  ]);

  const investirSub = el("div", { class: "premissa-sub" }, [
    el("h3", {}, "Se investisse"),
    el(
      "p",
      { class: "panel-lead" },
      "CDB Básico, 100% do CDI. Aporta, todo mês, o valor que seria a parcela do consórcio.",
    ),
    el("div", { class: "cdi-info-compacta", id: "cdi-info" }),
    moneyField(
      "Quanto você já tem guardado hoje",
      "valorInicialInvestido",
      root,
      "Esse valor entra rendendo desde o mês 1, junto com os aportes mensais.",
    ),
  ]);

  const premissasCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Premissas da comparação"),
    financiamentoSub,
    investirSub,
  ]);

  root.append(dadosCard, bemCard, premissasCard, el("div", { id: "resultado-host" }));
  renderCdiInfo(root);
  renderResultado(root);
}

function moneyField(label, key, root, ajuda) {
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
  return el("div", { class: "field-group" }, [
    el("label", { class: "field-label" }, label),
    input,
    ajuda ? el("p", { class: "field-ajuda" }, ajuda) : null,
  ]);
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
    valorInicial: state.valorInicialInvestido,
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
      destaques: [
        ["Total pago", brl(consorcio.totalPago)],
        ["Parcela inicial → final", `${brl(consorcio.primeiraParcela)} → ${brl(consorcio.ultimaParcela)}`],
      ],
      detalhes: [
        ["Valor original", brl(consorcio.valorOriginal)],
        ["Taxa de administração", brl(consorcio.taxaAdministracaoNominal)],
        ["Efeito dos reajustes", brl(consorcio.efeitoReajustes)],
        ["Valor do bem no final", brl(valorBemFinal)],
      ],
      nota: "Presume contemplação a tempo de usar o bem no prazo — não é garantida.",
    },
    {
      nome: "Investir e comprar à vista depois",
      cor: "#22e0e0",
      patrimonioFinal: patrimonioInvestir,
      serieMensal: investir.serieMensal,
      destaques: [
        ["Total investido", brl(investir.totalInvestido)],
        [dinheiroQueSobra >= 0 ? "Sobra após a compra" : "Ainda faltaria pra comprar o bem", brl(Math.abs(dinheiroQueSobra))],
      ],
      detalhes: [
        ["Já tinha guardado", brl(investir.valorInicial)],
        ["Aporte mensal (mesmo da parcela)", `${brl(consorcio.primeiraParcela)} → ${brl(consorcio.ultimaParcela)}`],
        ["Rendimento bruto", brl(investir.rendimentoBruto)],
        [`IR (${(investir.aliquotaIR * 100).toFixed(1).replace(".", ",")}%)`, brl(investir.ir)],
        ["Rendimento líquido", brl(investir.rendimentoLiquido)],
        ["Valor do bem comprado", brl(Math.min(patrimonioInvestir, valorBemFinal))],
        [
          "Tempo que os juros economizaram",
          investir.tempoEconomizadoMeses > 0 ? `${investir.tempoEconomizadoMeses} meses a menos` : "—",
        ],
      ],
      nota: "O bem já está incluído no patrimônio, como se fosse comprado à vista ao final.",
    },
    {
      nome: "Financiamento (SAC)",
      cor: "#f5b942",
      patrimonioFinal: patrimonioFinanciamento,
      serieMensal: financiamento.serieMensal,
      destaques: [
        ["Total pago", brl(financiamento.totalPago)],
        ["Parcela inicial → final", `${brl(financiamento.primeiraParcela)} → ${brl(financiamento.ultimaParcela)}`],
      ],
      detalhes: [
        ["Total de juros", brl(financiamento.totalJuros)],
        ["Valor do bem no final", brl(valorBemFinal)],
      ],
      nota: "Posse imediata desde o mês 1 — não depende de sorteio nem lance.",
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
        "Resultado baseado nas premissas informadas acima — mude qualquer campo e recalcula na hora. Investimento tem risco; financiamento cobra juros; contemplação do consórcio não tem data garantida. Não é recomendação financeira.",
      ),
    ]),
  );

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Evolução do patrimônio ao longo do tempo"),
      el(
        "p",
        { class: "panel-lead" },
        "Patrimônio líquido projetado, mês a mês, em cada caminho.",
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
    ...c.destaques.map(([label, value]) =>
      el("div", { class: "card-resultado__stat" }, [
        el("span", { class: "card-resultado__label" }, label),
        el("span", { class: "card-resultado__value" }, value),
      ]),
    ),
    el("details", { class: "card-resultado__detalhes" }, [
      el("summary", {}, "Ver detalhes"),
      ...c.detalhes.map(([label, value]) =>
        el("div", { class: "card-resultado__stat" }, [
          el("span", { class: "card-resultado__label" }, label),
          el("span", { class: "card-resultado__value" }, value),
        ]),
      ),
    ]),
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