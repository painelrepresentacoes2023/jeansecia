import { sb } from "../supabase.js";

/* =========================
   HELPERS
========================= */
function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function clamp0(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

function ymToRange(ym) {
  // ym: "2026-01"
  const [y, m] = String(ym).split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 1); // first day of next month
  const toIso = (dt) =>
    `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}T00:00:00`;
  return { startISO: toIso(start), endISO: toIso(end) };
}

/* =========================
   DATA FETCHERS (robustos)
========================= */

async function sumVendasMes(ym) {
  const { startISO, endISO } = ymToRange(ym);

  // tenta data > created_at (sua tabela vendas costuma ter "data")
  const tries = [
    () =>
      sb
        .from("vendas")
        .select("id,total,data,created_at")
        .gte("data", startISO)
        .lt("data", endISO),
    () =>
      sb
        .from("vendas")
        .select("id,total,data,created_at")
        .gte("created_at", startISO)
        .lt("created_at", endISO),
  ];

  let data = null;
  let error = null;

  for (const fn of tries) {
    const res = await fn();
    if (!res.error) {
      data = res.data || [];
      error = null;
      break;
    }
    error = res.error;
  }

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);

  return { total, count: rows.length, rows };
}

async function sumComprasMes(ym) {
  const { startISO, endISO } = ymToRange(ym);

  // compras: tenta "total" / "valor_total" / "valor" / "custo_total"
  // data: tenta "data" / "created_at"
  const selects = [
    "id,data,created_at,total,valor_total,valor,custo_total,fornecedor,observacoes",
  ];

  const tries = [
    () =>
      sb
        .from("compras")
        .select(selects[0])
        .gte("data", startISO)
        .lt("data", endISO),
    () =>
      sb
        .from("compras")
        .select(selects[0])
        .gte("created_at", startISO)
        .lt("created_at", endISO),
  ];

  let data = null;
  let error = null;

  for (const fn of tries) {
    const res = await fn();
    if (!res.error) {
      data = res.data || [];
      error = null;
      break;
    }
    error = res.error;
  }

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => {
    const v =
      r.total ??
      r.valor_total ??
      r.valor ??
      r.custo_total ??
      0;
    return acc + Number(v || 0);
  }, 0);

  return { total, count: rows.length, rows };
}

function fmtDateBR(iso) {
  if (!iso) return "-";
  const s = String(iso).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("pt-BR");
  }
  const d2 = new Date(iso);
  if (Number.isNaN(d2.getTime())) return String(iso);
  return d2.toLocaleDateString("pt-BR");
}

function pickDateRow(r) {
  return r?.data || r?.created_at || null;
}

/* =========================
   UI
========================= */
function renderFinanceiroLayout() {
  const now = new Date();
  const ymDefault = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  return `
    <div class="card">
      <div class="card-title">Financeiro</div>
      <div class="card-sub">Vendas x Compras (gastos) e lucro do mês</div>

      <div class="grid" style="grid-template-columns: 220px auto; gap:12px; margin-top:12px; align-items:end;">
        <div class="field">
          <label>Mês</label>
          <input class="input" type="month" id="finMes" value="${ymDefault}" />
        </div>
        <div style="display:flex; gap:10px; align-items:end;">
          <button class="btn primary" id="btnFin">Aplicar</button>
          <div class="small" id="finMsg"></div>
        </div>
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr 1fr; gap:12px; margin-top:14px;">
        <div class="card">
          <div class="card-title">Vendas do mês</div>
          <div class="card-sub">Total e quantidade</div>
          <div id="finVendas" style="margin-top:10px;" class="small">—</div>
        </div>
        <div class="card">
          <div class="card-title">Compras (gastos)</div>
          <div class="card-sub">Total e quantidade</div>
          <div id="finCompras" style="margin-top:10px;" class="small">—</div>
        </div>
        <div class="card">
          <div class="card-title">Lucro do mês</div>
          <div class="card-sub">Vendas - Compras</div>
          <div id="finLucro" style="margin-top:10px;" class="small">—</div>
        </div>
      </div>

      <div class="grid cols-2" style="margin-top:14px; gap:12px;">
        <div class="card">
          <div class="card-title">Últimas vendas do mês</div>
          <div class="card-sub">Para bater o olho</div>
          <div id="finListVendas" class="small" style="margin-top:10px;">—</div>
        </div>

        <div class="card">
          <div class="card-title">Últimas compras do mês</div>
          <div class="card-sub">Para bater o olho</div>
          <div id="finListCompras" class="small" style="margin-top:10px;">—</div>
        </div>
      </div>
    </div>
  `;
}

