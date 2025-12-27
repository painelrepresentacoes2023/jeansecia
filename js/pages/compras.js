import { sb } from "../supabase.js";

/* =========================================================
   COMPRAS.JS (FINAL) — UI limpa + MODAL Nova Compra/Editar
   - Histórico sempre visível
   - "+ Nova compra" abre modal (novo)
   - "Editar" abre modal (edição)
   - Itens: editar (qtd/custo/mínimo) + remover
   - Salvar chama RPC e depois aplica mínimo no estoque
========================================================= */

/* =========================
   HELPERS BÁSICOS
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

function parseNumberBR(v) {
  // aceita 12,50 ou 12.50
  if (v == null) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtDateBR(isoDate) {
  if (!isoDate) return "-";
  const [y, m, d] = String(isoDate).split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

function opt(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function showToast(msg, type = "info") {
  // fallback seguro: NÃO quebra se não tiver toast global
  console.log(`[${type}] ${msg}`);
}

// ===============================
// EXCLUIR COMPRA (modal próprio)
// ===============================

// Se você já tem um estado global de "compra em edição", a ideia é setar aqui.
// Ex.: quando clicar em "Editar", você faz: COMPRA_EDITANDO_ID = compraId;
let COMPRA_EDITANDO_ID = null;

let _modalExcluirCompra = null;
let _compraIdParaExcluir = null;

function garantirModalExcluirCompra() {
  if (_modalExcluirCompra) return _modalExcluirCompra;

  const modal = document.createElement("div");
  modal.id = "modalExcluirCompra";
  modal.style.cssText = `
    position: fixed;
    inset: 0;
    display: none;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,.45);
    z-index: 9999;
    padding: 16px;
  `;

 modal.innerHTML = `
  <div style="
    width: min(520px, 100%);
    background: #fff;
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,.2);
    color: #111;
  ">
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
      <h3 style="margin:0; font-size:18px; color:#111; opacity:1;">Excluir compra</h3>
      <button type="button" id="btnFecharModalExcluir" class="btn" style="min-width:auto; opacity:1;">✕</button>
    </div>

    <p style="margin:12px 0 0; line-height:1.35; color:#222; opacity:1;">
      Tem certeza que deseja excluir esta compra?
      <br />
      <strong style="color:#000; opacity:1;">Isso vai apagar os itens e reverter o estoque.</strong>
    </p>

    <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:16px; flex-wrap:wrap;">
      <button type="button" id="btnCancelarExcluir" class="btn" style="opacity:1;">Cancelar</button>
      <button type="button" id="btnConfirmarExcluir" class="btn danger" style="opacity:1;">Excluir</button>
    </div>
  </div>
`;


  // Fechar clicando fora
  modal.addEventListener("click", (e) => {
    if (e.target === modal) fecharModalExcluirCompra();
  });

  document.body.appendChild(modal);

  modal.querySelector("#btnFecharModalExcluir").addEventListener("click", fecharModalExcluirCompra);
  modal.querySelector("#btnCancelarExcluir").addEventListener("click", fecharModalExcluirCompra);

  modal.querySelector("#btnConfirmarExcluir").addEventListener("click", async () => {
    if (!_compraIdParaExcluir) return;
    await excluirCompra(_compraIdParaExcluir);
  });

  _modalExcluirCompra = modal;
  return modal;
}

function abrirModalExcluirCompra(compraId) {
  const modal = garantirModalExcluirCompra();
  _compraIdParaExcluir = compraId;
  modal.style.display = "flex";
}

function fecharModalExcluirCompra() {
  if (!_modalExcluirCompra) return;
  _modalExcluirCompra.style.display = "none";
  _compraIdParaExcluir = null;
}

// Ajuste aqui se você já tem uma função pronta de "cancelar edição".
// Eu deixei seguro: se não existir nada, não quebra.
function cancelarEdicaoSeForEssaCompra(compraId) {
  try {
    if (COMPRA_EDITANDO_ID && COMPRA_EDITANDO_ID === compraId) {
      COMPRA_EDITANDO_ID = null;

      // Se você tiver um método seu, chame aqui:
      // ex: cancelarEdicaoCompra();
      if (typeof window.cancelarEdicaoCompra === "function") {
        window.cancelarEdicaoCompra();
      }

      // Se você usa algum "estado" / "form" manual, limpe aqui também (se já existir no seu código).
      // Não vou mexer nos seus IDs porque você não passou.
    }
  } catch (e) {
    // não trava por causa de estado
    console.warn("Falha ao cancelar edição:", e);
  }
}

function toastSafe(msg, type = "info") {
  // Usa seu toast se existir; senão, cai no console (sem popup).
  const fn =
    window.toast ||
    window.showToast ||
    window.mostrarToast ||
    window.toastify ||
    null;

  if (typeof fn === "function") return fn(msg, type);
  console.log(`[${type}] ${msg}`);
}

async function excluirCompra(compraId) {
  try {
    const modal = garantirModalExcluirCompra();
    const btn = modal.querySelector("#btnConfirmarExcluir");
    const btnCancel = modal.querySelector("#btnCancelarExcluir");

    btn.disabled = true;
    btnCancel.disabled = true;
    btn.textContent = "Excluindo...";

    // Se estiver editando essa compra, cancela estado
    cancelarEdicaoSeForEssaCompra(compraId);

    // RPC
    const { error } = await sb.rpc("deletar_compra", { p_compra_id: compraId });
    if (error) throw error;

    // 1) Fecha modal
    fecharModalExcluirCompra();

    // 2) Remove do STATE (pra não voltar)
    state.historico = (state.historico || []).filter((x) => x.compra_id !== compraId);

    // 3) Remove do DOM (some imediatamente)
    const row = document.querySelector(`tr[data-row-compra="${compraId}"]`);
    if (row) row.remove();

    // 4) Re-renderiza a tabela (pra atualizar contagem e filtros)
    renderHistoricoTable();

    toastSafe("Compra excluída e estoque revertido.", "success");
  } catch (err) {
    console.error(err);
    toastSafe(`Erro ao excluir: ${err?.message || err}`, "error");
  } finally {
    const modal = garantirModalExcluirCompra();
    const btn = modal.querySelector("#btnConfirmarExcluir");
    const btnCancel = modal.querySelector("#btnCancelarExcluir");

    btn.disabled = false;
    btnCancel.disabled = false;
    btn.textContent = "Excluir";
  }
}



/* =========================
   STATE
========================= */

