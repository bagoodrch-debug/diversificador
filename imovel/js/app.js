import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const DEFAULTS = {
  aluguelMensal: 2000,
  valorImovel: 400000,
  entrada: 80000,
  taxaFinanciamentoAnual: 10.5,
  prazoAnos: 30,
  sistema: "sac",
  valorizacaoAnual: 4,
  reajusteAluguelAnual: 5,
  custosAquisicaoPct: 4,
};

const ANOS_TABELA = [5, 10, 15, 20, 25, 30, 35];

const state = { ...DEFAULTS, cdiAnualPct: null, cdiError: null, cdiDataRef: null };

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) Object.assign(state, DEFAULTS, saved);
}
function persist() {
  save(KEYS.STATE, {
    aluguelMensal: state.aluguelMensal,
    valorImovel: state.valorImovel,
    entrada: state.entrada,
    taxaFinanciamentoAnual: state.taxaFinanciamentoAnual,
    prazoAnos: state.prazoAnos,
    sistema: state.sistema,
    valorizacaoAnual: state.valorizacaoAnual,
    reajusteAluguelAnual: state.reajusteAluguelAnual,
    custosAquisicaoPct: state.custosAquisicaoPct,
  });
}

/**
 * Simula, mês a mês, o patrimônio de quem financia o imóvel vs. de quem
 * aluga e investe a diferença (mesmo aporte inicial da entrada + custos de
 * aquisição, mais a diferença mensal entre a prestação e o aluguel).
 */
function simular({
  aluguelMensal,
  valorImovel,
  entrada,
  taxaFinanciamentoAnual,
  prazoAnos,
  sistema,
  valorizacaoAnual,
  reajusteAluguelAnual,
  custosAquisicaoPct,
  taxaInvestimentoAnual,
}) {
  const custosAquisicao = valorImovel * (custosAquisicaoPct / 100);
  const financiado = Math.max(valorImovel - entrada, 0);
  const prazoMeses = Math.round(prazoAnos * 12);
  const taxaFinMensal = Math.pow(1 + taxaFinanciamentoAnual / 100, 1 / 12) - 1;
  const taxaInvMensal = Math.pow(1 + (taxaInvestimentoAnual ?? 0) / 100, 1 / 12) - 1;
  const valorizacaoMensal = Math.pow(1 + valorizacaoAnual / 100, 1 / 12) - 1;

  const amortizacaoConstante = financiado / prazoMeses;
  let prestacaoPriceFixa = null;
  if (sistema === "price") {
    const i = taxaFinMensal;
    const n = prazoMeses;
    prestacaoPriceFixa = i > 0 ? (financiado * (i * Math.pow(1 + i, n))) / (Math.pow(1 + i, n) - 1) : financiado / n;
  }

  let saldoDevedor = financiado;
  let valorImovelAtual = valorImovel;
  let aluguelAtual = aluguelMensal;
  let saldoInvestido = entrada + custosAquisicao;

  const HORIZONTE_MESES = Math.max(prazoMeses, 35 * 12);
  let mesCompensa = null;
  const serieAnual = [];
  let primeiraPrestacao = null;

  for (let mes = 1; mes <= HORIZONTE_MESES; mes++) {
    // Reajuste anual do aluguel (contratos no Brasil reajustam 1x/ano).
    if (mes > 1 && (mes - 1) % 12 === 0) {
      aluguelAtual *= 1 + reajusteAluguelAnual / 100;
    }

    // Prestação do financiamento (se ainda houver saldo devedor).
    let prestacaoMes = 0;
    if (saldoDevedor > 0.01) {
      const juros = saldoDevedor * taxaFinMensal;
      let amortizacao;
      if (sistema === "sac") {
        amortizacao = Math.min(amortizacaoConstante, saldoDevedor);
        prestacaoMes = amortizacao + juros;
      } else {
        prestacaoMes = Math.min(prestacaoPriceFixa, saldoDevedor + juros);
        amortizacao = prestacaoMes - juros;
      }
      saldoDevedor = Math.max(saldoDevedor - amortizacao, 0);
    }
    if (primeiraPrestacao == null && prestacaoMes > 0) primeiraPrestacao = prestacaoMes;

    // Valorização do imóvel.
    valorImovelAtual *= 1 + valorizacaoMensal;

    // Quem aluga investe a diferença (pode ser negativa, quando a prestação
    // já caiu abaixo do aluguel reajustado — aí a "diferença" sai do
    // investimento em vez de entrar).
    const diferenca = prestacaoMes - aluguelAtual;
    saldoInvestido = saldoInvestido * (1 + taxaInvMensal) + diferenca;

    const patrimonioComprar = valorImovelAtual - saldoDevedor;
    const patrimonioAlugar = saldoInvestido;

    if (mesCompensa === null && patrimonioComprar >= patrimonioAlugar) {
      mesCompensa = mes;
    }

    if (mes % 12 === 0) {
      serieAnual.push({ ano: mes / 12, patrimonioComprar, patrimonioAlugar });
    }
  }

  return {
    mesCompensa,
    serieAnual,
    primeiraPrestacao: primeiraPrestacao ?? 0,
    custosAquisicao,
    financiado,
  };
}

