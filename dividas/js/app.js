import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";

const LIMITE_MESES = 600; // 50 anos — trava de segurança contra loop infinito

const DEFAULT_DIVIDAS = [
  { id: "d1", nome: "Empréstimo pessoal", saldo: 1000, taxaMensalPct: 4, pagamentoMinimo: 100 },
  { id: "d2", nome: "Cartão de crédito", saldo: 4000, taxaMensalPct: 13, pagamentoMinimo: 400 },
];

const state = {
  dividas: DEFAULT_DIVIDAS.map((d) => ({ ...d })),
  orcamentoTotal: 900,
};

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved && Array.isArray(saved.dividas) && saved.dividas.length > 0) {
    state.dividas = saved.dividas;
    state.orcamentoTotal = saved.orcamentoTotal ?? state.orcamentoTotal;
  }
}
function persist() {
  save(KEYS.STATE, { dividas: state.dividas, orcamentoTotal: state.orcamentoTotal });
}

function novoId() {
  return `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * Simula a quitação das dívidas com um critério de prioridade.
 * criterio: "saldo" (bola de neve — menor saldo primeiro) ou
 *           "taxa" (avalanche — maior juros primeiro)
 */
function simular(dividas, orcamentoTotal, criterio) {
  const ordenados = [...dividas].sort((a, b) =>
    criterio === "saldo" ? a.saldo - b.saldo : b.taxaMensalPct - a.taxaMensalPct,
  );
  const n = ordenados.length;
  const saldos = ordenados.map((d) => d.saldo);
  const minimos = ordenados.map((d) => d.pagamentoMinimo);
  const taxas = ordenados.map((d) => d.taxaMensalPct / 100);
  const quitadoNoMes = ordenados.map(() => null);

  const somaMinimos = minimos.reduce((a, b) => a + b, 0);
  const extraBase = Math.max(orcamentoTotal - somaMinimos, 0);

  let totalJuros = 0;
  let mes = 0;

  while (saldos.some((s) => s > 0.005) && mes < LIMITE_MESES) {
    mes++;

    // 1) aplica juros do mês em cada dívida ainda ativa
    for (let i = 0; i < n; i++) {
      if (saldos[i] > 0) {
        const juros = saldos[i] * taxas[i];
        totalJuros += juros;
        saldos[i] += juros;
      }
    }

    // 2) paga o mínimo de cada dívida ativa
    for (let i = 0; i < n; i++) {
      if (saldos[i] > 0) {
        saldos[i] -= Math.min(minimos[i], saldos[i]);
      }
    }

    // 3) o "extra" (orçamento sobrando + mínimos de dívidas já quitadas)
    //    vai inteiro para a dívida de maior prioridade que ainda está ativa
    let extraDisponivel = extraBase;
    for (let i = 0; i < n; i++) {
      if (saldos[i] <= 0) extraDisponivel += minimos[i];
    }
    for (let i = 0; i < n && extraDisponivel > 0; i++) {
      if (saldos[i] > 0) {
        const pagamento = Math.min(extraDisponivel, saldos[i]);
        saldos[i] -= pagamento;
        extraDisponivel -= pagamento;
      }
    }

    // 4) marca quitação
    for (let i = 0; i < n; i++) {
      if (saldos[i] <= 0.005 && quitadoNoMes[i] == null) {
        saldos[i] = 0;
        quitadoNoMes[i] = mes;
      }
    }
  }

  return {
    meses: mes,
    totalJuros,
    atingivel: saldos.every((s) => s <= 0.005),
    ordem: ordenados.map((d, i) => ({ nome: d.nome, mes: quitadoNoMes[i] })),
  };
}

export function initDividasApp() {
  loadPersisted();
  const root = qs("#dividas-root");
  if (!root) return;
  render(root);
}

function render(root) {
  clear(root);

  const somaMinimos = state.dividas.reduce((a, d) => a + d.pagamentoMinimo, 0);

  const listaHost = el("div", { class: "dividas-list" });
  const dividasCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Suas dívidas"),
    el("p", { class: "panel-lead" }, "Adicione cada dívida com o saldo devedor, a taxa de juros mensal e o pagamento mínimo."),
    listaHost,
    el(
      "button",
      {
        type: "button",
        class: "btn btn--outline btn--sm",
        style: "margin-top:.5rem",
        onClick: () => {
          state.dividas.push({ id: novoId(), nome: "", saldo: 1000, taxaMensalPct: 5, pagamentoMinimo: 100 });
          persist();
          render(root);
        },
      },
      "+ Adicionar dívida",
    ),
  ]);

  renderListaDividas(listaHost, root);

  const orcamentoInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: formatCurrencyInput(state.orcamentoTotal),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseCurrencyInput(e.target.value);
      e.target.value = formatCurrencyInput(n);
      state.orcamentoTotal = n;
      persist();
      renderResultado(root);
    },
  });

  const orcamentoCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Quanto você pode pagar por mês, no total?"),
    el("p", { class: "panel-lead" }, "Inclua os mínimos de todas as dívidas mais qualquer valor extra disponível."),
    el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "Orçamento mensal total"), orcamentoInput]),
    el("p", { class: "orcamento-info", id: "orcamento-info" }),
  ]);

  root.append(dividasCard, orcamentoCard, el("div", { id: "resultado-host" }));
  renderResultado(root);
}

function renderListaDividas(host, root) {
  clear(host);
  state.dividas.forEach((d) => {
    const nomeInput = el("input", {
      class: "field",
      placeholder: "Nome da dívida",
      value: d.nome,
      onInput: (e) => {
        d.nome = e.target.value;
        persist();
        renderResultado(root);
      },
    });
    const saldoInput = el("input", {
      class: "field",
      inputmode: "numeric",
      value: formatCurrencyInput(d.saldo),
      onFocus: (e) => e.target.select(),
      onInput: (e) => {
        const n = parseCurrencyInput(e.target.value);
        e.target.value = formatCurrencyInput(n);
        d.saldo = n;
        persist();
        renderResultado(root);
      },
    });
    const taxaInput = el("input", {
      class: "field",
      inputmode: "numeric",
      value: String(d.taxaMensalPct),
      onFocus: (e) => e.target.select(),
      onInput: (e) => {
        const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
        d.taxaMensalPct = Number.isFinite(n) ? n : 0;
        persist();
        renderResultado(root);
      },
    });
    const minimoInput = el("input", {
      class: "field",
      inputmode: "numeric",
      value: formatCurrencyInput(d.pagamentoMinimo),
      onFocus: (e) => e.target.select(),
      onInput: (e) => {
        const n = parseCurrencyInput(e.target.value);
        e.target.value = formatCurrencyInput(n);
        d.pagamentoMinimo = n;
        persist();
        renderResultado(root);
      },
    });

    const row = el("div", { class: "divida-row" }, [
      el("div", { class: "divida-row__field divida-row__field--nome" }, [
        el("label", { class: "field-label" }, "Nome"),
        nomeInput,
      ]),
      el("div", { class: "divida-row__field" }, [el("label", { class: "field-label" }, "Saldo devedor"), saldoInput]),
      el("div", { class: "divida-row__field divida-row__field--sm" }, [
        el("label", { class: "field-label" }, "Juros % a.m."),
        taxaInput,
      ]),
      el("div", { class: "divida-row__field" }, [el("label", { class: "field-label" }, "Pagamento mínimo"), minimoInput]),
      el("button", {
        type: "button",
        class: "icon-btn icon-btn--danger divida-row__remove",
        "aria-label": `Remover ${d.nome || "dívida"}`,
        title: "Remover dívida",
        onClick: () => {
          state.dividas = state.dividas.filter((x) => x.id !== d.id);
          persist();
          render(root);
        },
        html: closeSVG(),
      }),
    ]);
    host.append(row);
  });

  if (state.dividas.length === 0) {
    host.append(el("p", { class: "disclaimer" }, "Nenhuma dívida adicionada ainda."));
  }
}

function closeSVG() {
  return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
}

function renderResultado(root) {
  const host = qs("#resultado-host", root);
  const orcamentoInfo = qs("#orcamento-info", root);
  if (!host) return;
  clear(host);

  const somaMinimos = state.dividas.reduce((a, d) => a + d.pagamentoMinimo, 0);
  const extra = state.orcamentoTotal - somaMinimos;

  if (orcamentoInfo) {
    orcamentoInfo.textContent = `Soma dos pagamentos mínimos: ${brl(somaMinimos)}. Sobra pra acelerar a quitação: ${brl(Math.max(extra, 0))} por mês.`;
    orcamentoInfo.style.color = extra < 0 ? "var(--color-destructive)" : "";
  }

  if (state.dividas.length === 0) return;

  if (extra < 0) {
    host.append(
      el(
        "p",
        { class: "disclaimer", style: "color:var(--color-destructive)" },
        `Seu orçamento mensal não cobre nem os pagamentos mínimos (faltam ${brl(-extra)}). Aumente o orçamento ou renegocie alguma dívida antes de simular.`,
      ),
    );
    return;
  }

  const bolaDeNeve = simular(state.dividas, state.orcamentoTotal, "saldo");
  const avalanche = simular(state.dividas, state.orcamentoTotal, "taxa");

  const economiaMeses = bolaDeNeve.meses - avalanche.meses;
  const economiaJuros = bolaDeNeve.totalJuros - avalanche.totalJuros;

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Comparação das estratégias"),
      el("div", { class: "comparacao-grid" }, [
        estrategiaCard({
          titulo: "Bola de Neve",
          subtitulo: "Menor saldo primeiro",
          resultado: bolaDeNeve,
          destaque: economiaMeses <= 0,
        }),
        estrategiaCard({
          titulo: "Avalanche",
          subtitulo: "Maior juros primeiro",
          resultado: avalanche,
          destaque: economiaMeses >= 0,
        }),
      ]),
      economiaMeses > 0 || economiaJuros > 0
        ? el(
            "p",
            { class: "economia-nota" },
            `A Avalanche quita tudo ${economiaMeses > 0 ? `${economiaMeses} ${economiaMeses === 1 ? "mês" : "meses"} mais rápido` : "no mesmo tempo"} e economiza ${brl(Math.max(economiaJuros, 0))} em juros, comparada à Bola de Neve.`,
          )
        : el("p", { class: "economia-nota" }, "Nesse caso as duas estratégias dão praticamente no mesmo resultado."),
      el(
        "p",
        { class: "disclaimer" },
        "A Bola de Neve prioriza motivação (quitar dívidas pequenas rápido gera sensação de progresso). A Avalanche é matematicamente mais barata. Esta simulação é educacional e não considera taxas adicionais, multas ou renegociações.",
      ),
    ]),
  );
}

function estrategiaCard({ titulo, subtitulo, resultado, destaque }) {
  const anos = Math.floor(resultado.meses / 12);
  const mesesResto = resultado.meses % 12;
  const tempoLabel = anos > 0 ? `${anos}a ${mesesResto}m` : `${mesesResto} meses`;

  return el("div", { class: `estrategia-card${destaque ? " estrategia-card--destaque" : ""}` }, [
    el("h3", {}, titulo),
    el("p", { class: "estrategia-card__sub" }, subtitulo),
    el("div", { class: "estrategia-card__stat" }, [
      el("span", { class: "estrategia-card__label" }, "Tempo até quitar tudo"),
      el("span", { class: "estrategia-card__value" }, resultado.atingivel ? tempoLabel : "não atinge"),
    ]),
    el("div", { class: "estrategia-card__stat" }, [
      el("span", { class: "estrategia-card__label" }, "Total pago em juros"),
      el("span", { class: "estrategia-card__value" }, brl(resultado.totalJuros)),
    ]),
    el(
      "ol",
      { class: "ordem-quitacao" },
      resultado.ordem.map((o) =>
        el("li", {}, [
          el("span", {}, o.nome || "Dívida"),
          el("span", { class: "ordem-quitacao__mes" }, o.mes ? `mês ${o.mes}` : "—"),
        ]),
      ),
    ),
  ]);
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initDividasApp();
});
