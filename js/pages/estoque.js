import { sb } from "../supabase.js";

function opt(value, label) {
  return `<option value="${value}">${label}</option>`;
}

function badge(qtd, minimo) {
  const low = Number(qtd) <= Number(minimo);
  return low
    ? `<span class="badge low">● Baixo</span>`
    : `<span class="badge ok">● OK</span>`;
}

function row(r) {
  return `
    <tr>
      <td>${r.categoria ?? "-"}</td>
      <td>${r.produto ?? "-"}</td>
      <td>${r.codigo_produto ?? "-"}</td>
      <td>${r.cor ?? "-"}</td>
      <td>${r.tamanho ?? "-"}</td>
      <td>${r.quantidade ?? 0}</td>
      <td>${r.minimo ?? 0}</td>
      <td>${badge(r.quantidade ?? 0, r.minimo ?? 0)}</td>
    </tr>
  `;
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

async function loadProdutosByCategoria(categoriaId) {
  if (!categoriaId) return [];
  const { data, error } = await sb
    .from("produtos")
    .select("id,nome,codigo")
    .eq("categoria_id", categoriaId)
    .eq("ativo", true)
    .order("nome", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function loadTamanhosByCategoria(categoriaId) {
  if (!categoriaId) return [];
  // categoria -> grade -> grade_tamanhos
  const { data: cat, error: e1 } = await sb
    .from("categorias")
    .select("grade_id")
    .eq("id", categoriaId)
    .single();
  if (e1) throw e1;

  const { data, error } = await sb
    .from("grade_tamanhos")
    .select("tamanho,ordem")
    .eq("grade_id", cat.grade_id)
    .order("ordem", { ascending: true });

  if (error) throw error;
  return (data || []).map(x => x.tamanho);
}

async function loadEstoque(filters) {
  // Usa a VIEW vw_estoque_detalhado
  let q = sb.from("vw_estoque_detalhado")
  .select("*")
  .gt("quantidade", 0);


  if (filters.categoria_id) q = q.eq("categoria_id", filters.categoria_id);
  if (filters.produto_id) q = q.eq("produto_id", filters.produto_id);
  if (filters.cor) q = q.ilike("cor", `%${filters.cor}%`);
  if (filters.tamanho) q = q.eq("tamanho", filters.tamanho);
  if (filters.somente_baixo) q = q.eq("estoque_baixo", true);

  // só ativos
  q = q.eq("produto_ativo", true).eq("variacao_ativa", true);

  const { data, error } = await q
    .order("categoria", { ascending: true })
    .order("produto", { ascending: true })
    .order("cor", { ascending: true })
    .order("tamanho", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function renderEstoque() {
  // Render inicial
  const categorias = await loadCategorias();

  const html = `
    <div class="card">
      <div class="card-title">Estoque</div>
      <div class="card-sub">Filtre por categoria, produto, cor, tamanho e estoque baixo.</div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="toolbar">
        <div class="field">
          <label>Categoria</label>
          <select class="select" id="fCategoria">
            ${opt("", "Todas")}
            ${categorias.map(c => opt(c.id, c.nome)).join("")}
          </select>
        </div>

        <div class="field">
          <label>Produto</label>
          <select class="select" id="fProduto" disabled>
            ${opt("", "Todos")}
          </select>
        </div>

        <div class="field">
          <label>Cor</label>
          <input class="input" id="fCor" placeholder="Ex: azul, preto..." />
        </div>

        <div class="field">
          <label>Tamanho</label>
          <select class="select" id="fTamanho" disabled>
            ${opt("", "Todos")}
          </select>
        </div>

        <div class="chk">
          <input type="checkbox" id="fBaixo" />
          <label for="fBaixo" style="cursor:pointer;">Só estoque baixo</label>
        </div>

        <div class="right">
          <button class="btn" id="btnLimpar">Limpar</button>
          <button class="btn primary" id="btnAplicar">Aplicar</button>
        </div>
      </div>

      <div class="small" id="estoqueInfo">Carregando...</div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="table">
          <thead>
            <tr>
              <th>Categoria</th>
              <th>Produto</th>
              <th>Código</th>
              <th>Cor</th>
              <th>Tamanho</th>
              <th>Qtd</th>
              <th>Mínimo</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="tbodyEstoque">
            <tr><td colspan="8" class="small">Carregando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Espera o DOM encaixar e depois liga eventos
  setTimeout(() => initEstoqueEvents(), 0);
  return html;
}

async function applyFilters() {
  const categoria_id = document.getElementById("fCategoria").value || "";
  const produto_id = document.getElementById("fProduto").value || "";
  const cor = document.getElementById("fCor").value.trim();
  const tamanho = document.getElementById("fTamanho").value || "";
  const somente_baixo = document.getElementById("fBaixo").checked;

  const rows = await loadEstoque({
    categoria_id: categoria_id || null,
    produto_id: produto_id || null,
    cor: cor || null,
    tamanho: tamanho || null,
    somente_baixo,
  });

  const tbody = document.getElementById("tbodyEstoque");
  const info = document.getElementById("estoqueInfo");

  info.textContent = `${rows.length} registro(s) encontrado(s).`;
  tbody.innerHTML = rows.length
    ? rows.map(row).join("")
    : `<tr><td colspan="8" class="small">Nenhum item encontrado com esses filtros.</td></tr>`;
}

async function onCategoriaChange() {
  const categoriaId = document.getElementById("fCategoria").value || "";

  // Produto
  const selProd = document.getElementById("fProduto");
  selProd.innerHTML = opt("", "Todos");
  selProd.disabled = true;

  // Tamanho
  const selTam = document.getElementById("fTamanho");
  selTam.innerHTML = opt("", "Todos");
  selTam.disabled = true;

  if (!categoriaId) return;

  // carrega produtos
  const prods = await loadProdutosByCategoria(categoriaId);
  selProd.innerHTML = opt("", "Todos") + prods.map(p => opt(p.id, `${p.nome} (${p.codigo})`)).join("");
  selProd.disabled = false;

  // carrega tamanhos da grade
  const tams = await loadTamanhosByCategoria(categoriaId);
  selTam.innerHTML = opt("", "Todos") + tams.map(t => opt(t, t)).join("");
  selTam.disabled = false;
}

function clearFilters() {
  document.getElementById("fCategoria").value = "";
  document.getElementById("fProduto").innerHTML = opt("", "Todos");
  document.getElementById("fProduto").disabled = true;

  document.getElementById("fCor").value = "";

  document.getElementById("fTamanho").innerHTML = opt("", "Todos");
  document.getElementById("fTamanho").disabled = true;

  document.getElementById("fBaixo").checked = false;
}

function initEstoqueEvents() {
  const fCategoria = document.getElementById("fCategoria");
  const btnAplicar = document.getElementById("btnAplicar");
  const btnLimpar = document.getElementById("btnLimpar");

  fCategoria.addEventListener("change", async () => {
    try {
      await onCategoriaChange();
    } catch (e) {
      alert("Erro ao carregar produtos/tamanhos da categoria.");
      console.error(e);
    }
  });

  btnAplicar.addEventListener("click", async () => {
    try {
      await applyFilters();
    } catch (e) {
      showToast("Erro ao carregar estoque.", "error");
      console.error(e);
    }
  });

  btnLimpar.addEventListener("click", async () => {
    clearFilters();
    try {
      await applyFilters();
    } catch (e) {
      console.error(e);
    }
  });

  // Carrega inicial (sem filtros)
  applyFilters().catch(console.error);
}


window.addEventListener("forceRefreshEstoque", async () => {
  console.log("🔄 Recarregando estoque...");
  await loadEstoque();
});
