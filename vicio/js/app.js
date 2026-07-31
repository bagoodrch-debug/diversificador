import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const PRESETS = [
  { label: "Cigarro", nome: "Cigarro", valor: 12, frequencia: "dia" },
  { label: "Café", nome: "Café", valor: 8, frequencia: "dia" },
  { label: "iFood / Delivery", nome: "iFood", valor: 45, frequencia: "semana" },
  { label: "Lanche", nome: "Lanche", valor: 25, frequencia: "semana" },
  { label: "Vape", nome: "Vape (pod descartável)", valor: 80, frequencia: "semana" },
  { label: "Streaming", nome: "Assinatura de streaming", valor: 40, frequencia: "mes" },
];

const DEFAULTS = {
  nome: "Cigarro",
  valor: 12,
  frequencia: "dia",
  usarCdiAuto: true,
  taxaManualPct: 11,
  percentualCdi: 100,
};

const PERIODOS = [
  { anos: 1, label: "1 ano" },
  { anos: 5, label: "5 anos" },
  { anos: 10, label: "10 anos" },
];

const state = { ...DEFAULTS, cdiAnualPct: null, cdiError: null, cdiDataRef: null };

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) Object.assign(state, DEFAULTS, saved);
}
function persist() {
  save(KEYS.STATE, {
    nome: state.nome,
    valor: state.valor,
    frequencia: state.frequencia,
    usarCdiAuto: state.usarCdiAuto,
    taxaManualPct: state.taxaManualPct,
    percentualCdi: state.percentualCdi,
  });
}

function paraMensal(valor, frequencia) {
  if (frequencia === "dia") return valor * 30.44;
  if (frequencia === "semana") return valor * 4.348;
  return valor;
}

function taxaEfetiva() {
  const base = state.usarCdiAuto ? state.cdiAnualPct : state.taxaManualPct;
  if (base == null) return null;
  return base * (state.percentualCdi / 100);
}

/** Aporte mensal fixo, juros compostos mês a mês. */
function projetar({ aporteMensal, taxaAnualPct, meses }) {
  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = 0;
  for (let i = 0; i < meses; i++) saldo = saldo * (1 + taxaMensal) + aporteMensal;
  return saldo;
}

export function initVicioApp() {
  const root = qs("#vicio-root");
  if (!root) return;
  loadPersisted();
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
  renderCdiInfo(root);
}

function render(root) {
  clear(root);

  const presetRow = el(
    "div",
    { class: "preset-row" },
    PRESETS.map((p) =>
      el(
        "button",
        {
          type: "button",
          class: "preset-chip",
          "aria-pressed": String(state.nome === p.nome),
          onClick: () => {
            state.nome = p.nome;
            state.valor = p.valor;
            state.frequencia = p.frequencia;
            persist();
            render(root);
          },
        },
        p.label,
      ),
    ),
  );

  const nomeInput = el("input", {
    class: "field",
    value: state.nome,
    placeholder: "Ex: Cigarro, café, iFood…",
    onInput: (e) => {
      state.nome = e.target.value;
      persist();
      renderResultado(root);
    },
  });

  const valorInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: formatCurrencyInput(state.valor),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseCurrencyInput(e.target.value);
      e.target.value = formatCurrencyInput(n);
      state.valor = n;
      persist();
      renderResultado(root);
    },
  });

  const freqRow = el(
    "div",
    { class: "freq-toggle" },
    [
      ["dia", "Por dia"],
      ["semana", "Por semana"],
      ["mes", "Por mês"],
    ].map(([value, label]) =>
      el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(state.frequencia === value),
          onClick: () => {
            state.frequencia = value;
            persist();
            render(root);
          },
        },
        label,
      ),
    ),
  );

  const gastoCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Qual é o seu gasto?"),
    el("p", { class: "panel-lead" }, "Escolha um exemplo ou preencha o seu."),
    presetRow,
    el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "Nome do gasto"), nomeInput]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Valor"), valorInput]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Frequência"), freqRow]),
    ]),
  ]);

  const cdiInfoBox = el("div", { class: "cdi-info", id: "cdi-info" });
  const manualField = field({
    label: "Taxa (% ao ano)",
    value: state.taxaManualPct,
    isPercent: true,
    onChange: (v) => {
      state.taxaManualPct = v;
      persist();
      renderResultado(root);
    },
  });
  cdiInfoBox.style.display = state.usarCdiAuto ? "" : "none";
  manualField.style.display = state.usarCdiAuto ? "none" : "";

  const taxaCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Se você investisse em vez de gastar"),
    el("p", { class: "panel-lead" }, "Assumimos que o valor renderia baseado no CDI."),
    el("label", { class: "taxa-auto-toggle" }, [
      el("input", {
        type: "checkbox",
        checked: state.usarCdiAuto || undefined,
        onChange: (e) => {
          state.usarCdiAuto = e.target.checked;
          cdiInfoBox.style.display = state.usarCdiAuto ? "" : "none";
          manualField.style.display = state.usarCdiAuto ? "none" : "";
          persist();
          renderResultado(root);
        },
      }),
      el("span", {}, "Usar o CDI atual automaticamente"),
    ]),
    cdiInfoBox,
    manualField,
    field({
      label: "Seu investimento rende quantos % do CDI?",
      value: state.percentualCdi,
      isPercent: true,
      onChange: (v) => {
        state.percentualCdi = v;
        persist();
        renderResultado(root);
      },
    }),
  ]);

  root.append(gastoCard, taxaCard, el("div", { id: "resultado-host" }));
  renderResultado(root);
  renderCdiInfo(root);
}

