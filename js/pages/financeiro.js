import { sb } from "../supabase.js";

/* =========================
   HELPERS
========================= */
function money(n) {
  return Number(n || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function endOfDay(isoDate) {
  return `${isoDate}T23:59:59.999`;
}

/* =========================
   CORE
========================= */
async function somarVendas(inicio, fim) {
  const { data, error } = await sb
    .from("vendas")
    .select("total, created_at")
    .gte("created_at", `${inicio}T00:00:00`)
    .lte("created_at", endOfDay(fim))
    .limit(10000);

  if (error) throw error;

  return (data || []).reduce((s, r) => s + Number(r.total || 0), 0);
}

/**
 * ✅ Compras: não some "compras.total" porque no seu print está tudo 0.00.
 * O correto é somar o total calculado (view) ou o total vindo dos itens.
 */
async function somarCompras(inicio, fim) {
  const { data, error } = await sb
    .from("vw_compras_resumo")
    .select("total_itens, data")
    .gte("data", inicio)
    .lte("data", fim)
    .limit(10000);

  if (error) throw error;

  return (data || []).reduce((s, r) => s + Number(r.total_itens || 0), 0);
}




/* =========================
   UI
========================= */
function layout() {
  return `
    <div class="card">
      <div class="card-title">Financeiro</div>
      <div class="card-sub">Resumo de receitas, despesas e lucro</div>

      <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px;">
        <div class="field">
          <label>Início</label>
          <input class="input" type="date" id="finIni" />
        </div>
        <div class="field">
          <label>Fim</label>
          <input class="input" type="date" id="finFim" />
        </div>
        <button class="btn primary" id="finAplicar">Aplicar</button>
      </div>

      <div class="grid" style="grid-template-columns: 1fr; gap:10px; margin-top:14px;">
        <div class="card">
          <div class="small">Total vendido</div>
          <div id="outVendas" style="font-size:1.2rem;font-weight:800;">—</div>
        </div>

        <div class="card">
          <div class="small">Total gasto</div>
          <div id="outCompras" style="font-size:1.2rem;font-weight:800;">—</div>
        </div>

        <div class="card">
          <div class="small">Lucro líquido</div>
          <div id="outLucro" style="font-size:1.2rem;font-weight:900;">—</div>
        </div>

        <div class="small" id="finMsg"></div>
      </div>
    </div>
  `;
}

async function atualizar() {
  const ini = document.getElementById("finIni").value;
  const fim = document.getElementById("finFim").value;

  const outV = document.getElementById("outVendas");
  const outC = document.getElementById("outCompras");
  const outL = document.getElementById("outLucro");
  const msg = document.getElementById("finMsg");

  msg.textContent = "Calculando...";

  try {
    const vendas = await somarVendas(ini, fim);
    outV.textContent = money(vendas);

    const compras = await somarCompras(ini, fim);
    outC.textContent = money(compras);

    outL.textContent = money(vendas - compras);
    msg.textContent = "Resumo atualizado com sucesso.";
  } catch (e) {
    console.error("FINANCEIRO_ERRO:", e);
    msg.textContent = `Erro ao calcular financeiro: ${e?.message || "ver console"}`;
  }
}


/* =========================
   EXPORT
========================= */
export async function renderFinanceiro() {
  const html = layout();

  setTimeout(() => {
    const hoje = new Date();
    const inicio = new Date();
    inicio.setDate(hoje.getDate() - 30);

    document.getElementById("finIni").value = toISO(inicio);
    document.getElementById("finFim").value = toISO(hoje);

    document.getElementById("finAplicar").addEventListener("click", atualizar);

    atualizar();
  }, 0);

  return html;
}
