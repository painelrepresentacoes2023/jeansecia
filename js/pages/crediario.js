import { sb } from "../supabase.js";

/* =========================
   TOAST/FALLBACK
========================= */
function showToast(msg, type = "info") {
  console.log(`[${type}] ${msg}`);
  const el = document.getElementById("cMsg");
  if (el) el.textContent = msg || "";
}

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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("pt-BR");
}

function toISODateToday() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseNumberBR(v) {
  if (v == null) return 0;
  const s = String(v).trim().replace(/\./g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
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
  cred: [],
  parcelas: [],
  formas: [],
  vendaSelecionada: null,
  paySel: new Set(), // parcela_id
  crediFormas: [],   // valores do ENUM que são crediário
};

window.__crediarioState = state;

/* =========================
   LOADERS
========================= */
async function loadEnumValues(enumType) {
  const { data, error } = await sb.rpc("enum_values", { enum_type: enumType });
  if (error) throw error;
  return (data || []).map((x) => x.value);
}

async function loadFormasEnum() {
  // seu enum real é forma_pagamento (segundo seu print)
  try {
    return await loadEnumValues("forma_pagamento");
  } catch (e) {
    // fallback (não quebra a tela)
    console.warn("Falhou enum forma_pagamento:", e?.message);
    return [];
  }
}

async function loadCrediFormas() {
  // pega os valores do enum e filtra os que contêm "credi"
  let vals = [];
  try {
    vals = await loadEnumValues("forma_pagamento");
  } catch (e) {
    vals = [];
  }

  const filtered = (vals || []).filter((v) => String(v).toLowerCase().includes("credi"));

  // fallback duro caso enum_values falhe
  if (!filtered.length) {
    return ["crediario", "crediário", "credi"].filter(Boolean);
  }
  return filtered;
}

/**
 * ✅ Lista SOMENTE vendas do crediário
 * IMPORTANTÍSSIMO: NÃO usa ILIKE no enum (isso causava: operator does not exist: forma_pagamento ~~* unknown)
 * => usa IN com os valores do enum que têm "credi"
 */
async function loadCrediario() {
  // 0) descobre quais valores do enum são "crediário"
  if (!state.crediFormas?.length) {
    state.crediFormas = await loadCrediFormas();
  }

  // 1) puxa vendas do crediário
  let q = sb
    .from("vendas")
    .select(
      "id,data,forma,cliente_nome,cliente_telefone,cliente_endereco,subtotal,desconto_valor,total,observacoes,created_at,updated_at,numero_parcelas,dia_vencimento"
    )
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  // se tiver lista de formas credi, usa IN (perfeito p/ enum)
  if (state.crediFormas?.length) {
    q = q.in("forma", state.crediFormas);
  } else {
    // fallback: tenta eq (não deve acontecer)
    q = q.eq("forma", "crediario");
  }

  const { data: vendas, error: e1 } = await q;
  if (e1) throw e1;

  const v = (vendas || []).map((r) => ({
    ...r,
    venda_id: normId(r.id),
    id: normId(r.id),
  }));

  if (!v.length) return [];

  // 2) puxa parcelas dessas vendas pra somar pagos
  const ids = v.map((x) => x.venda_id).filter(Boolean);

  const { data: parc, error: e2 } = await sb
    .from("parcelas")
    .select("id,venda_id,valor,valor_pago_acumulado,status")
    .in("venda_id", ids);

  if (e2) throw e2;

  // 3) agrega por venda_id
  const acc = new Map(); // venda_id -> { total_pago }
  for (const p of parc || []) {
    const vid = normId(p.venda_id);
    if (!vid) continue;

    const valor = Number(p.valor || 0);
    const pagoAc = Number(p.valor_pago_acumulado || 0);
    const pago = Math.min(valor, clamp0(pagoAc));

    const cur = acc.get(vid) || { total_pago: 0 };
    cur.total_pago += pago;
    acc.set(vid, cur);
  }

  // 4) monta resumo final
  return v.map((row) => {
    const total = Number(row.total || 0);
    const total_pago = Number(acc.get(row.venda_id)?.total_pago || 0);
    const saldo_aberto = clamp0(total - total_pago);

    return {
      ...row,
      total,
      total_pago: Number(total_pago.toFixed(2)),
      saldo_aberto: Number(saldo_aberto.toFixed(2)),
    };
  });
}

async function loadParcelas(vendaId) {
  const vid = normId(vendaId);

  const { data, error } = await sb
    .from("parcelas")
    .select("id,venda_id,numero,vencimento,valor,status,valor_pago_acumulado,created_at")
    .eq("venda_id", vid)
    .order("numero", { ascending: true });

  if (error) throw error;

  return (data || []).map((r) => ({
    ...r,
    venda_id: normId(r.venda_id),
    parcela_id: normId(r.id),
  }));
}

// mantém sua rpc atual (payload jsonb)
async function registrarPagamentoRPC(payload) {
  const { error } = await sb.rpc("registrar_pagamento", { payload });
  if (error) throw error;
}

/* =========================
   UI
========================= */
function renderCrediarioLayout() {
  return `
    <style>
      /* ===== Layout responsivo e sem “corte” ===== */
      .row2{
        display:grid;
        grid-template-columns: 1.05fr 1fr;
        gap:14px;
        align-items:start;
      }
      @media (max-width: 980px){
        .row2{ grid-template-columns: 1fr; }
      }

      .table-wrap{
        overflow:auto;
        max-width:100%;
        -webkit-overflow-scrolling: touch;
      }
      .table{
        width:100%;
        min-width: 820px; /* impede cortar colunas; vira scroll horizontal */
        border-collapse: collapse;
      }
      @media (max-width: 980px){
        .table{ min-width: 860px; }
      }

      /* ===== Clique/seleção ===== */
      #cTbody tr[data-open]{ cursor:pointer; }
      #cTbody tr[data-open]:hover{ filter: brightness(1.08); }
      #cTbody tr.is-selected{ outline:2px solid rgba(110,168,254,.55); outline-offset:-2px; }

      /* botão */
      .btn{ cursor:pointer; }
    </style>

    <div class="row2">
      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Vendas no crediário, parcelas e pagamentos.</div>

        <div class="grid" style="grid-template-columns: 1fr; gap:10px; margin-top:12px;">
          <div class="field">
            <label>Buscar</label>
            <input class="input" id="fCred" placeholder="cliente, telefone..." />
          </div>
        </div>

        <div class="small" id="cInfo" style="margin-top:10px;">Carregando...</div>

        <div class="table-wrap" style="margin-top:10px;">
          <table class="table">
            <thead>
              <tr>
                <th style="min-width:110px;">Data</th>
                <th style="min-width:220px;">Cliente</th>
                <th style="min-width:120px;">Total</th>
                <th style="min-width:120px;">Pago</th>
                <th style="min-width:120px;">Aberto</th>
                <th style="min-width:130px;">Status</th>
                <th style="min-width:170px;">Ação</th>
              </tr>
            </thead>
            <tbody id="cTbody">
              <tr><td colspan="7" class="small">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Detalhes</div>
        <div class="card-sub">Clique em <b>Ver detalhes</b> em uma venda para ver parcelas.</div>

        <div class="small" id="cMsg" style="margin-top:10px;"></div>

        <div id="detBox" style="margin-top:10px;" class="small">Nenhuma venda selecionada.</div>
      </div>
    </div>
  `;
}

function isQuitado(vendaRow) {
  const aberto = Number(vendaRow?.saldo_aberto || 0);
  return aberto <= 0.009;
}

function markSelectedRow(vendaId) {
  const vid = normId(vendaId);
  const tbody = document.getElementById("cTbody");
  if (!tbody) return;
  tbody.querySelectorAll("tr").forEach((tr) => tr.classList.remove("is-selected"));
  if (!vid) return;
  const tr = tbody.querySelector(`tr[data-open="${CSS.escape(vid)}"]`);
  if (tr) tr.classList.add("is-selected");
}

function renderTabelaCred(filtro = "") {
  const info = document.getElementById("cInfo");
  const tbody = document.getElementById("cTbody");

  let rows = state.cred || [];
  const f = (filtro || "").trim().toLowerCase();

  if (f) {
    rows = rows.filter((r) => {
      const s = [r.cliente_nome, r.cliente_telefone, r.cliente_endereco].join(" ").toLowerCase();
      return s.includes(f);
    });
  }

  info.textContent = `${rows.length} venda(s) no crediário.`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="small">Nenhuma venda encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((r) => {
      const status = isQuitado(r) ? "Pago ✅" : "Em aberto";
      const vid = escapeHtml(r.venda_id);
      return `
        <tr data-open="${vid}">
          <td>${fmtDateBR(r.data)}</td>
          <td>
            ${escapeHtml(r.cliente_nome || "-")}
            <div class="small">${escapeHtml(r.cliente_telefone || "")}</div>
          </td>
          <td>${money(r.total || 0)}</td>
          <td>${money(r.total_pago || 0)}</td>
          <td>${money(r.saldo_aberto || 0)}</td>
          <td>${status}</td>
          <td>
            <button class="btn primary" data-openbtn="${vid}">Ver detalhes</button>
          </td>
        </tr>
      `;
    })
    .join("");

  // Clique na linha (também abre)
  tbody.querySelectorAll("tr[data-open]").forEach((tr) => {
    tr.addEventListener("click", async () => {
      const vid = tr.getAttribute("data-open");
      await abrirVenda(vid);
    });
  });

  // Clique no botão (não duplica)
  tbody.querySelectorAll("button[data-openbtn]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      await abrirVenda(btn.dataset.openbtn);
    });
  });
}

