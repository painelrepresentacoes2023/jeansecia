import { sb } from "../supabase.js";

/* =========================
   HELPERS
========================= */
function money(n) {
  const v = Number(n || 0);
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Corrige bug do "volta 1 dia" (DATE YYYY-MM-DD) */
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

function normId(v) {
  if (v == null) return "";
  return String(v).trim();
}

function clamp0(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

function pickKey(obj, keys) {
  if (!obj) return null;
  const lowerMap = new Map(Object.keys(obj).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lowerMap.get(String(k).toLowerCase());
    if (real) return real;
  }
  return null;
}

/** Hoje (00:00:00 -> 23:59:59) no fuso local */
function todayRangeISO() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  return { start: start.toISOString(), end: end.toISOString() };
}

/* =========================
   LOADERS (DASH)
========================= */
async function loadVendasHoje() {
  const { start, end } = todayRangeISO();

  // tenta buscar por "data" (se for timestamp) ou por created_at como fallback
  let data = [];
  let error = null;

  // 1) tenta por data
  ({ data, error } = await sb
    .from("vendas")
    .select("id,total,data,created_at")
    .gte("data", start)
    .lte("data", end));

  // 2) fallback: created_at
  if (error) {
    ({ data, error } = await sb
      .from("vendas")
      .select("id,total,data,created_at")
      .gte("created_at", start)
      .lte("created_at", end));
  }

  if (error) throw error;

  const rows = data || [];
  const total = rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
  return { count: rows.length, total: Number(total.toFixed(2)) };
}

/** pega formas do enum contendo "credi" (igual crediario.js) */
async function loadCrediFormas() {
  try {
    const { data, error } = await sb.rpc("enum_values", { enum_type: "forma_pagamento" });
    if (error) throw error;
    const vals = (data || []).map((x) => x.value);
    const filtered = vals.filter((v) => String(v).toLowerCase().includes("credi"));
    return filtered.length ? filtered : ["crediario", "crediário", "credi"];
  } catch {
    return ["crediario", "crediário", "credi"];
  }
}

/** total aberto do crediário + próxima parcela aberta a vencer */
async function loadCrediarioResumo() {
  const formas = await loadCrediFormas();

  // busca vendas crediário
  const { data: vendas, error: e1 } = await sb
    .from("vendas")
    .select("id,cliente_nome,cliente_telefone,total,forma,data")
    .in("forma", formas)
    .order("data", { ascending: false })
    .limit(300);

  if (e1) throw e1;

  const v = (vendas || []).map((r) => ({ ...r, id: normId(r.id) })).filter((r) => r.id);
  if (!v.length) {
    return { abertoTotal: 0, proxima: null };
  }

  const ids = v.map((x) => x.id);

  // parcelas abertas (status != paga) e ordena por vencimento
  const { data: parc, error: e2 } = await sb
    .from("parcelas")
    .select("id,venda_id,numero,vencimento,valor,status,valor_pago_acumulado")
    .in("venda_id", ids)
    .order("vencimento", { ascending: true })
    .order("numero", { ascending: true });

  if (e2) throw e2;

  const parcelas = (parc || []).map((p) => ({
    ...p,
    venda_id: normId(p.venda_id),
    id: normId(p.id),
  }));

  // total aberto = soma (valor - pago) das parcelas não quitadas
  let abertoTotal = 0;
  let proxima = null;

  for (const p of parcelas) {
    const valor = Number(p.valor || 0);
    const pago = Number(p.valor_pago_acumulado || 0);
    const saldo = clamp0(Number((valor - pago).toFixed(2)));

    const quitada =
      saldo <= 0.009 || String(p.status || "").toLowerCase().includes("pag");

    if (!quitada) {
      abertoTotal += saldo;

      if (!proxima) {
        const venda = v.find((x) => x.id === p.venda_id);
        proxima = {
          venda_id: p.venda_id,
          cliente_nome: venda?.cliente_nome || "-",
          cliente_telefone: venda?.cliente_telefone || "",
          vencimento: p.vencimento,
          numero: p.numero,
          saldo,
        };
      }
    }
  }

  return { abertoTotal: Number(abertoTotal.toFixed(2)), proxima };
}

/**
 * ✅ Estoque baixo: pega dados e filtra no JS:
 * baixa quando qtd < minimo
 * (sem tentar "comparar coluna com coluna" no Supabase)
 */
async function loadEstoqueBaixo() {
  // tenta tabela mais provável
  let data = null;
  let error = null;

  ({ data, error } = await sb.from("estoque").select("*").limit(500));
  if (error) {
    // fallback comum
    ({ data, error } = await sb.from("produtos").select("*").limit(500));
  }
  if (error) throw error;

  const rows = data || [];
  if (!rows.length) return [];

  // tenta descobrir nomes reais das colunas (pra funcionar mesmo se variar)
  const sample = rows[0];

  const kProduto = pickKey(sample, ["produto", "nome", "descricao", "produto_nome"]);
  const kCodigo = pickKey(sample, ["codigo", "sku"]);
  const kCategoria = pickKey(sample, ["categoria"]);
  const kCor = pickKey(sample, ["cor"]);
  const kTamanho = pickKey(sample, ["tamanho", "tam"]);

  const kQtd = pickKey(sample, ["qtd", "quantidade", "estoque", "estoque_atual", "saldo"]);
  const kMin = pickKey(sample, ["minimo", "estoque_minimo", "min_estoque", "min"]);

  // se não achar qtd/min, não tem como
  if (!kQtd || !kMin) return [];

  const baixos = rows
    .map((r) => {
      const qtd = Number(r[kQtd] ?? 0);
      const min = Number(r[kMin] ?? 0);
      return {
        raw: r,
        produto: kProduto ? r[kProduto] : "—",
        codigo: kCodigo ? r[kCodigo] : "",
        categoria: kCategoria ? r[kCategoria] : "",
        cor: kCor ? r[kCor] : "",
        tamanho: kTamanho ? r[kTamanho] : "",
        qtd,
        min,
      };
    })
    .filter((x) => Number.isFinite(x.qtd) && Number.isFinite(x.min) && x.min > 0 && x.qtd < x.min)
    .sort((a, b) => (a.qtd - a.min) - (b.qtd - b.min));

  return baixos.slice(0, 8); // top 8 no dashboard
}

/* =========================
   RENDER
========================= */
function renderLayout() {
  return `
    <div class="grid cols-1" style="gap:14px;">
      <div class="card" id="dVendas">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div class="small" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card" id="dCred">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>
        <div class="small" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="card" id="dEstoque">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
        <div class="small" style="margin-top:10px;">Carregando...</div>
      </div>

      <div class="grid cols-2" style="margin-top:0;">
        <div class="card" id="dRelatorio">
          <div class="card-title">Relatório por período</div>
          <div class="card-sub">Filtro de datas</div>

          <div class="grid" style="grid-template-columns: 1fr 1fr auto; gap:10px; margin-top:12px; align-items:end;">
            <div class="field">
              <label>Início</label>
              <input class="input" id="dIni" type="date" />
            </div>
            <div class="field">
              <label>Fim</label>
              <input class="input" id="dFim" type="date" />
            </div>
            <button class="btn primary" id="dAplicar">Aplicar</button>
          </div>

          <div class="small" style="margin-top:10px;" id="dRelMsg">Selecione um período.</div>
        </div>

        <div class="card">
          <div class="card-title">Resumo rápido</div>
          <div class="card-sub">Visão geral</div>
          <div class="small" id="dResumo" style="margin-top:10px;">Carregando...</div>
        </div>
      </div>
    </div>
  `;
}

function setResumo({ vendas, cred, estoque }) {
  const el = document.getElementById("dResumo");
  if (!el) return;

  const itensBaixos = (estoque || []).length;

  el.innerHTML = `
    • Vendas hoje: <b>${money(vendas?.total || 0)}</b> (${Number(vendas?.count || 0)} venda(s))<br/>
    • Crediário aberto: <b>${money(cred?.abertoTotal || 0)}</b><br/>
    • Itens com estoque baixo: <b>${itensBaixos}</b>
  `;
}

/* =========================
   INIT
========================= */
function setDateInputsDefault() {
  const ini = document.getElementById("dIni");
  const fim = document.getElementById("dFim");

  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(end);
  start.setDate(end.getDate() - 7);

  const toDateStr = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };

  if (ini) ini.value = toDateStr(start);
  if (fim) fim.value = toDateStr(end);
}

