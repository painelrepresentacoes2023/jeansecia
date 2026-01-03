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

/**
 * ✅ Corrige o bug do “volta 1 dia” em campos DATE (YYYY-MM-DD)
 * Postgres DATE não tem hora, mas new Date("YYYY-MM-DD") cai em UTC e no -03 volta.
 */
function fmtDateBR(iso) {
  if (!iso) return "-";

  const s = String(iso).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(y, m - 1, d); // local timezone
    return dt.toLocaleDateString("pt-BR");
  }

  const d2 = new Date(iso);
  if (Number.isNaN(d2.getTime())) return String(iso);
  return d2.toLocaleDateString("pt-BR");
}

function normId(v) {
  if (v == null) return "";
  return String(v).trim();
}

// ✅ “apelido” pra nunca mais quebrar se escapar normId em algum lugar
const normId = normId;

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
  vendaSelecionada: null,
  crediFormas: [],
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

async function loadCrediFormas() {
  let vals = [];
  try {
    vals = await loadEnumValues("forma_pagamento");
  } catch {
    vals = [];
  }
  const filtered = (vals || []).filter((v) => String(v).toLowerCase().includes("credi"));
  if (!filtered.length) return ["crediario", "crediário", "credi"];
  return filtered;
}

/**
 * ✅ Lista SOMENTE vendas do crediário
 * ✅ NÃO usa ILIKE no enum (evita o erro do operador)
 * ✅ Calcula total_pago / saldo_aberto pelas parcelas
 */
