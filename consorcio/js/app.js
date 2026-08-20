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
  });
}

/**
 * Simula um consórcio mês a mês. O saldo devedor já nasce com a taxa de
 * administração embutida, e é reajustado uma vez por ano pelo índice
 * informado (igual IGPM/INCC fazem na vida real). A parcela de cada mês é
 * sempre saldo-devedor-atual dividido pelos meses restantes - por isso ela
 * sobe ao longo do tempo, mesmo o "juro" sendo zero por nome.
 *
 * Também devolve o patrimônio (valor do bem valorizado menos saldo devedor)
 * mês a mês, pra alimentar o gráfico de evolução.
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

  return {
    totalPago,
    parcelas,
    serieMensal,
    primeiraParcela: parcelas[0],
    ultimaParcela: parcelas[parcelas.length - 1],
  };
}

/** Quem não faz consórcio investe, mês a mês, o mesmo valor que estaria
 *  pagando de parcela naquele mês (fluxo de caixa igual, pra comparação
 *  justa) - rendendo à taxa informada. */
function simularInvestirEquivalente({ parcelasConsorcio, taxaAnualPct }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = 0;
  let totalAportado = 0;
  const serieMensal = [];
  for (const parcela of parcelasConsorcio) {
    saldo = saldo * (1 + taxaMensal) + parcela;
    totalAportado += parcela;
    serieMensal.push(saldo);
  }
  return { saldoFinal: saldo, totalAportado, totalJuros: saldo - totalAportado, serieMensal };
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

  return { totalPago, totalJuros, primeiraParcela, serieMensal };
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
  renderResultado(root);
}

