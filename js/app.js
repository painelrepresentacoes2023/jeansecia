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
  els.navItems.forEach((b) =>
    b.classList.toggle("active", b.dataset.route === route)
  );
}

function getRouteFromHash() {
  const h = (location.hash || "").replace("#", "").trim();
  return h;
}

function setHash(route) {
  // não fica gerando histórico infinito; só troca o hash
  if (location.hash !== `#${route}`) {
    history.replaceState(null, "", `#${route}`);
  }
}

function saveLastRoute(route) {
  localStorage.setItem("ultima_pagina", route);
}

function getInitialRoute() {
  const hashRoute = getRouteFromHash();
  if (hashRoute && routes[hashRoute]) return hashRoute;

  const saved = localStorage.getItem("ultima_pagina");
  if (saved && routes[saved]) return saved;

  return "dashboard";
}

async function go(route, opts = { syncUrl: true, save: true }) {
  const ok = await requireAuth();
  if (!ok) return;

  const finalRoute = routes[route] ? route : "dashboard";
  const r = routes[finalRoute];

  els.pageTitle.textContent = r.title;
  els.breadcrumbs.textContent = r.crumbs;
  setActive(finalRoute);

  if (opts?.save) saveLastRoute(finalRoute);
  if (opts?.syncUrl) setHash(finalRoute);

  els.content.innerHTML = await r.render();
}

// Clique no menu
els.navItems.forEach((btn) =>
  btn.addEventListener("click", () => go(btn.dataset.route))
);

// Logout
els.btnLogout.addEventListener("click", async () => {
  await sb.auth.signOut();
  localStorage.removeItem("ultima_pagina");
  location.href = "./login.html";
});

// Se mudar o hash manualmente (ou voltar/avançar), respeita
window.addEventListener("hashchange", () => {
  const route = getInitialRoute();
  go(route, { syncUrl: true, save: true });
});

// Inicial: abre a última página (ou hash) — NÃO força dashboard
go(getInitialRoute(), { syncUrl: true, save: true });