const SIZES_CAMISA = ["P", "M", "G", "GG", "XG", "LG"];
const SIZES_NUM = ["36", "38", "40", "42", "44", "46", "50"];

const state = {
  produtos: [], // {id, nome, codigo, categoria_id, categoria_nome, grade_nome}
  produtoCores: new Map(), // produto_id -> [cor...]
  historico: [],

  // modal compra
  modalOpen: false,
  editCompraId: null, // null = nova compra
  compraHeader: { data: "", fornecedor: "" },

  // itens (do carrinho / compra no modal)
  itens: [], // {produto_id, produto_nome, produto_codigo, cor, tamanho, qtd, custo_unit, minimo}
};

// expõe pro console sem quebrar
window.__comprasState = state;
console.log("compras.js carregou ✅", window.__comprasState);

/* =========================
   LOADERS
========================= */

async function loadProdutosComGrade() {
  const { data, error } = await sb
    .from("produtos")
    .select(
      `
      id, nome, codigo, ativo, categoria_id,
      categorias (
        id, nome, grade_id,
        grades ( id, nome )
      )
    `
    )
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw error;

  return (data || []).map((p) => {
    const cat = p.categorias || {};
    const grd = cat.grades || {};
    return {
      id: p.id,
      nome: p.nome,
      codigo: p.codigo,
      categoria_id: p.categoria_id,
      categoria_nome: cat.nome || "-",
      grade_nome: grd.nome || "",
    };
  });
}

async function loadHistoricoCompras() {
  const { data, error } = await sb
    .from("vw_compras_resumo")
    .select("*")
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data || [];
}

