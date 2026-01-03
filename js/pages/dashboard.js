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

function todayDateOnly() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function startOfDayISO(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  return x.toISOString();
}
function endOfDayISO(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return x.toISOString();
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

/* tenta vários selects para descobrir colunas/tabelas sem quebrar */
async function trySelect(table, selectTries, build) {
  for (const sel of selectTries) {
    const data = await safeQuery(() => build(sb.from(table).select(sel)));
    if (data !== null) return { ok: true, table, used: sel, data };
  }
  return { ok: false, table, used: null, data: [] };
}

/* =========================
   UI
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
        <div class="card-sub">Próxima parcela + resumo</div>
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
          • Próxima parcela do crediário<br/>
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
   LOADERS
========================= */
async function loadVendasHoje() {
  const start = startOfDayISO(new Date());
  const end = endOfDayISO(new Date());

  // tenta por "data", fallback "created_at"
  let r = await trySelect(
    "vendas",
    ["id,data,total", "id,data,total,forma", "id,created_at,total"],
    (q) => q.gte("data", start).lte("data", end).limit(2000)
  );

  if (!r.ok) {
    r = await trySelect(
      "vendas",
      ["id,created_at,total", "id,created_at,total,forma"],
      (q) => q.gte("created_at", start).lte("created_at", end).limit(2000)
    );
  }

  return r.ok ? r.data : null;
}

/* enum formas crediário */
async function loadCrediFormas() {
  const vals = await safeQuery(() => sb.rpc("enum_values", { enum_type: "forma_pagamento" }));
  if (vals === null) return ["crediario", "crediário", "credi"];
  const filtered = (vals || [])
    .map((x) => x.value)
    .filter((v) => String(v).toLowerCase().includes("credi"));
  return filtered.length ? filtered : ["crediario", "crediário", "credi"];
}

/* resumo crediário + parcela mais próxima */
async function loadCrediarioResumoComProxima() {
  const crediFormas = await loadCrediFormas();

  const vendas = await safeQuery(() =>
    sb.from("vendas").select("id,forma,total,cliente_nome,cliente_telefone").in("forma", crediFormas).limit(3000)
  );

  const vendaIds = (Array.isArray(vendas) ? vendas : []).map((v) => String(v.id)).filter(Boolean);
  if (!vendaIds.length) {
    return {
      vencidasCount: 0,
      proximas7Count: 0,
      totalAberto: 0,
      proximaParcela: null,
    };
  }

  const parcelas = await safeQuery(() =>
    sb
      .from("parcelas")
      .select("id,venda_id,numero,vencimento,valor,valor_pago_acumulado,status")
      .in("venda_id", vendaIds)
      .limit(10000)
  );

  const hoje = todayDateOnly();
  const limite7 = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  })();

  const list = (Array.isArray(parcelas) ? parcelas : [])
    .map((p) => {
      const valor = Number(p.valor || 0);
      const pago = Number(p.valor_pago_acumulado || 0);
      const saldo = Number((valor - pago).toFixed(2));
      const st = String(p.status || "").toLowerCase();
      const quit = saldo <= 0.009 || st.includes("pag");
      const venc = String(p.vencimento).slice(0, 10);
      return { ...p, saldo, quit, venc };
    })
    .filter((p) => !p.quit);

  const vencidas = list.filter((p) => p.venc < hoje);
  const proximas7 = list.filter((p) => p.venc >= hoje && p.venc <= limite7);

  const totalAberto = list.reduce((s, p) => s + Number(p.saldo || 0), 0);

  // pega a próxima a vencer (>= hoje). se não tiver, pega a mais atrasada (menor vencimento)
  const proximasOrdenadas = [...list].sort((a, b) => (a.venc > b.venc ? 1 : a.venc < b.venc ? -1 : 0));
  const prox = proximasOrdenadas.find((p) => p.venc >= hoje) || proximasOrdenadas[0] || null;

  let proximaParcela = null;
  if (prox) {
    const venda = (vendas || []).find((v) => String(v.id) === String(prox.venda_id)) || null;
    proximaParcela = { ...prox, venda };
  }

  return {
    vencidasCount: vencidas.length,
    proximas7Count: proximas7.length,
    totalAberto,
    proximaParcela,
  };
}

