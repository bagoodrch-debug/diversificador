import { el, qs, clear, onReady, markActiveNav, initNavToggle } from "./core/dom.js";
import { brl, parseCurrencyInput, formatCurrencyInput } from "./core/format.js";
import { KEYS, load, save } from "./core/store.js";
import { getTaxas } from "./services/taxas-service.js";

const CDB_PRESETS = [
  { label: "CDB liquidez diária (banco grande)", percentualCdi: 100 },
  { label: "CDB com carência (banco médio)", percentualCdi: 110 },
  { label: "CDB banco digital, prazo maior", percentualCdi: 120 },
];

const DEFAULTS = {
  valor: 10000,
  meses: 12,
  percentualCdiCdb: 100,
  spreadTesouroPct: 0.05,
  custodiaTesouroPct: 0.2,
};

const state = { ...DEFAULTS, cdiAnualPct: null, cdiError: null, cdiDataRef: null };

function loadPersisted() {
  const saved = load(KEYS.STATE);
  if (saved) Object.assign(state, DEFAULTS, saved);
}
function persist() {
  save(KEYS.STATE, {
    valor: state.valor,
    meses: state.meses,
    percentualCdiCdb: state.percentualCdiCdb,
    spreadTesouroPct: state.spreadTesouroPct,
    custodiaTesouroPct: state.custodiaTesouroPct,
  });
}

/** Tabela regressiva de IR sobre renda fixa (regra oficial, não muda). */
function aliquotaIR(dias) {
  if (dias <= 180) return 0.225;
  if (dias <= 360) return 0.2;
  if (dias <= 720) return 0.175;
  return 0.15;
}

/** Regra oficial da poupança: 0,5% a.m. se Selic > 8,5% a.a., senão 70% da Selic. TR aproximada em 0. */
function taxaPoupancaAnualPct(selicAnualPct) {
  if (selicAnualPct > 8.5) {
    return (Math.pow(1.005, 12) - 1) * 100;
  }
  return selicAnualPct * 0.7;
}

function calcularProduto({ valor, meses, taxaBrutaAnualPct, temIR, custodiaAnualPct = 0 }) {
  const dias = meses * 30;
  const taxaMensal = Math.pow(1 + taxaBrutaAnualPct / 100, 1 / 12) - 1;
  const valorFinalBruto = valor * Math.pow(1 + taxaMensal, meses);
  const rendimentoBruto = valorFinalBruto - valor;
  const aliquota = temIR ? aliquotaIR(dias) : 0;
  const ir = rendimentoBruto > 0 ? rendimentoBruto * aliquota : 0;
  const custodia = custodiaAnualPct > 0 ? valor * (custodiaAnualPct / 100) * (meses / 12) : 0;
  const rendimentoLiquido = rendimentoBruto - ir - custodia;
  const valorFinalLiquido = valor + rendimentoLiquido;
  const rentabilidadeLiquidaPct = valor > 0 ? (rendimentoLiquido / valor) * 100 : 0;
  return {
    taxaBrutaAnualPct,
    rendimentoBruto,
    ir,
    aliquotaIRPct: aliquota * 100,
    custodia,
    rendimentoLiquido,
    valorFinalLiquido,
    rentabilidadeLiquidaPct,
  };
}

export function initInvestirApp() {
  loadPersisted();
  const root = qs("#investir-root");
  if (!root) return;
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
  const mesesInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state.meses),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseInt(e.target.value.replace(/[^0-9]/g, ""), 10);
      state.meses = Number.isFinite(n) && n > 0 ? n : 1;
      persist();
      renderResultado(root);
    },
  });

  const basicoCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Quanto e por quanto tempo?"),
    el("div", { class: "field-row" }, [
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Valor a investir"), valorInput]),
      el("div", { class: "field-group", style: "flex:1" }, [el("label", { class: "field-label" }, "Prazo (meses)"), mesesInput]),
    ]),
    el("div", { class: "cdi-info", id: "cdi-info" }),
  ]);

  const cdbPresetRow = el(
    "div",
    { class: "preset-row" },
    CDB_PRESETS.map((p) =>
      el(
        "button",
        {
          type: "button",
          class: "preset-chip",
          "aria-pressed": String(state.percentualCdiCdb === p.percentualCdi),
          onClick: () => {
            state.percentualCdiCdb = p.percentualCdi;
            persist();
            render(root);
          },
        },
        `${p.label} (${p.percentualCdi}% CDI)`,
      ),
    ),
  );

  const cdbInput = el("input", {
    class: "field",
    inputmode: "numeric",
    value: String(state.percentualCdiCdb),
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const n = parseFloat(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""));
      state.percentualCdiCdb = Number.isFinite(n) ? n : 0;
      persist();
      renderResultado(root);
    },
  });

  const cdbCard = el("section", { class: "panel card" }, [
    el("h2", {}, "Qual CDB você quer comparar?"),
    el(
      "p",
      { class: "panel-lead" },
      "Os exemplos abaixo são ilustrativos (não são dados ao vivo de nenhum banco específico) — digite a taxa real que o seu banco oferece.",
    ),
    cdbPresetRow,
    el("div", { class: "field-group" }, [el("label", { class: "field-label" }, "CDB rende quantos % do CDI?"), cdbInput]),
  ]);

  root.append(basicoCard, cdbCard, el("div", { id: "resultado-host" }));
  renderCdiInfo(root);
  renderResultado(root);
}

