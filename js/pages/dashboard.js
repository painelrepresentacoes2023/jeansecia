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

/** YYYY-MM-DD local (sem bug UTC) */
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** formata DATE (YYYY-MM-DD) sem voltar 1 dia */
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

/* =========================
   CREDIÁRIO: FORMAS (enum)
========================= */
async function loadEnumValues(enumType) {
  const { data, error } = await sb.rpc("enum_values", { enum_type: enumType });
  if (error) throw error;
  return (data || []).map((x) => x.value);
}

async function loadCrediFormas() {
  let vals = [];
  try {
    vals = await loadEnumValues("forma_pagamento");
  } catch {
    vals = [];
  }
  const filtered = (vals || []).filter((v) => String(v).toLowerCase().includes("credi"));
  if (!filtered.length) return ["crediario", "crediário", "credi"];
  return filtered;
}

/* =========================
   QUERIES
========================= */
async function fetchVendasHoje() {
  const t = todayISO();

  // pega vendas do dia (comparando só a data yyyy-mm-dd)
  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data")
    .gte("data", `${t}T00:00:00`)
    .lte("data", `${t}T23:59:59`)
    .limit(500);

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { count: rows.length, total: Number(total.toFixed(2)) };
}

async function fetchRelatorioPeriodo(inicioISO, fimISO) {
  // intervalo inclusive (fim até 23:59:59)
  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data")
    .gte("data", `${inicioISO}T00:00:00`)
    .lte("data", `${fimISO}T23:59:59`)
    .limit(2000);

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { count: rows.length, total: Number(total.toFixed(2)) };
}

/**
 * ✅ Crediário no dashboard:
 * - abertoTotal = soma dos saldos das parcelas NÃO pagas (valor - valor_pago_acumulado)
 * - proximaParcela = menor vencimento entre as NÃO pagas, junto com cliente/telefone
 *
 * Observação: isso depende do relacionamento parcelas(venda_id) -> vendas(id)
 */
async function fetchCrediarioDashboard() {
  const crediFormas = await loadCrediFormas();

  // puxa parcelas ainda abertas e já traz dados da venda (cliente/telefone/forma)
  const { data, error } = await sb
    .from("parcelas")
    .select(
      "id,venda_id,numero,vencimento,valor,valor_pago_acumulado,status,vendas(cliente_nome,cliente_telefone,forma)"
    )
    .order("vencimento", { ascending: true })
    .limit(2000);

  if (error) throw error;

  const rows = (data || []).filter((p) => {
    const st = String(p.status || "").toLowerCase();
    const venda = p.vendas || {};
    const forma = String(venda.forma || "").toLowerCase();

    const ehCred = crediFormas.map((x) => String(x).toLowerCase()).includes(forma);
    const naoPaga = !st.includes("pag"); // paga/pago
    return ehCred && naoPaga;
  });

  let abertoTotal = 0;
  for (const p of rows) {
    const valor = Number(p.valor || 0);
    const pago = Number(p.valor_pago_acumulado || 0);
    abertoTotal += clamp0(valor - pago);
  }
  abertoTotal = Number(abertoTotal.toFixed(2));

  const proximaParcela = rows.length ? rows[0] : null;

  return { abertoTotal, proximaParcela };
}

/**
 * ✅ Estoque Baixo:
 * Puxa da SUA tabela "estoque" e colunas que aparecem na página Estoque:
 * categoria, produto, codigo, cor, tamanho, qtd, minimo
 */
async function fetchEstoqueBaixo() {
  const { data, error } = await sb
    .from("estoque")
    .select("categoria,produto,codigo,cor,tamanho,qtd,minimo")
    .order("produto", { ascending: true })
    .limit(3000);

  if (error) throw error;

  const rows = (data || []).map((r) => ({
    categoria: r.categoria ?? "",
    produto: r.produto ?? "",
    codigo: r.codigo ?? "",
    cor: r.cor ?? "",
    tamanho: r.tamanho ?? "",
    qtd: Number(r.qtd || 0),
    minimo: Number(r.minimo || 0),
  }));

  // somente abaixo do mínimo
  const low = rows
    .filter((r) => Number.isFinite(r.minimo) && r.minimo > 0 && r.qtd < r.minimo)
    .map((r) => ({
      ...r,
      falta: clamp0(r.minimo - r.qtd),
    }));

  return low;
}

