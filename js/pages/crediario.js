import { sb } from "../supabase.js";

/* =========================
   TOAST/FALLBACK
========================= */
function showToast(msg, type = "info") {
  console.log(`[${type}] ${msg}`);
  const el = document.getElementById("cMsg");
  if (el) el.textContent = msg;
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
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("pt-BR");
}

/* =========================
   STATE
========================= */
const state = {
  cred: [],
  parcelas: [],
  formas: [],
  vendaSelecionada: null,
};

window.__crediarioState = state;

/* =========================
   LOADERS
========================= */
async function loadFormasEnum() {
  const { data, error } = await sb.rpc("enum_values", { enum_type: "forma" });
  if (error) throw error;
  return (data || []).map(x => x.value);
}

async function loadCrediario() {
  const { data, error } = await sb
    .from("vw_crediario_resumo")
    .select("*")
    .order("data", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return data || [];
}

async function loadParcelas(vendaId) {
  const { data, error } = await sb
    .from("vw_parcelas_detalhe")
    .select("*")
    .eq("venda_id", vendaId)
    .order("numero", { ascending: true });

  if (error) throw error;
  return data || [];
}

async function registrarPagamentoRPC(payload) {
  const { error } = await sb.rpc("registrar_pagamento", { payload });
  if (error) throw error;
}

/* =========================
   UI
========================= */
function renderCrediarioLayout() {
  return `
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
                <th>Data</th>
                <th>Cliente</th>
                <th>Total</th>
                <th>Pago</th>
                <th>Aberto</th>
                <th style="width:140px;">Ações</th>
              </tr>
            </thead>
            <tbody id="cTbody">
              <tr><td colspan="6" class="small">Carregando...</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Detalhes</div>
        <div class="card-sub">Selecione uma venda para ver parcelas e registrar pagamento.</div>

        <div class="small" id="cMsg" style="margin-top:10px;"></div>

        <div id="detBox" style="margin-top:10px;" class="small">Nenhuma venda selecionada.</div>
      </div>
    </div>
  `;
}

function renderTabelaCred(filtro = "") {
  const info = document.getElementById("cInfo");
  const tbody = document.getElementById("cTbody");

  let rows = state.cred || [];
  const f = (filtro || "").trim().toLowerCase();

  if (f) {
    rows = rows.filter(r => {
      const s = [r.cliente_nome, r.cliente_telefone].join(" ").toLowerCase();
      return s.includes(f);
    });
  }

  info.textContent = `${rows.length} venda(s) no crediário.`;

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="small">Nenhuma venda encontrada.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${fmtDateBR(r.data)}</td>
      <td>${escapeHtml(r.cliente_nome || "-")} <span class="small">${escapeHtml(r.cliente_telefone || "")}</span></td>
      <td>${money(r.total || 0)}</td>
      <td>${money(r.total_pago || 0)}</td>
      <td>${money(r.saldo_aberto || 0)}</td>
      <td>
        <button class="btn primary" data-open="${r.venda_id}">Abrir</button>
      </td>
    </tr>
  `).join("");

  tbody.querySelectorAll("button[data-open]").forEach(btn => {
    btn.addEventListener("click", async () => {
      await abrirVenda(btn.dataset.open);
    });
  });
}

async function abrirVenda(vendaId) {
  const venda = (state.cred || []).find(v => v.venda_id === vendaId);
  if (!venda) return showToast("Venda não encontrada.", "error");

  state.vendaSelecionada = venda;
  state.parcelas = await loadParcelas(vendaId);

  renderDetalhes();
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

  const formasOptions = (state.formas || [])
    .map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`)
    .join("");

  box.innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:800;">${escapeHtml(venda.cliente_nome || "Cliente")}</div>
      <div class="small">${escapeHtml(venda.cliente_telefone || "")}</div>
      <div class="small" style="margin-top:6px;">
        Total: <b>${money(total)}</b> • Pago: <b>${money(pago)}</b> • Aberto: <b>${money(aberto)}</b>
      </div>
    </div>

    <div class="card" style="margin-bottom:12px;">
      <div style="font-weight:800;">Registrar pagamento</div>

      <div class="grid grid-3" style="gap:10px; margin-top:10px;">
        <div class="field">
          <label>Data</label>
          <input class="input" id="pgData" type="date" />
        </div>
        <div class="field">
          <label>Valor (R$)</label>
          <input class="input" id="pgValor" placeholder="Ex: 50,00" />
        </div>
        <div class="field">
          <label>Forma</label>
          <select class="select" id="pgForma">${formasOptions}</select>
        </div>
      </div>

      <div class="field" style="margin-top:10px;">
        <label>Obs</label>
        <input class="input" id="pgObs" placeholder="Opcional" />
      </div>

      <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
        <button class="btn primary" id="btnSalvarPg">Salvar pagamento</button>
        <button class="btn" id="btnFecharVenda">Fechar</button>
      </div>
    </div>

    <div class="card">
      <div style="font-weight:800;">Parcelas</div>
      <div class="table-wrap" style="margin-top:10px;">
        <table class="table">
          <thead>
            <tr>
              <th>Nº</th><th>Venc.</th><th>Valor</th><th>Pago</th><th>Saldo</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${
              parcelas.length
                ? parcelas.map(p => `
                    <tr>
                      <td>${Number(p.numero || 0)}</td>
                      <td>${fmtDateBR(p.vencimento)}</td>
                      <td>${money(p.valor || 0)}</td>
                      <td>${money(p.valor_pago_acumulado || 0)}</td>
                      <td>${money(p.saldo_parcela || 0)}</td>
                      <td>${escapeHtml(p.status || "-")}</td>
                    </tr>
                  `).join("")
                : `<tr><td colspan="6" class="small">Sem parcelas cadastradas.</td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  // default data hoje
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  document.getElementById("pgData").value = `${yyyy}-${mm}-${dd}`;

  document.getElementById("btnFecharVenda").addEventListener("click", () => {
    state.vendaSelecionada = null;
    state.parcelas = [];
    box.innerHTML = "Nenhuma venda selecionada.";
    showToast("", "info");
  });

  document.getElementById("btnSalvarPg").addEventListener("click", async () => {
    const data_pagamento = document.getElementById("pgData").value;
    const valor_pago = Number(String(document.getElementById("pgValor").value || "0").replace(/\./g, "").replace(",", "."));
    const forma = document.getElementById("pgForma").value;
    const observacoes = document.getElementById("pgObs").value.trim() || null;

    if (!data_pagamento) return showToast("Informe a data do pagamento.", "error");
    if (!valor_pago || valor_pago <= 0) return showToast("Valor inválido.", "error");
    if (!forma) return showToast("Selecione a forma.", "error");

    showToast("Salvando pagamento...", "info");
    try {
      await registrarPagamentoRPC({
        venda_id: venda.venda_id,
        data_pagamento,
        valor_pago,
        forma,
        observacoes,
      });

      showToast("Pagamento registrado ✅", "success");

      // recarrega tudo
      state.cred = await loadCrediario();
      renderTabelaCred(document.getElementById("fCred")?.value || "");

      // reabrir venda para atualizar parcelas/valores
      await abrirVenda(venda.venda_id);

    } catch (e) {
      console.error(e);
      showToast(e?.message || "Erro ao registrar pagamento.", "error");
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
        state.formas = await loadFormasEnum();
        state.cred = await loadCrediario();

        renderTabelaCred("");

        document.getElementById("fCred").addEventListener("input", (e) => {
          renderTabelaCred(e.target.value);
        });
      } catch (e) {
        console.error(e);
        showToast(e?.message || "Erro ao iniciar Crediário.", "error");
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
