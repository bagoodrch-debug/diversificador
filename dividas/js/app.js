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
   "saldo" → Bola de Neve (menor saldo primeiro)
   "taxa"  → Avalanche (maior juros primeiro)
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

  const ordenadas = [...ativas].sort((a, b) =>
    criterio === "saldo" ? a.saldo - b.saldo : b.taxaMensalPct - a.taxaMensalPct,
  );

  let extraAcumulado = extraBase;
  const etapasBase = ordenadas.map((d, i) => {
    const valorExtra = i === 0 ? extraBase : extraAcumulado;
    const pagamentoRecomendado = (d.pagamentoMinimo || 0) + valorExtra;
    const jurosMensal = d.saldo * ((d.taxaMensalPct || 0) / 100);
    const armadilha = i > 0 && (d.pagamentoMinimo || 0) > 0 && (d.pagamentoMinimo || 0) < jurosMensal;
    extraAcumulado += d.pagamentoMinimo || 0;
    return {
      id: d.id,
      nome: d.nome || "Dívida",
      saldo: d.saldo,
      taxaMensalPct: d.taxaMensalPct || 0,
      pagamentoMinimo: d.pagamentoMinimo || 0,
      jurosMensal,
      armadilha,
      valorExtra,
      pagamentoRecomendado,
      ehPrioridade: i === 0,
    };
  });

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

  const etapas = etapasBase.map((etapa, i) => ({
    ...etapa,
    ordem: i + 1,
    mesQuitacao: mesQuitacaoSim[i],
    mesesAteVirarPrioridade: i === 0 ? 0 : mesQuitacaoSim[i - 1],
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
  orcamentoCard.append(
    el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "Método de quitação"), metodoToggle]),
  );

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
   RESULTADO
   Escrito de propósito com <p> em vez de <span> soltos — parágrafo tem
   espaçamento próprio do navegador mesmo sem nenhum CSS carregado, então o
   texto nunca fica "grudado" mesmo se algum CSS não for aplicado certo.
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
          { class: "alerta alerta--erro" },
          `A soma dos pagamentos mínimos é ${brl(plano.somaMinimos)}, mas seu orçamento mensal é ${brl(plano.orcamentoTotal)} — faltam ${brl(plano.faltam)} por mês. Aumente o orçamento disponível ou renegocie alguma dívida antes de montar o plano.`,
        ),
      ]),
    );
    return;
  }

  const prioridade = plano.etapas[0];
  const nomeMetodo = plano.criterio === "saldo" ? "Bola de Neve" : "Avalanche";
  const motivoEscolha =
    plano.criterio === "saldo"
      ? `porque é a dívida com o menor saldo (${brl(prioridade.saldo)}) entre as que ainda estão ativas`
      : `porque é a dívida com a maior taxa de juros (${prioridade.taxaMensalPct.toFixed(1).replace(".", ",")}% ao mês) entre as que ainda estão ativas`;

  host.append(
    el("section", { class: "panel card" }, [
      el("h2", {}, "Seu orçamento este mês"),
      el("div", { class: "resultado-grid" }, [
        resultItem("Disponível para dívidas", brl(plano.orcamentoTotal)),
        resultItem("Vai para os mínimos", brl(plano.somaMinimos)),
        resultItem("Sobra pra acelerar", brl(plano.extraBase)),
      ]),
    ]),
  );

  const armadilhas = plano.etapas.filter((e) => e.armadilha);
  if (armadilhas.length > 0) {
    host.append(
      el("section", { class: "panel card" }, [
        el("h2", {}, "⚠️ Atenção com estas dívidas"),
        ...armadilhas.map((e) =>
          el("p", { class: "alerta alerta--aviso" }, [
            el("strong", {}, e.nome),
            `: o pagamento mínimo (${brl(e.pagamentoMinimo)}) é menor que os juros que ela gera por mês (${brl(e.jurosMensal)}). Enquanto ela não virar prioridade, o saldo dela vai crescer em vez de diminuir — mesmo pagando o mínimo em dia.`,
          ]),
        ),
      ]),
    );
  }

  const planoCard = el("section", { class: "panel card" }, [
    el("h2", {}, `Plano de pagamento — ${nomeMetodo}`),
    el("p", { class: "panel-lead" }, "O que fazer com cada dívida, começando pela que você deve pagar primeiro."),
  ]);
  plano.etapas.forEach((etapa) => {
    planoCard.append(dividaStatusBlock(etapa, motivoEscolha));
  });
  host.append(planoCard);

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
        ? el("p", { class: "alerta alerta--sucesso" }, `Livre de dívidas por volta de ${dataFinalLabel}.`)
        : el(
            "p",
            { class: "alerta alerta--erro" },
            "Com esse orçamento, o plano não quita tudo em 50 anos de simulação — considere aumentar o valor mensal.",
          ),
      el(
        "p",
        { class: "disclaimer" },
        "Simulação educacional e não é recomendação financeira. Não considera multas, taxas adicionais, renegociações ou mudanças futuras nas taxas de juros.",
      ),
    ]),
  );
}