async function abrirVenda(vendaId) {
  const vid = normId(vendaId);
  const venda = (state.cred || []).find((v) => normId(v.venda_id) === vid);
  if (!venda) return showToast("Venda não encontrada.", "error");

  state.vendaSelecionada = venda;
  state.paySel = new Set();

  showToast("", "info");
  markSelectedRow(vid);

  try {
    state.parcelas = await loadParcelas(vid);
  } catch (e) {
    console.error(e);
    state.parcelas = [];
    showToast(e?.message || "Erro ao carregar parcelas.", "error");
  }

  renderDetalhes();
}

function parcelaQuitada(p) {
  const valor = Number(p.valor || 0);
  const pagoAc = Number(p.valor_pago_acumulado || 0);
  const saldo = Number((valor - pagoAc).toFixed(2));
  return saldo <= 0.009;
}

function renderDetalhes() {
  const venda = state.vendaSelecionada;
  const box = document.getElementById("detBox");

  if (!venda) {
    box.innerHTML = "Nenhuma venda selecionada.";
    return;
  }

  const parcelas = state.parcelas || [];
  const total = Number(venda.total || 0);
  const pago = Number(venda.total_pago || 0);
  const aberto = Number(venda.saldo_aberto || 0);
  const endereco = venda.cliente_endereco || "";
  const statusVenda = isQuitado(venda) ? "Pago ✅" : "Em aberto";

  box.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:800; font-size: 1.05rem;">${escapeHtml(venda.cliente_nome || "Cliente")}</div>
      <div class="small">${escapeHtml(venda.cliente_telefone || "")}</div>
      ${endereco ? `<div class="small" style="margin-top:4px;">${escapeHtml(endereco)}</div>` : ""}

      <div class="small" style="margin-top:10px;">
        <div>Data: <b>${fmtDateBR(venda.data)}</b></div>
        <div>Forma: <b>${escapeHtml(String(venda.forma || ""))}</b></div>
        <div>Status: <b>${statusVenda}</b></div>
        <div style="margin-top:6px;">
          Total: <b>${money(total)}</b> • Pago: <b>${money(pago)}</b> • Aberto: <b>${money(aberto)}</b>
        </div>
        ${venda.observacoes ? `<div style="margin-top:6px;">Obs: ${escapeHtml(venda.observacoes)}</div>` : ""}
      </div>

      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn" id="btnFecharVenda">Fechar</button>
      </div>
    </div>

    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="font-weight:800;">Parcelas</div>
        <button class="btn primary" id="btnPagarSelecionadas">Marcar selecionadas como pagas</button>
      </div>

      <div class="small" style="margin-top:6px;">
        Marque a parcela do mês que foi paga e clique em <b>Marcar selecionadas como pagas</b>.
      </div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="table" style="min-width: 760px;">
          <thead>
            <tr>
              <th style="width:70px;">Pagar</th>
              <th style="width:70px;">Nº</th>
              <th style="width:140px;">Venc.</th>
              <th style="width:140px;">Valor</th>
              <th style="width:140px;">Pago</th>
              <th style="width:140px;">Saldo</th>
              <th style="width:150px;">Status</th>
            </tr>
          </thead>
          <tbody id="parcTbody">
            ${
              parcelas.length
                ? parcelas
                    .map((p) => {
                      const parcela_id = normId(p.parcela_id || p.id);
                      const valor = Number(p.valor || 0);
                      const pagoAc = Number(p.valor_pago_acumulado || 0);
                      const saldo = Number((valor - pagoAc).toFixed(2));
                      const quit = saldo <= 0.009;

                      return `
                        <tr>
                          <td>
                            ${
                              quit
                                ? `<span class="small">✅</span>`
                                : `<input type="checkbox" data-pay="${escapeHtml(parcela_id)}" />`
                            }
                          </td>
                          <td>${Number(p.numero || 0)}</td>
                          <td>${fmtDateBR(p.vencimento)}</td>
                          <td>${money(valor)}</td>
                          <td>${money(pagoAc)}</td>
                          <td>${money(clamp0(saldo))}</td>
                          <td>${quit ? "Pago ✅" : escapeHtml(String(p.status || "em_aberto"))}</td>
                        </tr>
                      `;
                    })
                    .join("")
                : `<tr><td colspan="7" class="small">Sem parcelas cadastradas.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById("btnFecharVenda").addEventListener("click", () => {
    state.vendaSelecionada = null;
    state.parcelas = [];
    state.paySel = new Set();
    box.innerHTML = "Nenhuma venda selecionada.";
    markSelectedRow("");
    showToast("", "info");
  });

  // binds seleção
  document.querySelectorAll("input[data-pay]").forEach((chk) => {
    chk.addEventListener("change", () => {
      const pid = normId(chk.dataset.pay);
      if (!pid) return;
      if (chk.checked) state.paySel.add(pid);
      else state.paySel.delete(pid);
    });
  });

  // marcar selecionadas como pagas (paga o SALDO de cada parcela)
  document.getElementById("btnPagarSelecionadas").addEventListener("click", async () => {
    const vendaAtual = state.vendaSelecionada;
    if (!vendaAtual) return;

    const ids = Array.from(state.paySel.values()).filter(Boolean);
    if (!ids.length) return showToast("Marque pelo menos 1 parcela.", "error");

    // Forma do pagamento: aqui eu uso a própria forma da venda como padrão,
    // você pode trocar depois se quiser adicionar select.
    const forma = String(vendaAtual.forma || "crediario");
    const data_pagamento = toISODateToday();

    const mapParc = new Map((state.parcelas || []).map((p) => [normId(p.parcela_id || p.id), p]));

    showToast("Registrando pagamento...", "info");

    try {
      for (const parcela_id of ids) {
        const p = mapParc.get(parcela_id);
        if (!p) continue;
        if (parcelaQuitada(p)) continue;

        const valor = Number(p.valor || 0);
        const pagoAc = Number(p.valor_pago_acumulado || 0);
        const saldo = Number((valor - pagoAc).toFixed(2));
        if (saldo <= 0.009) continue;

        await registrarPagamentoRPC({
          venda_id: vendaAtual.venda_id,
          parcela_id,
          parcela_numero: Number(p.numero || 0),
          data_pagamento,
          valor_pago: Number(saldo.toFixed(2)),
          forma,
          observacoes: `Pagamento parcela #${Number(p.numero || 0)}`,
        });
      }

      showToast("Parcelas marcadas como pagas ✅", "success");

      // recarrega lista + reabre venda
      state.cred = await loadCrediario();
      renderTabelaCred(document.getElementById("fCred")?.value || "");
      await abrirVenda(vendaAtual.venda_id);
    } catch (e) {
      console.error(e);
      showToast(e?.message || "Erro ao marcar parcelas como pagas.", "error");
    }
  });
}

/* =========================
   EXPORT
========================= */
export async function renderCrediario() {
  try {
    const html = renderCrediarioLayout();

    setTimeout(async () => {
      try {
        showToast("", "info");

        // carrega formas do enum (pra você usar em outros lugares se quiser)
        state.formas = await loadFormasEnum();

        // carrega as formas que são crediário (resolve o ERRO do ILIKE no enum)
        state.crediFormas = await loadCrediFormas();

        // lista vendas
        state.cred = await loadCrediario();

        renderTabelaCred("");

        const f = document.getElementById("fCred");
        if (f) {
          f.addEventListener("input", (e) => {
            renderTabelaCred(e.target.value);
          });
        }
      } catch (e) {
        console.error(e);
        showToast(e?.message || "Erro ao iniciar Crediário.", "error");

        // deixa a tabela “vazia” de forma bonita
        const tbody = document.getElementById("cTbody");
        const info = document.getElementById("cInfo");
        if (info) info.textContent = "0 venda(s) no crediário.";
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="small">Erro ao carregar vendas.</td></tr>`;
      }
    }, 0);

    return html;
  } catch (e) {
    console.error(e);
    return `
      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Erro ao carregar esta tela. Veja o Console (F12).</div>
      </div>
    `;
  }
}
