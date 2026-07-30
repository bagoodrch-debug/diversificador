// Roda em Node (GitHub Actions), NUNCA no navegador.
// Busca a taxa CDI diária mais recente na API pública do Banco Central
// (SGS, série 12 — "Taxa de juros - CDI") e grava reserva/dados/taxas.json.
// É uma API oficial do governo, gratuita, sem token e sem cota.
//
// A série vem em % ao dia. Anualizamos por juros compostos (252 dias
// úteis/ano, convenção padrão do mercado financeiro brasileiro).

const BCB_URL = "https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados/ultimos/1?formato=json";

async function fetchCdi() {
  const r = await fetch(BCB_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`BCB ${r.status}`);
  const j = await r.json();
  const item = j[0];
  if (!item || !item.valor) throw new Error("Resposta do BCB sem dado de CDI");

  const taxaDiariaPct = parseFloat(item.valor.replace(",", "."));
  const taxaAnualPct = (Math.pow(1 + taxaDiariaPct / 100, 252) - 1) * 100;

  return {
    dataReferencia: item.data, // dd/mm/aaaa, conforme o BCB
    taxaDiariaPct,
    taxaAnualPct,
  };
}

async function main() {
  const fs = await import("node:fs/promises");
  let payload;
  try {
    const cdi = await fetchCdi();
    payload = {
      updatedAt: new Date().toISOString(),
      cdi,
      error: null,
    };
  } catch (e) {
    payload = {
      updatedAt: new Date().toISOString(),
      cdi: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  await fs.mkdir("dados", { recursive: true });
  await fs.writeFile("dados/taxas.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("dados/taxas.json atualizado:", payload);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
