import { sb } from "../supabase.js";

/* =========================
   TOAST/FALLBACK (sem popup)
========================= */
function showToast(msg, type = "info") {
  console.log(`[${type}] ${msg}`);
  const el = document.getElementById("vMsg");
  if (el) el.textContent = msg;
}

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

function parseNumberBR(v) {
  if (v == null) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function fmtDateTimeBR(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR");
}

function isoFromDatetimeLocal(value) {
  // value: "YYYY-MM-DDTHH:mm"
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function normId(v) {
  if (v == null) return "";
  return String(v).trim();
}

function clamp0(n) {
  const x = Number(n || 0);
  return x < 0 ? 0 : x;
}

/* =========================
   STATE
========================= */
const state = {
  produtos: [],            // [{id,nome,codigo,categoria_nome}]
  produtoCores: new Map(), // produto_id -> [cor]
  historico: [],
  itens: [],               // [{variacao_id, produto_nome, produto_codigo, cor, tamanho, qtd, preco_unit}]
  editVendaId: null,
  formas: [],
};

window.__vendasState = state;

/* =========================
   LOADERS
========================= */
async function loadFormasEnum() {
  // enum: forma_pagamento
  const { data, error } = await sb.rpc("enum_values", { enum_type: "forma_pagamento" });
  if (error) throw error;
  return (data || []).map((x) => x.value);
}

async function loadProdutosDoEstoque() {
  const { data, error } = await sb
    .from("vw_estoque_detalhado")
    .select("produto_id, produto, codigo_produto, categoria, quantidade, produto_ativo, variacao_ativa")
    .gt("quantidade", 0)
    .eq("produto_ativo", true)
    .eq("variacao_ativa", true)
    .order("produto", { ascending: true });

  if (error) throw error;

  const map = new Map();
  for (const r of data || []) {
    const pid = normId(r.produto_id);
    if (!map.has(pid)) {
      map.set(pid, {
        id: pid,
        nome: r.produto,
        codigo: r.codigo_produto,
        categoria_nome: r.categoria || "-",
      });
    }
  }
  return Array.from(map.values());
}

async function loadCoresDoProduto(produtoId) {
  const pid = normId(produtoId);
  if (!pid) return [];
  if (state.produtoCores.has(pid)) return state.produtoCores.get(pid);

  const { data, error } = await sb
    .from("vw_estoque_detalhado")
    .select("cor")
    .eq("produto_id", pid)
    .eq("produto_ativo", true)
    .eq("variacao_ativa", true)
    .gt("quantidade", 0)
    .order("cor", { ascending: true });

  if (error) throw error;

  const cores = Array.from(new Set((data || []).map((x) => x.cor).filter(Boolean)));
  state.produtoCores.set(pid, cores);
  return cores;
}

async function loadTamanhosDaVariacao(produtoId, cor) {
  const pid = normId(produtoId);
  const { data, error } = await sb
    .from("vw_estoque_detalhado")
    .select("variacao_id, tamanho, quantidade")
    .eq("produto_id", pid)
    .eq("cor", cor)
    .eq("produto_ativo", true)
    .eq("variacao_ativa", true)
    .gt("quantidade", 0)
    .order("tamanho", { ascending: true });

  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    variacao_id: normId(r.variacao_id),
  }));
}

async function loadHistoricoVendas() {
  const { data, error } = await sb
    .from("vw_vendas_resumo")
    .select("*")
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(120);

  if (error) throw error;
  return (data || []).map((r) => ({
    ...r,
    venda_id: normId(r.venda_id),
  }));
}

async function loadVendaItens(vendaId) {
  const vid = normId(vendaId);
  const { data, error } = await sb
    .from("vw_venda_itens_detalhe")
    .select("*")
    .eq("venda_id", vid)
    .order("produto", { ascending: true })
    .order("cor", { ascending: true })
    .order("tamanho", { ascending: true });

  if (error) throw error;

  return (data || []).map((r) => ({
    ...r,
    venda_id: normId(r.venda_id),
    venda_item_id: normId(r.venda_item_id),
    variacao_id: normId(r.variacao_id),
    produto_id: normId(r.produto_id),
  }));
}

async function loadEstoquePorVariacoes(variacaoIds = []) {
  const ids = Array.from(new Set((variacaoIds || []).map(normId).filter(Boolean)));
  if (!ids.length) return new Map();

  const { data, error } = await sb
    .from("estoque")
    .select("variacao_id, quantidade")
    .in("variacao_id", ids);

  if (error) throw error;

  const m = new Map();
  (data || []).forEach((r) => m.set(normId(r.variacao_id), Number(r.quantidade || 0)));
  ids.forEach((id) => {
    if (!m.has(id)) m.set(id, 0);
  });
  return m;
}

/* =========================
   ESTOQUE (AJUSTE REAL)
   - delta > 0: devolve estoque
   - delta < 0: dá baixa
========================= */
async function applyEstoqueDeltas(deltaMap) {
  // deltaMap: Map(variacao_id -> delta)
  const entries = Array.from(deltaMap.entries()).filter(([vid, d]) => normId(vid) && Number(d || 0) !== 0);
  if (!entries.length) return;

  for (const [variacaoIdRaw, deltaRaw] of entries) {
    const variacao_id = normId(variacaoIdRaw);
    const delta = Number(deltaRaw || 0);

    // pega atual
    const { data: row, error: selErr } = await sb
      .from("estoque")
      .select("variacao_id, quantidade")
      .eq("variacao_id", variacao_id)
      .maybeSingle();

    if (selErr) throw selErr;

    const atual = Number(row?.quantidade || 0);
    const novo = clamp0(atual + delta);

    // upsert (garante que existe)
    const { error: upErr } = await sb
      .from("estoque")
      .upsert({ variacao_id, quantidade: novo }, { onConflict: "variacao_id" });

    if (upErr) throw upErr;
  }
}

