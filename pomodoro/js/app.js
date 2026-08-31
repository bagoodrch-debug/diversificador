import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { KEYS, load, save } from "./core/store.js";

const DEFAULTS = {
  focoMin: 25,
  pausaCurtaMin: 5,
  pausaLongaMin: 15,
  ciclosAtePausaLonga: 4,
  autoIniciarPausas: true,
  autoIniciarPomodoro: true,
  somAtivo: true,
};

const CORES = {
  foco: "#c1584f",
  pausaCurta: "#3f6d64",
  pausaLonga: "#3a5a6b",
};

const state = {
  ...DEFAULTS,
  modo: "foco", // "foco" | "pausaCurta" | "pausaLonga"
  segundosRestantes: DEFAULTS.focoMin * 60,
  rodando: false,
  fimEm: null, // timestamp (ms) de quando o ciclo atual termina, se rodando
  cicloAtual: 0, // quantos "foco" completados na rodada atual (0..ciclosAtePausaLonga)
  concluidosHoje: 0,
  concluidosData: hojeISO(),
};

let intervalId = null;
let audioCtx = null;

function hojeISO() {
  return new Date().toISOString().slice(0, 10);
}

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (!saved) return;
  Object.assign(state, DEFAULTS, saved);
  // Nunca reabre já "rodando" após reload — evita relógio fantasma correndo em segundo plano.
  state.rodando = false;
  state.fimEm = null;
  if (state.concluidosData !== hojeISO()) {
    state.concluidosHoje = 0;
    state.concluidosData = hojeISO();
  }
  state.segundosRestantes = Math.min(state.segundosRestantes, duracaoDoModo(state.modo)) || duracaoDoModo(state.modo);
}

function persist() {
  save(KEYS.STATE, { ...state });
}

function duracaoDoModo(modo) {
  if (modo === "pausaCurta") return state.pausaCurtaMin * 60;
  if (modo === "pausaLonga") return state.pausaLongaMin * 60;
  return state.focoMin * 60;
}

function rotuloDoModo(modo) {
  if (modo === "pausaCurta") return "Pausa curta";
  if (modo === "pausaLonga") return "Pausa longa";
  return "Pomodoro";
}

function formatMMSS(totalSegundos) {
  const s = Math.max(0, Math.round(totalSegundos));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function ensureAudioContext() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function tocarTom(ctx, freq, inicioMs, duracaoMs, volume = 0.22) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime + inicioMs / 1000;
  const t1 = t0 + duracaoMs / 1000;
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, t1);
  osc.start(t0);
  osc.stop(t1 + 0.03);
}

/** Toca o alarme, independente do toggle — usado pelo botão "Testar som". */
function tocarAlarme() {
  const ctx = ensureAudioContext();
  if (!ctx) return;
  const freqs = [988, 1319]; // Si5 / Mi6, intervalo de terça — soa como alarme, não irritante
  const totalPulsos = 11;
  const duracaoPulso = 200;
  const intervaloPulso = 340;
  for (let i = 0; i < totalPulsos; i++) {
    tocarTom(ctx, freqs[i % 2], i * intervaloPulso, duracaoPulso);
  }
}

/** Alarme de ~4 segundos ao fim de um ciclo — respeita o toggle de som. */
function playBeep() {
  if (!state.somAtivo) return;
  tocarAlarme();
}

function iniciar() {
  if (state.rodando) return;
  ensureAudioContext();
  if (!state.segundosRestantes) state.segundosRestantes = duracaoDoModo(state.modo);
  state.fimEm = Date.now() + state.segundosRestantes * 1000;
  state.rodando = true;
  persist();
  garantirIntervalo();
  renderTudo();
}

function pausar() {
  if (!state.rodando) return;
  state.segundosRestantes = Math.max(0, Math.round((state.fimEm - Date.now()) / 1000));
  state.rodando = false;
  state.fimEm = null;
  pararIntervalo();
  persist();
  renderTudo();
}

function reiniciarCicloAtual() {
  state.rodando = false;
  state.fimEm = null;
  state.segundosRestantes = duracaoDoModo(state.modo);
  pararIntervalo();
  persist();
  renderTudo();
}

/** Troca de modo manualmente pelas abas — não conta pra estatística de ciclos. */
function trocarModo(novoModo) {
  if (novoModo === state.modo) return;
  state.modo = novoModo;
  state.rodando = false;
  state.fimEm = null;
  state.segundosRestantes = duracaoDoModo(novoModo);
  pararIntervalo();
  persist();
  renderTudo();
}