function dividaStatusBlock(etapa, motivoEscolha) {
  const filhos = [];

  filhos.push(
    el("div", { class: "divida-status__header" }, [
      el("span", { class: "divida-status__ordem" }, `${etapa.ordem}º`),
      el("h3", {}, etapa.nome),
      etapa.ehPrioridade
        ? el("span", { class: "divida-status__badge divida-status__badge--prioridade" }, "Pague agora")
        : el("span", { class: "divida-status__badge" }, "Só o mínimo por enquanto"),
    ]),
  );

  if (etapa.ehPrioridade) {
    filhos.push(
      el("p", { class: "divida-status__linha" }, [
        "Pagamento recomendado este mês: ",
        el("strong", { class: "divida-status__valor" }, brl(etapa.pagamentoRecomendado)),
      ]),
      el("p", { class: "divida-status__linha divida-status__linha--muted" }, [
        `${brl(etapa.pagamentoMinimo)} de mínimo + `,
        el("strong", {}, brl(etapa.valorExtra)),
        " de amortização extra (esse valor abate direto o saldo, sem virar juros).",
      ]),
      el("p", { class: "divida-status__linha divida-status__linha--muted" }, `Escolhida para ser a prioridade ${motivoEscolha}.`),
    );
  } else {
    filhos.push(
      el("p", { class: "divida-status__linha" }, [
        "Pague só o mínimo por enquanto: ",
        el("strong", { class: "divida-status__valor" }, brl(etapa.pagamentoMinimo)),
      ]),
      el(
        "p",
        { class: "divida-status__linha divida-status__linha--muted" },
        `Vira prioridade em ${formatAnosMeses(etapa.mesesAteVirarPrioridade)}, quando a dívida anterior da fila for quitada — aí ela passa a receber o valor extra.`,
      ),
    );
  }

  if (etapa.armadilha) {
    filhos.push(
      el(
        "p",
        { class: "alerta alerta--aviso alerta--compacto" },
        "⚠️ O mínimo desta dívida não cobre os juros do mês — veja o aviso no topo da página.",
      ),
    );
  }

  filhos.push(
    el("p", { class: "divida-status__linha divida-status__linha--muted" }, [
      `Saldo devedor: ${brl(etapa.saldo)} · `,
      `Juros: ${etapa.taxaMensalPct.toFixed(1).replace(".", ",")}% a.m. · `,
      `Previsão de quitação: ${etapa.mesQuitacao ? formatAnosMeses(etapa.mesQuitacao) : "—"}`,
    ]),
  );

  return el("div", { class: `divida-status${etapa.ehPrioridade ? " divida-status--prioridade" : ""}` }, filhos);
}

function resultItem(label, value) {
  return el("div", { class: "result-item" }, [
    el("span", { class: "result-item__label" }, label),
    el("span", { class: "result-item__value" }, value),
  ]);
}

function formatAnosMeses(totalMeses) {
  if (totalMeses <= 0) return "já é a prioridade";
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
