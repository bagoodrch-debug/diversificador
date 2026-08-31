import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { KEYS, load, save } from "./core/store.js";

const DEFAULTS = {
  focoMin: 25,
  pausaCurtaMin: 5,
  pausaLongaMin: 15,
  ciclosAtePausaLonga: 4,
  somAtivo: true,
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
  // Garante que o tempo restante bate com a duração configurada do modo atual,
  // caso o usuário tenha mudado as durações fora de uma sessão ativa.
  state.segundosRestantes = Math.min(state.segundosRestantes, duracaoDoModo(state.modo));
  if (!state.segundosRestantes) state.segundosRestantes = duracaoDoModo(state.modo);
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
  return "Foco";
}

function emojiDoModo(modo) {
  if (modo === "pausaCurta") return "☕";
  if (modo === "pausaLonga") return "🌿";
  return "🍅";
}

function formatMMSS(totalSegundos) {
  const s = Math.max(0, Math.round(totalSegundos));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function playBeep() {
  if (!state.somAtivo) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const tocarTom = (freq, inicioMs, duracaoMs) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.0001;
      osc.connect(gain).connect(audioCtx.destination);
      const t0 = audioCtx.currentTime + inicioMs / 1000;
      const t1 = t0 + duracaoMs / 1000;
      gain.gain.exponentialRampToValueAtTime(0.15, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t1);
      osc.start(t0);
      osc.stop(t1 + 0.02);
    };
    tocarTom(880, 0, 160);
    tocarTom(1174, 200, 220);
  } catch {
    // Web Audio indisponível — segue sem som, sem quebrar a página.
  }
}

function iniciar() {
  if (state.rodando) return;
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

function pularParaProximo() {
  avancarCiclo({ contarComoConcluido: false });
}

function avancarCiclo({ contarComoConcluido }) {
  if (contarComoConcluido && state.modo === "foco") {
    if (state.concluidosData !== hojeISO()) {
      state.concluidosHoje = 0;
      state.concluidosData = hojeISO();
    }
    state.concluidosHoje += 1;
  }

  if (state.modo === "foco") {
    state.cicloAtual += 1;
    const rodadaCompleta = state.cicloAtual % state.ciclosAtePausaLonga === 0;
    state.modo = rodadaCompleta ? "pausaLonga" : "pausaCurta";
  } else {
    state.modo = "foco";
  }

  state.segundosRestantes = duracaoDoModo(state.modo);
  state.fimEm = state.rodando ? Date.now() + state.segundosRestantes * 1000 : null;
  persist();
  renderTudo();
}

function tick() {
  if (!state.rodando || !state.fimEm) return;
  const restante = Math.round((state.fimEm - Date.now()) / 1000);
  if (restante <= 0) {
    playBeep();
    avancarCiclo({ contarComoConcluido: true });
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
  if (state.rodando) {
    document.title = `${formatMMSS(state.segundosRestantes)} ${emojiDoModo(state.modo)} — Pomodoro`;
  } else {
    document.title = "Timer Pomodoro — Many Mens";
  }
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

  refs.modoLabel = el("span", { class: "pomo-modo__label" }, "");
  refs.digitos = el("div", { class: "pomo-timer__digits" }, "25:00");
  refs.dots = el("div", { class: "pomo-dots" }, []);
  refs.contador = el("p", { class: "pomo-contador" }, "");

  refs.btnPrincipal = el("button", { class: "btn btn--primary pomo-btn-principal", type: "button", onClick: onClickPrincipal }, "Iniciar");
  refs.btnReset = el("button", { class: "btn btn--ghost", type: "button", onClick: reiniciarCicloAtual }, "Reiniciar ciclo");
  refs.btnPular = el("button", { class: "btn btn--ghost", type: "button", onClick: pularParaProximo }, "Pular →");

  const timerCard = el("section", { class: "panel card pomo-card" }, [
    el("div", { class: "pomo-modo" }, [refs.modoLabel]),
    refs.digitos,
    refs.dots,
    el("div", { class: "pomo-acoes" }, [refs.btnPrincipal, refs.btnReset, refs.btnPular]),
    refs.contador,
  ]);

  refs.focoInput = numberField(state.focoMin, 1, 120, (v) => onDuracaoChange("focoMin", v));
  refs.pausaCurtaInput = numberField(state.pausaCurtaMin, 1, 60, (v) => onDuracaoChange("pausaCurtaMin", v));
  refs.pausaLongaInput = numberField(state.pausaLongaMin, 1, 90, (v) => onDuracaoChange("pausaLongaMin", v));
  refs.ciclosInput = numberField(state.ciclosAtePausaLonga, 2, 8, (v) => onDuracaoChange("ciclosAtePausaLonga", v));

  refs.somToggle = el(
    "button",
    {
      type: "button",
      class: "freq-toggle__opt pomo-som-toggle",
      "aria-pressed": String(state.somAtivo),
      onClick: () => {
        state.somAtivo = !state.somAtivo;
        persist();
        renderTudo();
      },
    },
    state.somAtivo ? "🔔 Som ativado" : "🔕 Som desativado",
  );

  const settingsCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Ajustar tempos"),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Foco (min)"), refs.focoInput]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Pausa curta (min)"), refs.pausaCurtaInput]),
    ]),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Pausa longa (min)"), refs.pausaLongaInput]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Ciclos até pausa longa"), refs.ciclosInput]),
    ]),
    el("div", { class: "field-group", style: "margin-bottom:0" }, [el("label", { class: "field-label" }, "Notificação sonora"), refs.somToggle]),
    el("p", { class: "disclaimer", style: "margin-top:.85rem" }, "Pause o ciclo atual pra editar os tempos sem interromper a contagem em andamento."),
  ]);

  root.append(timerCard, settingsCard);
}

