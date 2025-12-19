export async function renderDashboard() {
  return `
    <div class="grid cols-4">
      <div class="card">
        <div class="card-title">Vendas Hoje</div>
        <div class="card-sub">Resumo por data</div>
      </div>
      <div class="card">
        <div class="card-title">Crediário</div>
        <div class="card-sub">Vencidas e a vencer</div>
      </div>
      <div class="card">
        <div class="card-title">Estoque Baixo</div>
        <div class="card-sub">Itens abaixo do mínimo</div>
      </div>
      <div class="card">
        <div class="card-title">Compras</div>
        <div class="card-sub">Últimas entradas</div>
      </div>
    </div>

    <div class="grid cols-2" style="margin-top:14px;">
      <div class="card">
        <div class="card-title">Relatório por período</div>
        <div class="card-sub">Filtro de datas</div>
      </div>
      <div class="card">
        <div class="card-title">Atalhos</div>
        <div class="card-sub">Nova venda / Nova compra / Novo produto</div>
      </div>
    </div>
  `;
}