function renderCdiInfo(root) {
  const box = qs("#cdi-info", root);
  if (!box) return;
  clear(box);
  if (state.cdiAnualPct != null) {
    box.append(
      el("p", { class: "cdi-info__value" }, `CDI atual: ${state.cdiAnualPct.toFixed(2).replace(".", ",")}% ao ano`),
      el("p", { class: "cdi-info__meta" }, `Usado como base para Tesouro Selic, CDB e poupança. Referência: ${state.cdiDataRef ?? "—"}`),
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

  if (state.cdiAnualPct == null) {
    host.append(el("p", { class: "disclaimer" }, "Aguardando a taxa CDI carregar para calcular…"));
    return;
  }

  const taxaPoupanca = taxaPoupancaAnualPct(state.cdiAnualPct);
  const taxaTesouro = state.cdiAnualPct + state.spreadTesouroPct;
  const taxaCdb = state.cdiAnualPct * (state.percentualCdiCdb / 100);

  const poupanca = calcularProduto({ valor: state.valor, meses: state.meses, taxaBrutaAnualPct: taxaPoupanca, temIR: false });
  const tesouro = calcularProduto({
    valor: state.valor,
    meses: state.meses,
    taxaBrutaAnualPct: taxaTesouro,
    temIR: true,
    custodiaAnualPct: state.custodiaTesouroPct,
  });
  const cdb = calcularProduto({ valor: state.valor, meses: state.meses, taxaBrutaAnualPct: taxaCdb, temIR: true });

  const produtos = [
    {
      nome: "Poupança",
      resultado: poupanca,
      vantagens: ["Isenta de Imposto de Renda", "Liquidez imediata, sem carência", "Sem taxas"],
      desvantagens: ["Rende pouco fora de momentos de Selic baixa", "Costuma perder para CDB e Tesouro na maioria dos cenários"],
    },
    {
      nome: "Tesouro Selic",
      resultado: tesouro,
      vantagens: ["Risco baixíssimo (garantia do Tesouro Nacional)", "Boa liquidez (venda em D+1)", "Bom pra reserva de emergência"],
      desvantagens: ["Tem Imposto de Renda regressivo", "Taxa de custódia da B3 (pode ter isenção para saldos pequenos, confira as regras atuais)"],
    },
    {
      nome: "CDB",
      resultado: cdb,
      vantagens: ["Pode render mais que o Tesouro, dependendo do banco", "Garantido pelo FGC até R$ 250 mil por CPF/instituição", "Sem taxa de custódia"],
      desvantagens: ["Tem Imposto de Renda regressivo", "Pode ter carência (sem liquidez antes do vencimento)", "Depende da saúde financeira do banco emissor"],
    },
  ];

  const melhor = produtos.reduce((a, b) => (b.resultado.valorFinalLiquido > a.resultado.valorFinalLiquido ? b : a));

  host.append(
    el(
      "section",
      { class: "panel card" },
      [
        el("h2", {}, "Comparação líquida (já descontando IR)"),
        el("div", { class: "comparacao-grid" }, produtos.map((p) => produtoCard(p, p === melhor))),
        el(
          "p",
          { class: "disclaimer" },
          "Simulação educacional. Considera taxas constantes durante todo o prazo (na prática, CDI/Selic variam) e não é recomendação de investimento. Confira sempre as condições reais (carência, taxas, garantias) antes de investir.",
        ),
      ],
    ),
  );
}

function produtoCard(p, destaque) {
  const r = p.resultado;
  return el("div", { class: `produto-card${destaque ? " produto-card--destaque" : ""}` }, [
    destaque ? el("span", { class: "produto-card__selo" }, "Melhor líquido") : null,
    el("h3", {}, p.nome),
    el("div", { class: "produto-card__stat" }, [
      el("span", { class: "produto-card__label" }, "Taxa bruta"),
      el("span", { class: "produto-card__value" }, `${r.taxaBrutaAnualPct.toFixed(2).replace(".", ",")}% a.a.`),
    ]),
    el("div", { class: "produto-card__stat" }, [
      el("span", { class: "produto-card__label" }, "Rendimento bruto"),
      el("span", { class: "produto-card__value" }, brl(r.rendimentoBruto)),
    ]),
    r.ir > 0
      ? el("div", { class: "produto-card__stat" }, [
          el("span", { class: "produto-card__label" }, `IR (${r.aliquotaIRPct.toFixed(1).replace(".", ",")}%)`),
          el("span", { class: "produto-card__value produto-card__value--neg" }, `- ${brl(r.ir)}`),
        ])
      : null,
    r.custodia > 0
      ? el("div", { class: "produto-card__stat" }, [
          el("span", { class: "produto-card__label" }, "Custódia B3"),
          el("span", { class: "produto-card__value produto-card__value--neg" }, `- ${brl(r.custodia)}`),
        ])
      : null,
    el("div", { class: "produto-card__stat produto-card__stat--total" }, [
      el("span", { class: "produto-card__label" }, "Rendimento líquido"),
      el("span", { class: "produto-card__value" }, brl(r.rendimentoLiquido)),
    ]),
    el("div", { class: "produto-card__final" }, [
      el("span", {}, "Valor final líquido"),
      el("strong", {}, brl(r.valorFinalLiquido)),
    ]),
    el("details", { class: "produto-card__detalhes" }, [
      el("summary", {}, "Vantagens e desvantagens"),
      el(
        "ul",
        { class: "produto-card__lista produto-card__lista--boas" },
        p.vantagens.map((v) => el("li", {}, v)),
      ),
      el(
        "ul",
        { class: "produto-card__lista produto-card__lista--ruins" },
        p.desvantagens.map((v) => el("li", {}, v)),
      ),
    ]),
  ]);
}

onReady(() => {
  markActiveNav();
  initNavToggle();
  const yearEl = qs("#year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  initInvestirApp();
});