function buildQtyMapFromStateItens() {
  const m = new Map();
  for (const it of state.itens || []) {
    const vid = normId(it.variacao_id);
    const qtd = Number(it.qtd || 0);
    if (!vid || qtd <= 0) continue;
    m.set(vid, (m.get(vid) || 0) + qtd);
  }
  return m;
}

function buildQtyMapFromVendaItensRows(rows = []) {
  const m = new Map();
  for (const r of rows || []) {
    const vid = normId(r.variacao_id);
    const qtd = Number(r.quantidade || 0);
    if (!vid || qtd <= 0) continue;
    m.set(vid, (m.get(vid) || 0) + qtd);
  }
  return m;
}

/* =========================
   UI LAYOUT
========================= */
function renderVendasLayout() {
  return `
    <div class="row2">
      <div class="card">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div>
            <div class="card-title" id="vTitulo">Nova Venda</div>
            <div class="card-sub" id="vSub">Registre uma venda e dê baixa automática no estoque.</div>
          </div>
        </div>

        <div class="grid grid-2" style="margin-top:12px; gap:10px;">
          <div class="field">
            <label>Data/Hora</label>
            <input class="input" id="vData" type="datetime-local" />
          </div>
          <div class="field">
            <label>Forma</label>
            <select class="select" id="vForma"></select>
          </div>
        </div>

        <div class="grid grid-2" style="margin-top:10px; gap:10px;">
          <div class="field">
            <label>Cliente (opcional)</label>
            <input class="input" id="vCliente" placeholder="Nome do cliente" />
          </div>
          <div class="field">
            <label>Telefone (opcional)</label>
            <input class="input" id="vTelefone" placeholder="(11) 9xxxx-xxxx" />
          </div>
        </div>

        <div class="grid grid-2" style="margin-top:10px; gap:10px;">
          <div class="field">
            <label>Desconto (R$)</label>
            <input class="input" id="vDesconto" placeholder="0,00" />
          </div>
          <div class="field">
            <label>Observações</label>
            <input class="input" id="vObs" placeholder="Opcional" />
          </div>
        </div>

        <div class="hr"></div>

        <div class="card-title" style="font-size:14px;">Item da venda</div>

        <div class="grid" style="grid-template-columns: 1.2fr 0.7fr; gap:10px; margin-top:10px;">
          <div class="field">
            <label>Produto (buscar)</label>
            <input class="input" id="vProdSearch" placeholder="Digite nome ou código..." autocomplete="off" />
            <div class="small" style="margin-top:6px;" id="vProdHint">Selecione um produto da lista.</div>
            <div id="vProdList" class="dropdown" style="display:none;"></div>
          </div>

          <div class="field">
            <label>Categoria</label>
            <input class="input" id="vCategoriaView" disabled />
          </div>
        </div>

        <div class="grid grid-4" style="gap:10px; margin-top:10px;">
          <div class="field">
            <label>Cor</label>
            <select class="select" id="vCor" disabled>
              <option value="">Selecione o produto</option>
            </select>
          </div>
          <div class="field">
            <label>Tamanho</label>
            <select class="select" id="vTam" disabled>
              <option value="">Selecione o produto</option>
            </select>
          </div>
          <div class="field">
            <label>Qtd</label>
            <input class="input" id="vQtd" type="number" min="1" step="1" value="1" disabled />
          </div>
          <div class="field">
            <label>Preço unit. (R$)</label>
            <input class="input" id="vPreco" placeholder="Ex: 79,90" disabled />
          </div>
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn primary" id="btnAddVendaItem" disabled>Adicionar item</button>
          <button class="btn" id="btnLimparVendaItem" disabled>Limpar campos</button>
        </div>

        <div class="small" id="vMsg" style="margin-top:12px;"></div>

        <div class="hr"></div>

        <div class="card-title" style="font-size:14px;">Itens adicionados</div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead>
              <tr>
                <th>Produto</th>
                <th>Cor</th>
                <th>Tam</th>
                <th style="width:90px;">Qtd</th>
                <th style="width:140px;">Preço</th>
                <th>Total</th>
                <th style="width:160px;">Ações</th>
              </tr>
            </thead>
            <tbody id="vItensTbody">
              <tr><td colspan="7" class="small">Nenhum item ainda.</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top:12px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div class="small" id="vResumo"></div>
          <div style="display:flex; gap:10px; flex-wrap:wrap;">
            <button class="btn" id="btnCancelarVendaEdicao" style="display:none;">Cancelar edição</button>
            <button class="btn primary" id="btnSalvarVenda" disabled>Salvar venda</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Histórico de Vendas</div>
        <div class="card-sub">Filtre, veja itens, edite e exclua vendas quando precisar.</div>

        <div class="grid" style="grid-template-columns: 1fr; gap:10px; margin-top:10px;">
          <div class="field">
            <label>Buscar no histórico</label>
            <input class="input" id="hVendaFiltro" placeholder="cliente, produto, forma..." />
          </div>
        </div>

        <div class="small" id="hVendaInfo" style="margin-top:10px;">Carregando...</div>
        <div id="hVendaItensBox" class="small" style="margin-top:10px;"></div>

        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead>
              <tr>
                <th>Data</th>
                <th>Cliente</th>
                <th>Produtos</th>
                <th>Total</th>
                <th style="width:220px;">Ações</th>
              </tr>
            </thead>
            <tbody id="hVendaTbody">
              <tr><td colspan="5" class="small">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/* =========================
   PROD SEARCH DROPDOWN
========================= */
let selectedProduto = null;

function showProdList(items) {
  const box = document.getElementById("vProdList");
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
    <div class="dropdown-item" data-id="${escapeHtml(p.id)}">
      <div style="font-weight:700;">${escapeHtml(p.nome)}</div>
      <div class="small">${escapeHtml(p.codigo || "")} • ${escapeHtml(p.categoria_nome || "-")}</div>
    </div>
  `
    )
    .join("");

  box.querySelectorAll(".dropdown-item").forEach((el) => {
    el.addEventListener("click", async () => {
      const id = normId(el.dataset.id);
      const p = (state.produtos || []).find((x) => normId(x.id) === id);
      if (p) await selectProduto(p);
      box.style.display = "none";
    });
  });
}

