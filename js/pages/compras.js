import { sb } from "../supabase.js";

const SIZES_CAMISA = ["P", "M", "G", "GG", "XG", "LG"];
const SIZES_NUM = ["36", "38", "40", "42", "44", "46", "50"];

const state = {
  produtos: [],              // {id, nome, codigo, categoria_id, categoria_nome, grade_id, grade_nome}
  produtoCores: new Map(),   // produto_id -> ["Azul", "Preto"...]
  itens: [],                 // itens da compra (carrinho)
};

function escapeHtml(s = "") {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
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

function opt(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

/* =========================
   LOADERS
========================= */

async function loadProdutosComGrade() {
  // puxa produto + categoria + grade
  // ajuste o select conforme seu schema real
  const { data, error } = await sb
    .from("produtos")
    .select(`
      id, nome, codigo, ativo, categoria_id,
      categorias (
        id, nome, grade_id,
        grades ( id, nome )
      )
    `)
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw error;

  return (data || []).map(p => {
    const cat = p.categorias || {};
    const grd = cat.grades || {};
    return {
      id: p.id,
      nome: p.nome,
      codigo: p.codigo,
      categoria_id: p.categoria_id,
      categoria_nome: cat.nome || "-",
      grade_id: cat.grade_id || null,
      grade_nome: grd.nome || "",
    };
  });
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

  const cores = (data || []).map(x => x.cor).filter(Boolean);
  state.produtoCores.set(produtoId, cores);
  return cores;
}

/* =========================
   HELPERS (GRADE -> TAMANHOS)
========================= */

function getTamanhosByGradeNome(gradeNome = "") {
  const g = gradeNome.toLowerCase();
  if (g.includes("num")) return SIZES_NUM;
  // padrão: camisa
  return SIZES_CAMISA;
}

/* =========================
   UI
========================= */

function renderCompras() {
  return `
    <div class="row2">
      <div class="card">
        <div class="card-title">Nova Compra</div>
        <div class="card-sub">Registre entradas no estoque e custos. Você pode adicionar vários itens no mesmo lançamento.</div>

        <div class="grid grid-2" style="margin-top:12px; gap:10px;">
          <div class="field">
            <label>Data</label>
            <input class="input" id="cData" type="date" />
          </div>
          <div class="field">
            <label>Fornecedor (opcional)</label>
            <input class="input" id="cFornecedor" placeholder="Ex: Fábrica X / Sacoleira Y" />
          </div>
        </div>

        <div class="hr"></div>

        <div class="card-title" style="font-size:14px;">Item da compra</div>

        <div class="grid" style="grid-template-columns: 1.2fr 0.7fr; gap:10px; margin-top:10px;">
          <div class="field">
            <label>Produto (buscar)</label>
            <input class="input" id="cProdSearch" placeholder="Digite nome ou código..." autocomplete="off" />
            <div class="small" style="margin-top:6px;" id="cProdHint">Selecione um produto da lista.</div>
            <div id="cProdList" class="dropdown" style="display:none;"></div>
          </div>

          <div class="field">
            <label>Categoria</label>
            <input class="input" id="cCategoriaView" disabled />
          </div>
        </div>

        <div class="grid grid-3" style="gap:10px; margin-top:10px;">
          <div class="field">
            <label>Cor</label>
            <select class="select" id="cCor" disabled>
              <option value="">Selecione o produto</option>
            </select>
          </div>

          <div class="field">
            <label>Tamanho</label>
            <select class="select" id="cTam" disabled>
              <option value="">Selecione o produto</option>
            </select>
          </div>

          <div class="field">
            <label>Quantidade</label>
            <input class="input" id="cQtd" type="number" min="1" step="1" value="1" disabled />
          </div>
        </div>

        <div class="hr"></div>

        <div class="grid grid-2" style="gap:10px;">
          <div class="field">
            <label>Modo de custo</label>
            <select class="select" id="cModo" disabled>
              <option value="unit">Valor unitário</option>
              <option value="lote">Valor total do lote</option>
            </select>
            <div class="small" id="cModoHelp" style="margin-top:6px;">
              Informe o custo unitário por peça.
            </div>
          </div>

          <div class="field">
            <label id="cValorLabel">Valor unitário (R$)</label>
            <input class="input" id="cValor" placeholder="Ex: 39,90" disabled />
            <div class="small" id="cCalcInfo" style="margin-top:6px;"></div>
          </div>
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn primary" id="btnAddItem" disabled>Adicionar item</button>
          <button class="btn" id="btnLimparItem" disabled>Limpar campos</button>
        </div>

        <div class="small" id="cMsg" style="margin-top:12px;"></div>

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
                <th>Custo Unit.</th>
                <th>Total</th>
                <th style="width:110px;">Ações</th>
              </tr>
            </thead>
            <tbody id="cItensTbody">
              <tr><td colspan="7" class="small">Nenhum item ainda.</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top:12px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div class="small" id="cResumo"></div>
          <button class="btn primary" id="btnSalvarCompra" disabled>Salvar compra</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Histórico (em breve)</div>
        <div class="card-sub">Depois que salvarmos compras, vamos listar aqui com filtro por período e detalhes.</div>
        <div class="small" style="margin-top:10px;">(Vamos fazer após fechar o fluxo de salvar compra + atualizar estoque.)</div>
      </div>
    </div>
  `;
}

/* =========================
   DROPDOWN PRODUTOS (BUSCA)
========================= */

let selectedProduto = null;

function showProdList(items) {
  const box = document.getElementById("cProdList");
  if (!items.length) {
    box.style.display = "none";
    box.innerHTML = "";
    return;
  }
  box.style.display = "block";
  box.innerHTML = items.slice(0, 10).map(p => `
    <div class="dropdown-item" data-id="${p.id}">
      <div style="font-weight:700;">${escapeHtml(p.nome)}</div>
      <div class="small">${escapeHtml(p.codigo)} • ${escapeHtml(p.categoria_nome)} ${p.grade_nome ? "• " + escapeHtml(p.grade_nome) : ""}</div>
    </div>
  `).join("");

  box.querySelectorAll(".dropdown-item").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.id;
      const p = state.produtos.find(x => x.id === id);
      if (p) selectProduto(p);
      box.style.display = "none";
    });
  });
}

