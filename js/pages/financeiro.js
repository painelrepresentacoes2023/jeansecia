import { sb } from "../supabase.js";

/* =========================
   HELPERS
========================= */
function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function toISODateLocal(d) {
  // retorna YYYY-MM-DD no fuso local
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function findFirstWorkingColumn(table, candidates) {
  for (const col of candidates) {
    const { error } = await sb.from(table).select(col).limit(1);
    if (!error) return col;
  }
  return null;
}

async function sumByDateRange(table, dateCandidates, valueCandidates, startISO, endISO) {
  const dateCol = await findFirstWorkingColumn(table, dateCandidates);
  if (!dateCol) throw new Error(`Tabela "${table}" não tem coluna de data compatível (${dateCandidates.join(", ")}).`);

  const valueCol = await findFirstWorkingColumn(table, valueCandidates);
  if (!valueCol) throw new Error(`Tabela "${table}" não tem coluna de valor compatível (${valueCandidates.join(", ")}).`);

  // Para pegar o dia inteiro no filtro:
  // - se for DATE: YYYY-MM-DD funciona
  // - se for TIMESTAMP (created_at): precisamos jogar end pro fim do dia
  const endForTs = `${endISO}T23:59:59.999`;

  let q = sb.from(table).select(`${valueCol},${dateCol}`).gte(dateCol, startISO);

  // se a coluna for created_at (timestamp), usa fim do dia com hora
  if (String(dateCol).toLowerCase().includes("created")) q = q.lte(dateCol, endForTs);
  else q = q.lte(dateCol, endISO);

  // evita ficar travado por paginação:
  // (se você tiver MUITAS linhas, depois a gente troca por uma RPC de soma no SQL)
  const { data, error } = await q.limit(10000);
  if (error) throw error;

  const total = (data || []).reduce((acc, r) => acc + Number(r?.[valueCol] || 0), 0);
  return { total, dateCol, valueCol };
}

/* =========================
   UI
========================= */
function layout() {
  return `
    <div class="card">
      <div class="card-title">Financeiro</div>
      <div class="card-sub">Resumo de receitas, despesas e lucro</div>

      <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px; align-items:end;">
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
          <div style="font-weight:900; font-size:1.15rem;" id="finVendas">—</div>
        </div>

        <div class="card">
          <div class="small">Total gasto</div>
          <div style="font-weight:900; font-size:1.15rem;" id="finCompras">—</div>
        </div>

        <div class="card">
          <div class="small">Lucro líquido</div>
          <div style="font-weight:900; font-size:1.15rem;" id="finLucro">—</div>
        </div>

        <div class="small" id="finMsg" style="opacity:.8;"></div>
      </div>
    </div>
  `;
}

async function atualizarResumo() {
  const iniEl = document.getElementById("finIni");
  const fimEl = document.getElementById("finFim");
  const msg = document.getElementById("finMsg");

  const outV = document.getElementById("finVendas");
  const outC = document.getElementById("finCompras");
  const outL = document.getElementById("finLucro");

  const ini = iniEl?.value;
  const fim = fimEl?.value;

  if (!ini || !fim) {
    if (msg) msg.textContent = "Selecione um período.";
    return;
  }

  if (msg) msg.textContent = "Calculando...";

  try {
    // VENDAS: normalmente é data + total
    const vendas = await sumByDateRange(
      "vendas",
      ["data", "created_at"],
      ["total", "valor_total", "subtotal"],
      ini,
      fim
    );

    // COMPRAS: aqui é onde geralmente dá ruim por nome de coluna diferente
    const compras = await sumByDateRange(
      "compras",
      ["data", "data_compra", "created_at"],
      ["total", "valor_total", "total_compra", "valor", "custo_total"],
      ini,
      fim
    );

    const totalVendido = vendas.total || 0;
    const totalGasto = compras.total || 0;
    const lucro = totalVendido - totalGasto;

    if (outV) outV.textContent = money(totalVendido);
    if (outC) outC.textContent = money(totalGasto);
    if (outL) outL.textContent = money(lucro);

    if (msg) {
      msg.textContent = `Resumo atualizado. (vendas: ${vendas.valueCol}/${vendas.dateCol} • compras: ${compras.valueCol}/${compras.dateCol})`;
    }
  } catch (e) {
    console.error(e);
    if (outV) outV.textContent = money(0);
    if (outC) outC.textContent = money(0);
    if (outL) outL.textContent = money(0);
    if (msg) msg.textContent = e?.message || "Erro ao calcular financeiro.";
  }
}

/* =========================
   EXPORT
========================= */
export async function renderFinanceiro() {
  const html = layout();

  setTimeout(() => {
    // ✅ últimos 30 dias automático
    const hoje = new Date();
    const ini = addDays(hoje, -30);

    const iniEl = document.getElementById("finIni");
    const fimEl = document.getElementById("finFim");
    const btn = document.getElementById("finAplicar");

    if (iniEl) iniEl.value = toISODateLocal(ini);
    if (fimEl) fimEl.value = toISODateLocal(hoje);

    btn?.addEventListener("click", atualizarResumo);

    // carrega sozinho ao abrir
    atualizarResumo();
  }, 0);

  return html;
}