/* =========================
   UI (HTML)
========================= */
function layout() {
  // datas padrão (últimos 7 dias)
  const fim = todayISO();
  const d = new Date();
  d.setDate(d.getDate() - 7);
  const inicio = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

  return `
    <style>
      .dashTableWrap{ overflow:auto; max-width:100%; -webkit-overflow-scrolling:touch; }
      .dashTable{ width:100%; min-width:860px; border-collapse:collapse; }
      .muted{ opacity:.85; }
      .big{ font-size:1.35rem; font-weight:900; margin-top:6px; }
      .rowBetween{ display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .pill{
        display:inline-flex; align-items:center; gap:8px;
        padding:6px 10px; border-radius:999px;
        border:1px solid rgba(255,255,255,.10);
        background: rgba(255,255,255,.03);
        font-size:.85rem;
      }
      .ok{ color:#7CFFB2; }
      .bad{ color:#FF8A8A; }
    </style>

    <div class="grid cols-2">
      <div class="card" id="cardVendasHoje">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div class="small muted" id="vhMsg">Carregando...</div>
      </div>

      <div class="card" id="cardCrediarioDash">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>
        <div class="small muted" id="crMsg">Carregando...</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;" id="cardEstoqueBaixo">
      <div class="rowBetween">
        <div>
          <div class="card-title">Estoque Baixo</div>
          <div class="card-sub">Itens abaixo do mínimo</div>
        </div>
        <button class="btn" id="btnAbrirEstoque">Abrir Estoque</button>
      </div>

      <div class="small muted" id="ebMsg" style="margin-top:10px;">Carregando...</div>

      <div class="dashTableWrap" style="margin-top:10px;">
        <table class="dashTable">
          <thead>
            <tr>
              <th style="min-width:220px;">Produto</th>
              <th style="min-width:110px;">Código</th>
              <th style="min-width:110px;">Cor</th>
              <th style="min-width:90px;">Tam.</th>
              <th style="min-width:90px;">Qtd</th>
              <th style="min-width:110px;">Mínimo</th>
              <th style="min-width:110px;">Falta</th>
            </tr>
          </thead>
          <tbody id="ebTbody">
            <tr><td colspan="7" class="small">Carregando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px;">
      <div class="card" id="cardRelatorio">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Filtro de datas</div>

        <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px; align-items:end;">
          <div class="field">
            <label>Início</label>
            <input class="input" type="date" id="rpInicio" value="${inicio}" />
          </div>
          <div class="field">
            <label>Fim</label>
            <input class="input" type="date" id="rpFim" value="${fim}" />
          </div>
          <button class="btn primary" id="rpAplicar">Aplicar</button>
        </div>

        <div class="small muted" id="rpMsg" style="margin-top:10px;">Selecione um período.</div>
      </div>

      <div class="card" id="cardResumo">
        <div class="card-title">Resumo rápido</div>
        <div class="card-sub">Visão geral</div>
        <div class="small muted" id="rsMsg" style="margin-top:10px;">Carregando...</div>
      </div>
    </div>
  `;
}

/* =========================
   RENDERERS
========================= */
function renderVendasHoje({ count, total }) {
  const el = document.getElementById("vhMsg");
  if (!el) return;
  el.innerHTML = `
    <div class="big">${money(total)}</div>
    <div class="small muted">${count} venda(s) hoje</div>
  `;
}

function renderCrediario({ abertoTotal, proximaParcela }) {
  const el = document.getElementById("crMsg");
  if (!el) return;

  const btn = `<button class="btn primary" id="btnAbrirCrediario" style="margin-top:10px;">Abrir no Crediário</button>`;

  if (!proximaParcela) {
    el.innerHTML = `
      <div class="big">Aberto: ${money(abertoTotal)}</div>
      <div class="small muted">Nenhuma parcela em aberto agora ✅</div>
      ${btn}
    `;
    return;
  }

  const venda = proximaParcela.vendas || {};
  const cliente = venda.cliente_nome || "—";
  const tel = venda.cliente_telefone || "";
  const venc = fmtDateBR(proximaParcela.vencimento);
  const numero = Number(proximaParcela.numero || 0);

  const valor = Number(proximaParcela.valor || 0);
  const pago = Number(proximaParcela.valor_pago_acumulado || 0);
  const saldo = clamp0(valor - pago);

  el.innerHTML = `
    <div class="big">Aberto: ${money(abertoTotal)}</div>

    <div class="card" style="margin-top:12px;">
      <div style="font-weight:800;">Próxima parcela</div>
      <div class="small">${escapeHtml(cliente)}${tel ? ` • ${escapeHtml(tel)}` : ""}</div>
      <div class="small">Venc: <b>${venc}</b> • Nº <b>${numero}</b></div>
      <div class="small" style="margin-top:6px;">
        Saldo: <b>${money(saldo)}</b>
      </div>
    </div>

    ${btn}
  `;
}