async function selectProduto(p) {
  selectedProduto = p;

  document.getElementById("cProdSearch").value = `${p.nome} (${p.codigo})`;
  document.getElementById("cCategoriaView").value = p.categoria_nome || "-";

  // habilita campos
  document.getElementById("cCor").disabled = false;
  document.getElementById("cTam").disabled = false;
  document.getElementById("cQtd").disabled = false;
  document.getElementById("cModo").disabled = false;
  document.getElementById("cValor").disabled = false;
  document.getElementById("btnAddItem").disabled = false;
  document.getElementById("btnLimparItem").disabled = false;

  // carrega cores do produto
  const cores = await loadCoresDoProduto(p.id);
  const corSel = document.getElementById("cCor");
  corSel.innerHTML = `<option value="">Selecione</option>` + cores.map(c => opt(c, c)).join("");

  // tamanhos conforme grade
  const tamanhos = getTamanhosByGradeNome(p.grade_nome || "");
  const tamSel = document.getElementById("cTam");
  tamSel.innerHTML = `<option value="">Selecione</option>` + tamanhos.map(t => opt(t, t)).join("");

  updateModoUI();
}

function clearItemFields(keepProduto = true) {
  document.getElementById("cMsg").textContent = "";
  document.getElementById("cCalcInfo").textContent = "";

  if (!keepProduto) {
    selectedProduto = null;
    document.getElementById("cProdSearch").value = "";
    document.getElementById("cCategoriaView").value = "";
    document.getElementById("cCor").innerHTML = `<option value="">Selecione o produto</option>`;
    document.getElementById("cTam").innerHTML = `<option value="">Selecione o produto</option>`;
    document.getElementById("cCor").disabled = true;
    document.getElementById("cTam").disabled = true;
    document.getElementById("cQtd").disabled = true;
    document.getElementById("cModo").disabled = true;
    document.getElementById("cValor").disabled = true;
    document.getElementById("btnAddItem").disabled = true;
    document.getElementById("btnLimparItem").disabled = true;
  } else {
    document.getElementById("cCor").value = "";
    document.getElementById("cTam").value = "";
    document.getElementById("cQtd").value = "1";
    document.getElementById("cValor").value = "";
  }
}

