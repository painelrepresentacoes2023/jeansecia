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

/** Corrige DATE (YYYY-MM-DD) sem voltar 1 dia */
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

function startOfDayISO(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return x.toISOString();
}
function endOfDayISO(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return x.toISOString();
}
function addDaysDateOnly(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function safeQuery(fn) {
  try {
    const res = await fn();
    if (res?.error) throw res.error;
    return res?.data ?? [];
  } catch (e) {
    console.warn(e);
    return null;
  }
}

/* tenta vários selects, para não quebrar */
async function safeSelect(table, selectTries, buildQuery) {
  for (const sel of selectTries) {
    const data = await safeQuery(() => buildQuery(sb.from(table).select(sel)));
    if (data !== null) return { ok: true, data, used: sel };
  }
  return { ok: false, data: [], used: null };
}

/* =========================
   UI (layout)
========================= */
function layout() {
  return `
    <div class="grid cols-3">
      <div class="card">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo por data</div>
        <div class="small" id="vHojeMsg" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Vencidas e a vencer</div>
        <div class="small" id="credMsg" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
        <div class="small" id="estMsg" style="margin-top:10px;">Carregando...</div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px;">
      <div class="card">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Filtro de datas</div>

        <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px; align-items:end;">
          <div class="field">
            <label>Início</label>
            <input class="input" id="rpIni" type="date" />
          </div>
          <div class="field">
            <label>Fim</label>
            <input class="input" id="rpFim" type="date" />
          </div>
          <button class="btn primary" id="rpBtn">Aplicar</button>
        </div>

        <div class="small" id="rpOut" style="margin-top:12px;">Selecione um período.</div>
      </div>

      <div class="card">
        <div class="card-title">Resumo rápido</div>
        <div class="card-sub">Visão geral</div>
        <div class="small" style="margin-top:12px; opacity:.85;">
          • Vendas hoje<br/>
          • Parcelas do crediário (vencidas / próximas)<br/>
          • Produtos abaixo do mínimo
        </div>
      </div>
    </div>
  `;
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

/* =========================
   LOADERS (dados)
========================= */
async function loadVendasHoje() {
  const start = startOfDayISO(new Date());
  const end = endOfDayISO(new Date());

  // tenta por "data"
  let r = await safeSelect(
    "vendas",
    ["id,data,total", "id,data,total,forma", "id,created_at,total"],
    (q) => q.gte("data", start).lte("data", end).limit(2000)
  );

  // fallback: created_at
  if (!r.ok || !(r.used || "").includes("data")) {
    r = await safeSelect(
      "vendas",
      ["id,created_at,total", "id,created_at,total,forma"],
      (q) => q.gte("created_at", start).lte("created_at", end).limit(2000)
    );
  }

  return r.ok ? r.data : null;
}

/* pega enum de formas (igual você fez no crediário.js) */
async function loadCrediFormas() {
  const vals = await safeQuery(() => sb.rpc("enum_values", { enum_type: "forma_pagamento" }));
  if (vals === null) return ["crediario", "crediário", "credi"];
  const filtered = (vals || [])
    .map((x) => x.value)
    .filter((v) => String(v).toLowerCase().includes("credi"));
  return filtered.length ? filtered : ["crediario", "crediário", "credi"];
}

async function loadCrediarioResumo() {
  const crediFormas = await loadCrediFormas();

  // 1) vendas do crediário
  const vendas = await safeQuery(() =>
    sb.from("vendas").select("id,forma,total").in("forma", crediFormas).limit(2000)
  );
  const vendasOk = Array.isArray(vendas) ? vendas : [];
  const vendaIds = vendasOk.map((v) => String(v.id)).filter(Boolean);
  if (!vendaIds.length) return { vencidas: [], proximas: [], totalAberto: 0, totalVencidas: 0, totalProximas: 0 };

  // 2) parcelas dessas vendas
  const parcelas = await safeQuery(() =>
    sb
      .from("parcelas")
      .select("id,venda_id,vencimento,valor,valor_pago_acumulado,status,numero")
      .in("venda_id", vendaIds)
      .limit(5000)
  );
  const parc = Array.isArray(parcelas) ? parcelas : [];

  const hoje = addDaysDateOnly(0);
  const limite = addDaysDateOnly(7);

  const emAberto = parc
    .map((p) => {
      const valor = Number(p.valor || 0);
      const pago = Number(p.valor_pago_acumulado || 0);
      const saldo = Number((valor - pago).toFixed(2));
      const st = String(p.status || "").toLowerCase();
      const quit = saldo <= 0.009 || st.includes("pag");
      return { ...p, saldo, quit };
    })
    .filter((p) => !p.quit);

  const vencidas = emAberto.filter((p) => String(p.vencimento).slice(0, 10) < hoje);
  const proximas = emAberto.filter((p) => {
    const vd = String(p.vencimento).slice(0, 10);
    return vd >= hoje && vd <= limite;
  });

  const totalAberto = emAberto.reduce((s, p) => s + Number(p.saldo || 0), 0);
  const totalVencidas = vencidas.reduce((s, p) => s + Number(p.saldo || 0), 0);
  const totalProximas = proximas.reduce((s, p) => s + Number(p.saldo || 0), 0);

  return { vencidas, proximas, totalAberto, totalVencidas, totalProximas };
}

/* Estoque baixo: tenta várias combinações de nomes */
async function loadEstoqueBaixo() {
  // tenta tabela produtos
  const tries = [
    "id,nome,estoque,estoque_minimo",
    "id,nome,quantidade,estoque_minimo",
    "id,nome,quantidade_atual,estoque_minimo",
    "id,nome,qtd,estoque_minimo",
    "id,nome,estoque,minimo",
    "id,nome,quantidade,minimo",
    "id,nome,qtd,minimo",
    "id,descricao,estoque,estoque_minimo",
    "id,descricao,quantidade,minimo",
  ];

  const r = await safeSelect("produtos", tries, (q) => q.limit(5000));
  if (!r.ok) return null;

  const rows = r.data || [];
  if (!rows.length) return [];

  // descobre chaves existentes no sample
  const s = rows[0] || {};

  const nomeKey = s.nome != null ? "nome" : (s.descricao != null ? "descricao" : "nome");

  const estoqueKey =
    s.estoque != null ? "estoque" :
    (s.quantidade_atual != null ? "quantidade_atual" :
    (s.quantidade != null ? "quantidade" :
    (s.qtd != null ? "qtd" : "estoque")));

  const minimoKey =
    s.estoque_minimo != null ? "estoque_minimo" :
    (s.minimo != null ? "minimo" :
    (s.min_estoque != null ? "min_estoque" : "estoque_minimo"));

  const out = rows
    .map((p) => {
      const est = Number(p[estoqueKey] ?? 0);
      const min = Number(p[minimoKey] ?? 0);
      return { id: p.id, nome: p[nomeKey], est, min };
    })
    .filter((x) => Number.isFinite(x.min) && x.min > 0 && Number.isFinite(x.est) && x.est <= x.min)
    .sort((a, b) => (a.est - b.est))
    .slice(0, 12);

  return out;
}

async function loadRelatorioPeriodo(inicioYYYYMMDD, fimYYYYMMDD) {
  const ini = `${inicioYYYYMMDD}T00:00:00.000Z`;
  const fim = `${fimYYYYMMDD}T23:59:59.999Z`;

  // tenta por "data"
  let rows = await safeQuery(() =>
    sb.from("vendas").select("id,total,data").gte("data", ini).lte("data", fim).limit(10000)
  );

  // fallback created_at
  if (rows === null) {
    rows = await safeQuery(() =>
      sb.from("vendas").select("id,total,created_at").gte("created_at", ini).lte("created_at", fim).limit(10000)
    );
  }

  const list = Array.isArray(rows) ? rows : [];
  const qtd = list.length;
  const total = list.reduce((s, r) => s + Number(r.total || 0), 0);
  const ticket = qtd ? total / qtd : 0;

  return { qtd, total, ticket };
}

/* =========================
   FILL UI
========================= */
async function fillDashboard() {
  // Vendas Hoje
  const vendasHoje = await loadVendasHoje();
  if (vendasHoje === null) {
    setHtml("vHojeMsg", "Não consegui carregar vendas hoje.");
  } else {
    const qtd = vendasHoje.length;
    const total = vendasHoje.reduce((s, v) => s + Number(v.total || 0), 0);
    setHtml(
      "vHojeMsg",
      `<div style="font-weight:900; font-size:1.2rem;">${money(total)}</div>
       <div class="small" style="opacity:.9;">${qtd} venda(s) hoje</div>`
    );
  }

  // Crediário
  const cred = await loadCrediarioResumo();
  if (!cred) {
    setHtml("credMsg", "Não consegui carregar crediário.");
  } else {
    setHtml(
      "credMsg",
      `<div class="small"><b>Vencidas:</b> ${cred.vencidas.length} • <b>${money(cred.totalVencidas)}</b></div>
       <div class="small"><b>Próx. 7 dias:</b> ${cred.proximas.length} • <b>${money(cred.totalProximas)}</b></div>
       <div style="margin-top:8px; font-weight:900; font-size:1.05rem;">Aberto: ${money(cred.totalAberto)}</div>`
    );
  }

  // Estoque baixo
  const baixo = await loadEstoqueBaixo();
  if (baixo === null) {
    setHtml(
      "estMsg",
      `Não encontrei a tabela <b>produtos</b> ou as colunas de estoque/min.<br/>
       (Me diga o nome da tabela/colunas que eu ajusto em 1 minuto.)`
    );
  } else if (!baixo.length) {
    setHtml("estMsg", "Nenhum item abaixo do mínimo ✅");
  } else {
    setHtml(
      "estMsg",
      `<div class="small" style="margin-bottom:8px;"><b>${baixo.length}</b> item(ns) críticos</div>
       <div class="small" style="display:grid; gap:6px;">
         ${baixo
           .map(
             (p) =>
               `<div style="display:flex; justify-content:space-between; gap:10px;">
                  <span>${escapeHtml(p.nome || "-")}</span>
                  <span><b>${p.est}</b> / min ${p.min}</span>
                </div>`
           )
           .join("")}
       </div>`
    );
  }
}

function bindPeriodo() {
  const ini = document.getElementById("rpIni");
  const fim = document.getElementById("rpFim");
  const out = document.getElementById("rpOut");
  const btn = document.getElementById("rpBtn");

  if (ini && fim) {
    ini.value = addDaysDateOnly(-7);
    fim.value = addDaysDateOnly(0);
  }

  btn?.addEventListener("click", async () => {
    const i = ini?.value;
    const f = fim?.value;

    if (!i || !f) return (out.textContent = "Selecione início e fim.");
    if (i > f) return (out.textContent = "Início não pode ser maior que fim.");

    out.textContent = "Carregando relatório...";
    const r = await loadRelatorioPeriodo(i, f);
    if (!r) return (out.textContent = "Erro ao carregar relatório.");

    out.innerHTML = `
      <div class="small"><b>Período:</b> ${fmtDateBR(i)} → ${fmtDateBR(f)}</div>
      <div style="margin-top:8px; font-weight:900; font-size:1.15rem;">${money(r.total)}</div>
      <div class="small" style="opacity:.9;">${r.qtd} venda(s) • Ticket médio ${money(r.ticket)}</div>
    `;
  });
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = layout();

  setTimeout(async () => {
    try {
      bindPeriodo();
      await fillDashboard();
    } catch (e) {
      console.error(e);
      setHtml("vHojeMsg", "Erro ao carregar.");
      setHtml("credMsg", "Erro ao carregar.");
      setHtml("estMsg", "Erro ao carregar.");
    }
  }, 0);

  return html;
}