export function initImovelApp() {
  loadPersisted();
  const root = qs("#imovel-root");
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

  const principaisCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Os números principais"),
    moneyField("Aluguel mensal", "aluguelMensal", root),
    moneyField("Valor do imóvel", "valorImovel", root),
    moneyField("Entrada disponível", "entrada", root),
    percentField("Taxa do financiamento (% ao ano)", "taxaFinanciamentoAnual", root),
    numberField("Prazo do financiamento (anos)", "prazoAnos", root),
  ]);

  const sistemaToggle = el(
    "div",
    { class: "freq-toggle" },
    [
      ["sac", "SAC (parcelas decrescentes)"],
      ["price", "PRICE (parcelas fixas)"],
    ].map(([value, label]) =>
      el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(state.sistema === value),
          onClick: () => {
            state.sistema = value;
            persist();
            renderResultado(root);
          },
        },
        label,
      ),
    ),
  );

  const premissasCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Premissas"),
    el("p", { class: "panel-lead" }, "Valores padrão razoáveis — ajuste se quiser."),
    el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "Sistema de amortização"), sistemaToggle]),
    percentField("Valorização anual do imóvel (%)", "valorizacaoAnual", root),
    percentField("Reajuste anual do aluguel (%)", "reajusteAluguelAnual", root),
    percentField("Custos de aquisição — ITBI + cartório (%)", "custosAquisicaoPct", root),
    el("div", { class: "cdi-info", id: "cdi-info" }),
  ]);

  root.append(principaisCard, premissasCard, el("div", { id: "resultado-host" }));
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

function percentField(label, key, root) {
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
  return el("div", { class: "field-group" }, [el("label", { class: "field-label" }, label), input]);
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
        `Rendimento de quem aluga: CDI atual, ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% ao ano`,
      ),
      el("p", { class: "cdi-info__meta" }, `Referência: ${state.cdiDataRef ?? "—"}`),
    );
  } else if (state.cdiError) {
    box.append(el("p", { class: "cdi-info__error" }, `Não foi possível buscar o CDI agora. ${state.cdiError}`));
  } else {
    box.append(el("p", { class: "cdi-info__meta" }, "Buscando taxa CDI…"));
  }
}

function formatAnosMeses(totalMeses) {
  const anos = Math.floor(totalMeses / 12);
  const meses = totalMeses % 12;
  const partes = [];
  if (anos > 0) partes.push(`${anos} ano${anos > 1 ? "s" : ""}`);
  if (meses > 0) partes.push(`${meses} ${meses === 1 ? "mês" : "meses"}`);
  return partes.join(" e ") || "menos de 1 mês";
}

function renderResultado(root) {
  const host = qs("#resultado-host", root);
  if (!host) return;
  clear(host);

  if (state.cdiAnualPct == null) {
    host.append(el("p", { class: "disclaimer" }, "Aguardando a taxa CDI carregar para calcular…"));
    return;
  }
  if (state.entrada > state.valorImovel) {
    host.append(el("p", { class: "disclaimer", style: "color:var(--color-destructive)" }, "A entrada não pode ser maior que o valor do imóvel."));
    return;
  }

  const r = simular({
    aluguelMensal: state.aluguelMensal,
    valorImovel: state.valorImovel,
    entrada: state.entrada,
    taxaFinanciamentoAnual: state.taxaFinanciamentoAnual,
    prazoAnos: state.prazoAnos,
    sistema: state.sistema,
    valorizacaoAnual: state.valorizacaoAnual,
    reajusteAluguelAnual: state.reajusteAluguelAnual,
    custosAquisicaoPct: state.custosAquisicaoPct,
    taxaInvestimentoAnual: state.cdiAnualPct,
  });

  const percentualEntrada = state.valorImovel > 0 ? (state.entrada / state.valorImovel) * 100 : 0;

  host.append(
    el("section", { class: "panel card resumo-card" }, [
      el("p", { class: "resumo-linha" }, [
        "Entrada de ",
        el("strong", {}, brl(state.entrada)),
        ` (${percentualEntrada.toFixed(0)}%) + custos de aquisição de `,
        el("strong", {}, brl(r.custosAquisicao)),
        ". Prestação inicial: ",
        el("strong", {}, brl(r.primeiraPrestacao)),
        " (vs. aluguel de ",
        el("strong", {}, brl(state.aluguelMensal)),
        ").",
      ]),
    ]),
  );

  const veredicto =
    r.mesCompensa != null
      ? `A partir de ${formatAnosMeses(r.mesCompensa)}, financiar o imóvel passa a valer mais a pena do que alugar e investir a diferença.`
      : `No horizonte simulado (até ${ANOS_TABELA[ANOS_TABELA.length - 1]} anos), alugar e investir a diferença continua sendo financeiramente melhor do que financiar.`;

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Quando compensa financiar?"),
      el("p", { class: `veredicto${r.mesCompensa != null ? " veredicto--comprar" : " veredicto--alugar"}` }, veredicto),
      el("table", { class: "tabela-patrimonio" }, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Ano"), el("th", {}, "Financiar (patrimônio)"), el("th", {}, "Alugar + investir")])),
        el(
          "tbody",
          {},
          ANOS_TABELA.filter((a) => a <= Math.max(state.prazoAnos, 35))
            .map((ano) => r.serieAnual.find((s) => s.ano === ano))
            .filter(Boolean)
            .map((linha) =>
              el("tr", { class: linha.patrimonioComprar >= linha.patrimonioAlugar ? "linha--comprar" : "linha--alugar" }, [
                el("td", {}, `${linha.ano}`),
                el("td", {}, brl(linha.patrimonioComprar)),
                el("td", {}, brl(linha.patrimonioAlugar)),
              ]),
            ),
        ),
      ]),
      el(
        "p",
        { class: "disclaimer" },
        "Simulação educacional. Considera valorização do imóvel e reajuste de aluguel constantes ao longo do tempo, taxas nominais (sem descontar inflação separadamente), e não inclui IPTU, condomínio, seguros ou manutenção do imóvel (assumidos parecidos em ambos os cenários, já que aluguéis no Brasil geralmente também cobram condomínio e IPTU do inquilino). Não é recomendação financeira — decisões de moradia envolvem fatores além do financeiro.",
      ),
    ]),
  );
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initImovelApp();
});
