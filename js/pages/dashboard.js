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

/**
 * Corrige bug de “volta 1 dia” em DATE YYYY-MM-DD
 */
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
   VENDAS HOJE
========================= */
async function fetchVendasHoje() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");

  const ini = `${y}-${m}-${d}T00:00:00`;
  const fim = `${y}-${m}-${d}T23:59:59`;

  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data")
    .gte("data", ini)
    .lte("data", fim);

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);

  return { total, count: rows.length };
}

/* =========================
   ITENS DA VENDA (produtos)
   - tenta tabelas comuns
========================= */
async function fetchItensVendaTexto(vendaId) {
  if (!vendaId) return "";

  const tables = ["vendas_itens", "venda_itens", "itens_venda"];

  for (const t of tables) {
    try {
      const { data, error } = await sb
        .from(t)
        .select("*")
        .eq("venda_id", vendaId);

      if (error) continue;

      const itens = data || [];
      if (!itens.length) return "";

      // monta texto “produto cor tam xqtd”
      const lines = itens.map((it) => {
        const nome =
          it.descricao ||
          it.produto_nome ||
          it.produto ||
          it.nome_produto ||
          it.nome ||
          "-";

        const cor = it.cor || it.color || "";
        const tam = it.tamanho || it.tam || it.size || "";
        const qtd = Number(it.qtd ?? it.quantidade ?? it.quant ?? 1);

        const parts = [nome, cor, tam].filter(Boolean).join(" • ");
        return `${parts} ${qtd > 1 ? `x${qtd}` : ""}`.trim();
      });

      return lines.filter(Boolean).join(" | ");
    } catch {
      // tenta próxima tabela
    }
  }

  return ""; // não achou
}

/* =========================
   CREDIÁRIO – PRÓXIMA PARCELA
========================= */
async function fetchCrediarioResumo() {
  const { data, error } = await sb
    .from("parcelas")
    .select("id,venda_id,numero,vencimento,valor,valor_pago_acumulado,status")
    .order("vencimento", { ascending: true })
    .limit(2000);

  if (error) throw error;

  const abertas = (data || []).filter((p) => {
    const st = String(p.status || "").toLowerCase();
    const saldo = Number(p.valor || 0) - Number(p.valor_pago_acumulado || 0);
    return !st.includes("pag") && saldo > 0.009;
  });

  const abertoTotal = abertas.reduce((acc, p) => {
    return acc + clamp0(Number(p.valor || 0) - Number(p.valor_pago_acumulado || 0));
  }, 0);

  if (!abertas.length) return { abertoTotal, prox: null };

  const prox = abertas[0];

  // pega cliente
  const { data: venda } = await sb
    .from("vendas")
    .select("id,cliente_nome,cliente_telefone")
    .eq("id", prox.venda_id)
    .maybeSingle();

  // pega itens/produtos
  const itensTxt = await fetchItensVendaTexto(prox.venda_id);

  return {
    abertoTotal,
    prox: {
      venda_id: prox.venda_id,
      cliente_nome: venda?.cliente_nome || "",
      cliente_telefone: venda?.cliente_telefone || "",
      vencimento: prox.vencimento, // ✅ DATA DA PARCELA
      numero: prox.numero,
      saldo: Number(prox.valor || 0) - Number(prox.valor_pago_acumulado || 0),
      itensTxt,
    },
  };
}

/* =========================
   LAYOUT
========================= */
function renderSkeleton() {
  return `
    <div class="grid cols-1" style="gap:14px;">

      <div class="card">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div id="dashVendasHoje" class="small">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>
        <div id="dashCrediario" class="small">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Filtro de datas</div>

        <div class="grid" style="grid-template-columns:1fr 1fr auto; gap:10px; margin-top:10px;">
          <div class="field">
            <label>Início</label>
            <input type="date" class="input" id="repIni" />
          </div>
          <div class="field">
            <label>Fim</label>
            <input type="date" class="input" id="repFim" />
          </div>
          <button class="btn primary" id="btnRep">Aplicar</button>
        </div>

        <div id="repOut" class="small" style="margin-top:10px;">
          Selecione um período.
        </div>
      </div>

    </div>
  `;
}

/* =========================
   RENDERERS
========================= */
async function renderVendasHoje() {
  const el = document.getElementById("dashVendasHoje");
  if (!el) return;

  try {
    const { total, count } = await fetchVendasHoje();
    el.innerHTML = `
      <div style="font-size:1.2rem; font-weight:900;">
        ${money(total)}
      </div>
      <div class="small">${count} venda(s) hoje</div>
    `;
  } catch {
    el.textContent = "Erro ao carregar vendas de hoje.";
  }
}

async function renderCrediario() {
  const el = document.getElementById("dashCrediario");
  if (!el) return;

  try {
    const { abertoTotal, prox } = await fetchCrediarioResumo();

    if (!prox) {
      el.innerHTML = `
        <div style="font-weight:900;">Aberto: ${money(abertoTotal)}</div>
        <div class="small">Nenhuma parcela em aberto</div>
        <button class="btn" onclick="location.hash='#crediario'">Abrir no Crediário</button>
      `;
      return;
    }

    const itens = prox.itensTxt ? escapeHtml(prox.itensTxt) : "";

    el.innerHTML = `
      <div style="font-weight:900;">Aberto: ${money(abertoTotal)}</div>

      <div class="card" style="margin-top:10px;">
        <div style="font-weight:800;">Próxima parcela</div>

        <div class="small" style="margin-top:6px;">
          <b>${escapeHtml(prox.cliente_nome || "Cliente")}</b>
          ${prox.cliente_telefone ? ` • ${escapeHtml(prox.cliente_telefone)}` : ""}
        </div>

        <div class="small" style="margin-top:6px;">
          Vencimento da parcela: <b>${fmtDateBR(prox.vencimento)}</b>
          • Parcela: <b>${prox.numero}</b>
        </div>

        <div class="small" style="margin-top:6px;">
          Saldo desta parcela: <b>${money(prox.saldo)}</b>
        </div>

        <div class="small" style="margin-top:10px;">
          <b>Produtos:</b>
          ${itens ? itens : "(não encontrado)"}
        </div>
      </div>

      <button class="btn" style="margin-top:10px;" onclick="location.hash='#crediario'">
        Abrir no Crediário
      </button>
    `;
  } catch (e) {
    console.error(e);
    el.textContent = "Erro ao carregar crediário.";
  }
}

function bindRelatorio() {
  const ini = document.getElementById("repIni");
  const fim = document.getElementById("repFim");
  const out = document.getElementById("repOut");
  const btn = document.getElementById("btnRep");

  if (!ini || !fim || !btn || !out) return;

  btn.onclick = async () => {
    if (!ini.value || !fim.value) {
      out.textContent = "Selecione um período válido.";
      return;
    }

    out.textContent = "Carregando...";

    const { data, error } = await sb
      .from("vendas")
      .select("id,total")
      .gte("data", `${ini.value}T00:00:00`)
      .lte("data", `${fim.value}T23:59:59`);

    if (error) {
      out.textContent = "Erro ao gerar relatório.";
      return;
    }

    const rows = data || [];
    const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);

    out.innerHTML = `
      <div>Total no período: <b>${money(total)}</b></div>
      <div class="small">${rows.length} venda(s)</div>
    `;
  };
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = renderSkeleton();

  setTimeout(async () => {
    await Promise.allSettled([renderVendasHoje(), renderCrediario()]);
    bindRelatorio();
  }, 0);

  return html;
}
