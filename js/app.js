import { sb } from "./supabase.js";
import { renderDashboard } from "./pages/dashboard.js";
import { renderProdutos } from "./pages/produtos.js";
import { renderEstoque } from "./pages/estoque.js";
import { renderCompras } from "./pages/compras.js";
import { renderVendas } from "./pages/vendas.js";
import { renderCrediario } from "./pages/crediario.js";

const routes = {
  dashboard: { title: "Dashboard", crumbs: "Visão geral", render: renderDashboard },
  produtos:   { title: "Produtos", crumbs: "Cadastro e organização", render: renderProdutos },
  estoque:    { title: "Estoque", crumbs: "Filtros por categoria, cor e tamanho", render: renderEstoque },
  compras:    { title: "Compras", crumbs: "Entrada de mercadorias", render: renderCompras },
  vendas:     { title: "Vendas", crumbs: "Registro e histórico", render: renderVendas },
  crediario:  { title: "Crediário", crumbs: "Parcelas, alertas e pagamentos", render: renderCrediario },
};

const els = {
  navItems: document.querySelectorAll(".nav-item"),
  pageTitle: document.getElementById("pageTitle"),
  breadcrumbs: document.getElementById("breadcrumbs"),
  content: document.getElementById("appContent"),
  btnLogout: document.getElementById("btnLogout"),
};

async function requireAuth() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    location.href = "./login.html";
    return false;
  }
  return true;
}


function setActive(route) {
  els.navItems.forEach(b => b.classList.toggle("active", b.dataset.route === route));
}

async function go(route) {
  const ok = await requireAuth();
  if (!ok) return;

  const r = routes[route] || routes.dashboard;
  els.pageTitle.textContent = r.title;
  els.breadcrumbs.textContent = r.crumbs;
  setActive(route);
  els.content.innerHTML = await r.render();
}

els.navItems.forEach(btn => btn.addEventListener("click", () => go(btn.dataset.route)));

els.btnLogout.addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

go("dashboard");
