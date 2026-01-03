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
  // yyyy-mm-dd
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function byNum(a, b) {
  return Number(a || 0) - Number(b || 0);
}

async function safeQuery(fn) {
  try {
    const res = await fn();
    if (res?.error) throw res.error;
    return res?.data ?? [];
  } catch (e) {
    console.warn(e);
    return null; // sinaliza que falhou
  }
}

/* tenta várias listas de colunas (pra não quebrar se faltar alguma) */
async function safeSelect(table, selectTries, buildQuery) {
  for (const sel of selectTries) {
    const data = await safeQuery(() => buildQuery(sb.from(table).select(sel)));
    if (data !== null) return { data, used: sel, ok: true };
  }
  return { data: [], used: null, ok: false };
}

/* =========================
   RENDER
========================= */
function layout() {
  return `
    <div class="grid cols-4">
      <div class="card" id="cardVendasHoje">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo por data</div>
        <div class="small" id="vHojeMsg" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card" id="cardCrediario">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Vencidas e a vencer</div>
        <div class="small" id="credMsg" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card" id="cardEstoque">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
        <div class="small" id="estMsg" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card" id="cardCompras">
        <div class="card-title">Compras</div>
        <div class="card-sub">Últimas entradas</div>
        <div class="small" id="compMsg" style="margin-top:10px;">Carregando...</div>
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
        <div class="card-title">Atalhos</div>
        <div class="card-sub">Nova venda / Nova compra / Novo produto</div>

        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn primary" id="goVendas">Ir para Vendas</button>
          <button class="btn" id="goCompras">Ir para Compras</button>
          <button class="btn" id="goProdutos">Ir para Produtos</button>
          <button class="btn" id="goCred">Ir para Crediário</button>
        </div>

        <div class="small" style="margin-top:10px; opacity:.85;">
          Dica: use os atalhos pra cadastrar rapidão.
        </div>
      </div>
    </div>
  `;
}

/* =========================
   LOADERS (DADOS)
========================= */
async function loadVendasHoje() {
  // tenta data como timestamp ou date; a query com gte/lte funciona em ambos na maioria dos casos
  const start = startOfDayISO(new Date());
  const end = endOfDayISO(new Date());

  const tries = [
    "id,data,total",
    "id,data,total,forma",
    "id,created_at,total",
  ];

  const { data, ok, used } = await safeSelect(
    "vendas",
    tries,
    (q) => q.gte("data", start).lte("data", end).order("data", { ascending: false }).limit(500)
  );

  // se falhou com "data", tenta com created_at
  if (!ok || !used?.includes("data")) {
    const alt = await safeSelect(
      "vendas",
      ["id,created_at,total", "id,created_at,total,forma"],
      (q) => q.gte("created_at", start).lte("created_at", end).order("created_at", { ascending: false }).limit(500)
    );
    return alt.data || [];
  }

  return data || [];
}