/** Chamado quando um ciclo termina naturalmente (contagem chegou a zero). */
function avancarCicloAutomatico() {
  if (state.modo === "foco") {
    if (state.concluidosData !== hojeISO()) {
      state.concluidosHoje = 0;
      state.concluidosData = hojeISO();
    }
    state.concluidosHoje += 1;
    state.cicloAtual += 1;
    const rodadaCompleta = state.cicloAtual % state.ciclosAtePausaLonga === 0;
    state.modo = rodadaCompleta ? "pausaLonga" : "pausaCurta";
    state.rodando = state.autoIniciarPausas;
  } else {
    state.modo = "foco";
    state.rodando = state.autoIniciarPomodoro;
  }

  state.segundosRestantes = duracaoDoModo(state.modo);
  state.fimEm = state.rodando ? Date.now() + state.segundosRestantes * 1000 : null;
  if (state.rodando) garantirIntervalo();
  else pararIntervalo();
  persist();
  renderTudo();
}

function tick() {
  if (!state.rodando || !state.fimEm) return;
  const restante = Math.round((state.fimEm - Date.now()) / 1000);
  if (restante <= 0) {
    playBeep();
    avancarCicloAutomatico();
    return;
  }
  state.segundosRestantes = restante;
  atualizarDisplay();
  atualizarTitulo();
}

function garantirIntervalo() {
  if (intervalId) return;
  intervalId = window.setInterval(tick, 250);
}
function pararIntervalo() {
  if (!intervalId) return;
  window.clearInterval(intervalId);
  intervalId = null;
}

function atualizarTitulo() {
  document.title = state.rodando ? `${formatMMSS(state.segundosRestantes)} — ${rotuloDoModo(state.modo)}` : "Técnica Pomodoro — Many Mens";
}

let refs = {};

export function initPomodoroApp() {
  loadPersisted();
  const root = qs("#pomodoro-root");
  if (!root) return;
  renderShell(root);
  renderTudo();
  if (state.rodando) garantirIntervalo();
}

function renderShell(root) {
  clear(root);

  refs.tabs = {};
  const tabsRow = el(
    "div",
    { class: "pomo-tabs", role: "tablist" },
    ["foco", "pausaCurta", "pausaLonga"].map((modo) => {
      const btn = el(
        "button",
        { type: "button", class: "pomo-tab", role: "tab", onClick: () => trocarModo(modo) },
        rotuloDoModo(modo).toUpperCase(),
      );
      refs.tabs[modo] = btn;
      return btn;
    }),
  );

  refs.digitos = el("div", { class: "pomo-digits" }, "25:00");
  refs.btnPrincipal = el("button", { class: "pomo-btn-principal", type: "button", onClick: onClickPrincipal }, "Iniciar");
  refs.btnReset = el("button", { class: "pomo-reset-link", type: "button", onClick: reiniciarCicloAtual }, "Reiniciar ciclo");

  const iconeConfig = el("span", {
    class: "pomo-config-btn__icon",
    html:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  });

  refs.stage = el("div", { class: "pomo-stage" }, [
    el("button", { class: "pomo-config-btn", type: "button", "aria-label": "Configurações", onClick: abrirModal }, [
      iconeConfig,
      el("span", { class: "pomo-config-btn__texto" }, "Configurações"),
    ]),
    tabsRow,
    refs.digitos,
    refs.btnPrincipal,
    refs.btnReset,
  ]);

  refs.dots = el("div", { class: "pomo-dots" }, []);
  refs.contador = el("p", { class: "pomo-contador" }, "");
  const infoRow = el("div", { class: "pomo-info" }, [refs.dots, refs.contador]);

  root.append(refs.stage, infoRow);
  renderModal(root);
}

function onClickPrincipal() {
  if (state.rodando) pausar();
  else iniciar();
}

function renderTudo() {
  atualizarDisplay();
  atualizarTitulo();

  refs.stage.style.background = CORES[state.modo];

  Object.entries(refs.tabs).forEach(([modo, btn]) => {
    btn.classList.toggle("pomo-tab--ativa", modo === state.modo);
    btn.setAttribute("aria-selected", String(modo === state.modo));
  });

  refs.btnPrincipal.textContent = state.rodando ? "Pausar" : state.segundosRestantes < duracaoDoModo(state.modo) ? "Continuar" : "Iniciar";
  refs.btnPrincipal.style.color = CORES[state.modo];

  clear(refs.dots);
  for (let i = 0; i < state.ciclosAtePausaLonga; i++) {
    const posicaoNaRodada = state.cicloAtual % state.ciclosAtePausaLonga;
    const rodadaRecemFechada = state.cicloAtual > 0 && posicaoNaRodada === 0 && state.modo === "pausaLonga";
    const preenchido = i < posicaoNaRodada || rodadaRecemFechada;
    refs.dots.append(el("span", { class: `pomo-dot${preenchido ? " pomo-dot--cheio" : ""}` }));
  }

  refs.contador.textContent = `${state.concluidosHoje} pomodoro${state.concluidosHoje === 1 ? "" : "s"} concluído${state.concluidosHoje === 1 ? "" : "s"} hoje`;

  if (refs.toggleAutoPausas) atualizarModal();
}

function atualizarDisplay() {
  refs.digitos.textContent = formatMMSS(state.segundosRestantes);
}