async function loadCrediario() {
  if (!state.crediFormas?.length) state.crediFormas = await loadCrediFormas();

  let q = sb
    .from("vendas")
    .select(
      "id,data,forma,cliente_nome,cliente_telefone,cliente_endereco,subtotal,desconto_valor,total,observacoes,created_at,updated_at,numero_parcelas,dia_vencimento"
    )
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (state.crediFormas?.length) q = q.in("forma", state.crediFormas);
  else q = q.eq("forma", "crediario");

  const { data: vendas, error: e1 } = await q;
  if (e1) throw e1;

  const v = (vendas || []).map((r) => ({
    ...r,
    venda_id: normId(r.id),
    id: normId(r.id),
  }));

  if (!v.length) return [];

  const ids = v.map((x) => x.venda_id).filter(Boolean);

  const { data: parc, error: e2 } = await sb
    .from("parcelas")
    .select("id,venda_id,valor,valor_pago_acumulado,status")
    .in("venda_id", ids);

  if (e2) throw e2;

  const acc = new Map(); // venda_id -> total_pago
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

/* =========================
   PARCELA: marcar como paga
========================= */
function isQuitada(parcela) {
  const valor = Number(parcela?.valor || 0);
  const pagoAc = Number(parcela?.valor_pago_acumulado || 0);
  const saldo = Number((valor - pagoAc).toFixed(2));
  return saldo <= 0.009 || String(parcela?.status || "").toLowerCase().includes("pag");
}

async function marcarParcelaComoPaga(parcela) {
  const pid = normId(parcela?.parcela_id || parcela?.id);
  if (!pid) throw new Error("Parcela inválida.");

  const valor = Number(parcela?.valor || 0);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error("Valor da parcela inválido.");

  const patch = {
    status: "paga",
    valor_pago_acumulado: Number(valor.toFixed(2)),
  };

  const { error } = await sb.from("parcelas").update(patch).eq("id", pid);
  if (error) throw error;
}

/* =========================
   UI
========================= */
function renderCrediarioLayout() {
  return `
    <style>
      .table-wrap{
        overflow:auto;
        max-width:100%;
        -webkit-overflow-scrolling: touch;
      }
      .table{
        width:100%;
        min-width: 900px;
        border-collapse: collapse;
      }
      #cTbody tr:hover{ filter: brightness(1.08); }

      /* ===== modal ===== */
      .cModal-backdrop{
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,.55);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 18px;
        z-index: 9999;
      }
      .cModal{
        width: min(980px, 96vw);
        max-height: 88vh;
        overflow: auto;
        border-radius: 16px;
        background: rgba(16, 24, 44, .96);
        border: 1px solid rgba(255,255,255,.08);
        box-shadow: 0 18px 60px rgba(0,0,0,.45);
        padding: 16px;
      }
      .cModalHeader{
        display:flex;
        gap: 10px;
        align-items:flex-start;
        justify-content:space-between;
        margin-bottom: 12px;
      }
      .cModalTitle{
        font-weight: 800;
        font-size: 1.05rem;
      }
      .pTable{ min-width: 860px; }
    </style>

    <div class="card">
      <div class="card-title">Crediário</div>
      <div class="card-sub">Vendas no crediário, parcelas e pagamentos.</div>

      <div class="grid" style="grid-template-columns: 1fr; gap:10px; margin-top:12px;">
        <div class="field">
          <label>Buscar</label>
          <input class="input" id="fCred" placeholder="cliente, telefone..." />
        </div>
      </div>

      <div class="small" id="cMsg" style="margin-top:10px;"></div>
      <div class="small" id="cInfo" style="margin-top:10px;">Carregando...</div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="table">
          <thead>
            <tr>
              <th style="min-width:110px;">Data</th>
              <th style="min-width:260px;">Cliente</th>
              <th style="min-width:120px;">Total</th>
              <th style="min-width:120px;">Pago</th>
              <th style="min-width:120px;">Aberto</th>
              <th style="min-width:120px;">Status</th>
              <th style="min-width:170px;">Ação</th>
            </tr>
          </thead>
          <tbody id="cTbody">
            <tr><td colspan="7" class="small">Carregando...</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- MODAL -->
    <div class="cModal-backdrop" id="cModalBackdrop" aria-hidden="true">
      <div class="cModal" role="dialog" aria-modal="true" aria-labelledby="cModalTitle">
        <div class="cModalHeader">
          <div>
            <div class="cModalTitle" id="cModalTitle">Detalhes</div>
            <div class="small" id="cModalSub">—</div>
          </div>
          <button class="btn" id="cModalClose">Fechar</button>
        </div>
        <div id="cModalBody" class="small">Carregando...</div>
      </div>
    </div>
  `;
}

function isQuitado(vendaRow) {
  const aberto = Number(vendaRow?.saldo_aberto || 0);
  return aberto <= 0.009;
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
        <tr>
          <td>${fmtDateBR(r.data)}</td>
          <td>
            ${escapeHtml(r.cliente_nome || "-")}
            <div class="small">${escapeHtml(r.cliente_telefone || "")}</div>
          </td>
          <td>${money(r.total || 0)}</td>
          <td>${money(r.total_pago || 0)}</td>
          <td>${money(r.saldo_aberto || 0)}</td>
          <td>${status}</td>
          <td><button class="btn primary" data-open="${vid}">Ver detalhes</button></td>
        </tr>
      `;
    })
    .join("");

  tbody.querySelectorAll("button[data-open]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await abrirModalVenda(btn.dataset.open);
    });
  });
}

/* =========================
   MODAL
========================= */
function modalEls() {
  return {
    backdrop: document.getElementById("cModalBackdrop"),
    title: document.getElementById("cModalTitle"),
    sub: document.getElementById("cModalSub"),
    body: document.getElementById("cModalBody"),
  };
}

function openModal() {
  const { backdrop } = modalEls();
  if (!backdrop) return;
  backdrop.style.display = "flex";
  backdrop.setAttribute("aria-hidden", "false");
}

function closeModal() {
  const { backdrop } = modalEls();
  if (!backdrop) return;
  backdrop.style.display = "none";
  backdrop.setAttribute("aria-hidden", "true");
}

/**
 * ✅ Fechar do modal 100%: delegação no document (não falha mesmo com re-render)
 */
function bindModalOnce() {
  if (window.__credModalBound) return;
  window.__credModalBound = true;

  document.addEventListener("click", (ev) => {
    const t = ev.target;

    // botão fechar
    if (t && t.id === "cModalClose") {
      ev.preventDefault();
      closeModal();
      return;
    }

    // clicou fora (backdrop)
    const backdrop = document.getElementById("cModalBackdrop");
    if (backdrop && t === backdrop) {
      closeModal();
    }
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeModal();
  });
}

async function abrirModalVenda(vendaId) {
  const vid = normId(vendaId);
  const venda = (state.cred || []).find((v) => normId(v.venda_id) === vid);
  if (!venda) return showToast("Venda não encontrada.", "error");

  state.vendaSelecionada = venda;

  bindModalOnce();
  openModal();

  const { title, sub, body } = modalEls();
  if (title) title.textContent = "Detalhes da venda";
  if (sub) sub.textContent = "Carregando parcelas...";
  if (body) body.innerHTML = `<div class="small">Carregando...</div>`;

  try {
    state.parcelas = await loadParcelas(vid);
    renderModalDetalhes();
  } catch (e) {
    console.error(e);
    if (sub) sub.textContent = "Erro ao carregar.";
    if (body) body.innerHTML = `<div class="small">${escapeHtml(e?.message || "Erro ao carregar detalhes.")}</div>`;
  }
}

function renderModalDetalhes() {
  const venda = state.vendaSelecionada;
  const parcelas = state.parcelas || [];
  const { sub, body } = modalEls();

  if (!venda || !body) return;

  const total = Number(venda.total || 0);
  const pago = Number(venda.total_pago || 0);
  const aberto = Number(venda.saldo_aberto || 0);
  const endereco = venda.cliente_endereco || "";
  const statusVenda = isQuitado(venda) ? "Pago ✅" : "Em aberto";

  if (sub) sub.textContent = `${venda.cliente_nome || "Cliente"} • ${venda.cliente_telefone || ""}`;

  body.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:800;">${escapeHtml(venda.cliente_nome || "Cliente")}</div>
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
    </div>

    <div class="card">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
        <div style="font-weight:800;">Parcelas</div>
        <div class="small">Clique em <b>Marcar como paga</b> quando o cliente pagar.</div>
      </div>

      <div class="table-wrap" style="margin-top:10px;">
        <table class="table pTable">
          <thead>
            <tr>
              <th style="width:80px;">Nº</th>
              <th style="width:140px;">Venc.</th>
              <th style="width:140px;">Valor</th>
              <th style="width:140px;">Pago</th>
              <th style="width:140px;">Saldo</th>
              <th style="width:160px;">Status</th>
              <th style="width:190px;">Ação</th>
            </tr>
          </thead>
          <tbody id="parcTbody">
            ${
              parcelas.length
                ? parcelas
                    .map((p) => {
                      const pid = normId(p.parcela_id || p.id);
                      const valor = Number(p.valor || 0);
                      const pagoAc = Number(p.valor_pago_acumulado || 0);
                      const saldo = Number((valor - pagoAc).toFixed(2));
                      const quit = isQuitada(p);

                      return `
                        <tr>
                          <td>${Number(p.numero || 0)}</td>
                          <td>${fmtDateBR(p.vencimento)}</td>
                          <td>${money(valor)}</td>
                          <td>${money(pagoAc)}</td>
                          <td>${money(clamp0(saldo))}</td>
                          <td>${quit ? "paga" : escapeHtml(String(p.status || "aberta"))}</td>
                          <td>
                            ${
                              quit
                                ? `<span class="small">—</span>`
                                : `<button class="btn primary" data-pay="${escapeHtml(pid)}">Marcar como paga</button>`
                            }
                          </td>
                        </tr>
                      `;
                    })
                    .join("")
                : `<tr><td colspan="7" class="small">Sem parcelas cadastradas.</td></tr>`
            }
          </tbody>
        </table>
      </div>

      <div class="small" style="margin-top:10px;" id="modalMsg"></div>
    </div>
  `;

  const tbody = body.querySelector("#parcTbody");
  const modalMsg = body.querySelector("#modalMsg");

  tbody?.querySelectorAll("button[data-pay]")?.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const parcelaId = normId(btn.dataset.pay);
      const parcela = (state.parcelas || []).find((x) => normId(x.parcela_id || x.id) === parcelaId);
      if (!parcela) return;

      if (modalMsg) modalMsg.textContent = "Salvando...";

      try {
        await marcarParcelaComoPaga(parcela);

        // recarrega para atualizar total/pago/aberto
        state.cred = await loadCrediario();
        state.parcelas = await loadParcelas(venda.venda_id);

        state.vendaSelecionada =
          (state.cred || []).find((v) => normId(v.venda_id) === normId(venda.venda_id)) || venda;

        renderTabelaCred(document.getElementById("fCred")?.value || "");
        renderModalDetalhes();

        showToast("Parcela marcada como paga ✅", "success");
      } catch (e) {
        console.error(e);
        const msg = e?.message || "Erro ao marcar parcela como paga.";
        if (modalMsg) modalMsg.textContent = msg;
        showToast(msg, "error");
      }
    });
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
        bindModalOnce();

        state.crediFormas = await loadCrediFormas();
        state.cred = await loadCrediario();

        renderTabelaCred("");

        const f = document.getElementById("fCred");
        if (f) f.addEventListener("input", (e) => renderTabelaCred(e.target.value));
      } catch (e) {
        console.error(e);
        showToast(e?.message || "Erro ao iniciar Crediário.", "error");

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
