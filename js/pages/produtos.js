import { sb } from "../supabase.js";

const state = {
  categorias: [],
  grades: [],
  produtos: [],
  editingId: null,
  selectedProdutoId: null,
  cores: [],
};

function opt(value, label) {
  return `<option value="${value}">${label}</option>`;
}

function escapeHtml(s="") {
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/* =========================
   LOADERS
========================= */
async function loadGrades() {
  const { data, error } = await sb
    .from("grades")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) throw error;

  return (data || [])
    .filter(g => g.ativo !== false)
    .map(g => ({
      id: g.id,
      nome: g.nome ?? g.descricao ?? g.titulo ?? g.tipo ?? g.label ?? "Grade"
    }));
}


async function loadCategorias() {
  const { data, error } = await sb
    .from("categorias")
    .select("id,nome,grade_id,ativo")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadProdutos(search="") {
  let q = sb
    .from("produtos")
    .select("id,codigo,nome,ativo,categoria_id,categorias(nome)")
    .order("nome", { ascending: true });

  if (search?.trim()) {
    const s = search.trim();
    q = q.or(`nome.ilike.%${s}%,codigo.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) throw error;

  return (data || []).map(p => ({
    id: p.id,
    codigo: p.codigo,
    nome: p.nome,
    ativo: p.ativo,
    categoria_id: p.categoria_id,
    categoria_nome: p.categorias?.nome || "-",
  }));
}

/* =========================
   PRODUTOS CRUD
========================= */
async function saveProduto({ id, codigo, nome, categoria_id, ativo=true }) {
  const payload = { codigo, nome, categoria_id, ativo };
  if (id) {
    const { error } = await sb.from("produtos").update(payload).eq("id", id);
    if (error) throw error;
    return id;
  } else {
    const { data, error } = await sb.from("produtos").insert([payload]).select("id").single();
    if (error) throw error;
    return data.id;
  }
}

async function toggleProdutoAtivo(id, ativo) {
  const { error } = await sb.from("produtos").update({ ativo }).eq("id", id);
  if (error) throw error;
}

/* =========================
   CATEGORIAS (Add)
========================= */
async function addCategoria(nome, grade_id) {
  const payload = { nome: nome.trim(), grade_id };

  const { data, error } = await sb
    .from("categorias")
    .insert([payload])
    .select("id,nome,grade_id")
    .single();

  if (!error) return data;

  // Se já existir (duplicado), busca e retorna a existente
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("duplicate") || msg.includes("unique")) {
    const { data: exist, error: err2 } = await sb
      .from("categorias")
      .select("id,nome,grade_id")
      .ilike("nome", payload.nome)
      .limit(1)
      .maybeSingle();

    if (err2) throw err2;
    if (exist) return exist;
  }

  throw error;
}


/* =========================
   CORES
========================= */
async function loadCores(produtoId) {
  if (!produtoId) return [];
  const { data, error } = await sb
    .from("produto_cores")
    .select("id,cor")
    .eq("produto_id", produtoId)
    .order("cor", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function addCor(produtoId, cor) {
  const c = cor.trim();
  if (!c) return;
  const { error } = await sb.from("produto_cores").insert([{ produto_id: produtoId, cor: c }]);
  if (error) throw error;
}

async function removeCor(corId) {
  const { error } = await sb.from("produto_cores").delete().eq("id", corId);
  if (error) throw error;
}

/* =========================
   UI RENDER
========================= */
function renderListaProdutos() {
  return `
    <div class="card">
      <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; flex-wrap:wrap;">
        <div>
          <div class="card-title">Produtos cadastrados</div>
          <div class="card-sub">Clique para editar e gerenciar as cores.</div>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <input class="input" id="pSearch" placeholder="Buscar por nome ou código..." style="min-width:260px;">
          <button class="btn" id="btnPSearch">Buscar</button>
        </div>
      </div>

      <div class="table-wrap" style="margin-top:12px;">
        <table class="table">
          <thead>
            <tr>
              <th>Produto</th>
              <th>Código</th>
              <th>Categoria</th>
              <th>Status</th>
              <th style="width:160px;">Ações</th>
            </tr>
          </thead>
          <tbody id="pTbody">
            <tr><td colspan="5" class="small">Carregando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderFormProduto() {
  const catOptions = state.categorias.map(c => opt(c.id, c.nome)).join("");

  return `
    <div class="card">
      <div class="card-title">${state.editingId ? "Editar Produto" : "Novo Produto"}</div>
      <div class="card-sub">Cadastre o item. Depois, defina as cores disponíveis.</div>

      <div style="margin-top:12px;" class="field">
        <label>Nome do produto</label>
        <input class="input" id="fNome" placeholder="Ex: Camiseta Palmeiras" />
      </div>

      <div style="margin-top:10px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
        <div class="field">
          <label>Código</label>
          <input class="input" id="fCodigo" placeholder="Ex: PAL-001" />
        </div>

        <div class="field">
          <label>Categoria</label>
          <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
            <select class="select" id="fCategoria" style="flex:1;">
              <option value="">Selecione</option>
              ${catOptions}
            </select>
            <button class="btn" id="btnAddCategoria" title="Adicionar categoria" style="white-space:nowrap;">
  + Add Categoria
</button>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button class="btn primary" id="btnSalvarProduto">Salvar</button>
        <button class="btn" id="btnNovoProduto">Novo</button>
        <button class="btn danger" id="btnDesativarProduto" style="display:none;">Desativar</button>
        <button class="btn" id="btnAtivarProduto" style="display:none;">Ativar</button>
      </div>

      <div class="hr"></div>

      <div class="card-title" style="font-size:14px;">Cores do produto</div>
      <div class="card-sub">Essas cores vão aparecer na aba Compras quando você selecionar este produto.</div>

      <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <input class="input" id="fCor" placeholder="Ex: Verde, Preto, Azul..." style="min-width:240px;" ${state.selectedProdutoId ? "" : "disabled"} />
        <button class="btn" id="btnAddCor" ${state.selectedProdutoId ? "" : "disabled"}>Adicionar cor</button>
      </div>

      <div class="chips" id="chipsCores" style="margin-top:10px;">
        ${state.selectedProdutoId ? `<span class="small">Carregando cores...</span>` : `<span class="small">Salve um produto para liberar as cores.</span>`}
      </div>
    </div>

    <!-- MINI MODAL: Add Categoria -->
    <div class="modal-overlay" id="catModal">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">Adicionar Categoria</div>
          <button class="icon-btn" id="catClose">✕</button>
        </div>

        <div class="field">
          <label>Nome da categoria</label>
          <input class="input" id="catNome" placeholder="Ex: Bermuda, Blusa, Calcinha..." />
        </div>

        <div class="field" style="margin-top:10px;">
          <label>Grade de tamanhos</label>
          <select class="select" id="catGrade">
            <option value="">Selecione a grade</option>
            ${state.grades.map(g => opt(g.id, g.nome)).join("")}
          </select>
          <div class="small" style="margin-top:6px;">
            Dica: “Grade Camisa” para P/M/G… e “Grade Numérica” para 36–50.
          </div>
        </div>

        <div class="inline-actions">
          <button class="btn" id="catCancelar">Cancelar</button>
          <button class="btn primary" id="catSalvar">Concluído</button>
        </div>

        <div class="small" id="catMsg" style="margin-top:10px;"></div>
      </div>
    </div>
  `;
}

function renderProdutoRow(p) {
  const status = p.ativo
    ? `<span class="badge ok">● Ativo</span>`
    : `<span class="badge low">● Inativo</span>`;

  return `
    <tr data-id="${p.id}" style="cursor:pointer;">
      <td>${escapeHtml(p.nome)}</td>
      <td>${escapeHtml(p.codigo)}</td>
      <td>${escapeHtml(p.categoria_nome)}</td>
      <td>${status}</td>
      <td><button class="btn" data-action="editar" data-id="${p.id}">Editar</button></td>
    </tr>
  `;
}

function fillFormProduto(p) {
  state.editingId = p.id;
  state.selectedProdutoId = p.id;

  document.getElementById("fNome").value = p.nome || "";
  document.getElementById("fCodigo").value = p.codigo || "";
  document.getElementById("fCategoria").value = p.categoria_id || "";

  const btnDes = document.getElementById("btnDesativarProduto");
  const btnAtv = document.getElementById("btnAtivarProduto");

  if (p.ativo) { btnDes.style.display = "inline-flex"; btnAtv.style.display = "none"; }
  else { btnDes.style.display = "none"; btnAtv.style.display = "inline-flex"; }

  document.getElementById("fCor").disabled = false;
  document.getElementById("btnAddCor").disabled = false;
}

function resetForm() {
  state.editingId = null;
  state.selectedProdutoId = null;
  state.cores = [];

  document.getElementById("fNome").value = "";
  document.getElementById("fCodigo").value = "";
  document.getElementById("fCategoria").value = "";

  document.getElementById("btnDesativarProduto").style.display = "none";
  document.getElementById("btnAtivarProduto").style.display = "none";

  document.getElementById("fCor").value = "";
  document.getElementById("fCor").disabled = true;
  document.getElementById("btnAddCor").disabled = true;

  document.getElementById("chipsCores").innerHTML = `<span class="small">Salve um produto para liberar as cores.</span>`;
}

async function refreshLista(search="") {
  state.produtos = await loadProdutos(search);
  const tbody = document.getElementById("pTbody");
  tbody.innerHTML = state.produtos.length
    ? state.produtos.map(renderProdutoRow).join("")
    : `<tr><td colspan="5" class="small">Nenhum produto encontrado.</td></tr>`;
}

async function refreshCores() {
  const wrap = document.getElementById("chipsCores");
  if (!state.selectedProdutoId) return;

  state.cores = await loadCores(state.selectedProdutoId);

  if (!state.cores.length) {
    wrap.innerHTML = `<span class="small">Nenhuma cor cadastrada ainda.</span>`;
    return;
  }

  wrap.innerHTML = state.cores.map(c => `
    <span class="chip">
      ${escapeHtml(c.cor)}
      <button title="Remover" data-corid="${c.id}">✕</button>
    </span>
  `).join("");

  wrap.querySelectorAll("button[data-corid]").forEach(btn => {
    btn.addEventListener("click", async () => {
      try {
        await removeCor(btn.dataset.corid);
        await refreshCores();
      } catch (e) {
        alert("Erro ao remover cor.");
        console.error(e);
      }
    });
  });
}

/* =========================
   MODAL CATEGORIA
========================= */
function openCatModal() {
  document.getElementById("catMsg").textContent = "";
  document.getElementById("catNome").value = "";
  document.getElementById("catGrade").value = "";
  document.getElementById("catModal").style.display = "flex";
  document.getElementById("catNome").focus();
}
function closeCatModal() {
  document.getElementById("catModal").style.display = "none";
}

async function reloadCategoriasAndSelect(categoriaId) {
  state.categorias = await loadCategorias();

  const sel = document.getElementById("fCategoria");
  sel.innerHTML =
    `<option value="">Selecione</option>` +
    state.categorias.map(c => opt(c.id, c.nome)).join("");

  if (categoriaId) sel.value = categoriaId;
}

/* =========================
   EVENTS
========================= */
function bindEvents() {
  document.getElementById("btnNovoProduto").addEventListener("click", () => resetForm());

  document.getElementById("btnPSearch").addEventListener("click", async () => {
    const s = document.getElementById("pSearch").value || "";
    await refreshLista(s);
  });

  document.getElementById("pSearch").addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const s = document.getElementById("pSearch").value || "";
      await refreshLista(s);
    }
  });

  // Abrir modal categoria
  document.getElementById("btnAddCategoria").addEventListener("click", () => openCatModal());
  document.getElementById("catClose").addEventListener("click", () => closeCatModal());
  document.getElementById("catCancelar").addEventListener("click", () => closeCatModal());
  document.getElementById("catModal").addEventListener("click", (e) => {
    if (e.target.id === "catModal") closeCatModal();
  });

  // Salvar categoria
  document.getElementById("catSalvar").addEventListener("click", async () => {
    const msg = document.getElementById("catMsg");
    msg.textContent = "Salvando...";
    try {
      const nome = document.getElementById("catNome").value.trim();
      const grade_id = document.getElementById("catGrade").value;

      if (!nome) return (msg.textContent = "Digite o nome da categoria.");
      if (!grade_id) return (msg.textContent = "Selecione a grade de tamanhos.");

      const cat = await addCategoria(nome, grade_id);
      await reloadCategoriasAndSelect(cat.id);

      msg.textContent = "Categoria criada!";
      setTimeout(() => closeCatModal(), 350);
    } catch (e) {
  console.error("ERRO ADD CATEGORIA:", e);
  msg.textContent = e?.message || "Erro ao criar categoria.";
}

  });

  // salvar produto
  document.getElementById("btnSalvarProduto").addEventListener("click", async () => {
    try {
      const nome = document.getElementById("fNome").value.trim();
      const codigo = document.getElementById("fCodigo").value.trim();
      const categoria_id = document.getElementById("fCategoria").value;

      if (!nome) return alert("Informe o nome do produto.");
      if (!codigo) return alert("Informe o código do produto.");
      if (!categoria_id) return alert("Selecione a categoria.");

      const id = await saveProduto({
        id: state.editingId,
        nome, codigo, categoria_id,
        ativo: true
      });

      await refreshLista(document.getElementById("pSearch").value || "");

      const produto = state.produtos.find(x => x.id === id) || { id, nome, codigo, categoria_id, ativo:true, categoria_nome:"-" };
      fillFormProduto(produto);
      await refreshCores();

      alert("Produto salvo com sucesso.");
    } catch (e) {
      alert("Erro ao salvar produto. Se o código já existir, troque o código.");
      console.error(e);
    }
  });

  document.getElementById("btnDesativarProduto").addEventListener("click", async () => {
    if (!state.selectedProdutoId) return;
    if (!confirm("Desativar este produto?")) return;
    try {
      await toggleProdutoAtivo(state.selectedProdutoId, false);
      await refreshLista(document.getElementById("pSearch").value || "");
      alert("Produto desativado.");
    } catch (e) {
      alert("Erro ao desativar produto.");
      console.error(e);
    }
  });

  document.getElementById("btnAtivarProduto").addEventListener("click", async () => {
    if (!state.selectedProdutoId) return;
    try {
      await toggleProdutoAtivo(state.selectedProdutoId, true);
      await refreshLista(document.getElementById("pSearch").value || "");
      alert("Produto ativado.");
    } catch (e) {
      alert("Erro ao ativar produto.");
      console.error(e);
    }
  });

  document.getElementById("btnAddCor").addEventListener("click", async () => {
    try {
      const cor = document.getElementById("fCor").value.trim();
      if (!state.selectedProdutoId) return alert("Salve um produto primeiro.");
      if (!cor) return alert("Digite uma cor.");

      await addCor(state.selectedProdutoId, cor);
      document.getElementById("fCor").value = "";
      await refreshCores();
    } catch (e) {
      alert("Erro ao adicionar cor (talvez já exista).");
      console.error(e);
    }
  });

  // editar ao clicar na lista
  document.getElementById("pTbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action='editar']");
    const tr = e.target.closest("tr[data-id]");
    const id = btn?.dataset.id || tr?.dataset.id;
    if (!id) return;

    const p = state.produtos.find(x => x.id === id);
    if (!p) return;

    fillFormProduto(p);
    await refreshCores();
  });
}

export async function renderProdutos() {
  try {
    // 1) carrega grades e categorias antes de montar o HTML
    state.grades = await loadGrades();
    state.categorias = await loadCategorias();

    console.log("GRADES:", state.grades);

    const html = `
      <div class="row2">
        ${renderFormProduto()}
        ${renderListaProdutos()}
      </div>
    `;

    setTimeout(async () => {
      try {
        bindEvents();
        await refreshLista("");
        resetForm();
      } catch (e) {
        console.error(e);
        alert("Erro interno ao iniciar a tela Produtos.");
      }
    }, 0);

    return html;

  } catch (e) {
    console.error(e);
    return `
      <div class="card">
        <div class="card-title">Produtos</div>
        <div class="card-sub">Erro ao carregar esta tela. Abra o Console (F12) para ver o motivo.</div>
      </div>
    `;
  }
}