function updateModoUI() {
  const modo = document.getElementById("cModo").value;
  const label = document.getElementById("cValorLabel");
  const help = document.getElementById("cModoHelp");

  if (modo === "lote") {
    label.textContent = "Valor total do lote (R$)";
    help.textContent = "Você informa o total gasto no lote; o sistema calcula o custo unitário automaticamente.";
  } else {
    label.textContent = "Valor unitário (R$)";
    help.textContent = "Informe o custo unitário por peça.";
  }
  document.getElementById("cCalcInfo").textContent = "";
}

/* =========================
   ITENS + RESUMO
========================= */

function calcCustoUnitario(modo, valor, qtd) {
  const v = parseNumberBR(valor);
  const q = Math.max(1, Number(qtd || 1));
  if (modo === "lote") {
    const unit = v / q;
    return Number(unit.toFixed(2));
  }
  return Number(v.toFixed(2));
}

function renderItens() {
  const tbody = document.getElementById("cItensTbody");

  if (!state.itens.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="small">Nenhum item ainda.</td></tr>`;
    document.getElementById("btnSalvarCompra").disabled = true;
    document.getElementById("cResumo").textContent = "";
    return;
  }

  tbody.innerHTML = state.itens.map((it, idx) => {
    const total = it.qtd * it.custo_unit;
    return `
      <tr>
        <td>${escapeHtml(it.produto_nome)} <span class="small">(${escapeHtml(it.produto_codigo)})</span></td>
        <td>${escapeHtml(it.cor)}</td>
        <td>${escapeHtml(it.tamanho)}</td>
        <td>${it.qtd}</td>
        <td>${money(it.custo_unit)}</td>
        <td>${money(total)}</td>
        <td><button class="btn danger" data-rm="${idx}">Remover</button></td>
      </tr>
    `;
  }).join("");

  tbody.querySelectorAll("button[data-rm]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.rm);
      state.itens.splice(idx, 1);
      renderItens();
    });
  });

  const totalGeral = state.itens.reduce((s, it) => s + (it.qtd * it.custo_unit), 0);
  const totalPecas = state.itens.reduce((s, it) => s + it.qtd, 0);

  document.getElementById("cResumo").textContent =
    `Total de itens: ${totalPecas} • Total da compra: ${money(totalGeral)}`;

  document.getElementById("btnSalvarCompra").disabled = false;
}

/* =========================
   SALVAR COMPRA (placeholder)
========================= */

// ⚠️ Aqui você liga no seu schema.
// Eu deixei duas opções:
//
// A) Se você tiver tabelas "compras" + "compras_itens" e "estoque"
// B) Se você tiver uma RPC (recomendado) que já faz tudo: compra + itens + estoque

async function salvarCompraNoBanco(payload) {
  // ✅ OPÇÃO B (RECOMENDADO): RPC que registra compra e atualiza estoque
  // Ex: rpc("registrar_compra", { p_data, p_fornecedor, p_obs, p_itens })
  //
  // Se você AINDA não tem essa RPC, me fala que eu te mando o SQL certinho.

  const { data, error } = await sb.rpc("registrar_compra", {
    p_data: payload.data,
    p_fornecedor: payload.fornecedor || null,
    p_observacoes: payload.observacoes || null,
    p_itens: payload.itens
  });

  if (error) throw error;
  return data;
}

/* =========================
   BIND EVENTS
========================= */

function bind() {
  // data default hoje
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,"0");
  const dd = String(today.getDate()).padStart(2,"0");
  document.getElementById("cData").value = `${yyyy}-${mm}-${dd}`;

  // buscar produto
  const inp = document.getElementById("cProdSearch");
  inp.addEventListener("input", () => {
    const q = (inp.value || "").trim().toLowerCase();
    if (!q || q.length < 2) {
      showProdList([]);
      return;
    }
    const items = state.produtos.filter(p =>
      (p.nome || "").toLowerCase().includes(q) ||
      (p.codigo || "").toLowerCase().includes(q)
    );
    showProdList(items);
  });

  // fecha dropdown clicando fora
  document.addEventListener("click", (e) => {
    const box = document.getElementById("cProdList");
    const wrap = document.getElementById("cProdSearch");
    if (!box.contains(e.target) && e.target !== wrap) box.style.display = "none";
  });

  // modo custo
  document.getElementById("cModo").addEventListener("change", updateModoUI);

  // adicionar item
  document.getElementById("btnAddItem").addEventListener("click", () => {
    const msg = document.getElementById("cMsg");
    msg.textContent = "";
    msg.className = "small";

    if (!selectedProduto) return (msg.textContent = "Selecione um produto.");
    const cor = document.getElementById("cCor").value;
    const tam = document.getElementById("cTam").value;
    const qtd = Number(document.getElementById("cQtd").value || 0);
    const modo = document.getElementById("cModo").value;
    const valor = document.getElementById("cValor").value;

    if (!cor) return (msg.textContent = "Selecione a cor.");
    if (!tam) return (msg.textContent = "Selecione o tamanho.");
    if (!qtd || qtd < 1) return (msg.textContent = "Quantidade inválida.");
    if (!valor.trim()) return (msg.textContent = "Informe o valor.");

    const custoUnit = calcCustoUnitario(modo, valor, qtd);

    if (!custoUnit || custoUnit <= 0) return (msg.textContent = "Valor inválido.");

    // info cálculo no modo lote
    const calcInfo = document.getElementById("cCalcInfo");
    if (modo === "lote") {
      calcInfo.textContent = `Custo unitário calculado: ${money(custoUnit)} (total ÷ qtd)`;
    } else {
      calcInfo.textContent = "";
    }

    state.itens.push({
      produto_id: selectedProduto.id,
      produto_nome: selectedProduto.nome,
      produto_codigo: selectedProduto.codigo,
      categoria_id: selectedProduto.categoria_id,
      cor,
      tamanho: tam,
      qtd,
      custo_unit: custoUnit,
      // se quiser guardar "modo" e "valor_digitado", dá pra salvar também
    });

    renderItens();
    clearItemFields(true);
  });

  document.getElementById("btnLimparItem").addEventListener("click", () => {
    clearItemFields(true);
  });

  // salvar compra
  document.getElementById("btnSalvarCompra").addEventListener("click", async () => {
    const msg = document.getElementById("cMsg");
    msg.textContent = "";
    msg.className = "small";

    if (!state.itens.length) return (msg.textContent = "Adicione pelo menos 1 item.");

    const data = document.getElementById("cData").value;
    if (!data) return (msg.textContent = "Informe a data.");

    const fornecedor = document.getElementById("cFornecedor").value.trim();

    // payload para RPC
    const payload = {
      data,
      fornecedor,
      observacoes: null,
      itens: state.itens.map(it => ({
        produto_id: it.produto_id,
        cor: it.cor,
        tamanho: it.tamanho,
        qtd: it.qtd,
        custo_unit: it.custo_unit
      }))
    };

    msg.textContent = "Salvando compra...";
    try {
      await salvarCompraNoBanco(payload);

      // sem pop-up. só feedback leve e reset
      msg.textContent = "Compra salva. Estoque atualizado.";
      msg.className = "small";
      state.itens = [];
      renderItens();
      clearItemFields(false);

      setTimeout(() => { msg.textContent = ""; }, 1200);

    } catch (e) {
      console.error(e);
      msg.textContent = e?.message || "Erro ao salvar compra.";
      msg.className = "small";
    }
  });
}

/* =========================
   EXPORT RENDER
========================= */

export async function renderCompras() {
  try {
    const html = renderCompras();

    setTimeout(async () => {
      try {
        state.produtos = await loadProdutosComGrade();
        bind();
      } catch (e) {
        console.error(e);
        const msg = document.getElementById("cMsg");
        if (msg) msg.textContent = e?.message || "Erro ao iniciar Compras.";
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