async function initDashboard() {
  setDateInputsDefault();

  const dV = document.getElementById("dVendas");
  const dC = document.getElementById("dCred");
  const dE = document.getElementById("dEstoque");

  let vendas = null;
  let cred = null;
  let estoque = [];

  // VENDAS HOJE
  try {
    vendas = await loadVendasHoje();
    if (dV) {
      dV.innerHTML = `
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo do dia</div>
        <div style="margin-top:10px; font-weight:900; font-size:1.2rem;">${money(vendas.total)}</div>
        <div class="small">${vendas.count} venda(s) hoje</div>
      `;
    }
  } catch (e) {
    console.error(e);
    if (dV) dV.querySelector(".small") && (dV.querySelector(".small").textContent = "Erro ao carregar vendas.");
  }

  // CREDIÁRIO
  try {
    cred = await loadCrediarioResumo();
    const prox = cred.proxima;
    if (dC) {
      dC.innerHTML = `
        <div class="card-title">Crediário</div>
        <div class="card-sub">Aberto e próxima parcela</div>

        <div style="margin-top:10px; font-weight:900; font-size:1.2rem;">
          Aberto: ${money(cred.abertoTotal)}
        </div>

        ${
          prox
            ? `
              <div class="card" style="margin-top:12px; padding:12px;">
                <div style="font-weight:800;">Próxima parcela</div>
                <div class="small" style="margin-top:6px;">
                  <b>${escapeHtml(prox.cliente_nome)}</b> • ${escapeHtml(prox.cliente_telefone || "")}<br/>
                  Venc: <b>${fmtDateBR(prox.vencimento)}</b> • Nº <b>${Number(prox.numero || 0)}</b><br/>
                  Saldo: <b>${money(prox.saldo)}</b>
                </div>
                <div style="margin-top:10px;">
                  <a class="btn primary" href="#crediario">Abrir no Crediário</a>
                </div>
              </div>
            `
            : `<div class="small" style="margin-top:10px;">Nenhuma parcela em aberto ✅</div>`
        }
      `;
    }
  } catch (e) {
    console.error(e);
    if (dC) dC.querySelector(".small") && (dC.querySelector(".small").textContent = "Erro ao carregar crediário.");
  }

  // ESTOQUE BAIXO (CORREÇÃO PRINCIPAL)
  try {
    estoque = await loadEstoqueBaixo();
    if (dE) {
      if (!estoque.length) {
        dE.innerHTML = `
          <div class="card-title">Estoque Baixo</div>
          <div class="card-sub">Itens abaixo do mínimo</div>
          <div class="small" style="margin-top:10px;">Nenhum item abaixo do mínimo ✅</div>
          <div style="margin-top:10px;">
            <a class="btn" href="#estoque">Abrir Estoque</a>
          </div>
        `;
      } else {
        dE.innerHTML = `
          <div class="card-title">Estoque Baixo</div>
          <div class="card-sub">Itens abaixo do mínimo</div>

          <div class="table-wrap" style="margin-top:10px;">
            <table class="table" style="min-width:880px;">
              <thead>
                <tr>
                  <th style="min-width:240px;">Produto</th>
                  <th style="min-width:120px;">Código</th>
                  <th style="min-width:140px;">Cor</th>
                  <th style="min-width:120px;">Tam.</th>
                  <th style="min-width:100px;">Qtd</th>
                  <th style="min-width:110px;">Mínimo</th>
                  <th style="min-width:140px;">Falta</th>
                </tr>
              </thead>
              <tbody>
                ${estoque
                  .map((x) => {
                    const falta = clamp0(Number(x.min - x.qtd).toFixed(0));
                    return `
                      <tr>
                        <td>${escapeHtml(x.produto || "—")}</td>
                        <td>${escapeHtml(x.codigo || "")}</td>
                        <td>${escapeHtml(x.cor || "")}</td>
                        <td>${escapeHtml(x.tamanho || "")}</td>
                        <td><b>${Number(x.qtd || 0)}</b></td>
                        <td>${Number(x.min || 0)}</td>
                        <td><b>${Number(falta)}</b></td>
                      </tr>
                    `;
                  })
                  .join("")}
              </tbody>
            </table>
          </div>

          <div style="margin-top:10px;">
            <a class="btn primary" href="#estoque">Abrir Estoque</a>
          </div>
        `;
      }
    }
  } catch (e) {
    console.error(e);
    if (dE) {
      dE.innerHTML = `
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
        <div class="small" style="margin-top:10px;">Erro ao carregar estoque baixo.</div>
        <div class="small" style="margin-top:8px;">Veja o Console (F12).</div>
      `;
    }
  }

  setResumo({ vendas, cred, estoque });

  // Relatório por período (placeholder do botão)
  const btn = document.getElementById("dAplicar");
  const msg = document.getElementById("dRelMsg");
  btn?.addEventListener("click", () => {
    if (!msg) return;
    msg.textContent = "Relatório por período: (se você quiser, eu ligo isso na sua tabela de vendas e somo tudo).";
  });
}

/* =========================
   EXPORT
========================= */
export async function renderDashboard() {
  const html = renderLayout();

  setTimeout(() => {
    initDashboard().catch((e) => console.error(e));
  }, 0);

  return html;
}
