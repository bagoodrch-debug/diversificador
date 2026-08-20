import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const DEFAULTS = {
  valorBem: 100000,
  prazoMeses: 60,
  taxaAdministracaoPct: 18,
  reajusteAnualPct: 6,
  valorizacaoBemAnualPct: 4,
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
    valorizacaoBemAnualPct: state.valorizacaoBemAnualPct,
    taxaFinanciamentoAnualPct: state.taxaFinanciamentoAnualPct,
  });
}

/**
 * Simula um consórcio: o saldo devedor já nasce com a taxa de administração
 * embutida, e é reajustado uma vez por ano pelo índice informado (igual
 * IGPM/INCC fazem na vida real). A parcela de cada mês é sempre
 * saldo-devedor-atual dividido pelos meses restantes — por isso ela sobe
 * ao longo do tempo, mesmo o "juro" sendo zero por nome.
 */
function simularConsorcio({ valorBem, prazoMeses, taxaAdministracaoPct, reajusteAnualPct }) {
  let saldoDevedor = valorBem * (1 + taxaAdministracaoPct / 100);
  let mesesRestantes = prazoMeses;
  let totalPago = 0;
  const parcelas = [];

  for (let mes = 1; mes <= prazoMeses; mes++) {
    if (mes > 1 && (mes - 1) % 12 === 0) {
      saldoDevedor *= 1 + reajusteAnualPct / 100;
    }
    const parcela = saldoDevedor / mesesRestantes;
    totalPago += parcela;
    saldoDevedor -= parcela;
    mesesRestantes -= 1;
    parcelas.push(parcela);
  }

  return { totalPago, parcelas, primeiraParcela: parcelas[0], ultimaParcela: parcelas[parcelas.length - 1] };
}

/** Quem não faz consórcio investe, mês a mês, o mesmo valor que estaria
 *  pagando de parcela naquele mês (fluxo de caixa igual, pra comparação
 *  justa) — rendendo à taxa informada. */
function simularInvestirEquivalente({ parcelasConsorcio, taxaAnualPct }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = 0;
  let totalAportado = 0;
  for (const parcela of parcelasConsorcio) {
    saldo = saldo * (1 + taxaMensal) + parcela;
    totalAportado += parcela;
  }
  return { saldoFinal: saldo, totalAportado, totalJuros: saldo - totalAportado };
}

/** Financiamento SAC padrão: amortização constante, parcela decrescente. */
function simularFinanciamentoSAC({ valorBem, prazoMeses, taxaAnualPct }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  const amortizacaoConstante = valorBem / prazoMeses;
  let saldoDevedor = valorBem;
  let totalJuros = 0;
  let totalPago = 0;
  let primeiraParcela = null;

  for (let mes = 1; mes <= prazoMeses; mes++) {
    const juros = saldoDevedor * taxaMensal;
    const parcela = amortizacaoConstante + juros;
    if (primeiraParcela == null) primeiraParcela = parcela;
    totalJuros += juros;
    totalPago += parcela;
    saldoDevedor -= amortizacaoConstante;
  }

  return { totalPago, totalJuros, primeiraParcela };
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

  const card = el("section", { class: "panel card" }, [
    el("h2", {}, "Os dados do seu consórcio"),
    moneyField("Valor do bem / carta de crédito", "valorBem", root),
    numberField("Prazo (meses)", "prazoMeses", root),
    percentField("Taxa de administração total (%)", "taxaAdministracaoPct", root, "Some no contrato — costuma ficar entre 15% e 25%."),
    percentField("Reajuste anual do saldo (%)", "reajusteAnualPct", root, "IGPM, INCC ou IPCA, dependendo do bem — confira no seu contrato."),
  ]);

  const premissasCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Premissas da comparação"),
    percentField("Valorização anual do bem (%)", "valorizacaoBemAnualPct", root, "Quanto o bem (imóvel, carro) deve se valorizar por ano."),
    percentField("Taxa do financiamento SAC (% ao ano)", "taxaFinanciamentoAnualPct", root, "Pra comparar com a opção de financiar em vez de consorciar."),
    el("div", { class: "cdi-info", id: "cdi-info" }),
  ]);

  root.append(card, premissasCard, el("div", { id: "resultado-host" }));
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
      const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
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
        { class: "cdi-info__value" },
        `Rendimento usado na comparação: CDI atual, ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% ao ano`,
      ),
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
  });

  const investir = simularInvestirEquivalente({
    parcelasConsorcio: consorcio.parcelas,
    taxaAnualPct: state.cdiAnualPct,
  });

  const financiamento = simularFinanciamentoSAC({
    valorBem: state.valorBem,
    prazoMeses: state.prazoMeses,
    taxaAnualPct: state.taxaFinanciamentoAnualPct,
  });

  const valorBemFinal = state.valorBem * Math.pow(1 + state.valorizacaoBemAnualPct / 100, state.prazoMeses / 12);

  const patrimonioConsorcio = valorBemFinal; // ao fim do prazo, presume-se quitado
  const patrimonioInvestir = investir.saldoFinal; // ainda não comprou o bem — é o saldo em caixa
  const patrimonioFinanciamento = valorBemFinal; // também quitado ao fim do prazo, mesmo horizonte

  const cards = [
    {
      nome: "Consórcio",
      patrimonioFinal: patrimonioConsorcio,
      totalPago: consorcio.totalPago,
      extra: [
        ["1ª parcela", brl(consorcio.primeiraParcela)],
        ["Última parcela", brl(consorcio.ultimaParcela)],
        ["Custo da administração", brl(consorcio.totalPago - state.valorBem)],
      ],
      nota: "Presume que a carta foi contemplada a tempo de usar o bem por todo o prazo — na prática, a contemplação depende de sorteio ou lance.",
    },
    {
      nome: "Investir e comprar à vista depois",
      patrimonioFinal: patrimonioInvestir,
      totalPago: investir.totalAportado,
      extra: [
        ["Total investido", brl(investir.totalAportado)],
        ["Rendimento acumulado", brl(investir.totalJuros)],
        ["Dá pra comprar o bem?", patrimonioInvestir >= valorBemFinal ? "Sim, e sobra troco" : "Ainda não, falta " + brl(valorBemFinal - patrimonioInvestir)],
      ],
      nota: `Investe, todo mês, o mesmo valor que seria a parcela do consórcio naquele mês, rendendo ${state.cdiAnualPct.toFixed(1).replace(".", ",")}% a.a. (CDI atual).`,
    },
    {
      nome: "Financiamento (SAC)",
      patrimonioFinal: patrimonioFinanciamento,
      totalPago: financiamento.totalPago,
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
}

function cardResultado(c, destaque) {
  return el("div", { class: `card-resultado${destaque ? " card-resultado--destaque" : ""}` }, [
    destaque ? el("span", { class: "card-resultado__selo" }, "Melhor patrimônio final") : null,
    el("h3", {}, c.nome),
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