async function selectProduto(p) {
  selectedProduto = p;

  document.getElementById("vProdSearch").value = `${p.nome} (${p.codigo || ""})`;
  document.getElementById("vCategoriaView").value = p.categoria_nome || "-";

  document.getElementById("vCor").disabled = false;
  document.getElementById("vTam").disabled = false;
  document.getElementById("vQtd").disabled = false;
  document.getElementById("vPreco").disabled = false;
  document.getElementById("btnAddVendaItem").disabled = false;
  document.getElementById("btnLimparVendaItem").disabled = false;

  const cores = await loadCoresDoProduto(p.id);
  const corSel = document.getElementById("vCor");
  corSel.innerHTML =
    `<option value="">Selecione</option>` +
    cores.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  document.getElementById("vTam").innerHTML = `<option value="">Selecione a cor</option>`;
}

async function onCorChange() {
  const cor = document.getElementById("vCor").value;
  const tamSel = document.getElementById("vTam");
  tamSel.innerHTML = `<option value="">Carregando...</option>`;

  if (!selectedProduto || !cor) {
    tamSel.innerHTML = `<option value="">Selecione a cor</option>`;
    return;
  }

  const vars = await loadTamanhosDaVariacao(selectedProduto.id, cor);
  tamSel.innerHTML =
    `<option value="">Selecione</option>` +
    vars
      .map(
        (v) =>
          `<option value="${escapeHtml(v.variacao_id)}">${escapeHtml(v.tamanho)} (estoque: ${Number(v.quantidade || 0)})</option>`
      )
      .join("");
}

function clearVendaItemFields(keepProduto = true) {
  const msg = document.getElementById("vMsg");
  if (msg) msg.textContent = "";

  if (!keepProduto) {
    selectedProduto = null;
    document.getElementById("vProdSearch").value = "";
    document.getElementById("vCategoriaView").value = "";
    document.getElementById("vCor").innerHTML = `<option value="">Selecione o produto</option>`;
    document.getElementById("vTam").innerHTML = `<option value="">Selecione o produto</option>`;
    document.getElementById("vCor").disabled = true;
    document.getElementById("vTam").disabled = true;
    document.getElementById("vQtd").disabled = true;
    document.getElementById("vPreco").disabled = true;
    document.getElementById("btnAddVendaItem").disabled = true;
    document.getElementById("btnLimparVendaItem").disabled = true;
  } else {
    document.getElementById("vCor").value = "";
    document.getElementById("vTam").innerHTML = `<option value="">Selecione a cor</option>`;
    document.getElementById("vQtd").value = "1";
    document.getElementById("vPreco").value = "";
  }
}

/* =========================
   ITENS
========================= */
function calcResumoVenda() {
  const subtotal = state.itens.reduce((s, it) => s + Number(it.qtd || 0) * Number(it.preco_unit || 0), 0);
  const desconto = parseNumberBR(document.getElementById("vDesconto").value);
  const total = Math.max(subtotal - desconto, 0);
  return { subtotal, desconto, total };
}

function updateResumoOnly() {
  const { subtotal, desconto, total } = calcResumoVenda();
  const totalPecas = state.itens.reduce((s, it) => s + Number(it.qtd || 0), 0);
  document.getElementById("vResumo").textContent =
    `Peças: ${totalPecas} • Subtotal: ${money(subtotal)} • Desconto: ${money(desconto)} • Total: ${money(total)}`;
}