function numberField(valor, min, max, onChange) {
  return el("input", {
    class: "field",
    type: "number",
    min: String(min),
    max: String(max),
    value: String(valor),
    disabled: state.rodando,
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

function onClickPrincipal() {
  if (state.rodando) pausar();
  else iniciar();
}

function renderTudo() {
  atualizarDisplay();
  atualizarTitulo();

  refs.modoLabel.textContent = `${emojiDoModo(state.modo)} ${rotuloDoModo(state.modo)}`;
  refs.modoLabel.className = `pomo-modo__label pomo-modo__label--${state.modo}`;

  refs.btnPrincipal.textContent = state.rodando ? "Pausar" : state.segundosRestantes < duracaoDoModo(state.modo) ? "Continuar" : "Iniciar";

  clear(refs.dots);
  for (let i = 0; i < state.ciclosAtePausaLonga; i++) {
    const preenchido = i < state.cicloAtual % state.ciclosAtePausaLonga || (state.cicloAtual > 0 && state.cicloAtual % state.ciclosAtePausaLonga === 0 && i < state.ciclosAtePausaLonga);
    refs.dots.append(el("span", { class: `pomo-dot${preenchido ? " pomo-dot--cheio" : ""}` }));
  }

  refs.contador.textContent = `${state.concluidosHoje} pomodoro${state.concluidosHoje === 1 ? "" : "s"} concluído${state.concluidosHoje === 1 ? "" : "s"} hoje`;

  // Reflete o estado "desabilitado durante execução" dos campos de duração.
  [refs.focoInput, refs.pausaCurtaInput, refs.pausaLongaInput, refs.ciclosInput].forEach((input) => {
    input.disabled = state.rodando;
  });
}

function atualizarDisplay() {
  refs.digitos.textContent = formatMMSS(state.segundosRestantes);
  refs.digitos.className = `pomo-timer__digits pomo-timer__digits--${state.modo}`;
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initPomodoroApp();
});
