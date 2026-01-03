import { sb } from "../supabase.js";

function money(v = 0) {
  return Number(v || 0).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function calcularFinanceiro(inicio, fim) {
  // 🔹 VENDAS
  const { data: vendas, error: e1 } = await sb
    .from("vendas")
    .select("total")
    .gte("data", inicio)
    .lte("data", fim);

  if (e1) throw e1;

  const totalVendas = (vendas || []).reduce(
    (s, v) => s + Number(v.total || 0),
    0
  );

  // 🔹 COMPRAS / GASTOS
  const { data: compras, error: e2 } = await sb
    .from("compras")
    .select("total")
    .gte("data", inicio)
    .lte("data", fim);

  if (e2) throw e2;

  const totalCompras = (compras || []).reduce(
    (s, c) => s + Number(c.total || 0),
    0
  );

  return {
    totalVendas,
    totalCompras,
    lucro: totalVendas - totalCompras,
  };
}

export async function renderFinanceiro() {
  const hoje = todayISO();

  setTimeout(async () => {
    const btn = document.getElementById("btnAplicarFinanceiro");
    const msg = document.getElementById("finMsg");

    btn.addEventListener("click", async () => {
      const inicio = document.getElementById("finInicio").value;
      const fim = document.getElementById("finFim").value;

      if (!inicio || !fim) {
        msg.textContent = "Selecione o período.";
        return;
      }

      msg.textContent = "Calculando...";

      try {
        const r = await calcularFinanceiro(inicio, fim);

        document.getElementById("finVendas").textContent =
          money(r.totalVendas);
        document.getElementById("finCompras").textContent =
          money(r.totalCompras);
        document.getElementById("finLucro").textContent =
          money(r.lucro);

        msg.textContent = "Resumo atualizado.";
      } catch (e) {
        console.error(e);
        msg.textContent = "Erro ao calcular financeiro.";
      }
    });
  }, 0);

  return `
    <div class="card">
      <div class="card-title">Financeiro</div>
      <div class="card-sub">Resumo de receitas, despesas e lucro</div>

      <div class="grid cols-3" style="margin-top:12px;">
        <div class="field">
          <label>Início</label>
          <input type="date" id="finInicio" value="${hoje}" class="input">
        </div>
        <div class="field">
          <label>Fim</label>
          <input type="date" id="finFim" value="${hoje}" class="input">
        </div>
        <div class="field" style="display:flex;align-items:end;">
          <button class="btn primary" id="btnAplicarFinanceiro">
            Aplicar
          </button>
        </div>
      </div>

      <div class="grid cols-3" style="margin-top:18px;">
        <div class="card">
          <div class="small">Total vendido</div>
          <div class="big" id="finVendas">${money(0)}</div>
        </div>
        <div class="card">
          <div class="small">Total gasto</div>
          <div class="big" id="finCompras">${money(0)}</div>
        </div>
        <div class="card">
          <div class="small">Lucro líquido</div>
          <div class="big" id="finLucro">${money(0)}</div>
        </div>
      </div>

      <div class="small" id="finMsg" style="margin-top:10px;"></div>
    </div>
  `;
}
