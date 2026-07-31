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
  { label: "Outro", nome: "", valor: 0, frequencia: "dia" },
];

const DEFAULTS = {
  nome: "Cigarro",
  valor: 12,
  frequencia: "dia",
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
  });
}

function paraMensal(valor, frequencia) {
  if (frequencia === "dia") return valor * 30.44;
  if (frequencia === "semana") return valor * 4.348;
  return valor;
}

/** A projeção usa 100% do CDI atual — sem opção de ajuste, por simplicidade. */
function taxaEfetiva() {
  return state.cdiAnualPct;
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

  root.append(gastoCard, el("div", { id: "resultado-host" }));
  renderResultado(root);
  if (!state.nome) nomeInput.focus();
}

function cdiExplicacao() {
  if (state.cdiAnualPct != null) {
    return `As projeções abaixo consideram o CDI atual: ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% ao ano (referência: ${state.cdiDataRef ?? "—"}).`;
  }
  if (state.cdiError) {
    return `Não foi possível buscar o CDI agora. ${state.cdiError}`;
  }
  return "Buscando a taxa CDI atual…";
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
    el("p", { class: "cdi-explicacao" }, cdiExplicacao()),
  ]);
  host.append(resumo);

  if (taxa == null) {
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