function renderItensVenda() {
  const tbody = document.getElementById("vItensTbody");

  if (!state.itens.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="small">Nenhum item ainda.</td></tr>`;
    document.getElementById("btnSalvarVenda").disabled = true;
    document.getElementById("vResumo").textContent = "";
    return;
  }

  tbody.innerHTML = state.itens
    .map((it, idx) => {
      const total = Number(it.qtd || 0) * Number(it.preco_unit || 0);

      return `
      <tr>
        <td>${escapeHtml(it.produto_nome)} <span class="small">(${escapeHtml(it.produto_codigo || "")})</span></td>
        <td>${escapeHtml(it.cor)}</td>
        <td>${escapeHtml(it.tamanho)}</td>

        <td>
          <input class="input" data-qtd="${idx}" type="number" min="1" step="1"
                 value="${Number(it.qtd || 1)}" style="width:80px; padding:8px;" />
        </td>

        <td>
          <input class="input" data-preco="${idx}" type="text"
                 value="${String(Number(it.preco_unit || 0)).replace(".", ",")}" style="width:120px; padding:8px;" />
        </td>

        <td>${money(total)}</td>

        <td style="display:flex; gap:8px; flex-wrap:wrap;">
          <button class="btn danger" data-rm="${idx}">Remover</button>
        </td>
      </tr>
    `;
    })
    .join("");

  tbody.querySelectorAll("input[data-qtd]").forEach((inp) => {
    inp.addEventListener("input", () => {
      const idx = Number(inp.dataset.qtd);
      const v = Math.max(1, Number(inp.value || 1));
      state.itens[idx].qtd = v;
      updateResumoOnly();
    });
  });

  tbody.querySelectorAll("input[data-preco]").forEach((inp) => {
    inp.addEventListener("blur", () => {
      const idx = Number(inp.dataset.preco);
      const v = parseNumberBR(inp.value);
      state.itens[idx].preco_unit = Math.max(0, Number(v.toFixed(2)));
      inp.value = String(state.itens[idx].preco_unit).replace(".", ",");
      updateResumoOnly();
    });
  });

  tbody.querySelectorAll("button[data-rm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.rm);
      state.itens.splice(idx, 1);
      renderItensVenda();
      updateResumoOnly();
    });
  });

  document.getElementById("btnSalvarVenda").disabled = false;
  updateResumoOnly();
}

/* =========================
   RPC (SALVAR/EDITAR)
========================= */
async function salvarVendaRPC(payload, vendaId = null) {
  if (vendaId) {
    const { error } = await sb.rpc("atualizar_venda", { payload: { ...payload, venda_id: vendaId } });
    if (error) throw error;
    return vendaId;
  } else {
    const { data: newId, error } = await sb.rpc("registrar_venda", { payload });
    if (error) throw error;
    return normId(newId);
  }
}

async function salvarItensVenda(vendaId) {
  const vid = normId(vendaId);

  const itens = (state.itens || []).map((it) => {
    const qtd = Number(it.qtd || 0);
    const preco = Number(it.preco_unit || 0);
    return {
      venda_id: vid,
      variacao_id: normId(it.variacao_id),
      quantidade: qtd,
      preco_unit_aplicado: preco,
      subtotal: Number((qtd * preco).toFixed(2)), // evita NOT NULL
    };
  });

  const { error: delErr } = await sb.from("venda_itens").delete().eq("venda_id", vid);
  if (delErr) throw delErr;

  if (itens.length > 0) {
    const { error: insErr } = await sb.from("venda_itens").insert(itens);
    if (insErr) throw insErr;
  }
}

/* =========================
   HISTÓRICO
========================= */
function renderHistoricoVendasTable(filterText = "") {
  const info = document.getElementById("hVendaInfo");
  const tbody = document.getElementById("hVendaTbody");

  let rows = state.historico || [];
  const f = (filterText || "").trim().toLowerCase();

  if (f) {
    rows = rows.filter((r) => {
      const s = [r.cliente_nome, r.cliente_telefone, r.forma, r.produtos_resumo].join(" ").toLowerCase();
      return s.includes(f);
    });
  }

  info.textContent = `${rows.length} venda(s) no histórico.`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="small">Nenhuma venda encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${fmtDateTimeBR(r.data)}</td>
      <td>${escapeHtml(r.cliente_nome || "-")}</td>
      <td title="${escapeHtml(r.produtos_resumo || "-")}">${escapeHtml((r.produtos_resumo || "-").slice(0, 28))}${
        (r.produtos_resumo || "").length > 28 ? "..." : ""
      }</td>
      <td>${money(r.total || 0)}</td>
      <td style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn" data-ver="${escapeHtml(r.venda_id)}">Ver itens</button>
        <button class="btn primary" data-editar="${escapeHtml(r.venda_id)}">Editar</button>
        <button class="btn danger" data-excluir="${escapeHtml(r.venda_id)}">Excluir</button>
      </td>
    </tr>
  `
    )
    .join("");

  tbody.querySelectorAll("button[data-ver]").forEach((btn) => {
    btn.addEventListener("click", async () => abrirModalItensVenda(btn.dataset.ver));
  });

  tbody.querySelectorAll("button[data-editar]").forEach((btn) => {
    btn.addEventListener("click", async () => editarVenda(btn.dataset.editar));
  });

  tbody.querySelectorAll("button[data-excluir]").forEach((btn) => {
    btn.addEventListener("click", async () => excluirVenda(btn.dataset.excluir));
  });
}

async function reloadHistoricoVendas() {
  state.historico = await loadHistoricoVendas();
  renderHistoricoVendasTable(document.getElementById("hVendaFiltro")?.value || "");
}

