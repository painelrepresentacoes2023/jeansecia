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

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  }
  return fallback;
}

function pickNum(obj, keys, fallback = 0) {
  for (const k of keys) {
    const v = Number(obj?.[k]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/* =========================
   DASHBOARD: VENDAS HOJE
========================= */
async function fetchVendasHoje() {
  // pega "hoje" no fuso local (Brasil)
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const start = `${yyyy}-${mm}-${dd}T00:00:00`;
  const end = `${yyyy}-${mm}-${dd}T23:59:59`;

  const { data, error } = await sb
    .from("vendas")
    .select("id,total,data,created_at")
    .gte("data", start)
    .lte("data", end)
    .order("data", { ascending: false });

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { total, count: rows.length };
}

/* =========================
   DASHBOARD: CREDIÁRIO (PRÓXIMA PARCELA)
   (mantém do jeito que já tá funcionando)
========================= */
async function fetchCrediarioProximaParcela() {
  // busca parcelas abertas (status != paga) e pega a mais próxima de vencer
  const { data, error } = await sb
    .from("parcelas")
    .select("id,venda_id,numero,vencimento,valor,status,valor_pago_acumulado")
    .order("vencimento", { ascending: true })
    .limit(2000);

  if (error) throw error;

  const abertas = (data || []).filter((p) => {
    const st = String(p.status || "").toLowerCase();
    const valor = Number(p.valor || 0);
    const pago = Number(p.valor_pago_acumulado || 0);
    const saldo = Number((valor - pago).toFixed(2));
    return !st.includes("pag") && saldo > 0.009;
  });

  if (!abertas.length) return { abertoTotal: 0, prox: null };

  // total aberto somando saldos das parcelas
  const abertoTotal = abertas.reduce((acc, p) => {
    const valor = Number(p.valor || 0);
    const pago = Number(p.valor_pago_acumulado || 0);
    return acc + clamp0(valor - pago);
  }, 0);

  const proxParc = abertas[0];

  // pega dados da venda pra mostrar cliente
  const { data: vData, error: vErr } = await sb
    .from("vendas")
    .select("id,cliente_nome,cliente_telefone")
    .eq("id", proxParc.venda_id)
    .maybeSingle();

  // se falhar venda, só ignora e mostra sem nome
  const cliente_nome = vErr ? "" : (vData?.cliente_nome || "");
  const cliente_telefone = vErr ? "" : (vData?.cliente_telefone || "");

  return {
    abertoTotal: Number(abertoTotal.toFixed(2)),
    prox: {
      cliente_nome,
      cliente_telefone,
      vencimento: proxParc.vencimento,
      numero: proxParc.numero,
      saldo: clamp0(Number(proxParc.valor || 0) - Number(proxParc.valor_pago_acumulado || 0)),
    },
  };
}

/* =========================
   DASHBOARD: ESTOQUE BAIXO (SIMPLES)
   - tenta várias tabelas/views
   - tenta vários nomes de colunas
   - filtra qtd < minimo
========================= */
async function fetchEstoqueBaixo() {
  const sources = ["estoque", "vw_estoque", "estoque_view", "view_estoque", "estoque_itens"];

  // tentativa de select "wide": se a fonte não tiver uma coluna, o PostgREST pode errar.
  // então fazemos fallback pra select menor por tentativa.
  const selectWide = "categoria,produto,codigo,cor,tamanho,qtd,minimo,quantidade,estoque_minimo,min";

  let lastError = null;

  for (const src of sources) {
    // 1) tenta wide
    let res = await sb.from(src).select(selectWide).limit(3000);
    if (res.error) {
      lastError = res.error;

      // 2) fallback: select mínimo (quase todo mundo tem algum desses)
      res = await sb.from(src).select("*").limit(3000);
      if (res.error) {
        lastError = res.error;
        continue;
      }
    }

    const data = res.data || [];
    const rows = data.map((r) => {
      const produto = pick(r, ["produto", "nome", "descricao", "produto_nome"], "");
      const codigo = pick(r, ["codigo", "cod", "sku"], "");
      const cor = pick(r, ["cor", "cor_nome"], "");
      const tamanho = pick(r, ["tamanho", "tam", "grade"], "");
      const categoria = pick(r, ["categoria", "cat", "categoria_nome"], "");

      const qtd = pickNum(r, ["qtd", "quantidade", "estoque", "saldo", "qtd_atual"], 0);
      const minimo = pickNum(r, ["minimo", "estoque_minimo", "min", "qtd_minima", "minimo_estoque"], 0);

      return { produto, codigo, cor, tamanho, categoria, qtd, minimo };
    });

    const baixos = rows
      .filter((r) => Number.isFinite(r.minimo) && r.minimo > 0 && Number.isFinite(r.qtd) && r.qtd < r.minimo)
      .map((r) => ({ ...r, falta: clamp0(r.minimo - r.qtd) }))
      .sort((a, b) => b.falta - a.falta);

    return { source: src, baixos };
  }

  // se nada deu certo:
  throw lastError || new Error("Não consegui ler o estoque em nenhuma tabela/view.");
}

/* =========================
   RENDER
========================= */
function renderSkeleton() {
  return `
    <div class="grid cols-1" style="gap:14px;">
      <div class="card">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div class="small" id="dVendasHoje">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>
        <div class="small" id="dCred">Carregando...</div>
      </div>

      <div class="card">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
        <div class="small" id="dEstoqueMsg">Carregando...</div>

        <div class="table-wrap" style="margin-top:10px; overflow:auto; max-width:100%; -webkit-overflow-scrolling:touch;">
          <table class="table" style="min-width:900px; width:100%;">
            <thead>
              <tr>
                <th style="min-width:220px;">Produto</th>
                <th style="min-width:120px;">Código</th>
                <th style="min-width:120px;">Cor</th>
                <th style="min-width:120px;">Tam.</th>
                <th style="min-width:90px;">Qtd</th>
                <th style="min-width:90px;">Mínimo</th>
                <th style="min-width:90px;">Falta</th>
              </tr>
            </thead>
            <tbody id="dEstoqueTbody">
              <tr><td colspan="7" class="small">Carregando...</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top:10px;">
          <button class="btn" id="btnAbrirEstoque">Abrir Estoque</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Filtro de datas</div>

        <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px; align-items:end;">
          <div class="field">
            <label>Início</label>
            <input class="input" id="repIni" type="date" />
          </div>
          <div class="field">
            <label>Fim</label>
            <input class="input" id="repFim" type="date" />
          </div>
          <button class="btn primary" id="btnRep">Aplicar</button>
        </div>

        <div class="small" id="repOut" style="margin-top:10px;">Selecione um período.</div>
      </div>
    </div>
  `;
}

async function renderVendasHoje() {
  const el = document.getElementById("dVendasHoje");
  if (!el) return;

  try {
    const { total, count } = await fetchVendasHoje();
    el.innerHTML = `
      <div style="font-size:1.15rem; font-weight:900;">${money(total)}</div>
      <div class="small">${count} venda(s) hoje</div>
    `;
  } catch (e) {
    console.error(e);
    el.textContent = "Erro ao carregar vendas de hoje.";
  }
}

async function renderCrediario() {
  const el = document.getElementById("dCred");
  if (!el) return;

  try {
    const { abertoTotal, prox } = await fetchCrediarioProximaParcela();

    if (!prox) {
      el.innerHTML = `
        <div style="font-size:1.1rem; font-weight:900;">Aberto: ${money(abertoTotal)}</div>
        <div class="small">Nenhuma parcela aberta ✅</div>
        <div style="margin-top:10px;">
          <button class="btn" id="btnAbrirCred">Abrir no Crediário</button>
        </div>
      `;
    } else {
      el.innerHTML = `
        <div style="font-size:1.1rem; font-weight:900;">Aberto: ${money(abertoTotal)}</div>
        <div class="card" style="margin-top:10px;">
          <div style="font-weight:800;">Próxima parcela</div>
          <div class="small">${escapeHtml(prox.cliente_nome || "-")} • ${escapeHtml(prox.cliente_telefone || "")}</div>
          <div class="small">Venc: <b>${fmtDateBR(prox.vencimento)}</b> • Nº <b>${Number(prox.numero || 0)}</b></div>
          <div class="small">Saldo: <b>${money(prox.saldo)}</b></div>
        </div>
        <div style="margin-top:10px;">
          <button class="btn" id="btnAbrirCred">Abrir no Crediário</button>
        </div>
      `;
    }

    const btn = document.getElementById("btnAbrirCred");
    if (btn) btn.onclick = () => (location.hash = "#crediario");
  } catch (e) {
    console.error(e);
    el.textContent = "Erro ao carregar crediário.";
  }
}

async function renderEstoqueBaixo() {
  const msg = document.getElementById("dEstoqueMsg");
  const tbody = document.getElementById("dEstoqueTbody");
  const btn = document.getElementById("btnAbrirEstoque");

  if (btn) btn.onclick = () => (location.hash = "#estoque");

  if (!msg || !tbody) return;

  try {
    const { baixos } = await fetchEstoqueBaixo();

    if (!baixos.length) {
      msg.innerHTML = `Nenhum item abaixo do mínimo ✅`;
      tbody.innerHTML = `<tr><td colspan="7" class="small">—</td></tr>`;
      return;
    }

    msg.innerHTML = `<b>${baixos.length}</b> item(ns) abaixo do mínimo`;

    tbody.innerHTML = baixos
      .slice(0, 20)
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
  } catch (e) {
    console.error(e);
    msg.textContent = "Erro ao carregar estoque baixo.";
    tbody.innerHTML = `<tr><td colspan="7" class="small">Erro.</td></tr>`;
  }
}

function bindRelatorioPeriodo() {
  const ini = document.getElementById("repIni");
  const fim = document.getElementById("repFim");
  const out = document.getElementById("repOut");
  const btn = document.getElementById("btnRep");
  if (!ini || !fim || !out || !btn) return;

  // default: últimos 7 dias
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  ini.value = toISO(start);
  fim.value = toISO(end);

  btn.onclick = async () => {
    const a = ini.value;
    const b = fim.value;
    if (!a || !b) return (out.textContent = "Selecione um período válido.");

    out.textContent = "Carregando...";

    try {
      const { data, error } = await sb
        .from("vendas")
        .select("id,total,data")
        .gte("data", `${a}T00:00:00`)
        .lte("data", `${b}T23:59:59`)
        .limit(5000);

      if (error) throw error;

      const rows = data || [];
      const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);

      out.innerHTML = `
        <div>Total no período: <b>${money(total)}</b></div>
        <div class="small">${rows.length} venda(s)</div>
      `;
    } catch (e) {
      console.error(e);
      out.textContent = "Erro ao gerar relatório.";
    }
  };
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = renderSkeleton();

  setTimeout(async () => {
    await Promise.allSettled([renderVendasHoje(), renderCrediario(), renderEstoqueBaixo()]);
    bindRelatorioPeriodo();
  }, 0);

  return html;
}