async function loadCrediarioResumo() {
  // 1) pega vendas do crediário (forma contém "credi")
  const vendas = await safeQuery(() =>
    sb
      .from("vendas")
      .select("id,forma,total")
      .in("forma", ["crediario", "crediário", "credi"]) // se sua forma for enum, isso funciona
  );

  // se não existir enum/valores, tenta fallback por igualdade
  const vendasOk = Array.isArray(vendas) ? vendas : [];
  const vendaIds = vendasOk.map((v) => String(v.id)).filter(Boolean);

  if (!vendaIds.length) return { vencidas: [], proximas: [], totalAberto: 0 };

  // 2) busca parcelas dessas vendas
  const parcelas = await safeQuery(() =>
    sb
      .from("parcelas")
      .select("id,venda_id,vencimento,valor,valor_pago_acumulado,status,numero")
      .in("venda_id", vendaIds)
      .order("vencimento", { ascending: true })
      .limit(2000)
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

  return { vencidas, proximas, totalAberto };
}

async function loadEstoqueBaixo() {
  // tenta colunas comuns
  const tries = [
    "id,nome,estoque,estoque_minimo",
    "id,nome,quantidade,estoque_minimo",
    "id,nome,estoque_atual,estoque_minimo",
    "id,descricao,estoque,estoque_minimo",
  ];

  const result = await safeSelect(
    "produtos",
    tries,
    (q) => q.limit(1000)
  );

  if (!result.ok) return null;

  const rows = result.data || [];
  // detecta quais campos vieram
  const sample = rows[0] || {};
  const nomeKey = sample.nome != null ? "nome" : (sample.descricao != null ? "descricao" : "nome");
  const estKey =
    sample.estoque != null ? "estoque" :
    (sample.quantidade != null ? "quantidade" :
    (sample.estoque_atual != null ? "estoque_atual" : "estoque"));

  const out = rows
    .map((r) => {
      const est = Number(r[estKey] || 0);
      const min = Number(r.estoque_minimo || 0);
      return { id: r.id, nome: r[nomeKey], est, min };
    })
    .filter((x) => Number.isFinite(x.min) && x.min > 0 && x.est <= x.min)
    .sort((a, b) => byNum(a.est, b.est))
    .slice(0, 12);

  return out;
}

async function loadComprasRecentes() {
  const tries = [
    "id,data,total,fornecedor",
    "id,data,total",
    "id,created_at,total,fornecedor",
    "id,created_at,total",
  ];

  // tenta por data; se der ruim, tenta por created_at
  let r = await safeSelect("compras", tries, (q) => q.order("data", { ascending: false }).limit(5));
  if (!r.ok) {
    r = await safeSelect("compras", ["id,created_at,total,fornecedor", "id,created_at,total"], (q) =>
      q.order("created_at", { ascending: false }).limit(5)
    );
  }
  return r.ok ? (r.data || []) : null;
}

async function loadRelatorioPeriodo(inicioYYYYMMDD, fimYYYYMMDD) {
  // usa data >= inicio e <= fim (DATE) ou timestamps (funciona bem na prática)
  const ini = `${inicioYYYYMMDD}T00:00:00.000Z`;
  const fim = `${fimYYYYMMDD}T23:59:59.999Z`;

  // tenta por data; fallback created_at
  let data = await safeQuery(() =>
    sb.from("vendas").select("id,total,data").gte("data", ini).lte("data", fim).limit(5000)
  );

  if (data === null) {
    data = await safeQuery(() =>
      sb.from("vendas").select("id,total,created_at").gte("created_at", ini).lte("created_at", fim).limit(5000)
    );
  }

  const rows = Array.isArray(data) ? data : [];
  const qtd = rows.length;
  const total = rows.reduce((s, r) => s + Number(r.total || 0), 0);
  const ticket = qtd ? total / qtd : 0;

  return { qtd, total, ticket };
}

/* =========================
   UI UPDATE
========================= */
function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

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
      `<div class="small"><b>Vencidas:</b> ${cred.vencidas.length} parcela(s)</div>
       <div class="small"><b>Próx. 7 dias:</b> ${cred.proximas.length} parcela(s)</div>
       <div style="margin-top:8px; font-weight:900; font-size:1.05rem;">Aberto: ${money(cred.totalAberto)}</div>`
    );
  }

  // Estoque baixo
  const baixo = await loadEstoqueBaixo();
  if (baixo === null) {
    setHtml("estMsg", "Tabela de produtos não encontrada ou colunas diferentes.");
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

  // Compras recentes
  const compras = await loadComprasRecentes();
  if (compras === null) {
    setHtml("compMsg", "Tabela de compras não encontrada (ou colunas diferentes).");
  } else if (!compras.length) {
    setHtml("compMsg", "Nenhuma compra registrada ainda.");
  } else {
    const first = compras[0] || {};
    const hasData = first.data != null;
    const hasCreated = first.created_at != null;

    setHtml(
      "compMsg",
      `<div class="small" style="display:grid; gap:8px;">
        ${compras
          .map((c) => {
            const dt = hasData ? c.data : (hasCreated ? c.created_at : null);
            const forn = c.fornecedor ? ` • ${escapeHtml(c.fornecedor)}` : "";
            return `<div style="display:flex; justify-content:space-between; gap:10px;">
              <span>${fmtDateBR(dt)}${forn}</span>
              <b>${money(c.total || 0)}</b>
            </div>`;
          })
          .join("")}
      </div>`
    );
  }
}

function bindDashboardActions() {
  // defaults período: últimos 7 dias
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
    if (!i || !f) {
      if (out) out.textContent = "Selecione início e fim.";
      return;
    }
    if (i > f) {
      if (out) out.textContent = "Início não pode ser maior que fim.";
      return;
    }

    if (out) out.textContent = "Carregando relatório...";
    const r = await loadRelatorioPeriodo(i, f);
    if (!r) {
      if (out) out.textContent = "Erro ao carregar relatório.";
      return;
    }

    if (out) {
      out.innerHTML = `
        <div class="small"><b>Período:</b> ${fmtDateBR(i)} → ${fmtDateBR(f)}</div>
        <div style="margin-top:8px; font-weight:900; font-size:1.15rem;">${money(r.total)}</div>
        <div class="small" style="opacity:.9;">${r.qtd} venda(s) • Ticket médio ${money(r.ticket)}</div>
      `;
    }
  });

  // Atalhos (hash)
  document.getElementById("goVendas")?.addEventListener("click", () => (location.hash = "#vendas"));
  document.getElementById("goCompras")?.addEventListener("click", () => (location.hash = "#compras"));
  document.getElementById("goProdutos")?.addEventListener("click", () => (location.hash = "#produtos"));
  document.getElementById("goCred")?.addEventListener("click", () => (location.hash = "#crediario"));
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = layout();

  setTimeout(async () => {
    try {
      bindDashboardActions();
      await fillDashboard();
    } catch (e) {
      console.error(e);
      // não trava a tela
      setHtml("vHojeMsg", "Erro ao carregar.");
      setHtml("credMsg", "Erro ao carregar.");
      setHtml("estMsg", "Erro ao carregar.");
      setHtml("compMsg", "Erro ao carregar.");
    }
  }, 0);

  return html;
}