/* =========================
   EXCLUIR VENDA (COM DEVOLUÇÃO ESTOQUE)
========================= */
async function excluirVenda(vendaId) {
  const vid = normId(vendaId);
  if (!vid) return;

  try {
    showToast("Excluindo venda...", "info");

    // pega itens pra devolver estoque
    const itensOld = await loadVendaItens(vid);
    const oldMap = buildQtyMapFromVendaItensRows(itensOld);

    // 1) devolve estoque (se der ruim, não deleta nada)
    await applyEstoqueDeltas(oldMap);

    // 2) deleta venda_itens e vendas
    const { error: e1 } = await sb.from("venda_itens").delete().eq("venda_id", vid);
    if (e1) {
      // rollback estoque
      const rollback = new Map();
      for (const [k, v] of oldMap.entries()) rollback.set(k, -v);
      await applyEstoqueDeltas(rollback);
      throw e1;
    }

    const { error: e2 } = await sb.from("vendas").delete().eq("id", vid);
    if (e2) {
      // rollback estoque
      const rollback = new Map();
      for (const [k, v] of oldMap.entries()) rollback.set(k, -v);
      await applyEstoqueDeltas(rollback);
      throw e2;
    }

    if (state.editVendaId === vid) cancelarEdicaoVenda();

    await reloadHistoricoVendas();
    showToast("Venda excluída (estoque devolvido).", "success");
  } catch (e) {
    console.error(e);
    showToast(e?.message || "Erro ao excluir venda.", "error");
  }
}

/* =========================
   EDITAR VENDA
========================= */
function setModoEdicaoVenda(on) {
  const titulo = document.getElementById("vTitulo");
  const sub = document.getElementById("vSub");
  const btn = document.getElementById("btnSalvarVenda");
  const btnCancel = document.getElementById("btnCancelarVendaEdicao");

  if (!titulo || !sub || !btn || !btnCancel) return;

  if (on) {
    titulo.textContent = "Editar Venda";
    sub.textContent = "Você está editando uma venda existente. Ao salvar, o estoque será ajustado automaticamente.";
    btn.textContent = "Atualizar venda";
    btnCancel.style.display = "inline-flex";
  } else {
    titulo.textContent = "Nova Venda";
    sub.textContent = "Registre uma venda e dê baixa automática no estoque.";
    btn.textContent = "Salvar venda";
    btnCancel.style.display = "none";
  }
}

async function editarVenda(vendaId) {
  const vid = normId(vendaId);
  try {
    const venda = (state.historico || []).find((x) => normId(x.venda_id) === vid);
    if (!venda) return showToast("Venda não encontrada.", "error");

    const itens = await loadVendaItens(vid);

    state.editVendaId = vid;
    setModoEdicaoVenda(true);

    const d = new Date(venda.data);
    const isoLocal = Number.isNaN(d.getTime())
      ? ""
      : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    document.getElementById("vData").value = isoLocal;
    document.getElementById("vForma").value = venda.forma;
    document.getElementById("vCliente").value = venda.cliente_nome || "";
    document.getElementById("vTelefone").value = venda.cliente_telefone || "";
    document.getElementById("vDesconto").value = String(Number(venda.desconto_valor || 0)).replace(".", ",");
    document.getElementById("vObs").value = venda.observacoes || "";

    state.itens = (itens || []).map((i) => ({
      variacao_id: normId(i.variacao_id),
      produto_nome: i.produto,
      produto_codigo: i.codigo_produto,
      cor: i.cor,
      tamanho: i.tamanho,
      qtd: Number(i.quantidade || 1),
      preco_unit: Number(i.preco_unit || 0),
    }));

    renderItensVenda();
    showToast("Venda carregada para edição.", "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao abrir venda para edição.", "error");
  }
}

function cancelarEdicaoVenda() {
  state.editVendaId = null;
  state.itens = [];
  setModoEdicaoVenda(false);
  renderItensVenda();

  setDefaultDateTimeNow();
  document.getElementById("vCliente").value = "";
  document.getElementById("vTelefone").value = "";
  document.getElementById("vDesconto").value = "0,00";
  document.getElementById("vObs").value = "";
  showToast("Edição cancelada.", "success");
}

/* =========================
   BIND / NOVA VENDA
========================= */
function setDefaultDateTimeNow() {
  const d = new Date();
  const isoLocal = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  document.getElementById("vData").value = isoLocal;
}

function iniciarNovaVenda() {
  state.editVendaId = null;
  setModoEdicaoVenda(false);

  state.itens = [];
  renderItensVenda();

  clearVendaItemFields(false);

  setDefaultDateTimeNow();
  document.getElementById("vCliente").value = "";
  document.getElementById("vTelefone").value = "";
  document.getElementById("vDesconto").value = "0,00";
  document.getElementById("vObs").value = "";

  showToast("Nova venda iniciada.", "success");
  document.getElementById("vProdSearch")?.focus();
}

