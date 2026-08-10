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
  criterio: "saldo", // "saldo" = Bola de Neve · "taxa" = Avalanche
};

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved && Array.isArray(saved.dividas) && saved.dividas.length > 0) {
    state.dividas = saved.dividas;
    state.orcamentoTotal = saved.orcamentoTotal ?? state.orcamentoTotal;
    state.criterio = saved.criterio ?? state.criterio;
  }
}
function persist() {
  save(KEYS.STATE, { dividas: state.dividas, orcamentoTotal: state.orcamentoTotal, criterio: state.criterio });
}

function novoId() {
  return `d${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

/* ==========================================================================
   NÚCLEO DO CÁLCULO — um lugar só, parametrizado por critério de ordenação.
   "saldo"  → Bola de Neve (menor saldo primeiro)
   "taxa"   → Avalanche (maior juros primeiro)
   Trocar o método no futuro é só chamar calcularPlano com outro critério —
   nenhuma lógica de ordenação fica espalhada pela interface.
   ========================================================================== */
function calcularPlano(dividasEntrada, orcamentoTotal, criterio) {
  const ativas = dividasEntrada.filter((d) => d.saldo > 0.01);
  const jaQuitadas = dividasEntrada.filter((d) => d.saldo <= 0.01);

  if (ativas.length === 0) {
    return { valido: true, semDividasAtivas: true, jaQuitadas, criterio };
  }

  const somaMinimos = ativas.reduce((soma, d) => soma + (d.pagamentoMinimo || 0), 0);
  const extraBase = orcamentoTotal - somaMinimos;

  if (extraBase < 0) {
    return { valido: false, somaMinimos, faltam: -extraBase, orcamentoTotal, criterio };
  }

  // 1) Ordena pelo critério da estratégia.
  const ordenadas = [...ativas].sort((a, b) =>
    criterio === "saldo" ? a.saldo - b.saldo : b.taxaMensalPct - a.taxaMensalPct,
  );

  // 2) Pagamento planejado por posição — dá pra calcular direto, sem simular:
  //    a dívida da vez recebe o mínimo dela + todo o "extra" acumulado até
  //    ali (o extra inicial mais o mínimo de cada dívida já quitada antes
  //    dela). Isso É o efeito cascata, de forma explícita.
  let extraAcumulado = extraBase;
  const etapasBase = ordenadas.map((d, i) => {
    const valorExtra = i === 0 ? extraBase : extraAcumulado;
    const pagamentoRecomendado = (d.pagamentoMinimo || 0) + valorExtra;
    extraAcumulado += d.pagamentoMinimo || 0;
    return {
      id: d.id,
      nome: d.nome || "Dívida",
      saldo: d.saldo,
      taxaMensalPct: d.taxaMensalPct || 0,
      pagamentoMinimo: d.pagamentoMinimo || 0,
      valorExtra,
      pagamentoRecomendado,
    };
  });

  // 3) Simulação mês a mês (com juros compostos reais) só pra descobrir
  //    QUANDO cada dívida é quitada — isso não dá pra calcular direto
  //    porque depende dos juros acumulando mês a mês.
  const n = ordenadas.length;
  const saldosSim = ordenadas.map((d) => d.saldo);
  const minimosSim = ordenadas.map((d) => d.pagamentoMinimo || 0);
  const taxasSim = ordenadas.map((d) => (d.taxaMensalPct || 0) / 100);
  const mesQuitacaoSim = ordenadas.map(() => null);
  const saldoRestanteNaQuitacao = ordenadas.map(() => null);
  let totalJuros = 0;
  let mes = 0;

  while (saldosSim.some((s) => s > 0.005) && mes < LIMITE_MESES) {
    mes++;
    for (let i = 0; i < n; i++) {
      if (saldosSim[i] > 0) {
        const juros = saldosSim[i] * taxasSim[i];
        totalJuros += juros;
        saldosSim[i] += juros;
      }
    }
    for (let i = 0; i < n; i++) {
      if (saldosSim[i] > 0) saldosSim[i] -= Math.min(minimosSim[i], saldosSim[i]);
    }
    let extraDisponivel = extraBase;
    for (let i = 0; i < n; i++) if (saldosSim[i] <= 0) extraDisponivel += minimosSim[i];
    for (let i = 0; i < n && extraDisponivel > 0; i++) {
      if (saldosSim[i] > 0) {
        const pagamento = Math.min(extraDisponivel, saldosSim[i]);
        saldosSim[i] -= pagamento;
        extraDisponivel -= pagamento;
      }
    }
    for (let i = 0; i < n; i++) {
      if (saldosSim[i] <= 0.005 && mesQuitacaoSim[i] == null) {
        saldosSim[i] = 0;
        mesQuitacaoSim[i] = mes;
        saldoRestanteNaQuitacao[i] = saldosSim.reduce((s, v) => s + v, 0);
      }
    }
  }

  const etapas = etapasBase.map((etapa, i) => ({
    ...etapa,
    ordem: i + 1,
    mesQuitacao: mesQuitacaoSim[i],
    saldoRestanteApos: saldoRestanteNaQuitacao[i],
  }));
  const atingivel = saldosSim.every((s) => s <= 0.005);

  return {
    valido: true,
    orcamentoTotal,
    somaMinimos,
    extraBase,
    etapas,
    totalMeses: mes,
    totalJuros,
    atingivel,
    jaQuitadas,
    criterio,
  };
}

/* ==========================================================================
   APP / RENDER
   ========================================================================== */

export function initDividasApp() {
  loadPersisted();
  const root = qs("#dividas-root");
  if (!root) return;
  render(root);
}

function render(root) {
  clear(root);

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
  ]);

  const metodoBotoes = [];
  const metodoToggle = el(
    "div",
    { class: "freq-toggle", style: "margin-top:.75rem" },
    [
      ["saldo", "Bola de Neve (recomendado)"],
      ["taxa", "Avalanche"],
    ].map(([value, label]) => {
      const btn = el(
        "button",
        {
          type: "button",
          class: "freq-toggle__opt",
          "aria-pressed": String(state.criterio === value),
          onClick: () => {
            state.criterio = value;
            metodoBotoes.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.valor === value)));
            persist();
            renderResultado(root);
          },
        },
        label,
      );
      btn.dataset.valor = value;
      metodoBotoes.push(btn);
      return btn;
    }),
  );
  orcamentoCard.append(el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "Método de quitação"), metodoToggle]));

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

/* ==========================================================================
   RESULTADO — o "Plano de Quitação"
   ========================================================================== */

function renderResultado(root) {
  const host = qs("#resultado-host", root);
  if (!host) return;
  clear(host);

  if (state.dividas.length === 0) return;

  const plano = calcularPlano(state.dividas, state.orcamentoTotal, state.criterio);

  if (plano.semDividasAtivas) {
    host.append(
      el("section", { class: "panel card" }, [
        el("h2", {}, "Parabéns"),
        el("p", {}, "Todas as dívidas cadastradas já estão quitadas (saldo zerado)."),
      ]),
    );
    return;
  }

  if (!plano.valido) {
    host.append(
      el("section", { class: "panel card" }, [
        el("h2", {}, "O orçamento não fecha"),
        el(
          "p",
          { class: "disclaimer", style: "color:var(--color-destructive);font-size:.9rem" },
          `A soma dos pagamentos mínimos é ${brl(plano.somaMinimos)}, mas seu orçamento mensal é ${brl(plano.orcamentoTotal)} — faltam ${brl(plano.faltam)} por mês. Aumente o orçamento disponível ou renegocie alguma dívida antes de montar o plano.`,
        ),
      ]),
    );
    return;
  }

  const prioridade = plano.etapas[0];
  const nomeMetodo = plano.criterio === "saldo" ? "Bola de Neve" : "Avalanche";
  const porqueLabel =
    plano.criterio === "saldo"
      ? `menor saldo entre as dívidas ativas (${brl(prioridade.saldo)})`
      : `maior taxa de juros entre as dívidas ativas (${prioridade.taxaMensalPct.toFixed(1).replace(".", ",")}% a.m.)`;

  // --- Destaque: o que pagar agora ---
  host.append(
    el("section", { class: "panel card resumo-mes" }, [
      el("span", { class: "resumo-mes__eyebrow" }, "Prioridade deste mês"),
      el("h2", { class: "resumo-mes__nome" }, prioridade.nome),
      el("div", { class: "resumo-mes__valor" }, [
        el("span", { class: "resumo-mes__valor-num" }, brl(prioridade.pagamentoRecomendado)),
        el("span", { class: "resumo-mes__valor-label" }, "pagamento recomendado este mês"),
      ]),
      el("div", { class: "resumo-mes__breakdown" }, [
        el("span", {}, [brl(prioridade.pagamentoMinimo), " mínimo"]),
        el("span", { class: "resumo-mes__mais" }, "+"),
        el("span", {}, [brl(prioridade.valorExtra), " extra"]),
      ]),
      el(
        "p",
        { class: "resumo-mes__explicacao" },
        `Escolhida por ter ${porqueLabel}. As outras dívidas recebem só o pagamento mínimo — todo o valor extra do seu orçamento (${brl(plano.extraBase)}) é concentrado aqui. Quando ela for quitada, esse valor inteiro passa para a próxima da fila automaticamente.`,
      ),
    ]),
  );

  // --- Plano de quitação: linha do tempo ---
  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, `Seu plano de quitação`),
      el("p", { class: "panel-lead" }, `Método: ${nomeMetodo}. Ordem em que suas dívidas vão sumir.`),
      el(
        "div",
        { class: "timeline" },
        plano.etapas.map((etapa, i) => timelineItem(etapa, i === 0, i === plano.etapas.length - 1)),
      ),
    ]),
  );

  // --- Resultado final ---
  const hoje = new Date();
  const dataFinal = new Date(hoje.getFullYear(), hoje.getMonth() + plano.totalMeses, hoje.getDate());
  const dataFinalLabel = dataFinal.toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  const saldoTotalHoje = plano.etapas.reduce((s, e) => s + e.saldo, 0);

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Resultado do plano"),
      el("div", { class: "resultado-grid" }, [
        resultItem("Dívida total hoje", brl(saldoTotalHoje)),
        resultItem("Valor mensal destinado", brl(plano.orcamentoTotal)),
        resultItem("Tempo até quitar tudo", plano.atingivel ? formatAnosMeses(plano.totalMeses) : "não atinge"),
        resultItem("Total pago em juros", brl(plano.totalJuros)),
      ]),
      plano.atingivel
        ? el("p", { class: "economia-nota" }, `Livre de dívidas por volta de ${dataFinalLabel}.`)
        : el(
            "p",
            { class: "disclaimer", style: "color:var(--color-destructive)" },
            "Com esse orçamento, o plano não quita tudo em 50 anos de simulação — considere aumentar o valor mensal.",
          ),
      progressoMarcos(plano, saldoTotalHoje),
      el(
        "p",
        { class: "disclaimer" },
        "Simulação educacional e não é recomendação financeira. Não considera multas, taxas adicionais, renegociações ou mudanças futuras nas taxas de juros.",
      ),
    ]),
  );
}

function progressoMarcos(plano, saldoTotalHoje) {
  const ordemCronologica = [...plano.etapas].sort((a, b) => a.mesQuitacao - b.mesQuitacao);
  const marcos = [{ label: "Hoje", valor: saldoTotalHoje }];
  ordemCronologica.forEach((etapa) => {
    marcos.push({ label: `${etapa.nome} quitada`, valor: Math.max(etapa.saldoRestanteApos, 0) });
  });

  return el(
    "div",
    { class: "marcos-divida" },
    marcos.map((m) =>
      el("div", { class: "marco-item" }, [
        el("span", { class: "marco-item__valor" }, brl(m.valor)),
        el("span", { class: "marco-item__label" }, m.label),
      ]),
    ),
  );
}

function timelineItem(etapa, ehAtual, ehUltima) {
  return el("div", { class: `timeline__item${ehAtual ? " timeline__item--atual" : ""}${ehUltima ? " timeline__item--ultima" : ""}` }, [
    el("div", { class: "timeline__marker" }, String(etapa.ordem)),
    el("div", { class: "timeline__content" }, [
      el("div", { class: "timeline__header" }, [
        el("h3", {}, etapa.nome),
        ehAtual ? el("span", { class: "timeline__badge" }, "Pague agora") : null,
      ]),
      el("div", { class: "timeline__stats" }, [
        el("span", {}, ["Saldo ", el("strong", {}, brl(etapa.saldo))]),
        el("span", {}, ["Pagamento ", el("strong", {}, `${brl(etapa.pagamentoRecomendado)}/mês`)]),
        el("span", {}, ["Quita em ", el("strong", {}, etapa.mesQuitacao ? formatAnosMeses(etapa.mesQuitacao) : "—")]),
      ]),
    ]),
  ]);
}

function resultItem(label, value) {
  return el("div", { class: "result-item" }, [
    el("span", { class: "result-item__label" }, label),
    el("span", { class: "result-item__value" }, value),
  ]);
}

function formatAnosMeses(totalMeses) {
  const anos = Math.floor(totalMeses / 12);
  const meses = totalMeses % 12;
  const partes = [];
  if (anos > 0) partes.push(`${anos} ano${anos > 1 ? "s" : ""}`);
  if (meses > 0 || anos === 0) partes.push(`${meses} ${meses === 1 ? "mês" : "meses"}`);
  return partes.join(" e ");
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initDividasApp();
});