function render(root) {
  clear(root);

  const dadosCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Os dados do seu consórcio"),
    moneyField("Valor do bem / carta de crédito", "valorBem", root),
    numberField("Prazo (meses)", "prazoMeses", root),
    percentField("Taxa de administração total (%)", "taxaAdministracaoPct", root, "Some no contrato — costuma ficar entre 15% e 25%."),
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
      "Use negativo pra depreciação (ex: -8 para um carro perdendo valor).",
    ),
  ]);

  const financiamentoCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Se você financiasse no banco, em vez de consorciar"),
    el(
      "p",
      { class: "panel-lead" },
      "Usa o mesmo valor e o mesmo prazo do consórcio acima — só muda a taxa de juros, no sistema SAC (parcela vai diminuindo com o tempo).",
    ),
    percentField("Taxa do financiamento (% ao ano)", "taxaFinanciamentoAnualPct", root),
  ]);

  const investirCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Se você investisse, em vez de consorciar"),
    el(
      "p",
      { class: "panel-lead" },
      "Investe, todo mês, o mesmo valor que seria a parcela do consórcio naquele mês, rendendo a taxa abaixo.",
    ),
    el("div", { class: "cdi-info", id: "cdi-info" }),
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
      el("p", { class: "cdi-info__value" }, `CDI atual: ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% ao ano`),
      el("p", { class: "cdi-info__meta" }, `Referência: ${state.cdiDataRef ?? "—"}`),
    );
  } else if (state.cdiError) {
    box.append(el("p", { class: "cdi-info__error" }, `Não foi possível buscar o CDI agora. ${state.cdiError}`));
  } else {
    box.append(el("p", { class: "cdi-info__meta" }, "Buscando taxa CDI…"));
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
  });

  const financiamento = simularFinanciamentoSAC({
    valorBem: state.valorBem,
    prazoMeses: state.prazoMeses,
    taxaAnualPct: state.taxaFinanciamentoAnualPct,
    valorizacaoBemAnualPct: state.valorizacaoBemAnualPct,
  });

  const valorBemFinal = state.valorBem * Math.pow(1 + state.valorizacaoBemAnualPct / 100, state.prazoMeses / 12);

  const patrimonioConsorcio = consorcio.serieMensal[consorcio.serieMensal.length - 1];
  const patrimonioInvestir = investir.saldoFinal;
  const patrimonioFinanciamento = financiamento.serieMensal[financiamento.serieMensal.length - 1];

  const cards = [
    {
      nome: "Consórcio",
      cor: "#ff3b30",
      patrimonioFinal: patrimonioConsorcio,
      totalPago: consorcio.totalPago,
      serieMensal: consorcio.serieMensal,
      extra: [
        ["1ª parcela", brl(consorcio.primeiraParcela)],
        ["Última parcela", brl(consorcio.ultimaParcela)],
        ["Custo da administração", brl(consorcio.totalPago - state.valorBem)],
      ],
      nota: "Presume que a carta foi contemplada a tempo de usar o bem por todo o prazo — na prática, a contemplação depende de sorteio ou lance.",
    },
    {
      nome: "Investir e comprar à vista depois",
      cor: "#22e0e0",
      patrimonioFinal: patrimonioInvestir,
      totalPago: investir.totalAportado,
      serieMensal: investir.serieMensal,
      extra: [
        ["Total investido", brl(investir.totalAportado)],
        ["Rendimento acumulado", brl(investir.totalJuros)],
        [
          "Dá pra comprar o bem?",
          patrimonioInvestir >= valorBemFinal ? "Sim, e sobra troco" : "Ainda não, falta " + brl(valorBemFinal - patrimonioInvestir),
        ],
      ],
      nota: `Investe, todo mês, o mesmo valor que seria a parcela do consórcio naquele mês, rendendo ${state.cdiAnualPct
        .toFixed(1)
        .replace(".", ",")}% a.a. (CDI atual).`,
    },
    {
      nome: "Financiamento (SAC)",
      cor: "#f5b942",
      patrimonioFinal: patrimonioFinanciamento,
      totalPago: financiamento.totalPago,
      serieMensal: financiamento.serieMensal,
      extra: [
        ["1ª parcela", brl(financiamento.primeiraParcela)],
        ["Total em juros", brl(financiamento.totalJuros)],
        ["Posse do bem", "Imediata, desde o mês 1"],
      ],
      nota: "Diferente do consórcio, você tem o bem em mãos desde o primeiro mês — não depende de sorteio.",
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
        "Simulação educacional. Taxas de administração, índices de reajuste e regras variam entre administradoras — confira sempre o contrato real antes de decidir. Não é recomendação financeira.",
      ),
    ]),
  );

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Evolução do patrimônio ao longo do tempo"),
      el(
        "p",
        { class: "panel-lead" },
        "Cada linha mostra o quanto você teria de patrimônio (bem menos dívida, ou saldo investido) mês a mês, em cada caminho.",
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

  const svg = `<svg viewBox="0 0 ${larguraTotal} ${alturaTotal}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Gráfico comparando a evolução do patrimônio nos três cenários">${guias}${linhas}${marcasAno.join("")}</svg>`;

  return el("div", { class: "grafico-wrap", html: svg });
}

function brlCompacto(valor) {
  if (valor >= 1000000) return `R$ ${(valor / 1000000).toFixed(1)}M`;
  if (valor >= 1000) return `R$ ${(valor / 1000).toFixed(0)}k`;
  return brl(valor);
}

function cardResultado(c, destaque) {
  return el("div", { class: `card-resultado${destaque ? " card-resultado--destaque" : ""}` }, [
    destaque ? el("span", { class: "card-resultado__selo" }, "Melhor patrimônio final") : null,
    el("h3", {}, [el("span", { class: "card-resultado__dot", style: `background:${c.cor}` }), c.nome]),
    el("div", { class: "card-resultado__stat card-resultado__stat--total" }, [
      el("span", { class: "card-resultado__label" }, "Patrimônio ao final"),
      el("span", { class: "card-resultado__value" }, brl(c.patrimonioFinal)),
    ]),
    el("div", { class: "card-resultado__stat" }, [
      el("span", { class: "card-resultado__label" }, "Total pago no período"),
      el("span", { class: "card-resultado__value" }, brl(c.totalPago)),
    ]),
    ...c.extra.map(([label, value]) =>
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