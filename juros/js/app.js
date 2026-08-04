import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";

const DEFAULTS = {
  valorInicial: 1000,
  aporteMensal: 300,
  taxa: 10,
  taxaPeriodo: "ano", // "ano" ou "mes"
  tempo: 10,
  tempoPeriodo: "ano", // "ano" ou "mes"
};

const state = { ...DEFAULTS };

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) Object.assign(state, DEFAULTS, saved);
}
function persist() {
  save(KEYS.STATE, { ...state });
}

/** Simula mês a mês, devolvendo o saldo final e a série anual. */
function simular({ valorInicial, aporteMensal, taxa, taxaPeriodo, tempo, tempoPeriodo }) {
  const taxaMensal = taxaPeriodo === "ano" ? Math.pow(1 + taxa / 100, 1 / 12) - 1 : taxa / 100;
  const meses = tempoPeriodo === "ano" ? Math.round(tempo * 12) : Math.round(tempo);

  let saldo = valorInicial;
  let totalAportado = valorInicial;
  const serieAnual = [];

  for (let mes = 1; mes <= meses; mes++) {
    saldo = saldo * (1 + taxaMensal) + aporteMensal;
    totalAportado += aporteMensal;
    if (mes % 12 === 0 || mes === meses) {
      serieAnual.push({ mes, saldo, totalAportado, juros: saldo - totalAportado });
    }
  }

  return {
    valorFinal: saldo,
    totalAportado,
    totalJuros: saldo - totalAportado,
    serieAnual,
  };
}

export function initJurosApp() {
  loadPersisted();
  const root = qs("#juros-root");
  if (!root) return;
  render(root);
}

function render(root) {
  clear(root);

  const valorInicialInput = moneyField(state.valorInicial, (v) => {
    state.valorInicial = v;
    persist();
    renderResultado(root);
  });
  const aporteInput = moneyField(state.aporteMensal, (v) => {
    state.aporteMensal = v;
    persist();
    renderResultado(root);
  });

  const taxaInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state.taxa),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
      state.taxa = Number.isFinite(n) ? n : 0;
      persist();
      renderResultado(root);
    },
  });
  const taxaPeriodoToggle = periodoToggle(state.taxaPeriodo, ["mes", "% ao mês"], ["ano", "% ao ano"], (v) => {
    state.taxaPeriodo = v;
    persist();
    render(root);
  });

  const tempoInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state.tempo),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
      state.tempo = Number.isFinite(n) && n > 0 ? n : 1;
      persist();
      renderResultado(root);
    },
  });
  const tempoPeriodoToggle = periodoToggle(state.tempoPeriodo, ["mes", "Meses"], ["ano", "Anos"], (v) => {
    state.tempoPeriodo = v;
    persist();
    render(root);
  });

  const card = el("section", { class: "panel card" }, [
    el("h2", {}, "Seus dados"),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Valor inicial"), valorInicialInput]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Aporte mensal"), aporteInput]),
    ]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Taxa de juros"), taxaInput, taxaPeriodoToggle]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Tempo"), tempoInput, tempoPeriodoToggle]),
    ]),
  ]);

  root.append(card, el("div", { id: "resultado-host" }));
  renderResultado(root);
}

function moneyField(valor, onChange) {
  return el("input", {
    class: "field",
    inputmode: "numeric",
    value: formatCurrencyInput(valor),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseCurrencyInput(e.target.value);
      e.target.value = formatCurrencyInput(n);
      onChange(n);
    },
  });
}

function periodoToggle(atual, [valorA, labelA], [valorB, labelB], onChange) {
  const botoes = [];
  const wrap = el(
    "div",
    { class: "freq-toggle", style: "margin-top:.5rem" },
    [
      [valorA, labelA],
      [valorB, labelB],
    ].map(([value, label]) => {
      const btn = el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(atual === value),
          onClick: () => onChange(value),
        },
        label,
      );
      botoes.push(btn);
      return btn;
    }),
  );
  return wrap;
}

function renderResultado(root) {
  const host = qs("#resultado-host", root);
  if (!host) return;
  clear(host);

  const r = simular(state);

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Resultado"),
      el("div", { class: "resultado-grid" }, [
        resultItem("Valor final", brl(r.valorFinal)),
        resultItem("Total investido", brl(r.totalAportado)),
        resultItem("Total em juros", brl(r.totalJuros)),
      ]),
      el("table", { class: "tabela-anual" }, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Ano"), el("th", {}, "Total investido"), el("th", {}, "Juros acumulados"), el("th", {}, "Saldo")])),
        el(
          "tbody",
          {},
          r.serieAnual.map((linha, i) =>
            el("tr", {}, [
              el("td", {}, `${i + 1}`),
              el("td", {}, brl(linha.totalAportado)),
              el("td", {}, brl(linha.juros)),
              el("td", {}, brl(linha.saldo)),
            ]),
          ),
        ),
      ]),
      el(
        "p",
        { class: "disclaimer" },
        "Simulação educacional com taxa de juros constante durante todo o período (na prática, taxas de investimento variam com o tempo). Não é recomendação de investimento.",
      ),
    ]),
  );
}

function resultItem(label, value) {
  return el("div", { class: "result-item" }, [
    el("span", { class: "result-item__label" }, label),
    el("span", { class: "result-item__value" }, value),
  ]);
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initJurosApp();
});
