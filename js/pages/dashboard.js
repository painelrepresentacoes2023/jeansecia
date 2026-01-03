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

/**
 * Corrige bug do “volta 1 dia” em DATE (YYYY-MM-DD)
 */
function fmtDateBR(iso) {
  if (!iso) return "-";
  const s = String(iso).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString("pt-BR");
  }
  const d2 = new Date(iso);
  if (Number.isNaN(d2.getTime())) return String(iso);
  return d2.toLocaleDateString("pt-BR");
}

function normId(v) {
  if (v == null) return "";
  return String(v).trim();
}

function clamp0(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

/**
 * Intervalo do dia (local) em ISO (pra filtrar timestamp)
 */
function getTodayRangeISO() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function toISODateYYYYMMDD(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateInputToISOStartEnd(startYYYYMMDD, endYYYYMMDD) {
  // inclui o dia final inteiro
  const [sy, sm, sd] = startYYYYMMDD.split("-").map(Number);
  const [ey, em, ed] = endYYYYMMDD.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd, 0, 0, 0, 0);
  const end = new Date(ey, em - 1, ed + 1, 0, 0, 0, 0);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

/* =========================
   LOADERS
========================= */
async function loadVendasHoje() {
  const { startISO, endISO } = getTodayRangeISO();
  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data,created_at")
    .gte("data", startISO)
    .lt("data", endISO);

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { qtd: rows.length, total };
}

async function loadVendasPeriodo(startISO, endISO) {
  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data")
    .gte("data", startISO)
    .lt("data", endISO);

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { qtd: rows.length, total };
}

/**
 * Crediário (dashboard):
 * - Total em aberto (somando saldo das parcelas abertas)
 * - Próxima parcela a vencer (a mais próxima em vencimento, ainda aberta)
 */
async function loadCrediarioDashboard() {
  // Pega parcelas em aberto (não pagas)
  const { data: parc, error: e1 } = await sb
    .from("parcelas")
    .select("id,venda_id,numero,vencimento,valor,valor_pago_acumulado,status")
    .order("vencimento", { ascending: true })
    .limit(500);

  if (e1) throw e1;

  const parcelas = (parc || []).map((p) => {
    const valor = Number(p.valor || 0);
    const pago = Number(p.valor_pago_acumulado || 0);
    const saldo = Number((valor - pago).toFixed(2));
    const status = String(p.status || "").toLowerCase();
    const quitada = saldo <= 0.009 || status.includes("pag");
    return {
      ...p,
      venda_id: normId(p.venda_id),
      saldo: clamp0(saldo),
      quitada,
    };
  });

  const abertas = parcelas.filter((p) => !p.quitada);
  const abertoTotal = abertas.reduce((acc, p) => acc + Number(p.saldo || 0), 0);

  // próxima parcela = a menor vencimento (já está ordenado), dentre as abertas
  const prox = abertas.length ? abertas[0] : null;

  let vendaInfo = null;
  if (prox?.venda_id) {
    // tenta buscar cliente da venda
    const { data: vData, error: vErr } = await sb
      .from("vendas")
      .select("id,cliente_nome,cliente_telefone,forma,total")
      .eq("id", prox.venda_id)
      .maybeSingle();

    if (!vErr) vendaInfo = vData || null;
  }

  return {
    abertoTotal: Number(abertoTotal.toFixed(2)),
    proxParcela: prox
      ? {
          parcela_numero: Number(prox.numero || 0),
          vencimento: prox.vencimento,
          saldo: Number((prox.saldo || 0).toFixed(2)),
          venda_id: prox.venda_id,
          cliente_nome: vendaInfo?.cliente_nome || "",
          cliente_telefone: vendaInfo?.cliente_telefone || "",
        }
      : null,
  };
}

/**
 * Estoque baixo:
 * tenta primeiro tabela "estoque" com colunas do seu print:
 * categoria, produto, codigo, cor, tamanho, qtd, minimo
 * fallback: tabela "produtos" com estoque/estoque_minimo
 */
async function loadEstoqueBaixo() {
  const tries = [
    {
      table: "estoque",
      cols: ["id", "categoria", "produto", "codigo", "cor", "tamanho", "qtd", "minimo"],
      map: (r) => ({
        id: normId(r.id),
        categoria: r.categoria,
        produto: r.produto,
        codigo: r.codigo,
        cor: r.cor,
        tamanho: r.tamanho,
        qtd: Number(r.qtd || 0),
        minimo: Number(r.minimo || 0),
      }),
      isLow: (x) => Number(x.qtd || 0) < Number(x.minimo || 0),
    },
    {
      table: "produtos",
      cols: ["id", "categoria", "nome", "codigo", "cor", "tamanho", "estoque", "estoque_minimo"],
      map: (r) => ({
        id: normId(r.id),
        categoria: r.categoria,
        produto: r.nome,
        codigo: r.codigo,
        cor: r.cor,
        tamanho: r.tamanho,
        qtd: Number(r.estoque || 0),
        minimo: Number(r.estoque_minimo || 0),
      }),
      isLow: (x) => Number(x.qtd || 0) < Number(x.minimo || 0),
    },
  ];

  for (const t of tries) {
    const { data, error } = await sb.from(t.table).select(t.cols.join(",")).limit(500);
    if (error) continue;

    const rows = (data || []).map(t.map).filter((x) => Number.isFinite(x.qtd) && Number.isFinite(x.minimo));
    const low = rows.filter(t.isLow).sort((a, b) => (a.qtd - a.minimo) - (b.qtd - b.minimo));
    return { table: t.table, items: low.slice(0, 8) };
  }

  // nada encontrado
  return { table: null, items: [] };
}

/* =========================
   UI RENDER
========================= */
function renderDashboardLayout() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
  const startVal = toISODateYYYYMMDD(start);
  const endVal = toISODateYYYYMMDD(today);

  return `
    <style>
      .dash-kpi { font-size: 1.2rem; font-weight: 900; margin-top: 6px; }
      .dash-sub { opacity: .9; margin-top: 4px; }
      .dash-list { margin-top: 10px; display: grid; gap: 8px; }
      .dash-item {
        display:flex; justify-content:space-between; gap:12px; align-items:flex-start;
        padding: 10px; border-radius: 12px;
        background: rgba(255,255,255,.03);
        border: 1px solid rgba(255,255,255,.06);
      }
      .dash-item b { font-weight: 800; }
      .muted { opacity:.85; }
      .dash-btnrow { margin-top: 10px; display:flex; gap:10px; flex-wrap: wrap; }
      .mini { font-size: .85rem; opacity: .9; }
    </style>

    <div class="grid cols-3">
      <div class="card" id="cardVendasHoje">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div class="dash-kpi" id="vhTotal">—</div>
        <div class="dash-sub mini" id="vhQtd">—</div>
      </div>

      <div class="card" id="cardCrediario">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>
        <div class="dash-kpi" id="crAberto">—</div>

        <div class="dash-list" id="crProxBox">
          <div class="mini muted">Carregando próxima parcela...</div>
        </div>

        <div class="dash-btnrow">
          <button class="btn primary" id="btnAbrirCred">Abrir no Crediário</button>
        </div>
      </div>

      <div class="card" id="cardEstoqueBaixo">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>

        <div class="dash-list" id="ebList">
          <div class="mini muted">Carregando estoque baixo...</div>
        </div>

        <div class="dash-btnrow">
          <button class="btn" id="btnAbrirEstoque">Abrir Estoque</button>
        </div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px;">
      <div class="card" id="cardRelatorio">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Total e quantidade</div>

        <div class="grid grid-3" style="gap:10px; margin-top:12px; align-items:end;">
          <div class="field">
            <label>Início</label>
            <input class="input" type="date" id="rpIni" value="${startVal}" />
          </div>
          <div class="field">
            <label>Fim</label>
            <input class="input" type="date" id="rpFim" value="${endVal}" />
          </div>
          <div>
            <button class="btn primary" id="rpAplicar">Aplicar</button>
          </div>
        </div>

        <div style="margin-top:12px;">
          <div class="dash-kpi" id="rpTotal">—</div>
          <div class="dash-sub mini" id="rpQtd">Selecione um período.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Resumo rápido</div>
        <div class="card-sub">Visão geral</div>
        <div class="dash-list">
          <div class="dash-item"><span>Vendas hoje</span><b id="sumVendas">—</b></div>
          <div class="dash-item"><span>Aberto no crediário</span><b id="sumCred">—</b></div>
          <div class="dash-item"><span>Itens com estoque baixo</span><b id="sumEstoque">—</b></div>
        </div>
      </div>
    </div>
  `;
}

function renderEstoqueBaixoList(items) {
  const box = document.getElementById("ebList");
  const sum = document.getElementById("sumEstoque");
  if (!box) return;

  if (!items?.length) {
    box.innerHTML = `<div class="mini muted">Nenhum item abaixo do mínimo ✅</div>`;
    if (sum) sum.textContent = "0";
    return;
  }

  if (sum) sum.textContent = String(items.length);

  box.innerHTML = items
    .map((x) => {
      const nome = [x.produto, x.cor, x.tamanho].filter(Boolean).join(" • ");
      const cod = x.codigo ? `(${x.codigo})` : "";
      return `
        <div class="dash-item">
          <div>
            <b>${escapeHtml(nome || "Produto")}</b> <span class="mini muted">${escapeHtml(cod)}</span>
            <div class="mini muted">${escapeHtml(x.categoria || "")}</div>
          </div>
          <div style="text-align:right;">
            <div><b>${Number(x.qtd || 0)}</b> / mín. ${Number(x.minimo || 0)}</div>
            <div class="mini muted">Baixo</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCrediarioBox(data) {
  const abertoEl = document.getElementById("crAberto");
  const proxBox = document.getElementById("crProxBox");
  const sumCred = document.getElementById("sumCred");

  const aberto = Number(data?.abertoTotal || 0);
  if (abertoEl) abertoEl.textContent = `Aberto: ${money(aberto)}`;
  if (sumCred) sumCred.textContent = money(aberto);

  if (!proxBox) return;

  const p = data?.proxParcela;
  if (!p) {
    proxBox.innerHTML = `<div class="mini muted">Sem parcelas em aberto ✅</div>`;
    return;
  }

  proxBox.innerHTML = `
    <div class="dash-item">
      <div>
        <b>Próxima parcela</b>
        <div class="mini muted">${escapeHtml(p.cliente_nome || "-")} • ${escapeHtml(p.cliente_telefone || "")}</div>
        <div class="mini">Venc: <b>${fmtDateBR(p.vencimento)}</b> • Nº <b>${Number(p.parcela_numero || 0)}</b></div>
      </div>
      <div style="text-align:right;">
        <div><b>${money(p.saldo || 0)}</b></div>
        <div class="mini muted">saldo</div>
      </div>
    </div>
  `;
}

/* =========================
   MAIN
========================= */
async function bootDashboard() {
  // botões
  const btnCred = document.getElementById("btnAbrirCred");
  if (btnCred) btnCred.addEventListener("click", () => (location.hash = "#crediario"));

  const btnEst = document.getElementById("btnAbrirEstoque");
  if (btnEst) btnEst.addEventListener("click", () => (location.hash = "#estoque"));

  // vendas hoje
  try {
    const { qtd, total } = await loadVendasHoje();
    const vhTotal = document.getElementById("vhTotal");
    const vhQtd = document.getElementById("vhQtd");
    const sumVendas = document.getElementById("sumVendas");

    if (vhTotal) vhTotal.textContent = money(total);
    if (vhQtd) vhQtd.textContent = `${qtd} venda(s) hoje`;
    if (sumVendas) sumVendas.textContent = money(total);
  } catch (e) {
    console.error(e);
    const vhTotal = document.getElementById("vhTotal");
    const vhQtd = document.getElementById("vhQtd");
    if (vhTotal) vhTotal.textContent = "—";
    if (vhQtd) vhQtd.textContent = "Erro ao carregar vendas hoje.";
  }

  // crediário
  try {
    const c = await loadCrediarioDashboard();
    renderCrediarioBox(c);
  } catch (e) {
    console.error(e);
    const abertoEl = document.getElementById("crAberto");
    const proxBox = document.getElementById("crProxBox");
    if (abertoEl) abertoEl.textContent = "Erro no crediário.";
    if (proxBox) proxBox.innerHTML = `<div class="mini muted">${escapeHtml(e?.message || "Erro ao carregar crediário.")}</div>`;
  }

  // estoque baixo
  try {
    const { items } = await loadEstoqueBaixo();
    renderEstoqueBaixoList(items);
  } catch (e) {
    console.error(e);
    const box = document.getElementById("ebList");
    if (box) box.innerHTML = `<div class="mini muted">${escapeHtml(e?.message || "Erro ao carregar estoque baixo.")}</div>`;
  }

  // relatório por período
  const rpAplicar = document.getElementById("rpAplicar");
  if (rpAplicar) {
    rpAplicar.addEventListener("click", async () => {
      const ini = document.getElementById("rpIni")?.value;
      const fim = document.getElementById("rpFim")?.value;
      const rpTotal = document.getElementById("rpTotal");
      const rpQtd = document.getElementById("rpQtd");

      if (!ini || !fim) {
        if (rpQtd) rpQtd.textContent = "Preencha início e fim.";
        return;
      }

      const { startISO, endISO } = parseDateInputToISOStartEnd(ini, fim);

      if (rpQtd) rpQtd.textContent = "Carregando...";
      try {
        const r = await loadVendasPeriodo(startISO, endISO);
        if (rpTotal) rpTotal.textContent = money(r.total);
        if (rpQtd) rpQtd.textContent = `${r.qtd} venda(s) no período`;
      } catch (e) {
        console.error(e);
        if (rpTotal) rpTotal.textContent = "—";
        if (rpQtd) rpQtd.textContent = e?.message || "Erro ao gerar relatório.";
      }
    });
  }
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = renderDashboardLayout();

  setTimeout(() => {
    bootDashboard().catch((e) => console.error(e));
  }, 0);

  return html;
}