// evita bind duplicado
function bindVendas() {
  if (window.__vendasBound) return;
  window.__vendasBound = true;

  setDefaultDateTimeNow();

  // enum formas
  const selForma = document.getElementById("vForma");
  selForma.innerHTML = (state.formas || []).map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join("");

  document.getElementById("hVendaFiltro")?.addEventListener("input", (e) => {
    renderHistoricoVendasTable(e.target.value);
  });

  // autocomplete produto
  const inp = document.getElementById("vProdSearch");
  inp?.addEventListener("input", () => {
    const q = (inp.value || "").trim().toLowerCase();
    if (!q || q.length < 2) return showProdList([]);
    const items = (state.produtos || []).filter(
      (p) => (p.nome || "").toLowerCase().includes(q) || (p.codigo || "").toLowerCase().includes(q)
    );
    showProdList(items);
  });

  // fecha dropdown clicando fora
  document.addEventListener("click", (e) => {
    const box = document.getElementById("vProdList");
    const wrap = document.getElementById("vProdSearch");
    if (box && wrap && !box.contains(e.target) && e.target !== wrap) box.style.display = "none";
  });

  // cor -> tamanhos
  document.getElementById("vCor")?.addEventListener("change", onCorChange);

  // add item
  document.getElementById("btnAddVendaItem")?.addEventListener("click", () => {
    const msg = document.getElementById("vMsg");
    if (msg) msg.textContent = "";

    if (!selectedProduto) return (msg.textContent = "Selecione um produto.");

    const cor = document.getElementById("vCor").value;
    const variacaoId = normId(document.getElementById("vTam").value);
    const tamanhoText = document.getElementById("vTam").selectedOptions?.[0]?.textContent || "";
    const tamanho = String(tamanhoText).split(" (estoque:")[0].trim();
    const qtd = Math.max(1, Number(document.getElementById("vQtd").value || 1));
    const preco = parseNumberBR(document.getElementById("vPreco").value);

    if (!cor) return (msg.textContent = "Selecione a cor.");
    if (!variacaoId) return (msg.textContent = "Selecione o tamanho.");
    if (!preco || preco <= 0) return (msg.textContent = "Preço inválido.");

    const precoFix = Number(preco.toFixed(2));

    const existing = state.itens.find((x) => normId(x.variacao_id) === variacaoId && Number(x.preco_unit) === precoFix);
    if (existing) existing.qtd += qtd;
    else {
      state.itens.push({
        variacao_id: variacaoId,
        produto_nome: selectedProduto.nome,
        produto_codigo: selectedProduto.codigo,
        cor,
        tamanho,
        qtd,
        preco_unit: precoFix,
      });
    }

    renderItensVenda();
    clearVendaItemFields(true);
  });

  document.getElementById("btnLimparVendaItem")?.addEventListener("click", () => {
    clearVendaItemFields(true);
  });

  document.getElementById("btnCancelarVendaEdicao")?.addEventListener("click", cancelarEdicaoVenda);
  document.getElementById("vDesconto")?.addEventListener("input", () => updateResumoOnly());

  // salvar venda (cabeçalho + itens + estoque)
  document.getElementById("btnSalvarVenda")?.addEventListener("click", async () => {
    const msg = document.getElementById("vMsg");
    if (msg) msg.textContent = "";

    if (!state.itens.length) return (msg.textContent = "Adicione pelo menos 1 item.");

    const dataLocal = document.getElementById("vData").value;
    if (!dataLocal) return (msg.textContent = "Informe a data/hora.");

    const forma = document.getElementById("vForma").value;
    if (!forma) return (msg.textContent = "Selecione a forma.");

    // pega itens antigos (se edição)
    let oldItens = [];
    try {
      if (state.editVendaId) oldItens = await loadVendaItens(state.editVendaId);
    } catch (e) {
      console.error(e);
      return (msg.textContent = "Erro ao carregar itens antigos da venda.");
    }

    // valida estoque
    try {
      const newMap = buildQtyMapFromStateItens();
      const oldMap = buildQtyMapFromVendaItensRows(oldItens);

      const ids = Array.from(new Set([...newMap.keys(), ...oldMap.keys()]));
      const estoqueMap = await loadEstoquePorVariacoes(ids);

      for (const [variacaoId, qtdNova] of newMap.entries()) {
        const emEstoque = estoqueMap.get(variacaoId) ?? 0;
        const devolvendo = oldMap.get(variacaoId) ?? 0; // só na edição funciona
        const disponivel = emEstoque + devolvendo;

        if (disponivel < qtdNova) {
          throw new Error(
            `Estoque insuficiente. Disponível=${disponivel} (estoque=${emEstoque} + devolução=${devolvendo}) / Tentando=${qtdNova}`
          );
        }
      }
    } catch (e) {
      console.error(e);
      msg.textContent = e?.message || "Estoque insuficiente.";
      return;
    }

    const { subtotal, desconto, total } = calcResumoVenda();

    const payload = {
      data: isoFromDatetimeLocal(dataLocal),
      forma,
      cliente_nome: document.getElementById("vCliente").value.trim() || null,
      cliente_telefone: document.getElementById("vTelefone").value.trim() || null,
      desconto_valor: Number(desconto.toFixed(2)),
      subtotal: Number(subtotal.toFixed(2)),
      total: Number(total.toFixed(2)),
      observacoes: document.getElementById("vObs").value.trim() || null,
    };

    msg.textContent = state.editVendaId ? "Atualizando venda..." : "Salvando venda...";

    // delta estoque (devolve old, baixa new)
    const deltaMap = new Map();
    const oldMap2 = buildQtyMapFromVendaItensRows(oldItens);
    const newMap2 = buildQtyMapFromStateItens();

    for (const [vid, qtdOld] of oldMap2.entries()) deltaMap.set(vid, (deltaMap.get(vid) || 0) + qtdOld);
    for (const [vid, qtdNew] of newMap2.entries()) deltaMap.set(vid, (deltaMap.get(vid) || 0) - qtdNew);

    try {
      // 1) salva/atualiza cabeçalho
      const vendaId = await salvarVendaRPC(payload, state.editVendaId);

      // 2) ajusta estoque (se der ruim, não grava itens)
      await applyEstoqueDeltas(deltaMap);

      // 3) grava itens
      await salvarItensVenda(vendaId);

      // reset UI
      state.itens = [];
      renderItensVenda();
      clearVendaItemFields(false);

      state.editVendaId = null;
      setModoEdicaoVenda(false);

      setDefaultDateTimeNow();
      document.getElementById("vCliente").value = "";
      document.getElementById("vTelefone").value = "";
      document.getElementById("vDesconto").value = "0,00";
      document.getElementById("vObs").value = "";

      await reloadHistoricoVendas();
      msg.textContent = `OK ✅ Total: ${money(total)}`;
      setTimeout(() => (msg.textContent = ""), 1200);
    } catch (e) {
      console.error(e);

      // rollback estoque (melhor tentativa)
      try {
        const rollback = new Map();
        for (const [k, v] of deltaMap.entries()) rollback.set(k, -v);
        await applyEstoqueDeltas(rollback);
      } catch (rb) {
        console.error("Rollback estoque falhou:", rb);
      }

      msg.textContent = e?.message || "Erro ao salvar venda.";
    }
  });

  // botão global do topo "+ Nova Venda"
  const btnNovaVendaTop = document.getElementById("btnNovaVenda");
  if (btnNovaVendaTop && !btnNovaVendaTop.__bound) {
    btnNovaVendaTop.__bound = true;
    btnNovaVendaTop.addEventListener("click", (e) => {
      e.preventDefault();
      if (!location.hash.includes("vendas")) {
        location.hash = "#vendas";
        setTimeout(() => iniciarNovaVenda(), 250);
      } else {
        iniciarNovaVenda();
      }
    });
  }
}