function renderEstoqueBaixo(rows) {
  const msg = document.getElementById("ebMsg");
  const tbody = document.getElementById("ebTbody");
  if (!msg || !tbody) return;

  if (!rows.length) {
    msg.innerHTML = `<span class="pill ok">Nenhum item abaixo do mínimo ✅</span>`;
    tbody.innerHTML = `<tr><td colspan="7" class="small">Tudo certo no estoque.</td></tr>`;
    return;
  }

  msg.innerHTML = `<span class="pill bad">${rows.length} item(ns) abaixo do mínimo ⚠️</span>`;

  tbody.innerHTML = rows
    .slice(0, 12)
    .map((r) => {
      return `
        <tr>
          <td>${escapeHtml(r.produto || "—")}</td>
          <td>${escapeHtml(r.codigo || "—")}</td>
          <td>${escapeHtml(r.cor || "—")}</td>
          <td>${escapeHtml(r.tamanho || "—")}</td>
          <td>${Number(r.qtd || 0)}</td>
          <td>${Number(r.minimo || 0)}</td>
          <td><b>${Number(r.falta || 0)}</b></td>
        </tr>
      `;
    })
    .join("");
}

function renderResumo({ vendasHoje, crediario, estoqueLowCount }) {
  const el = document.getElementById("rsMsg");
  if (!el) return;

  const prox = crediario.proximaParcela
    ? fmtDateBR(crediario.proximaParcela.vencimento)
    : "—";

  el.innerHTML = `
    <div class="small">• Vendas hoje: <b>${money(vendasHoje.total)}</b> (${vendasHoje.count} venda(s))</div>
    <div class="small">• Crediário aberto: <b>${money(crediario.abertoTotal)}</b></div>
    <div class="small">• Próximo venc.: <b>${prox}</b></div>
    <div class="small">• Estoque baixo: <b>${estoqueLowCount}</b> item(ns)</div>
  `;
}

/* =========================
   BINDINGS
========================= */
function bindDashButtons() {
  const btnEst = document.getElementById("btnAbrirEstoque");
  btnEst?.addEventListener("click", () => {
    location.hash = "#estoque";
  });

  // botão do crediário é criado dentro do renderCrediario (depois)
  document.addEventListener("click", (ev) => {
    const t = ev.target;
    if (t && t.id === "btnAbrirCrediario") location.hash = "#crediario";
  });

  const rpBtn = document.getElementById("rpAplicar");
  rpBtn?.addEventListener("click", async () => {
    const ini = document.getElementById("rpInicio")?.value;
    const fim = document.getElementById("rpFim")?.value;
    const rpMsg = document.getElementById("rpMsg");
    if (!ini || !fim) {
      if (rpMsg) rpMsg.textContent = "Preencha início e fim.";
      return;
    }

    if (rpMsg) rpMsg.textContent = "Carregando...";
    try {
      const r = await fetchRelatorioPeriodo(ini, fim);
      if (rpMsg) {
        rpMsg.innerHTML = `Total: <b>${money(r.total)}</b> • <b>${r.count}</b> venda(s) no período.`;
      }
    } catch (e) {
      console.error(e);
      if (rpMsg) rpMsg.textContent = e?.message || "Erro ao gerar relatório.";
    }
  });
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = layout();

  setTimeout(async () => {
    try {
      bindDashButtons();

      // 1) vendas hoje
      const vendasHoje = await fetchVendasHoje();
      renderVendasHoje(vendasHoje);

      // 2) crediário
      const crediario = await fetchCrediarioDashboard();
      renderCrediario(crediario);

      // 3) estoque baixo
      const low = await fetchEstoqueBaixo();
      renderEstoqueBaixo(low);

      // 4) resumo
      renderResumo({
        vendasHoje,
        crediario,
        estoqueLowCount: low.length,
      });
    } catch (e) {
      console.error(e);
      // fallback mínimo sem quebrar a página
      const rs = document.getElementById("rsMsg");
      if (rs) rs.textContent = e?.message || "Erro ao carregar dashboard.";
    }
  }, 0);

  return html;
}