/* Estoque baixo: tenta produtos, se falhar tenta estoque */
async function loadEstoqueBaixo() {
  const selectTries = [
    "id,nome,estoque,estoque_minimo",
    "id,nome,quantidade,estoque_minimo",
    "id,nome,quantidade_atual,estoque_minimo",
    "id,nome,qtd,estoque_minimo",
    "id,nome,estoque,minimo",
    "id,nome,quantidade,minimo",
    "id,nome,qtd,minimo",
    "id,descricao,estoque,estoque_minimo",
    "id,descricao,quantidade,minimo",
    "id,produto_nome,estoque,estoque_minimo",
    "id,produto_nome,quantidade,minimo",
  ];

  // 1) tenta produtos
  let r = await trySelect("produtos", selectTries, (q) => q.limit(8000));

  // 2) tenta estoque
  if (!r.ok) {
    r = await trySelect("estoque", selectTries, (q) => q.limit(8000));
  }

  if (!r.ok) return { ok: false, items: [], table: null };

  const rows = r.data || [];
  if (!rows.length) return { ok: true, items: [], table: r.table };

  const sample = rows[0] || {};

  const nomeKey =
    sample.nome != null ? "nome" :
    (sample.produto_nome != null ? "produto_nome" :
    (sample.descricao != null ? "descricao" : "nome"));

  const estoqueKey =
    sample.estoque != null ? "estoque" :
    (sample.quantidade_atual != null ? "quantidade_atual" :
    (sample.quantidade != null ? "quantidade" :
    (sample.qtd != null ? "qtd" : "estoque")));

  const minimoKey =
    sample.estoque_minimo != null ? "estoque_minimo" :
    (sample.minimo != null ? "minimo" :
    (sample.min_estoque != null ? "min_estoque" : "estoque_minimo"));

  const items = rows
    .map((p) => {
      const est = Number(p[estoqueKey] ?? 0);
      const min = Number(p[minimoKey] ?? 0);
      return { id: p.id, nome: p[nomeKey], est, min };
    })
    .filter((x) => Number.isFinite(x.min) && x.min > 0 && Number.isFinite(x.est) && x.est <= x.min)
    .sort((a, b) => a.est - b.est)
    .slice(0, 12);

  return { ok: true, items, table: r.table };
}

async function loadRelatorioPeriodo(inicioYYYYMMDD, fimYYYYMMDD) {
  const ini = `${inicioYYYYMMDD}T00:00:00.000Z`;
  const fim = `${fimYYYYMMDD}T23:59:59.999Z`;

  let rows = await safeQuery(() =>
    sb.from("vendas").select("id,total,data").gte("data", ini).lte("data", fim).limit(20000)
  );

  if (rows === null) {
    rows = await safeQuery(() =>
      sb.from("vendas").select("id,total,created_at").gte("created_at", ini).lte("created_at", fim).limit(20000)
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
  // Vendas hoje
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

  // Crediário: resumo + próxima parcela
  const cred = await loadCrediarioResumoComProxima();
  const pp = cred?.proximaParcela;

  let blocoProxima = `<div class="small" style="opacity:.9;">Sem parcelas em aberto ✅</div>`;
  if (pp) {
    const cliente = pp?.venda?.cliente_nome || "Cliente";
    const tel = pp?.venda?.cliente_telefone || "";
    blocoProxima = `
      <div class="card" style="margin-top:10px; padding:12px;">
        <div style="font-weight:900;">Próxima parcela</div>
        <div class="small" style="margin-top:6px;">
          <b>${escapeHtml(cliente)}</b> ${tel ? `• ${escapeHtml(tel)}` : ""}
        </div>
        <div class="small" style="margin-top:4px;">
          Venc: <b>${fmtDateBR(pp.vencimento)}</b> • Nº <b>${Number(pp.numero || 0)}</b>
        </div>
        <div class="small" style="margin-top:4px;">
          Saldo: <b>${money(pp.saldo)}</b>
        </div>
        <div style="margin-top:10px;">
          <button class="btn primary" id="goCred">Abrir no Crediário</button>
        </div>
      </div>
    `;
  }

  setHtml(
    "credMsg",
    `<div class="small"><b>Vencidas:</b> ${cred.vencidasCount}</div>
     <div class="small"><b>Próx. 7 dias:</b> ${cred.proximas7Count}</div>
     <div style="margin-top:8px; font-weight:900; font-size:1.05rem;">Aberto: ${money(cred.totalAberto)}</div>
     ${blocoProxima}`
  );

  // bind botão abrir crediário
  const btn = document.getElementById("goCred");
  if (btn) {
    btn.addEventListener("click", () => {
      window.location.hash = "#crediario";
    });
  }

  // Estoque baixo
  const est = await loadEstoqueBaixo();
  if (!est.ok) {
    setHtml(
      "estMsg",
      `Não encontrei as tabelas <b>produtos</b> nem <b>estoque</b> com colunas compatíveis.<br/>
       (Se você me disser o nome exato da tabela/colunas eu deixo perfeito.)`
    );
  } else if (!est.items.length) {
    setHtml("estMsg", `Nenhum item abaixo do mínimo ✅`);
  } else {
    setHtml(
      "estMsg",
      `<div class="small" style="margin-bottom:8px;"><b>${est.items.length}</b> item(ns) críticos</div>
       <div class="small" style="opacity:.75; margin-bottom:8px;">Fonte: tabela <b>${escapeHtml(est.table)}</b></div>
       <div class="small" style="display:grid; gap:6px;">
         ${est.items
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
    // padrão: últimos 7 dias
    const d1 = new Date();
    d1.setDate(d1.getDate() - 7);
    const yyyy = d1.getFullYear();
    const mm = String(d1.getMonth() + 1).padStart(2, "0");
    const dd = String(d1.getDate()).padStart(2, "0");
    ini.value = `${yyyy}-${mm}-${dd}`;
    fim.value = todayDateOnly();
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