/* =========================
   MODAL ITENS (EDITAR VENDA)
========================= */
function ensureModal() {
  if (document.getElementById("modalVendaItens")) return;

  const div = document.createElement("div");
  div.id = "modalVendaItens";
  div.style.cssText = `
    position: fixed; inset: 0; background: rgba(0,0,0,.55);
    display:none; align-items:center; justify-content:center;
    padding: 16px; z-index: 9999;
  `;

  div.innerHTML = `
    <div style="width:min(980px, 98vw); background:#0f172a; border:1px solid rgba(255,255,255,.12);
                border-radius:16px; padding:16px; box-shadow:0 20px 60px rgba(0,0,0,.5);">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <div>
          <div style="font-weight:800; font-size:16px;">Itens da venda</div>
          <div class="small" id="modalVendaItensInfo" style="margin-top:2px;">—</div>
        </div>
        <button class="btn" id="btnFecharModalVendaItens">Fechar</button>
      </div>

      <div class="hr" style="margin:12px 0;"></div>

      <div id="modalVendaItensBody" class="small">Carregando...</div>

      <div class="hr" style="margin:12px 0;"></div>

      <div style="display:flex; justify-content:flex-end; gap:10px; flex-wrap:wrap;">
        <button class="btn primary" id="btnSalvarModalVendaItens">Salvar alterações</button>
      </div>
    </div>
  `;

  div.addEventListener("click", (e) => {
    if (e.target === div) closeModalItens();
  });

  document.body.appendChild(div);

  document.getElementById("btnFecharModalVendaItens").addEventListener("click", closeModalItens);
}

function openModalItens() {
  ensureModal();
  document.getElementById("modalVendaItens").style.display = "flex";
}

function closeModalItens() {
  const m = document.getElementById("modalVendaItens");
  if (m) m.style.display = "none";
}