function renderListVendas(rows) {
  if (!rows?.length) return `<div class="small">Nenhuma venda no mês.</div>`;

  const last = [...rows]
    .sort((a, b) => String(pickDateRow(b)).localeCompare(String(pickDateRow(a))))
    .slice(0, 6);

  return `
    <div class="table-wrap">
      <table class="table" style="min-width: 600px;">
        <thead>
          <tr>
            <th>Data</th>
            <th>Total</th>
            <th>ID</th>
          </tr>
        </thead>
        <tbody>
          ${last
            .map((r) => {
              const dt = fmtDateBR(pickDateRow(r));
              return `
                <tr>
                  <td>${escapeHtml(dt)}</td>
                  <td>${money(r.total || 0)}</td>
                  <td class="small">${escapeHtml(String(r.id || ""))}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderListCompras(rows) {
  if (!rows?.length) return `<div class="small">Nenhuma compra no mês.</div>`;

  const last = [...rows]
    .sort((a, b) => String(pickDateRow(b)).localeCompare(String(pickDateRow(a))))
    .slice(0, 6);

  return `
    <div class="table-wrap">
      <table class="table" style="min-width: 700px;">
        <thead>
          <tr>
            <th>Data</th>
            <th>Fornecedor</th>
            <th>Total</th>
          </tr>
        </thead>
        <tbody>
          ${last
            .map((r) => {
              const dt = fmtDateBR(pickDateRow(r));
              const fornecedor = r.fornecedor || r.nome_fornecedor || "-";
              const v = r.total ?? r.valor_total ?? r.valor ?? r.custo_total ?? 0;

              return `
                <tr>
                  <td>${escapeHtml(dt)}</td>
                  <td>${escapeHtml(String(fornecedor))}</td>
                  <td>${money(v)}</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

async function aplicarFinanceiro(ym) {
  const msg = document.getElementById("finMsg");
  const elV = document.getElementById("finVendas");
  const elC = document.getElementById("finCompras");
  const elL = document.getElementById("finLucro");
  const listV = document.getElementById("finListVendas");
  const listC = document.getElementById("finListCompras");

  if (msg) msg.textContent = "Carregando...";

  try {
    const [v, c] = await Promise.all([sumVendasMes(ym), sumComprasMes(ym)]);

    const lucro = Number(v.total || 0) - Number(c.total || 0);

    if (elV) {
      elV.innerHTML = `
        <div style="font-size:1.2rem; font-weight:900;">${money(v.total)}</div>
        <div class="small">${v.count} venda(s)</div>
      `;
    }

    if (elC) {
      elC.innerHTML = `
        <div style="font-size:1.2rem; font-weight:900;">${money(c.total)}</div>
        <div class="small">${c.count} compra(s)</div>
      `;
    }

    if (elL) {
      const ok = lucro >= 0;
      elL.innerHTML = `
        <div style="font-size:1.35rem; font-weight:900;">
          ${money(lucro)}
        </div>
        <div class="small">${ok ? "Lucro" : "Prejuízo"} no mês</div>
      `;
    }

    if (listV) listV.innerHTML = renderListVendas(v.rows);
    if (listC) listC.innerHTML = renderListCompras(c.rows);

    if (msg) msg.textContent = "";
  } catch (e) {
    console.error(e);
    if (msg) msg.textContent = e?.message || "Erro ao carregar financeiro.";
    if (elV) elV.textContent = "—";
    if (elC) elC.textContent = "—";
    if (elL) elL.textContent = "—";
  }
}

/* =========================
   EXPORT
========================= */
export async function renderFinanceiro() {
  const html = renderFinanceiroLayout();

  setTimeout(() => {
    const inp = document.getElementById("finMes");
    const btn = document.getElementById("btnFin");

    const run = () => aplicarFinanceiro(inp?.value);

    if (btn) btn.addEventListener("click", run);
    if (inp) inp.addEventListener("change", run);

    // primeira carga
    run();
  }, 0);

  return html;
}
