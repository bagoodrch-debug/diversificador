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
      }
    }
  }

  const etapas = etapasBase.map((etapa, i) => ({ ...etapa, ordem: i + 1, mesQuitacao: mesQuitacaoSim[i] }));
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
        el("h2", {}, "Parabéns! 🎉"),
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
      ? `porque tem o menor saldo (${brl(prioridade.saldo)}) entre as dívidas ativas`
      : `porque tem a maior taxa de juros (${prioridade.taxaMensalPct.toFixed(1).replace(".", ",")}% a.m.) entre as dívidas ativas`;

  // --- Resumo do mês: "o que eu faço com meu dinheiro este mês" ---
  host.append(
    el("section", { class: "panel card resumo-mes" }, [
      el("h2", {}, "O que fazer com seu dinheiro este mês"),
      el("p", { class: "resumo-linha" }, ["💰 Você tem ", el("strong", {}, brl(plano.orcamentoTotal)), " disponíveis para dívidas este mês."]),
      el("p", { class: "resumo-linha" }, ["🔒 ", el("strong", {}, brl(plano.somaMinimos)), " vão para os pagamentos mínimos de todas as dívidas."]),
      el("p", { class: "resumo-linha" }, [
        "🎯 Os ",
        el("strong", {}, brl(plano.extraBase)),
        " restantes vão inteiros para \"",
        el("strong", {}, prioridade.nome),
        "\" — ",
        porqueLabel,
        ".",
      ]),
      el("p", { class: "resumo-linha resumo-linha--destaque" }, [
        "👉 Pagamento recomendado em ",
        el("strong", {}, prioridade.nome),
        ": ",
        el("strong", { class: "resumo-valor" }, brl(prioridade.pagamentoRecomendado)),
        " este mês.",
      ]),
      el(
        "p",
        { class: "disclaimer", style: "margin-top:.6rem" },
        "Você paga o mínimo das outras dívidas e concentra todo o dinheiro extra nesta. Quando ela for quitada, o valor que era usado nela é transferido automaticamente para a próxima da fila.",
      ),
    ]),
  );

  // --- Plano de quitação (cascata) ---
  const etapasEls = [];
  plano.etapas.forEach((etapa, i) => {
    etapasEls.push(etapaCard(etapa, i === 0));
    if (i < plano.etapas.length - 1) {
      etapasEls.push(
        el("div", { class: "cascata-seta" }, [
          el("span", {}, `↓ ao quitar, libera ${brl(etapa.pagamentoMinimo)}/mês para a próxima`),
        ]),
      );
    }
  });

  host.append(
    el("section", { class: "panel card" }, [
      el("div", { class: "plano-head" }, [
        el("h2", {}, `Seu plano de quitação (${nomeMetodo})`),
      ]),
      el("div", { class: "plano-etapas" }, etapasEls),
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
      progressoBar(plano),
      el(
        "p",
        { class: "disclaimer" },
        "Simulação educacional e não é recomendação financeira. Não considera multas, taxas adicionais, renegociações ou mudanças futuras nas taxas de juros.",
      ),
    ]),
  );
}

function etapaCard(etapa, ehPrioridadeAtual) {
  return el("div", { class: `etapa-card${ehPrioridadeAtual ? " etapa-card--atual" : ""}` }, [
    el("div", { class: "etapa-card__top" }, [
      el("span", { class: "etapa-card__ordem" }, `${etapa.ordem}º`),
      el("div", { style: "min-width:0" }, [
        el("h3", {}, etapa.nome),
        ehPrioridadeAtual ? el("span", { class: "etapa-card__tag" }, "Prioridade atual") : null,
      ]),
    ]),
    el("div", { class: "etapa-card__grid" }, [
      etapaStat("Saldo", brl(etapa.saldo)),
      etapaStat("Pagamento mínimo", brl(etapa.pagamentoMinimo)),
      etapaStat("Valor extra recebido", brl(etapa.valorExtra)),
      etapaStat("Pagamento planejado", brl(etapa.pagamentoRecomendado), true),
      etapaStat("Previsão de quitação", etapa.mesQuitacao ? formatAnosMeses(etapa.mesQuitacao) : "—"),
    ]),
  ]);
}

function etapaStat(label, value, destaque = false) {
  return el("div", { class: `etapa-stat${destaque ? " etapa-stat--destaque" : ""}` }, [
    el("span", { class: "etapa-stat__label" }, label),
    el("span", { class: "etapa-stat__value" }, value),
  ]);
}

function progressoBar(plano) {
  const saldoTotalHoje = plano.etapas.reduce((s, e) => s + e.saldo, 0);
  const marcos = [
    { label: "Hoje", valor: saldoTotalHoje },
    ...plano.etapas.map((e) => ({
      label: `Após quitar ${e.nome}`,
      valor: plano.etapas.filter((x) => x.mesQuitacao > e.mesQuitacao || (x.mesQuitacao === e.mesQuitacao && x.ordem > e.ordem)).reduce((s, x) => s + x.saldo, 0),
    })),
  ];
  return el(
    "div",
    { class: "marcos-divida" },
    marcos.map((m, i) =>
      el("div", { class: "marco-item" }, [
        el("span", { class: "marco-item__valor" }, brl(Math.max(m.valor, 0))),
        el("span", { class: "marco-item__label" }, m.label),
      ]),
    ),
  );
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
