import { sb } from "../supabase.js";

const state = {
  categorias: [],
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

async function loadCategorias() {
  const { data, error } = await sb
    .from("categorias")
    .select("id,nome")
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadProdutos(search="") {
  // lista produtos com categoria (join)
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
          <input class="input" id="fCodigo" placeholder="Ex: 1023" />
        </div>
        <div class="field">
          <label>Categoria</label>
          <select class="select" id="fCategoria">
            <option value="">Selecione</option>
            ${catOptions}
          </select>
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
  `;
}

function renderProdutoRow(p) {
  const status = p.ativo
    ? `<span class="badge ok">● Ativo</span>`
    : `<span class="badge low">● Inativo</span>`;

  return `
    <tr data-id="${p.id}" class="pRow" style="cursor:pointer;">
      <td>${escapeHtml(p.nome)}</td>
      <td>${escapeHtml(p.codigo)}</td>
      <td>${escapeHtml(p.categoria_nome)}</td>
      <td>${status}</td>
      <td>
        <button class="btn" data-action="editar" data-id="${p.id}">Editar</button>
      </td>
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

  if (p.ativo) {
    btnDes.style.display = "inline-flex";
    btnAtv.style.display = "none";
  } else {
    btnDes.style.display = "none";
    btnAtv.style.display = "inline-flex";
  }

  // habilita cores
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

  // bind remover
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

      // seleciona/ativa área de cores
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

  // clique na linha -> editar
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
  state.categorias = await loadCategorias();

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
      // deixa form limpo
      resetForm();
    } catch (e) {
      alert("Erro ao carregar Produtos. Verifique tabelas/policies.");
      console.error(e);
    }
  }, 0);

  return html;
}