// ---------------------------------------------------------------------------
// Modal de configurações
// ---------------------------------------------------------------------------

function renderModal(root) {
  refs.focoInput = numberField(state.focoMin, 1, 120, (v) => onDuracaoChange("focoMin", v));
  refs.pausaCurtaInput = numberField(state.pausaCurtaMin, 1, 60, (v) => onDuracaoChange("pausaCurtaMin", v));
  refs.pausaLongaInput = numberField(state.pausaLongaMin, 1, 90, (v) => onDuracaoChange("pausaLongaMin", v));
  refs.ciclosInput = numberField(state.ciclosAtePausaLonga, 2, 8, (v) => onDuracaoChange("ciclosAtePausaLonga", v));

  refs.toggleAutoPausas = toggleSwitch(state.autoIniciarPausas, (v) => {
    state.autoIniciarPausas = v;
    persist();
  });
  refs.toggleAutoPomodoro = toggleSwitch(state.autoIniciarPomodoro, (v) => {
    state.autoIniciarPomodoro = v;
    persist();
  });
  refs.toggleSom = toggleSwitch(state.somAtivo, (v) => {
    state.somAtivo = v;
    persist();
  });
  refs.btnTestarSom = el(
    "button",
    {
      type: "button",
      class: "pomo-testar-som",
      onClick: () => {
        ensureAudioContext();
        tocarAlarme();
      },
    },
    "Testar som ▸",
  );

  const campo = (labelTexto, inputEl) => el("div", { class: "pomo-modal__campo" }, [el("label", {}, labelTexto), inputEl]);
  const linha = (labelTexto, toggleEl) => el("div", { class: "pomo-modal__linha" }, [el("span", {}, labelTexto), toggleEl]);

  refs.modal = el("div", { class: "pomo-modal-overlay", onClick: (e) => e.target === refs.modal && fecharModal() }, [
    el("div", { class: "pomo-modal", role: "dialog", "aria-modal": "true", "aria-label": "Configurações do timer" }, [
      el("div", { class: "pomo-modal__header" }, [
        el("h2", {}, "Configurações"),
        el("button", { class: "pomo-modal__fechar", type: "button", "aria-label": "Fechar", onClick: fecharModal }, "×"),
      ]),
      el("p", { class: "pomo-modal__subtitulo" }, "Tempo (minutos)"),
      el("div", { class: "pomo-modal__campos3" }, [
        campo("Pomodoro", refs.focoInput),
        campo("Pausa curta", refs.pausaCurtaInput),
        campo("Pausa longa", refs.pausaLongaInput),
      ]),
      linha("Iniciar automaticamente as pausas?", refs.toggleAutoPausas),
      linha("Iniciar automaticamente o pomodoro?", refs.toggleAutoPomodoro),
      linha("Notificação sonora?", refs.toggleSom),
      el("div", { class: "pomo-modal__linha", style: "border-top:none;padding-top:0;justify-content:flex-end" }, [refs.btnTestarSom]),
      campo("Intervalo para pausa longa (ciclos)", refs.ciclosInput),
    ]),
  ]);

  root.append(refs.modal);
}

function abrirModal() {
  refs.modal.classList.add("pomo-modal-overlay--aberto");
  document.body.classList.add("pomo-scroll-lock");
}
function fecharModal() {
  refs.modal.classList.remove("pomo-modal-overlay--aberto");
  document.body.classList.remove("pomo-scroll-lock");
}

function atualizarModal() {
  setToggle(refs.toggleAutoPausas, state.autoIniciarPausas);
  setToggle(refs.toggleAutoPomodoro, state.autoIniciarPomodoro);
  setToggle(refs.toggleSom, state.somAtivo);
}

function toggleSwitch(valorInicial, onChange) {
  const track = el("span", { class: "pomo-switch__track", "data-on": String(valorInicial) }, [el("span", { class: "pomo-switch__thumb" })]);
  const btn = el(
    "button",
    {
      type: "button",
      class: "pomo-switch",
      role: "switch",
      "aria-checked": String(valorInicial),
      onClick: () => {
        const novo = track.dataset.on !== "true";
        track.dataset.on = String(novo);
        btn.setAttribute("aria-checked", String(novo));
        onChange(novo);
      },
    },
    [track],
  );
  return btn;
}
function setToggle(btn, valor) {
  const track = btn.querySelector(".pomo-switch__track");
  track.dataset.on = String(valor);
  btn.setAttribute("aria-checked", String(valor));
}

function numberField(valor, min, max, onChange) {
  return el("input", {
    class: "pomo-modal__input",
    type: "number",
    min: String(min),
    max: String(max),
    value: String(valor),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseInt(e.target.value, 10);
      onChange(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
    },
  });
}

function onDuracaoChange(campo, valor) {
  state[campo] = valor;
  if (!state.rodando) {
    state.segundosRestantes = duracaoDoModo(state.modo);
  }
  persist();
  renderTudo();
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initPomodoroApp();
});
