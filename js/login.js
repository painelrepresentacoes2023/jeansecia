import { sb } from "./supabase.js";

const form = document.getElementById("loginForm");
const msg = document.getElementById("msg");

function setMsg(text, type="") {
  msg.textContent = text || "";
  msg.className = "login-msg" + (type ? " " + type : "");
}

async function alreadyLogged() {
  const { data } = await sb.auth.getSession();
  if (data?.session) {
    location.href = "./index.html";
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg("Entrando...", "");

  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;

  const { error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    setMsg("Login inválido. Verifique e-mail e senha.", "err");
    return;
  }

  setMsg("Login OK! Redirecionando...", "ok");
  setTimeout(() => (location.href = "./index.html"), 400);
});

alreadyLogged();