async function abrirModalItensVenda(vendaId) {
  const vid = normId(vendaId);
  openModalItens();

  const info = document.getElementById("modalVendaItensInfo");
  const body = document.getElementById("modalVendaItensBody");
  const btnSalvar = document.getElementById("btnSalvarModalVendaItens");

  info.textContent = `Venda: ${vid}`;
  body.textContent = "Carregando itens...";

  // carrega itens originais
  let itens = [];
  try {
    itens = await loadVendaItens(vid);
  } catch (e) {
    console.error(e);
    body.textContent = "Erro ao carregar itens.";
    return;
  }

  if (!itens.length) {
    body.textContent = "Nenhum item nessa venda.";
    return;
  }

  const original = itens.map((i) => ({
    venda_item_id: normId(i.venda_item_id),
    variacao_id: normId(i.variacao_id),
    produto: i.produto,
    codigo_produto: i.codigo_produto,
    cor: i.cor,
    tamanho: i.tamanho,
    quantidade: Number(i.quantidade || 1),
    preco_unit: Number(i.preco_unit || 0),
  }));

  // snapshot editável
  const edit = original.map((x) => ({ ...x }));

  const render = () => {
    body.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Cor</th>
              <th>Tam</th>
              <th style="width:110px;">Qtd</th>
              <th style="width:140px;">Preço</th>
              <th>Total</th>
              <th style="width:140px;">Ações</th>
            </tr>
          </thead>
          <tbody>
            ${edit.map((it, idx) => {
              const total = it.quantidade * it.preco_unit;
              return `
                <tr>
                  <td>${escapeHtml(it.produto)} <span class="small">(${escapeHtml(it.codigo_produto || "")})</span></td>
                  <td>${escapeHtml(it.cor || "-")}</td>
                  <td>${escapeHtml(it.tamanho || "-")}</td>

                  <td>
                    <input class="input" data-mqtd="${idx}" type="number" min="1" step="1"
                      value="${it.quantidade}" style="width:90px; padding:8px;" />
                  </td>

                  <td>
                    <input class="input" data-mpreco="${idx}" type="text"
                      value="${String(it.preco_unit).replace(".", ",")}" style="width:120px; padding:8px;" />
                  </td>

                  <td>${money(total)}</td>

                  <td style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button class="btn danger" data-mdel="${idx}">Remover</button>
                  </td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="small" style="margin-top:10px;">
        Ajuste quantidade e preço. Depois clique em <b>Salvar alterações</b>.
      </div>
    `;

    body.querySelectorAll("input[data-mqtd]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const idx = Number(inp.dataset.mqtd);
        edit[idx].quantidade = Math.max(1, Number(inp.value || 1));
        render();
      });
    });

    body.querySelectorAll("input[data-mpreco]").forEach((inp) => {
      inp.addEventListener("blur", () => {
        const idx = Number(inp.dataset.mpreco);
        const v = parseNumberBR(inp.value);
        edit[idx].preco_unit = Math.max(0, Number(v.toFixed(2)));
        render();
      });
    });

    body.querySelectorAll("button[data-mdel]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.mdel);
        edit.splice(idx, 1);
        if (!edit.length) body.textContent = "Nenhum item nessa venda.";
        else render();
      });
    });
  };

  render();

  btnSalvar.onclick = async () => {
    try {
      if (!edit.length) {
        showToast("A venda ficará sem itens. Se quiser, exclua a venda.", "error");
        return;
      }

      // valida estoque considerando devolução (original)
      const newMap = new Map();
      for (const it of edit) {
        const vid2 = normId(it.variacao_id);
        newMap.set(vid2, (newMap.get(vid2) || 0) + Number(it.quantidade || 0));
      }

      const oldMap = new Map();
      for (const it of original) {
        const vid2 = normId(it.variacao_id);
        oldMap.set(vid2, (oldMap.get(vid2) || 0) + Number(it.quantidade || 0));
      }

      const ids = Array.from(new Set([...newMap.keys(), ...oldMap.keys()]));
      const estoqueMap = await loadEstoquePorVariacoes(ids);

      for (const [variacaoId, qtdNova] of newMap.entries()) {
        const emEstoque = estoqueMap.get(variacaoId) ?? 0;
        const devolvendo = oldMap.get(variacaoId) ?? 0;
        const disponivel = emEstoque + devolvendo;
        if (disponivel < qtdNova) {
          throw new Error(`Estoque insuficiente p/ editar. Disp=${disponivel} / Tentando=${qtdNova}`);
        }
      }

      // delta estoque: devolve original e baixa novo
      const deltaMap = new Map();
      for (const [k, v] of oldMap.entries()) deltaMap.set(k, (deltaMap.get(k) || 0) + v);
      for (const [k, v] of newMap.entries()) deltaMap.set(k, (deltaMap.get(k) || 0) - v);

      // aplica delta primeiro (se falhar, não mexe na venda_itens)
      await applyEstoqueDeltas(deltaMap);

      // regrava venda_itens (simples e consistente)
      const { error: delErr } = await sb.from("venda_itens").delete().eq("venda_id", vid);
      if (delErr) {
        // rollback estoque
        const rollback = new Map();
        for (const [k, v] of deltaMap.entries()) rollback.set(k, -v);
        await applyEstoqueDeltas(rollback);
        throw delErr;
      }

      const insertRows = edit.map((it) => {
        const qtd = Number(it.quantidade || 0);
        const preco = Number(it.preco_unit || 0);
        return {
          venda_id: vid,
          variacao_id: normId(it.variacao_id),
          quantidade: qtd,
          preco_unit_aplicado: preco,
          subtotal: Number((qtd * preco).toFixed(2)),
        };
      });

      const { error: insErr } = await sb.from("venda_itens").insert(insertRows);
      if (insErr) {
        // rollback estoque
        const rollback = new Map();
        for (const [k, v] of deltaMap.entries()) rollback.set(k, -v);
        await applyEstoqueDeltas(rollback);
        throw insErr;
      }

      showToast("Itens atualizados (estoque ajustado).", "success");
      await reloadHistoricoVendas();

      // se a venda estiver aberta na esquerda, sincroniza
      if (state.editVendaId === vid) {
        const itensFresh = await loadVendaItens(vid);
        state.itens = itensFresh.map((i) => ({
          variacao_id: normId(i.variacao_id),
          produto_nome: i.produto,
          produto_codigo: i.codigo_produto,
          cor: i.cor,
          tamanho: i.tamanho,
          qtd: Number(i.quantidade || 1),
          preco_unit: Number(i.preco_unit || 0),
        }));
        renderItensVenda();
      }

      closeModalItens();
    } catch (e) {
      console.error(e);
      showToast(e.message || "Erro ao salvar alterações.", "error");
    }
  };
}

window.abrirModalItensVenda = abrirModalItensVenda;

/* =========================
   EXPORT
========================= */
export async function renderVendas() {
  try {
    window.__vendasBound = false;

    const html = renderVendasLayout();

    setTimeout(async () => {
      try {
        state.formas = await loadFormasEnum();
        state.produtos = await loadProdutosDoEstoque();

        bindVendas();
        await reloadHistoricoVendas();
      } catch (e) {
        console.error(e);
        showToast(e?.message || "Erro ao iniciar Vendas.", "error");
      }
    }, 0);

    return html;
  } catch (e) {
    console.error(e);
    return `
      <div class="card">
        <div class="card-title">Vendas</div>
        <div class="card-sub">Erro ao carregar esta tela. Veja o Console (F12).</div>
      </div>
    `;
  }
}