function field({ label, value, onChange, isPercent = false }) {
  const input = el("input", {
    class: "field",
    inputmode: "numeric",
    value: isPercent ? String(value) : formatCurrencyInput(value),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      if (isPercent) {
        const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
        onChange(Number.isFinite(n) ? n : 0);
      } else {
        const n = parseCurrencyInput(e.target.value);
        e.target.value = formatCurrencyInput(n);
        onChange(n);
      }
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

  const aporteMensal = paraMensal(state.valor, state.frequencia);
  const aporteAnual = aporteMensal * 12;
  const taxa = taxaEfetiva();

  const resumo = el("section", { class: "panel card resumo-card" }, [
    el("p", { class: "resumo-linha" }, [
      "Você gasta ",
      el("strong", {}, brl(aporteMensal)),
      " por mês com ",
      el("strong", {}, state.nome || "isso"),
      " — ",
      el("strong", {}, brl(aporteAnual)),
      " por ano.",
    ]),
  ]);
  host.append(resumo);

  if (taxa == null) {
    host.append(el("p", { class: "disclaimer" }, "Informe a taxa (ou aguarde o CDI carregar) para ver a projeção."));
    return;
  }

  const projecoes = PERIODOS.map((per) => {
    const meses = per.anos * 12;
    const final = projetar({ aporteMensal, taxaAnualPct: taxa, meses });
    const investido = aporteMensal * meses;
    const ganho = final - investido;
    return { ...per, final, investido, ganho };
  });

  const maxFinal = Math.max(...projecoes.map((p) => p.final), 1);

  const grid = el(
    "div",
    { class: "projecao-grid" },
    projecoes.map((p) =>
      el("div", { class: "projecao-card" }, [
        el("span", { class: "projecao-card__periodo" }, p.label),
        el("div", { class: "projecao-bar-track" }, el("div", { class: "projecao-bar-fill", style: `height:${(p.final / maxFinal) * 100}%` })),
        el("span", { class: "projecao-card__valor" }, brl(p.final)),
        el("span", { class: "projecao-card__detalhe" }, `Investido: ${brl(p.investido)}`),
        el("span", { class: "projecao-card__ganho" }, `Rendimento: ${brl(p.ganho)}`),
      ]),
    ),
  );

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, `Se você investisse ${state.nome ? `o valor do "${state.nome}"` : "esse valor"}`),
      grid,
      el(
        "p",
        { class: "disclaimer" },
        `Taxa efetiva usada: ${taxa.toFixed(2).replace(".", ",")}% ao ano. Simulação educacional — não considera impostos, taxas de administração, inflação nem mudanças futuras no CDI. Também não é um julgamento sobre seus hábitos: é só uma forma de visualizar o custo de oportunidade.`,
      ),
    ]),
  );
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initVicioApp();
});
