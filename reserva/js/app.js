import { el, qs, qsa, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const DEFAULTS = {
  mode: "planejar",
  planejar: {
    valorMensalReferencia: 3000,
    jaTemGuardado: 0,
    aporteMensal: 300,
    usarCdiAuto: true,
    taxaManualPct: 11,
    percentualCdi: 100,
  },
  seiQuanto: {
    valorAlvo: 18000,
    jaTemGuardado: 0,
    aporteMensal: 300,
    usarCdiAuto: true,
    taxaManualPct: 11,
    percentualCdi: 100,
  },
};

const state = {
  mode: "planejar", // sempre começa aqui ao carregar a página, de propósito
  planejar: { ...DEFAULTS.planejar },
  seiQuanto: { ...DEFAULTS.seiQuanto },
  cdiAnualPct: null,
  cdiError: null,
  cdiDataRef: null,
};

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) {
    if (saved.planejar) state.planejar = { ...DEFAULTS.planejar, ...saved.planejar };
    if (saved.seiQuanto) state.seiQuanto = { ...DEFAULTS.seiQuanto, ...saved.seiQuanto };
    // mode NÃO é restaurado — a página sempre inicia em "planejar".
  }
}

function persist() {
  save(KEYS.STATE, { planejar: state.planejar, seiQuanto: state.seiQuanto });
}

/** Simula aportes mensais com juros compostos até atingir o alvo. */
function simular({ alvo, jaTem, aporteMensal, taxaAnualPct }) {
  const alvoSeguro = Math.max(alvo, 0);
  if (jaTem >= alvoSeguro) return { meses: 0, atingivel: true, saldoFinal: jaTem };

  const taxaMensal = Math.pow(1 + taxaAnualPct / 100, 1 / 12) - 1;
  let saldo = jaTem;
  let meses = 0;
  const LIMITE = 1200; // 100 anos — trava de segurança
  while (saldo < alvoSeguro && meses < LIMITE) {
    saldo = saldo * (1 + taxaMensal) + aporteMensal;
    meses++;
  }
  return { meses, atingivel: saldo >= alvoSeguro, saldoFinal: saldo };
}

function formatMeses(totalMeses) {
  if (totalMeses <= 0) return "já está pronta";
  const anos = Math.floor(totalMeses / 12);
  const meses = totalMeses % 12;
  const partes = [];
  if (anos > 0) partes.push(`${anos} ano${anos > 1 ? "s" : ""}`);
  if (meses > 0 || anos === 0) partes.push(`${meses} ${meses === 1 ? "mês" : "meses"}`);
  return partes.join(" e ");
}

function taxaEfetiva(panelState) {
  const base = panelState.usarCdiAuto ? state.cdiAnualPct : panelState.taxaManualPct;
  if (base == null) return null;
  return base * (panelState.percentualCdi / 100);
}

/* ---------------------------------------------------------------------- */

export function initReservaApp() {
  const root = qs("#reserva-root");
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
  renderPanels(root);
}

function render(root) {
  clear(root);

  root.append(
    el("div", { class: "mode-switch-wrap" }, [
      el("span", { class: "mode-switch-label", "data-side": "left" }, "Planejar do zero"),
      el(
        "button",
        {
          type: "button",
          class: "mode-switch",
          "data-mode": state.mode,
          role: "switch",
          "aria-checked": String(state.mode === "sei-quanto"),
          "aria-label": "Alternar entre planejar do zero e já saber quanto preciso",
          onClick: () => {
            state.mode = state.mode === "planejar" ? "sei-quanto" : "planejar";
            updateSwitch(root);
          },
        },
        [el("span", { class: "mode-switch__knob" })],
      ),
      el("span", { class: "mode-switch-label", "data-side": "right" }, "Já sei quanto preciso"),
    ]),
  );

  const track = el("div", { class: "panels-track", "data-mode": state.mode });
  root.append(el("div", { class: "panels-viewport" }, track));

  track.append(buildPlanejarPanel(root), buildSeiQuantoPanel(root));
  renderPanels(root);
}