async function loadCompraItens(compra_id) {
  const { data, error } = await sb
    .from("vw_compra_itens_detalhe")
    .select("*")
    .eq("compra_id", compra_id)
    .order("produto", { ascending: true })
    .order("cor", { ascending: true })
    .order("tamanho", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadCoresDoProduto(produtoId) {
  if (!produtoId) return [];
  if (state.produtoCores.has(produtoId)) return state.produtoCores.get(produtoId);

  const { data, error } = await sb
    .from("produto_cores")
    .select("cor")
    .eq("produto_id", produtoId)
    .order("cor", { ascending: true });

  if (error) throw error;

  const cores = (data || []).map((x) => x.cor).filter(Boolean);
  state.produtoCores.set(produtoId, cores);
  return cores;
}

function getTamanhosByGradeNome(gradeNome = "") {
  const g = String(gradeNome || "").toLowerCase();
  if (g.includes("num")) return SIZES_NUM;
  return SIZES_CAMISA;
}

/* =========================
   VIEW HELPERS (VARIAÇÃO + ESTOQUE)
========================= */

async function getVariacaoId(produto_id, cor, tamanho) {
  const { data, error } = await sb
    .from("variacoes")
    .select("id")
    .eq("produto_id", produto_id)
    .eq("cor", cor)
    .eq("tamanho", tamanho)
    .maybeSingle();

  if (error) throw error;
  return data?.id || null;
}

async function aplicarMinimosNoEstoque(itens) {
  // Atualiza mínimo por variação (upsert)
  // Só aplica quando minimo for número >= 0
  for (const it of itens) {
    const minimoNum =
      it.minimo === "" || it.minimo == null ? null : Number(it.minimo);

    if (minimoNum == null || !Number.isFinite(minimoNum) || minimoNum < 0) continue;

    const variacao_id = await getVariacaoId(it.produto_id, it.cor, it.tamanho);
    if (!variacao_id) continue;

    const { error } = await sb
      .from("estoque")
      .upsert(
        [{ variacao_id, minimo: minimoNum }],
        { onConflict: "variacao_id" }
      );

    if (error) throw error;
  }
}

/* =========================
   RPC SALVAR / EDITAR
========================= */

async function salvarCompraRPC(payload, compra_id = null) {
  const payloadRpc = {
    compra_id: compra_id || undefined,
    data: payload.data,
    fornecedor: payload.fornecedor || null,
    observacoes: payload.observacoes || null,
    itens: payload.itens.map((it) => ({
      produto_id: it.produto_id,
      cor: it.cor,
      tamanho: it.tamanho,
      qtd: Number(it.qtd),
      custo_unit: Number(it.custo_unit),
    })),
  };

  if (compra_id) {
    const { error } = await sb.rpc("atualizar_compra", { payload: payloadRpc });
    if (error) throw error;
  } else {
    const { error } = await sb.rpc("registrar_compra", { payload: payloadRpc });
    if (error) throw error;
  }
}

/* =========================
   UI PRINCIPAL (HISTÓRICO + BOTÃO)
========================= */

function renderComprasLayout() {
  return `
    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
        <div>
          <div class="card-title">Compras</div>
          <div class="card-sub">Histórico de entradas. Edite compras e itens quando precisar.</div>
        </div>
        <button class="btn primary" id="btnNovaCompra">+ Nova compra</button>
      </div>

      <div class="grid grid-3" style="gap:10px; margin-top:12px;">
        <div class="field">
          <label>Filtro (fornecedor/produto/categoria)</label>
          <input class="input" id="hFiltroTxt" placeholder="Ex: fabrica, camiseta, calça..." />
        </div>
        <div class="field">
          <label>Data inicial</label>
          <input class="input" id="hDataIni" type="date" />
        </div>
        <div class="field">
          <label>Data final</label>
          <input class="input" id="hDataFim" type="date" />
        </div>
      </div>

      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" id="btnAplicarFiltro">Aplicar</button>
        <button class="btn" id="btnLimparFiltro">Limpar</button>
      </div>

      <div class="small" id="hInfo" style="margin-top:10px;">Carregando...</div>
      <div id="hItensBox" class="small" style="margin-top:10px;"></div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="table">
          <thead>
            <tr>
              <th>Data</th>
              <th>Fornecedor</th>
              <th>Produtos</th>
              <th>Peças</th>
              <th>Total</th>
              <th style="width:170px;">Ações</th>
            </tr>
          </thead>
          <tbody id="hTbody">
            <tr><td colspan="6" class="small">Carregando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Modal root -->
    <div id="comprasModalRoot"></div>
  `;
}

/* =========================
   HISTÓRICO (TABLE + FILTRO)
========================= */

function getHistoricoFiltrado() {
  const txt = (document.getElementById("hFiltroTxt")?.value || "").trim().toLowerCase();
  const ini = document.getElementById("hDataIni")?.value || "";
  const fim = document.getElementById("hDataFim")?.value || "";

  return (state.historico || []).filter((r) => {
    const blob = [
      r.fornecedor || "",
      r.produtos_resumo || "",
      r.categorias_resumo || "",
    ].join(" ").toLowerCase();

    if (txt && !blob.includes(txt)) return false;

    if (ini && String(r.data || "") < ini) return false;
    if (fim && String(r.data || "") > fim) return false;

    return true;
  });
}

function renderHistoricoTable() {
  const info = document.getElementById("hInfo");
  const tbody = document.getElementById("hTbody");

  const rows = getHistoricoFiltrado();
  if (info) info.textContent = `${rows.length} compra(s) no histórico.`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="small">Nenhuma compra encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const produtos = (r.produtos_resumo || "").trim();
      return `
        <tr data-row-compra="${r.compra_id}">
          <td>${fmtDateBR(r.data)}</td>
          <td>${escapeHtml(r.fornecedor || "-")}</td>
          <td class="small">${escapeHtml(produtos || "-")}</td>
          <td>${Number(r.total_pecas || 0)}</td>
          <td>${money(r.total_itens || 0)}</td>
          <td style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="btn" data-ver="${r.compra_id}">Ver itens</button>
            <button class="btn primary" data-editar="${r.compra_id}">Editar</button>
            <button class="btn danger" data-excluir="${r.compra_id}">Excluir</button>
          </td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("button[data-ver]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await verItensCompra(btn.dataset.ver);
    });
  });

  tbody.querySelectorAll("button[data-editar]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const compraId = btn.dataset.editar;

    COMPRA_EDITANDO_ID = compraId; // <<< ESTA LINHA

    await abrirModalCompraEdicao(compraId);
  });
});


   tbody.querySelectorAll('button[data-excluir]').forEach((btn) => {
  btn.addEventListener("click", () => {
    const compraId = btn.getAttribute("data-excluir");
    abrirModalExcluirCompra(compraId);
  });
});
}

async function reloadHistorico() {
  const info = document.getElementById("hInfo");
  const tbody = document.getElementById("hTbody");

  try {
    state.historico = await loadHistoricoCompras();
    renderHistoricoTable();
  } catch (e) {
    console.error(e);
    if (info) info.textContent = "Erro ao carregar histórico.";
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="small">Erro ao carregar histórico.</td></tr>`;
    showToast("Erro ao carregar histórico de compras.", "error");
  }
}

async function verItensCompra(compraId) {
  const box = document.getElementById("hItensBox");
  if (box) box.textContent = "Carregando itens...";

  try {
    const itens = await loadCompraItens(compraId);

    if (!itens.length) {
      if (box) box.textContent = "Nenhum item nessa compra.";
      return;
    }

    const html = `
      <div class="card" style="margin-top:10px;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div style="font-weight:700;">Itens da compra</div>
          <button class="btn" id="btnFecharItens">Fechar</button>
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead>
              <tr>
                <th>Produto</th><th>Cor</th><th>Tam</th><th>Qtd</th><th>Custo</th><th>Total</th>
              </tr>
            </thead>
            <tbody>
              ${itens
                .map((i) => {
                  const qtd = Number(i.quantidade || 0);
                  const custo = Number(i.custo_unit || 0);
                  return `
                    <tr>
                      <td>${escapeHtml(i.produto || "-")} <span class="small">(${escapeHtml(i.codigo_produto || "")})</span></td>
                      <td>${escapeHtml(i.cor || "-")}</td>
                      <td>${escapeHtml(i.tamanho || "-")}</td>
                      <td>${qtd}</td>
                      <td>${money(custo)}</td>
                      <td>${money(qtd * custo)}</td>
                    </tr>
                  `;
                })
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;

    if (box) box.innerHTML = html;

    const btn = document.getElementById("btnFecharItens");
    if (btn)
      btn.addEventListener("click", () => {
        if (box) box.innerHTML = "";
      });
  } catch (e) {
    console.error(e);
    if (box) box.textContent = "Erro ao carregar itens da compra.";
  }
}

/* =========================
   MODAL (COMPRA)
========================= */

function ensureModalCssOnce() {
  if (document.getElementById("comprasModalCss")) return;

  const css = document.createElement("style");
  css.id = "comprasModalCss";
  css.textContent = `
    .cfit-modal-overlay{
      position:fixed; inset:0; background:rgba(0,0,0,.55);
      display:flex; align-items:flex-start; justify-content:center;
      padding:20px; z-index:9999;
    }
    .cfit-modal{
      width:min(980px, 96vw);
      background:rgba(10,20,35,.95);
      border:1px solid rgba(255,255,255,.08);
      border-radius:16px;
      box-shadow:0 20px 60px rgba(0,0,0,.5);
      overflow:hidden;
    }
    .cfit-modal-header{
      padding:14px 16px;
      display:flex; align-items:center; justify-content:space-between; gap:10px;
      border-bottom:1px solid rgba(255,255,255,.08);
    }
    .cfit-modal-body{ padding:16px; max-height:80vh; overflow:auto; }
    .cfit-modal-footer{
      padding:14px 16px;
      display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
      border-top:1px solid rgba(255,255,255,.08);
    }
    .cfit-modal-title{ font-weight:800; font-size:16px; }
    .cfit-modal-sub{ opacity:.85; font-size:12px; margin-top:2px; }
    .cfit-modal-close{ cursor:pointer; }
    .cfit-inline-msg{ font-size:12px; opacity:.9; margin-top:8px; }
    .cfit-item-actions{ display:flex; gap:8px; flex-wrap:wrap; }
    .cfit-mini-modal{
      position:fixed; inset:0; background:rgba(0,0,0,.55);
      display:flex; align-items:center; justify-content:center;
      padding:20px; z-index:10000;
    }
    .cfit-mini-card{
      width:min(520px, 96vw);
      background:rgba(10,20,35,.96);
      border:1px solid rgba(255,255,255,.08);
      border-radius:16px;
      padding:16px;
    }
  `;
  document.head.appendChild(css);
}

function openModal(html) {
  ensureModalCssOnce();
  const root = document.getElementById("comprasModalRoot");
  if (!root) return;

  root.innerHTML = html;

  // fechar por overlay click
  const ov = document.getElementById("cfitModalOverlay");
  if (ov) {
    ov.addEventListener("click", (e) => {
      if (e.target === ov) closeModal();
    });
  }

  // fechar por ESC
  document.addEventListener("keydown", onEscClose, { passive: true });
}

function onEscClose(e) {
  if (e.key === "Escape") closeModal();
}

function closeModal() {
  const root = document.getElementById("comprasModalRoot");
  if (!root) return;

  root.innerHTML = "";
  state.modalOpen = false;
  state.editCompraId = null;
  state.itens = [];
  state.compraHeader = { data: "", fornecedor: "" };

  document.removeEventListener("keydown", onEscClose);
}

function renderModalCompra() {
  const editando = !!state.editCompraId;

  const titulo = editando ? "Editar Compra" : "Nova Compra";
  const sub = editando
    ? "Edite itens, quantidades, custos e mínimo. Depois clique em Atualizar."
    : "Registre uma entrada no estoque. Adicione itens e clique em Salvar.";

  const headerData = state.compraHeader.data || "";
  const headerFornecedor = state.compraHeader.fornecedor || "";

  return `
    <div class="cfit-modal-overlay" id="cfitModalOverlay">
      <div class="cfit-modal">
        <div class="cfit-modal-header">
          <div>
            <div class="cfit-modal-title">${titulo}</div>
            <div class="cfit-modal-sub">${sub}</div>
          </div>
          <div class="cfit-modal-close">
            <button class="btn" id="btnFecharModal">Fechar</button>
          </div>
        </div>

        <div class="cfit-modal-body">
          <div class="grid grid-2" style="gap:10px;">
            <div class="field">
              <label>Data</label>
              <input class="input" id="mData" type="date" value="${escapeHtml(headerData)}" />
            </div>
            <div class="field">
              <label>Fornecedor (opcional)</label>
              <input class="input" id="mFornecedor" placeholder="Ex: Fábrica X" value="${escapeHtml(headerFornecedor)}" />
            </div>
          </div>

          <div class="hr"></div>

          <div class="card-title" style="font-size:14px;">Adicionar item</div>

          <div class="grid" style="grid-template-columns: 1.2fr 0.7fr; gap:10px; margin-top:10px;">
            <div class="field">
              <label>Produto (buscar)</label>
              <input class="input" id="mProdSearch" placeholder="Digite nome ou código..." autocomplete="off" />
              <div class="small" style="margin-top:6px;" id="mProdHint">Selecione um produto da lista.</div>
              <div id="mProdList" class="dropdown" style="display:none;"></div>
            </div>
            <div class="field">
              <label>Categoria</label>
              <input class="input" id="mCategoriaView" disabled />
            </div>
          </div>

          <div class="grid grid-4" style="gap:10px; margin-top:10px;">
            <div class="field">
              <label>Cor</label>
              <select class="select" id="mCor" disabled>
                <option value="">Selecione o produto</option>
              </select>
            </div>

            <div class="field">
              <label>Tamanho</label>
              <select class="select" id="mTam" disabled>
                <option value="">Selecione o produto</option>
              </select>
            </div>

            <div class="field">
              <label>Quantidade</label>
              <input class="input" id="mQtd" type="number" min="1" step="1" value="1" disabled />
            </div>

            <div class="field">
              <label>Mínimo (estoque)</label>
              <input class="input" id="mMin" type="number" min="0" step="1" placeholder="Ex: 5" disabled />
            </div>
          </div>

          <div class="grid grid-2" style="gap:10px; margin-top:10px;">
            <div class="field">
              <label>Modo de custo</label>
              <select class="select" id="mModo" disabled>
                <option value="unit">Valor unitário</option>
                <option value="lote">Valor total do lote</option>
              </select>
              <div class="small" id="mModoHelp" style="margin-top:6px;">Informe o custo unitário por peça.</div>
            </div>
            <div class="field">
              <label id="mValorLabel">Valor unitário (R$)</label>
              <input class="input" id="mValor" placeholder="Ex: 39,90" disabled />
              <div class="small" id="mCalcInfo" style="margin-top:6px;"></div>
            </div>
          </div>

          <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn primary" id="btnAddItemModal" disabled>Adicionar item</button>
            <button class="btn" id="btnLimparCamposModal" disabled>Limpar</button>
          </div>

          <div class="cfit-inline-msg" id="mMsg"></div>

          <div class="hr"></div>

          <div class="card-title" style="font-size:14px;">Itens adicionados</div>
          <div class="table-wrap" style="margin-top:10px;">
            <table class="table">
              <thead>
                <tr>
                  <th>Produto</th>
                  <th>Cor</th>
                  <th>Tam</th>
                  <th>Qtd</th>
                  <th>Custo</th>
                  <th>Mín</th>
                  <th>Total</th>
                  <th style="width:170px;">Ações</th>
                </tr>
              </thead>
              <tbody id="mItensTbody">
                ${renderItensModalBody()}
              </tbody>
            </table>
          </div>

          <div class="small" id="mResumo" style="margin-top:10px;"></div>
        </div>

        <div class="cfit-modal-footer">
          <div class="small" id="mFooterInfo"></div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            ${editando ? `<button class="btn" id="btnCancelarEdicaoModal">Cancelar edição</button>` : ""}
            <button class="btn primary" id="btnSalvarCompraModal">${editando ? "Atualizar compra" : "Salvar compra"}</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderItensModalBody() {
  if (!state.itens.length) {
    return `<tr><td colspan="8" class="small">Nenhum item ainda.</td></tr>`;
  }

  return state.itens
    .map((it, idx) => {
      const total = Number(it.qtd || 0) * Number(it.custo_unit || 0);
      return `
        <tr>
          <td>${escapeHtml(it.produto_nome)} <span class="small">(${escapeHtml(it.produto_codigo)})</span></td>
          <td>${escapeHtml(it.cor)}</td>
          <td>${escapeHtml(it.tamanho)}</td>
          <td>${Number(it.qtd || 0)}</td>
          <td>${money(it.custo_unit || 0)}</td>
          <td>${it.minimo === "" || it.minimo == null ? "-" : Number(it.minimo)}</td>
          <td>${money(total)}</td>
          <td>
            <div class="cfit-item-actions">
              <button class="btn" data-edit-item="${idx}">Editar</button>
              <button class="btn danger" data-rm-item="${idx}">Remover</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function refreshResumoModal() {
  const resumoEl = document.getElementById("mResumo");
  if (!resumoEl) return;

  const totalGeral = state.itens.reduce(
    (s, it) => s + Number(it.qtd || 0) * Number(it.custo_unit || 0),
    0
  );
  const totalPecas = state.itens.reduce((s, it) => s + Number(it.qtd || 0), 0);

  resumoEl.textContent = state.itens.length
    ? `Total de itens: ${totalPecas} • Total da compra: ${money(totalGeral)}`
    : "";
}

function refreshItensModalTable() {
  const tbody = document.getElementById("mItensTbody");
  if (!tbody) return;

  tbody.innerHTML = renderItensModalBody();
  refreshResumoModal();

  tbody.querySelectorAll("button[data-rm-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.rmItem);
      state.itens.splice(idx, 1);
      refreshItensModalTable();
    });
  });

  tbody.querySelectorAll("button[data-edit-item]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.editItem);
      abrirMiniModalEditarItem(idx);
    });
  });
}

/* =========================
   MINI MODAL (EDITAR ITEM)
   - NÃO re-renderiza enquanto digita (evita cursor sumir)
========================= */

function abrirMiniModalEditarItem(idx) {
  const it = state.itens[idx];
  if (!it) return;

  const html = `
    <div class="cfit-mini-modal" id="miniModalOverlay">
      <div class="cfit-mini-card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div style="font-weight:800;">Editar item</div>
          <button class="btn" id="btnMiniFechar">Fechar</button>
        </div>

        <div class="small" style="margin-top:6px;">
          ${escapeHtml(it.produto_nome)} (${escapeHtml(it.produto_codigo)}) • ${escapeHtml(it.cor)} • ${escapeHtml(it.tamanho)}
        </div>

        <div class="grid grid-3" style="gap:10px; margin-top:12px;">
          <div class="field">
            <label>Quantidade</label>
            <input class="input" id="miniQtd" type="number" min="1" step="1" value="${Number(it.qtd || 1)}" />
          </div>
          <div class="field">
            <label>Custo unit (R$)</label>
            <input class="input" id="miniCusto" value="${escapeHtml(String(it.custo_unit ?? ""))}" />
          </div>
          <div class="field">
            <label>Mínimo</label>
            <input class="input" id="miniMin" type="number" min="0" step="1" value="${it.minimo === "" || it.minimo == null ? "" : Number(it.minimo)}" />
          </div>
        </div>

        <div class="small" id="miniMsg" style="margin-top:10px;"></div>

        <div style="margin-top:12px; display:flex; gap:10px; justify-content:flex-end; flex-wrap:wrap;">
          <button class="btn danger" id="btnMiniRemover">Remover item</button>
          <button class="btn primary" id="btnMiniSalvar">Salvar</button>
        </div>
      </div>
    </div>
  `;

  // injeta
  const root = document.getElementById("comprasModalRoot");
  if (!root) return;
  root.insertAdjacentHTML("beforeend", html);

  const overlay = document.getElementById("miniModalOverlay");
  const fechar = () => overlay?.remove();

  // fechar
  document.getElementById("btnMiniFechar")?.addEventListener("click", fechar);
  overlay?.addEventListener("click", (e) => {
    if (e.target === overlay) fechar();
  });

  // remover
  document.getElementById("btnMiniRemover")?.addEventListener("click", () => {
    state.itens.splice(idx, 1);
    fechar();
    refreshItensModalTable();
  });

  // salvar
  document.getElementById("btnMiniSalvar")?.addEventListener("click", () => {
    const msg = document.getElementById("miniMsg");
    const qtd = Number(document.getElementById("miniQtd").value || 0);
    const custo = parseNumberBR(document.getElementById("miniCusto").value);
    const minimoVal = document.getElementById("miniMin").value;

    const minimo = minimoVal === "" ? null : Number(minimoVal);

    if (!qtd || qtd < 1) return (msg.textContent = "Quantidade inválida.");
    if (!custo || custo <= 0) return (msg.textContent = "Custo inválido.");
    if (minimo != null && (!Number.isFinite(minimo) || minimo < 0)) return (msg.textContent = "Mínimo inválido.");

    state.itens[idx].qtd = qtd;
    state.itens[idx].custo_unit = Number(custo.toFixed(2));
    state.itens[idx].minimo = minimo;

    fechar();
    refreshItensModalTable();
  });

  // foco inicial
  setTimeout(() => {
    document.getElementById("miniQtd")?.focus();
    document.getElementById("miniQtd")?.select?.();
  }, 0);
}

/* =========================
   MODAL EVENTOS (ADD ITEM / SALVAR)
========================= */

let selectedProdutoModal = null;

function updateModoUIModal() {
  const modo = document.getElementById("mModo").value;
  const label = document.getElementById("mValorLabel");
  const help = document.getElementById("mModoHelp");
  const calcInfo = document.getElementById("mCalcInfo");

  if (modo === "lote") {
    label.textContent = "Valor total do lote (R$)";
    help.textContent = "Você informa o total do lote; o sistema calcula custo unit automaticamente.";
  } else {
    label.textContent = "Valor unitário (R$)";
    help.textContent = "Informe o custo unitário por peça.";
  }
  if (calcInfo) calcInfo.textContent = "";
}

function calcCustoUnitario(modo, valor, qtd) {
  const v = parseNumberBR(valor);
  const q = Math.max(1, Number(qtd || 1));
  if (modo === "lote") return Number((v / q).toFixed(2));
  return Number(v.toFixed(2));
}

function showProdListModal(items) {
  const box = document.getElementById("mProdList");
  if (!box) return;

  if (!items.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }

  box.style.display = "block";
  box.innerHTML = items
    .slice(0, 12)
    .map(
      (p) => `
      <div class="dropdown-item" data-id="${p.id}">
        <div style="font-weight:700;">${escapeHtml(p.nome)}</div>
        <div class="small">${escapeHtml(p.codigo)} • ${escapeHtml(p.categoria_nome)} ${
        p.grade_nome ? "• " + escapeHtml(p.grade_nome) : ""
      }</div>
      </div>
    `
    )
    .join("");

  box.querySelectorAll(".dropdown-item").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const p = state.produtos.find((x) => x.id === id);
      if (p) selectProdutoModal(p);
      box.style.display = "none";
    });
  });
}

async function selectProdutoModal(p) {
  selectedProdutoModal = p;

  document.getElementById("mProdSearch").value = `${p.nome} (${p.codigo})`;
  document.getElementById("mCategoriaView").value = p.categoria_nome || "-";

  // habilita campos
  ["mCor", "mTam", "mQtd", "mMin", "mModo", "mValor", "btnAddItemModal", "btnLimparCamposModal"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = false;
  });

  const cores = await loadCoresDoProduto(p.id);
  const corSel = document.getElementById("mCor");
  corSel.innerHTML = `<option value="">Selecione</option>` + cores.map((c) => opt(c, c)).join("");

  const tamanhos = getTamanhosByGradeNome(p.grade_nome || "");
  const tamSel = document.getElementById("mTam");
  tamSel.innerHTML = `<option value="">Selecione</option>` + tamanhos.map((t) => opt(t, t)).join("");

  updateModoUIModal();
}

function clearAddFieldsModal(keepProduto = true) {
  const msg = document.getElementById("mMsg");
  const calc = document.getElementById("mCalcInfo");
  if (msg) msg.textContent = "";
  if (calc) calc.textContent = "";

  if (!keepProduto) {
    selectedProdutoModal = null;
    document.getElementById("mProdSearch").value = "";
    document.getElementById("mCategoriaView").value = "";
    document.getElementById("mCor").innerHTML = `<option value="">Selecione o produto</option>`;
    document.getElementById("mTam").innerHTML = `<option value="">Selecione o produto</option>`;
    ["mCor", "mTam", "mQtd", "mMin", "mModo", "mValor", "btnAddItemModal", "btnLimparCamposModal"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });
  } else {
    document.getElementById("mCor").value = "";
    document.getElementById("mTam").value = "";
    document.getElementById("mQtd").value = "1";
    document.getElementById("mMin").value = "";
    document.getElementById("mValor").value = "";
  }
}

function bindModalCompraEvents() {
  // fechar
  document.getElementById("btnFecharModal")?.addEventListener("click", closeModal);

  // header change (mantém state)
  document.getElementById("mData")?.addEventListener("change", (e) => {
    state.compraHeader.data = e.target.value || "";
  });
  document.getElementById("mFornecedor")?.addEventListener("input", (e) => {
    state.compraHeader.fornecedor = e.target.value || "";
  });

  // buscar produto
  const inp = document.getElementById("mProdSearch");
  inp?.addEventListener("input", () => {
    const q = (inp.value || "").trim().toLowerCase();
    if (!q || q.length < 2) return showProdListModal([]);
    const items = state.produtos.filter((p) => {
      return (
        (p.nome || "").toLowerCase().includes(q) ||
        (p.codigo || "").toLowerCase().includes(q)
      );
    });
    showProdListModal(items);
  });

  // fecha dropdown clicando fora
  document.addEventListener("click", (e) => {
    const box = document.getElementById("mProdList");
    const wrap = document.getElementById("mProdSearch");
    if (!box || !wrap) return;
    if (!box.contains(e.target) && e.target !== wrap) box.style.display = "none";
  });

  // modo custo
  document.getElementById("mModo")?.addEventListener("change", updateModoUIModal);

  // limpar campos add
  document.getElementById("btnLimparCamposModal")?.addEventListener("click", () => {
    clearAddFieldsModal(true);
  });

  // adicionar item
  document.getElementById("btnAddItemModal")?.addEventListener("click", () => {
    const msg = document.getElementById("mMsg");
    const calcInfo = document.getElementById("mCalcInfo");
    if (msg) msg.textContent = "";

    if (!selectedProdutoModal) return (msg.textContent = "Selecione um produto.");

    const cor = document.getElementById("mCor").value;
    const tam = document.getElementById("mTam").value;
    const qtd = Number(document.getElementById("mQtd").value || 0);
    const modo = document.getElementById("mModo").value;
    const valor = document.getElementById("mValor").value;
    const minimoTxt = document.getElementById("mMin").value;

    const minimo = minimoTxt === "" ? null : Number(minimoTxt);

    if (!cor) return (msg.textContent = "Selecione a cor.");
    if (!tam) return (msg.textContent = "Selecione o tamanho.");
    if (!qtd || qtd < 1) return (msg.textContent = "Quantidade inválida.");
    if (!valor.trim()) return (msg.textContent = "Informe o valor.");
    if (minimo != null && (!Number.isFinite(minimo) || minimo < 0)) return (msg.textContent = "Mínimo inválido.");

    const custoUnit = calcCustoUnitario(modo, valor, qtd);
    if (!custoUnit || custoUnit <= 0) return (msg.textContent = "Valor inválido.");

    if (modo === "lote" && calcInfo) {
      calcInfo.textContent = `Custo unitário calculado: ${money(custoUnit)} (total ÷ qtd)`;
    } else if (calcInfo) {
      calcInfo.textContent = "";
    }

    state.itens.push({
      produto_id: selectedProdutoModal.id,
      produto_nome: selectedProdutoModal.nome,
      produto_codigo: selectedProdutoModal.codigo,
      cor,
      tamanho: tam,
      qtd,
      custo_unit: custoUnit,
      minimo,
    });

    refreshItensModalTable();
    clearAddFieldsModal(true);
  });

  // cancelar edição (volta pra nova compra, sem fechar modal)
  document.getElementById("btnCancelarEdicaoModal")?.addEventListener("click", () => {
    state.editCompraId = null;
    state.itens = [];
    selectedProdutoModal = null;

    // reset header
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    state.compraHeader = { data: `${yyyy}-${mm}-${dd}`, fornecedor: "" };

    openModal(renderModalCompra());
    bindModalCompraEvents();
    refreshItensModalTable();
  });

  // salvar/atualizar
  document.getElementById("btnSalvarCompraModal")?.addEventListener("click", async () => {
    const footerInfo = document.getElementById("mFooterInfo");
    if (footerInfo) footerInfo.textContent = "";

    if (!state.itens.length) {
      if (footerInfo) footerInfo.textContent = "Adicione pelo menos 1 item.";
      return;
    }

    const data = document.getElementById("mData").value;
    const fornecedor = (document.getElementById("mFornecedor").value || "").trim();

    if (!data) {
      if (footerInfo) footerInfo.textContent = "Informe a data.";
      return;
    }

    const payload = {
      data,
      fornecedor,
      observacoes: null,
      itens: state.itens.map((it) => ({
        produto_id: it.produto_id,
        cor: it.cor,
        tamanho: it.tamanho,
        qtd: it.qtd,
        custo_unit: it.custo_unit,
        minimo: it.minimo, // (não depende do RPC)
      })),
    };

    try {
      if (footerInfo) footerInfo.textContent = state.editCompraId ? "Atualizando compra..." : "Salvando compra...";

      // 1) chama RPC
      await salvarCompraRPC(payload, state.editCompraId);

      // 2) aplica mínimos no estoque (upsert)
      await aplicarMinimosNoEstoque(state.itens);

      if (footerInfo) footerInfo.textContent = state.editCompraId ? "Compra atualizada ✅" : "Compra salva ✅";

      // atualiza histórico e fecha modal
      await reloadHistorico();
      closeModal();
    } catch (e) {
      console.error(e);
      if (footerInfo) footerInfo.textContent = e?.message || "Erro ao salvar compra.";
    }
  });

  // render inicial itens/resumo
  refreshItensModalTable();
}

/* =========================
   ABRIR MODAL NOVA / EDIÇÃO
========================= */

function abrirModalNovaCompra() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");

  state.editCompraId = null;
  state.itens = [];
  state.compraHeader = { data: `${yyyy}-${mm}-${dd}`, fornecedor: "" };

  openModal(renderModalCompra());
  bindModalCompraEvents();
}

async function abrirModalCompraEdicao(compraId) {
  try {
    const compra = (state.historico || []).find((x) => x.compra_id === compraId);
    if (!compra) return showToast("Compra não encontrada no histórico.", "error");

    const itens = await loadCompraItens(compraId);

    state.editCompraId = compraId;
    state.compraHeader = { data: compra.data || "", fornecedor: compra.fornecedor || "" };

    // monta itens (minimo começa vazio — você edita no modal)
    state.itens = (itens || []).map((i) => ({
      produto_id: i.produto_id,
      produto_nome: i.produto,
      produto_codigo: i.codigo_produto,
      cor: i.cor,
      tamanho: i.tamanho,
      qtd: Number(i.quantidade || 0),
      custo_unit: Number(i.custo_unit || 0),
      minimo: null,
    }));

    openModal(renderModalCompra());
    bindModalCompraEvents();
    refreshItensModalTable();
  } catch (e) {
    console.error(e);
    showToast("Erro ao abrir compra para edição.", "error");
  }
}

/* =========================
   BIND PRINCIPAL
========================= */

function bindMainEvents() {
  document.getElementById("btnNovaCompra")?.addEventListener("click", abrirModalNovaCompra);

  document.getElementById("btnAplicarFiltro")?.addEventListener("click", renderHistoricoTable);

  document.getElementById("btnLimparFiltro")?.addEventListener("click", () => {
    const txt = document.getElementById("hFiltroTxt");
    const ini = document.getElementById("hDataIni");
    const fim = document.getElementById("hDataFim");
    if (txt) txt.value = "";
    if (ini) ini.value = "";
    if (fim) fim.value = "";
    renderHistoricoTable();
  });
}

/* =========================
   EXPORT RENDER
========================= */

export async function renderCompras() {
  try {
     localStorage.setItem("ultima_pagina", "compras");
location.hash = "#compras";

    const html = renderComprasLayout();

    setTimeout(async () => {
      try {
        state.produtos = await loadProdutosComGrade();
        bindMainEvents();
        await reloadHistorico();
      } catch (e) {
        console.error(e);
        showToast(e?.message || "Erro ao iniciar Compras.", "error");
      }
    }, 0);

    return html;
  } catch (e) {
    console.error(e);
    return `
      <div class="card">
        <div class="card-title">Compras</div>
        <div class="card-sub">Erro ao carregar esta tela. Veja o Console (F12).</div>
      </div>
    `;
  }
}