function updateSwitch(root) {
  const btn = qs(".mode-switch", root);
  const track = qs(".panels-track", root);
  btn.dataset.mode = state.mode;
  btn.setAttribute("aria-checked", String(state.mode === "sei-quanto"));
  track.dataset.mode = state.mode;
}

/* --------------------------- Painel: Planejar --------------------------- */

function buildPlanejarPanel(root) {
  const p = state.planejar;

  const panel = el("section", { class: "panel card" }, [
    el("h2", {}, "Planejar do zero"),
    el("p", { class: "panel-lead" }, "A meta é guardar 6 vezes sua renda mensal."),

    field({
      label: "Renda mensal",
      value: p.valorMensalReferencia,
      onChange: (v) => {
        p.valorMensalReferencia = v;
        persist();
        renderPanels(root);
      },
    }),
    field({
      label: "Quanto você já tem guardado hoje",
      value: p.jaTemGuardado,
      onChange: (v) => {
        p.jaTemGuardado = v;
        persist();
        renderPanels(root);
      },
    }),
    field({
      label: "Quanto consegue guardar por mês",
      value: p.aporteMensal,
      onChange: (v) => {
        p.aporteMensal = v;
        persist();
        renderPanels(root);
      },
    }),

    buildTaxaSection(p, root),
    el("div", { class: "resultado", id: "resultado-planejar" }),
  ]);

  return panel;
}

/* -------------------------- Painel: Já sei quanto ------------------------ */

function buildSeiQuantoPanel(root) {
  const p = state.seiQuanto;

  const panel = el("section", { class: "panel card" }, [
    el("h2", {}, "Já sei quanto preciso"),
    el("p", { class: "panel-lead" }, "Informe o valor-alvo que você já calculou."),

    field({
      label: "Valor total da reserva (meta)",
      value: p.valorAlvo,
      onChange: (v) => {
        p.valorAlvo = v;
        persist();
        renderPanels(root);
      },
    }),
    field({
      label: "Quanto você já tem guardado hoje",
      value: p.jaTemGuardado,
      onChange: (v) => {
        p.jaTemGuardado = v;
        persist();
        renderPanels(root);
      },
    }),
    field({
      label: "Quanto consegue guardar por mês (ex: salário líquido disponível)",
      value: p.aporteMensal,
      onChange: (v) => {
        p.aporteMensal = v;
        persist();
        renderPanels(root);
      },
    }),

    buildTaxaSection(p, root),
    el("div", { class: "resultado", id: "resultado-sei-quanto" }),
  ]);

  return panel;
}

/* ------------------------------ Bloco de taxa ---------------------------- */

function buildTaxaSection(panelState, root) {
  const wrap = el("div", { class: "taxa-section" });
  const which = panelState === state.planejar ? "planejar" : "sei-quanto";

  const cdiInfoBox = el("div", { class: "cdi-info", id: `cdi-info-${which}` });
  const manualField = field({
    label: "Taxa (% ao ano)",
    value: panelState.taxaManualPct,
    isPercent: true,
    onChange: (v) => {
      panelState.taxaManualPct = v;
      persist();
      renderPanels(root);
    },
  });
  cdiInfoBox.style.display = panelState.usarCdiAuto ? "" : "none";
  manualField.style.display = panelState.usarCdiAuto ? "none" : "";

  const autoToggle = el("label", { class: "taxa-auto-toggle" }, [
    el("input", {
      type: "checkbox",
      checked: panelState.usarCdiAuto || undefined,
      onChange: (e) => {
        panelState.usarCdiAuto = e.target.checked;
        cdiInfoBox.style.display = panelState.usarCdiAuto ? "" : "none";
        manualField.style.display = panelState.usarCdiAuto ? "none" : "";
        persist();
        renderPanels(root);
      },
    }),
    el("span", {}, "Usar o CDI atual automaticamente"),
  ]);

  wrap.append(autoToggle, cdiInfoBox, manualField);

  wrap.append(
    field({
      label: "Seu investimento rende quantos % do CDI?",
      value: panelState.percentualCdi,
      isPercent: true,
      onChange: (v) => {
        panelState.percentualCdi = v;
        persist();
        renderPanels(root);
      },
    }),
  );

  return wrap;
}

/* ------------------------------ Campo genérico --------------------------- */

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

/* -------------------------------- Resultado ------------------------------ */

function renderPanels(root) {
  if (!root) return;
  renderCdiInfo(root);
  renderResultadoPlanejar(root);
  renderResultadoSeiQuanto(root);
}

function renderCdiInfo(root) {
  ["planejar", "sei-quanto"].forEach((which) => {
    const box = qs(`#cdi-info-${which}`, root);
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
  });
}

function renderResultadoPlanejar(root) {
  const host = qs("#resultado-planejar", root);
  if (!host) return;
  clear(host);

  const p = state.planejar;
  const taxa = taxaEfetiva(p);
  const alvo = p.valorMensalReferencia * 6;
  const mesesJaGuardados = p.valorMensalReferencia > 0 ? p.jaTemGuardado / p.valorMensalReferencia : 0;

  host.append(resultadoCard({ alvo, jaTem: p.jaTemGuardado, aporteMensal: p.aporteMensal, taxa, mesesJaGuardados, baseLabel: "salário" }));
}

function renderResultadoSeiQuanto(root) {
  const host = qs("#resultado-sei-quanto", root);
  if (!host) return;
  clear(host);

  const p = state.seiQuanto;
  const taxa = taxaEfetiva(p);
  const alvo = p.valorAlvo;
  const gastoImplicito = alvo / 6;
  const mesesJaGuardados = gastoImplicito > 0 ? p.jaTemGuardado / gastoImplicito : 0;

  host.append(resultadoCard({ alvo, jaTem: p.jaTemGuardado, aporteMensal: p.aporteMensal, taxa, mesesJaGuardados, baseLabel: "gasto" }));
}

function resultadoCard({ alvo, jaTem, aporteMensal, taxa, mesesJaGuardados, baseLabel }) {
  const wrap = el("div", { class: "resultado-inner" });

  if (taxa == null) {
    wrap.append(el("p", { class: "disclaimer" }, "Informe a taxa (ou aguarde o CDI carregar) para ver o resultado."));
    return wrap;
  }

  const falta = Math.max(alvo - jaTem, 0);
  const progresso = alvo > 0 ? Math.min((jaTem / alvo) * 100, 100) : 0;
  const sim = simular({ alvo, jaTem, aporteMensal, taxaAnualPct: taxa });

  wrap.append(
    el("div", { class: "resultado-grid" }, [
      resultItem("Reserva-alvo (6x)", brl(alvo)),
      resultItem(`Meses de ${baseLabel} já guardados`, `${mesesJaGuardados.toFixed(1).replace(".", ",")} meses`),
      resultItem("Falta guardar", brl(falta)),
      resultItem(
        "Tempo estimado",
        sim.atingivel ? formatMeses(sim.meses) : "não atinge no ritmo atual",
      ),
    ]),
  );

  wrap.append(
    el("div", { class: "progress-bar" }, el("div", { class: "progress-bar__fill", style: `width:${progresso}%` })),
    el("p", { class: "progress-label" }, `${progresso.toFixed(0)}% da meta já guardado`),
  );

  if (!sim.atingivel) {
    wrap.append(
      el(
        "p",
        { class: "disclaimer", style: "color:var(--color-destructive)" },
        "Com esse aporte mensal e essa taxa, a meta não é atingida em 100 anos de simulação — aumente o valor guardado por mês.",
      ),
    );
  }

  wrap.append(
    el(
      "p",
      { class: "disclaimer" },
      `Taxa efetiva usada na simulação: ${taxa.toFixed(2).replace(".", ",")}% ao ano. Esta simulação é educacional e não considera impostos, taxas de administração ou mudanças futuras no CDI.`,
    ),
  );

  return wrap;
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
  initReservaApp();
});
