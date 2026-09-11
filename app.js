/* Gestão de Sacas — lógica do app (Supabase como banco, sem localStorage) */
(function () {
  "use strict";

  /* ================= SUPABASE CLIENT ================= */
  var CFG = window.GESTAO_SACAS_CONFIG || {};
  if (!CFG.supabaseUrl || CFG.supabaseUrl.indexOf("SEU-PROJETO") !== -1) {
    document.body.innerHTML =
      '<div style="max-width:420px;margin:60px auto;padding:20px;font-family:system-ui;line-height:1.5">' +
      "<h2>Configuração pendente</h2><p>Abra <code>config.js</code> e cole a URL e a anon key do seu projeto " +
      "Supabase (Project Settings &gt; API). Instruções completas no <code>README.md</code>.</p></div>";
    return;
  }
  var sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey);

  /* ================= HELPERS ================= */
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function normSaca(s) { var n = parseInt(s, 10); return isNaN(n) ? null : n; }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); }
  function fmtElapsed(iso) {
    var min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    if (min < 1) return "agora mesmo";
    if (min === 1) return "há 1 min";
    if (min < 60) return "há " + min + " min";
    var h = Math.floor(min / 60);
    return "há " + h + "h" + String(min % 60).padStart(2, "0");
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove("show"); }, 2400);
  }
  function showConfirm(msg, danger, onYes) {
    var ov = document.getElementById("confirmOverlay");
    document.getElementById("confirmMsg").textContent = msg;
    var yesBtn = document.getElementById("confirmYes");
    var noBtn = document.getElementById("confirmNo");
    yesBtn.classList.toggle("danger", !!danger);
    ov.hidden = false;
    function cleanup() { ov.hidden = true; yesBtn.removeEventListener("click", onYesH); noBtn.removeEventListener("click", onNoH); }
    function onYesH() { cleanup(); onYes(); }
    function onNoH() { cleanup(); }
    yesBtn.addEventListener("click", onYesH);
    noBtn.addEventListener("click", onNoH);
  }
  function dbError(err, fallbackMsg) {
    console.error(err);
    toast(fallbackMsg || "Erro ao salvar — tente de novo");
    document.getElementById("connBanner").hidden = false;
  }
  // fetch every page of a query instead of trusting the implicit ~1000-row cap
  async function fetchAll(build) {
    var all = [], from = 0, pageSize = 1000;
    while (true) {
      var { data, error } = await build(from, from + pageSize - 1);
      if (error) { dbError(error); break; }
      if (!data || !data.length) break;
      all = all.concat(data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  var state = { fila: [], liberadas: [], recusadas: [], motoristas: [], session: null };

  /* ================= THEME ================= */
  var SUN_PATH = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>';
  var MOON_PATH = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  function isDarkActive() {
    var t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  function updateThemeIcon() {
    document.getElementById("themeIcon").innerHTML = isDarkActive() ? SUN_PATH : MOON_PATH;
  }
  document.getElementById("themeToggle").addEventListener("click", function () {
    var next = isDarkActive() ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("gs_theme", next); } catch (e) {}
    updateThemeIcon();
  });
  updateThemeIcon();

  /* ---------- date header ---------- */
  var now = new Date();
  document.getElementById("todayNum").textContent =
    String(now.getDate()).padStart(2, "0") + "/" + String(now.getMonth() + 1).padStart(2, "0");
  document.getElementById("todayName").textContent = now.toLocaleDateString("pt-BR", { weekday: "long" });

  /* ================= AUTH ================= */
  var loginScreen = document.getElementById("loginScreen");
  var appEl = document.getElementById("app");
  function showApp() { loginScreen.hidden = true; appEl.classList.add("authed"); }
  function showLogin() { loginScreen.hidden = false; appEl.classList.remove("authed"); }
  function applyRoleUI(perfil) {
    var isGestor = perfil === "gestor";
    document.getElementById("tabRelatorios").hidden = !isGestor;
    document.getElementById("roleChip").hidden = !isGestor;
  }

  async function loadProfileAndEnter(user) {
    var { data, error } = await sb.from("usuarios_sacas").select("*").eq("id", user.id).maybeSingle();
    if (error || !data) {
      document.getElementById("loginError").textContent =
        "Login certo, mas seu perfil não está cadastrado em usuarios_sacas. Peça pro gestor cadastrar.";
      document.getElementById("loginError").classList.add("show");
      await sb.auth.signOut();
      return;
    }
    state.session = { userId: user.id, nome: data.nome, perfil: data.perfil };
    applyRoleUI(data.perfil);
    showApp();
    renderAll();
    startPolling();
  }

  // o Supabase Auth exige e-mail; a pessoa só digita um usuário, e a gente
  // completa com um domínio fixo por trás dos panos antes de mandar pro login
  var AUTH_DOMAIN = "gestaosacas.local";
  function toAuthEmail(usuario) {
    var clean = usuario.trim().toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9.\-_]/g, "");
    return clean + "@" + AUTH_DOMAIN;
  }

  document.getElementById("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    var email = toAuthEmail(document.getElementById("loginUser").value);
    var pass = document.getElementById("loginPass").value;
    var err = document.getElementById("loginError");
    var btn = document.getElementById("loginBtn");
    err.classList.remove("show");
    btn.disabled = true; btn.textContent = "Entrando…";
    var { data, error } = await sb.auth.signInWithPassword({ email: email, password: pass });
    btn.disabled = false; btn.textContent = "Entrar";
    if (error || !data.user) {
      err.textContent = "Usuário ou senha inválidos.";
      err.classList.add("show");
      return;
    }
    document.getElementById("loginPass").value = "";
    await loadProfileAndEnter(data.user);
  });

  document.getElementById("logoutBtn").addEventListener("click", function () {
    showConfirm("Sair do sistema?", false, async function () {
      stopPolling();
      await sb.auth.signOut();
      state.session = null;
      showLogin();
    });
  });

  /* ================= TABS ================= */
  var panels = document.querySelectorAll("section[data-panel]");
  document.getElementById("tabbar").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-go]");
    if (!b) return;
    go(b.dataset.go);
  });
  function go(name) {
    if (name === "relatorios" && document.getElementById("tabRelatorios").hidden) return;
    panels.forEach(function (p) { p.classList.toggle("active", p.dataset.panel === name); });
    document.querySelectorAll("#tabbar button").forEach(function (b) { b.classList.toggle("active", b.dataset.go === name); });
    window.scrollTo(0, 0);
    if (name === "relatorios") { renderReportLiberadas(); renderReportRecusadas(); }
  }
  document.getElementById("reportPilltabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-rsub]");
    if (!b) return;
    document.querySelectorAll("#reportPilltabs button").forEach(function (x) { x.classList.toggle("active", x === b); });
    document.querySelectorAll(".subpanel[data-rsub]").forEach(function (p) { p.classList.toggle("active", p.dataset.rsub === b.dataset.rsub); });
  });
  document.getElementById("reportLibModeToggle").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-mode]");
    if (!b) return;
    document.querySelectorAll("#reportLibModeToggle button").forEach(function (x) { x.classList.toggle("active", x === b); });
    reportLibMode = b.dataset.mode;
    renderReportLiberadas();
  });

  /* ================= DRIVER MEMORY ================= */
  async function refreshMotoristasCache() {
    var { data, error } = await sb.from("motoristas").select("*").order("vezes", { ascending: false });
    if (error) { dbError(error); return; }
    state.motoristas = data || [];
  }
  async function rememberDriver(nome) {
    nome = nome.trim();
    if (!nome) return;
    var dia = todayKey();
    var hit = state.motoristas.find(function (m) { return m.nome.toLowerCase() === nome.toLowerCase(); });
    if (hit) {
      var { error } = await sb.from("motoristas").update({ vezes: (hit.vezes || 0) + 1, ultima_vez: dia }).eq("id", hit.id);
      if (error) { dbError(error); return; }
    } else {
      var { error: e2 } = await sb.from("motoristas").insert({ nome: nome, vezes: 1, ultima_vez: dia });
      if (e2) { dbError(e2); return; }
    }
    await refreshMotoristasCache();
  }
  async function ensureDriverListed(nome) {
    nome = nome.trim();
    if (!nome) return;
    var hit = state.motoristas.find(function (m) { return m.nome.toLowerCase() === nome.toLowerCase(); });
    if (hit) return;
    var { error } = await sb.from("motoristas").insert({ nome: nome, vezes: 0, ultima_vez: todayKey() });
    if (error && error.code !== "23505") { dbError(error); return; }
    await refreshMotoristasCache();
  }

  /* ================= AUTOCOMPLETE (Fila) ================= */
  var drv = document.getElementById("drv");
  var acList = document.getElementById("acList");
  var acCursor = -1;

  function acRender(q) {
    q = q.trim().toLowerCase();
    var pool = state.motoristas;
    var matches = q ? pool.filter(function (m) { return m.nome.toLowerCase().indexOf(q) !== -1; }) : pool.slice(0, 6);
    if (!matches.length || (matches.length === 1 && matches[0].nome.toLowerCase() === q)) { acList.hidden = true; return; }
    acCursor = -1;
    acList.innerHTML = matches.slice(0, 8).map(function (m) {
      var name = esc(m.nome);
      if (q) {
        var i = m.nome.toLowerCase().indexOf(q);
        if (i !== -1) name = esc(m.nome.slice(0, i)) + "<mark>" + esc(m.nome.slice(i, i + q.length)) + "</mark>" + esc(m.nome.slice(i + q.length));
      }
      var seen = m.vezes ? m.vezes + "x" : "novo";
      return '<button type="button" class="ac-item" data-name="' + esc(m.nome) + '"><span>' + name + "</span><small>" + seen + "</small></button>";
    }).join("");
    acList.hidden = false;
  }
  drv.addEventListener("input", function () { acRender(drv.value); });
  drv.addEventListener("focus", function () { acRender(drv.value); });
  drv.addEventListener("blur", function () { setTimeout(function () { acList.hidden = true; }, 150); });
  drv.addEventListener("keydown", function (e) {
    if (acList.hidden) return;
    var items = acList.querySelectorAll(".ac-item");
    if (e.key === "ArrowDown") { e.preventDefault(); acCursor = Math.min(acCursor + 1, items.length - 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); acCursor = Math.max(acCursor - 1, 0); }
    else if (e.key === "Enter" && acCursor >= 0) { e.preventDefault(); items[acCursor].click(); return; }
    else return;
    items.forEach(function (it, i) { it.classList.toggle("cursor", i === acCursor); });
  });
  acList.addEventListener("mousedown", function (e) {
    var it = e.target.closest(".ac-item");
    if (!it) return;
    e.preventDefault();
    drv.value = it.dataset.name;
    acList.hidden = true;
    document.getElementById("bag").focus();
  });

  /* ================= FILA: add to queue ================= */
  var filaForm = document.getElementById("filaForm");
  var bag = document.getElementById("bag");
  bag.addEventListener("input", function () { bag.value = bag.value.replace(/\D/g, "").slice(0, 3); });

  async function checkSacaConflict(sacaNum) {
    var dia = todayKey();
    var { data: pend } = await sb.from("fila").select("id,motorista").eq("dia", dia).eq("saca", sacaNum).limit(1);
    if (pend && pend.length) return { type: "pending", with: pend[0] };
    var { data: taken } = await sb.from("registros").select("id,motorista").eq("dia", dia).eq("saca", sacaNum).eq("status", "levou").limit(1);
    if (taken && taken.length) return { type: "taken", with: taken[0] };
    return null;
  }

  filaForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var nome = drv.value.trim();
    var raw = bag.value.trim();
    var ok = true;
    drv.classList.remove("field-error"); bag.classList.remove("field-error");
    if (!nome) { drv.classList.add("field-error"); ok = false; }
    var sacaNum = normSaca(raw);
    if (sacaNum === null || sacaNum < 1 || sacaNum > 999) { bag.classList.add("field-error"); ok = false; }
    if (!ok) { toast("Preencha o nome e a saca (1 a 999)"); return; }

    var submitBtn = document.getElementById("filaSubmitBtn");
    submitBtn.disabled = true;
    var conflict = await checkSacaConflict(sacaNum);
    submitBtn.disabled = false;

    if (conflict && conflict.type === "pending") {
      toast("Saca " + sacaNum + " já está na fila, aguardando liberação");
      return;
    }
    if (conflict && conflict.type === "taken") {
      showConfirm("A saca " + sacaNum + " já foi liberada hoje para " + conflict.with.motorista + ". Adicionar mesmo assim?", true, function () {
        addToQueue(nome, sacaNum);
      });
      return;
    }
    addToQueue(nome, sacaNum);
  });

  async function addToQueue(nome, sacaNum) {
    var submitBtn = document.getElementById("filaSubmitBtn");
    submitBtn.disabled = true;
    var { error } = await sb.from("fila").insert({ motorista: nome, saca: sacaNum, dia: todayKey() });
    submitBtn.disabled = false;
    if (error) { dbError(error, "Não deu pra adicionar à fila"); return; }
    await rememberDriver(nome);
    filaForm.reset();
    acList.hidden = true;
    await renderAll();
    toast("Saca " + sacaNum + " · " + nome + " entrou na fila");
    drv.focus();
  }

  /* ================= RENDER: QUEUE (Fila tab) ================= */
  async function fetchTodayFila() {
    return fetchAll(function (from, to) {
      return sb.from("fila").select("*").eq("dia", todayKey()).order("criado_em", { ascending: true }).range(from, to);
    });
  }
  function renderQueue() {
    var items = state.fila;
    var wrap = document.getElementById("queueList");
    document.getElementById("filaCount").textContent = items.length ? "(" + items.length + ")" : "";
    if (!items.length) { wrap.innerHTML = '<div class="empty">Ninguém na fila no momento.</div>'; return; }
    wrap.innerHTML = items.map(function (f) {
      if (f.saca) {
        return '<div class="queue-row" data-id="' + f.id + '">' +
          '<div class="tag">' + esc(f.saca) + "</div>" +
          '<div class="who"><b>' + esc(f.motorista) + '</b><div class="meta elapsed" data-ts="' + f.criado_em + '">' + fmtElapsed(f.criado_em) + "</div></div>" +
          '<button class="row-del" data-del="' + f.id + '">remover</button>' +
        "</div>";
      }
      return '<div class="pending-row" data-id="' + f.id + '">' +
        '<div class="pr-top"><div class="who"><b>' + esc(f.motorista) + '</b>' +
          '<div class="meta elapsed" data-ts="' + f.criado_em + '">aguardando saca · ' + fmtElapsed(f.criado_em) + "</div></div></div>" +
        '<div class="pr-actions">' +
          '<input class="input pr-bag" inputmode="numeric" pattern="[0-9]*" maxlength="3" placeholder="nº da saca">' +
          '<button type="button" class="pr-ok-btn" data-set-saca="' + f.id + '">OK</button>' +
          '<button type="button" class="pr-absent-btn" data-ausente="' + f.id + '">Ausente</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }
  document.getElementById("queueList").addEventListener("input", function (e) {
    if (e.target.classList.contains("pr-bag")) e.target.value = e.target.value.replace(/\D/g, "").slice(0, 3);
  });
  document.getElementById("queueList").addEventListener("click", async function (e) {
    var delId = e.target.getAttribute("data-del");
    if (delId) {
      var it = state.fila.find(function (f) { return f.id === delId; });
      if (!it) return;
      showConfirm('Remover "' + it.motorista + '" (saca ' + it.saca + ") da fila?", false, async function () {
        var { error } = await sb.from("fila").delete().eq("id", delId);
        if (error) { dbError(error); return; }
        await renderAll();
      });
      return;
    }
    var absentId = e.target.getAttribute("data-ausente");
    if (absentId) {
      var it2 = state.fila.find(function (f) { return f.id === absentId; });
      if (!it2) return;
      showConfirm('Marcar "' + it2.motorista + '" como ausente? Ele sai da fila.', true, async function () {
        var { error } = await sb.from("fila").delete().eq("id", absentId);
        if (error) { dbError(error); return; }
        await renderAll();
        toast(it2.motorista + " marcado como ausente");
      });
      return;
    }
    var setId = e.target.getAttribute("data-set-saca");
    if (setId) {
      var row = e.target.closest(".pending-row");
      var input = row.querySelector(".pr-bag");
      var sacaNum = normSaca(input.value.trim());
      if (sacaNum === null || sacaNum < 1 || sacaNum > 999) {
        input.classList.add("field-error");
        toast("Digite a saca (1 a 999)");
        return;
      }
      input.classList.remove("field-error");
      e.target.disabled = true;
      var conflict = await checkSacaConflict(sacaNum);
      e.target.disabled = false;
      if (conflict && conflict.type === "pending") {
        toast("Saca " + sacaNum + " já está na fila, aguardando liberação");
        return;
      }
      if (conflict && conflict.type === "taken") {
        showConfirm("A saca " + sacaNum + " já foi liberada hoje para " + conflict.with.motorista + ". Confirma mesmo assim?", true, async function () {
          await saveSacaForFila(setId, sacaNum);
        });
        return;
      }
      await saveSacaForFila(setId, sacaNum);
    }
  });
  async function saveSacaForFila(id, sacaNum) {
    var { error } = await sb.from("fila").update({ saca: sacaNum }).eq("id", id);
    if (error) { dbError(error, "Não deu pra salvar a saca"); return; }
    await renderAll();
    toast("Saca " + sacaNum + " definida — pronta pra liberar");
  }

  /* ================= RENDER: RESOLVE (Liberar tab) ================= */
  var resolveList = document.getElementById("resolveList");
  var resolveSearch = document.getElementById("resolveSearch");

  function missRowHTML() {
    return '<div class="miss-row">' +
      '<input class="input qtd" inputmode="numeric" pattern="[0-9]*" placeholder="Qtd" maxlength="3">' +
      '<div class="code-wrap"><b>NX</b><input class="mcode" inputmode="numeric" pattern="[0-9]*" placeholder="número" maxlength="8"></div>' +
      '<button type="button" class="del" aria-label="remover">&times;</button>' +
    "</div>";
  }

  function renderResolve() {
    var q = resolveSearch.value.trim().toLowerCase();
    var ready = state.fila.filter(function (f) { return f.saca; });
    var items = ready.filter(function (f) {
      return !q || f.motorista.toLowerCase().indexOf(q) !== -1 || String(f.saca).indexOf(q) !== -1;
    });
    if (!items.length) {
      resolveList.innerHTML = '<div class="empty">' + (ready.length ? "Nada encontrado para essa busca." : "Ninguém com saca definida aguardando liberação.") + "</div>";
      return;
    }
    resolveList.innerHTML = items.map(function (f) {
      return '<div class="resolve-row" data-id="' + f.id + '">' +
        '<div class="rr-top"><div class="tag">' + esc(f.saca) + '</div>' +
        '<div class="who"><b>' + esc(f.motorista) + '</b><div class="meta elapsed" data-ts="' + f.criado_em + '">aguardando ' + fmtElapsed(f.criado_em) + "</div></div></div>" +
        '<div class="rr-actions">' +
          '<button type="button" class="rr-btn ok" data-act="levou">Levou</button>' +
          '<button type="button" class="rr-btn no" data-act="recusou">Recusou</button>' +
        "</div>" +
      "</div>";
    }).join("");
  }
  resolveSearch.addEventListener("input", renderResolve);

  resolveList.addEventListener("click", async function (e) {
    var act = e.target.getAttribute("data-act");
    if (!act) return;
    var row = e.target.closest(".resolve-row");
    var id = row.dataset.id;
    var f = state.fila.find(function (x) { return x.id === id; });
    if (!f) return;
    row.querySelectorAll(".rr-btn").forEach(function (b) { b.disabled = true; });
    await resolveEntry(f, act);
  });

  async function resolveEntry(f, status) {
    var { error: delErr } = await sb.from("fila").delete().eq("id", f.id);
    if (delErr) { dbError(delErr); return; }
    var { error: insErr } = await sb.from("registros").insert({
      motorista: f.motorista, saca: f.saca, status: status, faltantes: [],
      dia: f.dia, ts_fila: f.criado_em, ts_resolvido: new Date().toISOString()
    });
    if (insErr) { dbError(insErr, "Não deu pra registrar — a saca voltou pra fila"); await sb.from("fila").insert(f); await renderAll(); return; }
    await renderAll();
    toast(status === "levou"
      ? "Saca " + f.saca + " liberada para " + f.motorista + " — confira os pacotes com ele"
      : "Saca " + f.saca + " marcada como recusada");
  }

  /* ================= RENDER: LIBERADAS ================= */
  var liberadasSearch = document.getElementById("liberadasSearch");
  async function fetchTodayLiberadas() {
    return fetchAll(function (from, to) {
      return sb.from("registros").select("*").eq("dia", todayKey()).eq("status", "levou")
        .order("motorista", { ascending: true }).range(from, to);
    });
  }
  function renderLiberadas() {
    var q = liberadasSearch.value.trim().toLowerCase();
    var all = state.liberadas;
    var items = q
      ? all.filter(function (r) { return r.motorista.toLowerCase().indexOf(q) !== -1 || String(r.saca).indexOf(q) !== -1; })
      : all;
    var wrap = document.getElementById("liberadasList");
    if (!items.length) {
      wrap.innerHTML = '<div class="empty">' + (all.length ? "Nada encontrado para essa busca." : "Nenhuma liberação ainda hoje.") + "</div>";
      return;
    }
    wrap.innerHTML = items.map(function (r) { return entryHTML(r, true); }).join("");
  }
  liberadasSearch.addEventListener("input", renderLiberadas);

  function entryHTML(r, editable) {
    var chip = r.status === "levou" ? '<span class="chip ok">Levou</span>' : '<span class="chip no">Recusou</span>';
    var miss = r.faltantes && r.faltantes.length
      ? '<div class="miss-tags">' + r.faltantes.map(function (fx) { return '<span class="miss-tag">' + esc(fx.codigo) + " ×" + fx.qtd + "</span>"; }).join("") + "</div>"
      : "";
    var report = "";
    if (editable && r.status === "levou") {
      var linkLabel = r.faltantes && r.faltantes.length ? "+ reportar outro pacote" : "+ pacote faltante";
      report = '<button type="button" class="link-btn miss-link">' + linkLabel + "</button>" +
        '<div class="miss-box"><div class="missRowsInline"></div>' +
          '<button type="button" class="link-btn add-miss-inline">+ adicionar outro código</button>' +
          '<button type="button" class="btn-ghost save-miss" style="margin-top:10px">Salvar pacote faltante</button>' +
        "</div>";
    }
    return '<div class="entry" data-id="' + r.id + '">' +
      '<div class="tag">' + esc(r.saca) + "</div>" +
      '<div class="who"><b>' + esc(r.motorista) + "</b>" +
        '<div class="meta">' + chip + " · " + fmtTime(r.ts_resolvido) + "</div>" + miss + "</div>" +
      '<button class="row-del" data-del="' + r.id + '">excluir</button>' +
      report +
    "</div>";
  }

  document.getElementById("liberadasList").addEventListener("click", async function (e) {
    var wrap = e.target.closest(".entry");
    if (!wrap) return;
    var id = wrap.dataset.id;

    if (e.target.classList.contains("miss-link")) {
      var box = wrap.querySelector(".miss-box");
      var rows = wrap.querySelector(".missRowsInline");
      box.classList.toggle("show");
      if (box.classList.contains("show") && !rows.children.length) rows.insertAdjacentHTML("beforeend", missRowHTML());
      return;
    }
    if (e.target.classList.contains("add-miss-inline")) {
      wrap.querySelector(".missRowsInline").insertAdjacentHTML("beforeend", missRowHTML());
      return;
    }
    if (e.target.classList.contains("del")) {
      e.target.closest(".miss-row").remove();
      return;
    }
    if (e.target.classList.contains("save-miss")) {
      var novos = [];
      wrap.querySelectorAll(".missRowsInline .miss-row").forEach(function (mr) {
        var qv = parseInt(mr.querySelector(".qtd").value, 10);
        var cv = mr.querySelector(".mcode").value.trim().replace(/\D/g, "");
        if ((qv > 0) || cv) novos.push({ qtd: qv > 0 ? qv : 1, codigo: "NX" + cv });
      });
      if (!novos.length) { toast("Informe a quantidade ou o código do pacote"); return; }
      var reg = state.liberadas.find(function (r) { return r.id === id; });
      var merged = (reg.faltantes || []).concat(novos);
      var { error } = await sb.from("registros").update({ faltantes: merged }).eq("id", id);
      if (error) { dbError(error); return; }
      await renderAll();
      toast("Pacote faltante registrado na saca " + reg.saca);
      return;
    }
    handleEntryDelete(e);
  });
  document.getElementById("refusedList").addEventListener("click", handleEntryDelete);
  function handleEntryDelete(e) {
    var id = e.target.getAttribute("data-del");
    if (!id) return;
    showConfirm("Excluir este registro? A saca sai do histórico de hoje.", true, async function () {
      var { error } = await sb.from("registros").delete().eq("id", id);
      if (error) { dbError(error); return; }
      await renderAll();
    });
  }

  /* ================= RENDER: RECUSADAS ================= */
  async function fetchTodayRecusadas() {
    return fetchAll(function (from, to) {
      return sb.from("registros").select("*").eq("dia", todayKey()).eq("status", "recusou")
        .order("ts_resolvido", { ascending: false }).range(from, to);
    });
  }
  function renderRefused() {
    var wrap = document.getElementById("refusedList");
    wrap.innerHTML = state.recusadas.length ? state.recusadas.map(function (r) { return entryHTML(r, false); }).join("") : '<div class="empty">Nenhuma saca recusada hoje.</div>';
  }

  /* ================= STAT BAR ================= */
  function renderStats() {
    document.getElementById("sWait").textContent = state.fila.length;
    document.getElementById("sOk").textContent = state.liberadas.length;
    document.getElementById("sNo").textContent = state.recusadas.length;
    var ready = state.fila.filter(function (f) { return f.saca; }).length;
    var badge = document.getElementById("tabWaitBadge");
    badge.hidden = ready === 0;
    badge.textContent = ready;
  }

  /* ================= ELAPSED TICKER ================= */
  setInterval(function () {
    document.querySelectorAll(".elapsed").forEach(function (el) {
      var prefix = el.textContent.indexOf("aguardando") === 0 ? "aguardando " : "";
      el.textContent = prefix + fmtElapsed(el.dataset.ts);
    });
  }, 20000);

  /* ---------- lista colada: um nome de motorista por linha, direto pra Fila ---------- */
  function parsePastedNames(text) {
    return (text || "")
      .split(/\r?\n/)
      .map(function (line) { return line.replace(/^\s*[-•*\d]+[.)]?\s*/, "").trim(); })
      .filter(function (line) { return line.length > 1; });
  }

  document.getElementById("addPasted").addEventListener("click", async function () {
    var ta = document.getElementById("pasteNames");
    var names = parsePastedNames(ta.value);
    if (!names.length) { toast("Cole ao menos um nome"); return; }
    var btn = this;
    btn.disabled = true;
    var existing = state.fila.map(function (f) { return f.motorista.toLowerCase(); });
    var added = 0, skipped = 0;
    for (var i = 0; i < names.length; i++) {
      var nome = names[i];
      if (existing.indexOf(nome.toLowerCase()) !== -1) { skipped++; continue; }
      await ensureDriverListed(nome);
      var { error } = await sb.from("fila").insert({ motorista: nome, saca: null, dia: todayKey() });
      if (error) { dbError(error); continue; }
      existing.push(nome.toLowerCase());
      added++;
    }
    btn.disabled = false;
    ta.value = "";
    await renderAll();
    toast((added ? added + " nome(s) adicionado(s) à fila" : "Nenhum nome novo") + (skipped ? " · " + skipped + " já estavam na fila" : ""));
  });

  /* ================= RELATÓRIOS (gestor) ================= */
  var MESES_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
    "agosto", "setembro", "outubro", "novembro", "dezembro"];
  var reportLibMode = "dia";

  function fmtDateLabel(k) {
    var p = k.split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var label = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    return k === todayKey() ? label + " · hoje" : label;
  }
  function fmtMonthLabel(k) {
    var p = k.split("-");
    var name = MESES_PT[+p[1] - 1] || "";
    return name.charAt(0).toUpperCase() + name.slice(1) + " de " + p[0];
  }

  async function renderReportLiberadas() {
    var wrap = document.getElementById("reportLibList");
    wrap.innerHTML = '<div class="empty">Carregando…</div>';
    var all = await fetchAll(function (from, to) {
      return sb.from("registros").select("id,dia").eq("status", "levou").range(from, to);
    });
    document.getElementById("reportLibTotal").textContent = all.length;
    if (!all.length) { wrap.innerHTML = '<div class="empty">Nenhuma saca liberada registrada ainda.</div>'; return; }
    var groups = {};
    all.forEach(function (r) {
      var key = reportLibMode === "dia" ? r.dia : String(r.dia).slice(0, 7);
      groups[key] = (groups[key] || 0) + 1;
    });
    var keys = Object.keys(groups).sort().reverse();
    wrap.innerHTML = keys.map(function (k) {
      var label = reportLibMode === "dia" ? fmtDateLabel(k) : fmtMonthLabel(k);
      return '<div class="report-row"><span>' + esc(label) + "</span><b>" + groups[k] + "</b></div>";
    }).join("");
  }

  async function renderReportRecusadas() {
    var wrap = document.getElementById("reportRecList");
    wrap.innerHTML = '<div class="empty">Carregando…</div>';
    var all = await fetchAll(function (from, to) {
      return sb.from("registros").select("motorista,dia,saca,ts_resolvido").eq("status", "recusou").range(from, to);
    });
    document.getElementById("reportRecTotal").textContent = all.length;
    if (!all.length) { wrap.innerHTML = '<div class="empty">Nenhuma saca recusada registrada ainda.</div>'; return; }
    var byDriver = {};
    all.forEach(function (r) { (byDriver[r.motorista] = byDriver[r.motorista] || []).push(r); });
    var names = Object.keys(byDriver).sort(function (a, b) {
      return byDriver[b].length - byDriver[a].length || a.localeCompare(b, "pt-BR");
    });
    wrap.innerHTML = names.map(function (n) {
      var list = byDriver[n].slice().sort(function (a, b) { return new Date(b.ts_resolvido) - new Date(a.ts_resolvido); });
      var sub = list.map(function (r) {
        return '<div class="report-sub-row">' + fmtDateLabel(r.dia) + " · saca " + esc(r.saca) + "</div>";
      }).join("");
      return '<div class="report-driver" data-name="' + esc(n) + '">' +
        '<button type="button" class="report-driver-head"><span>' + esc(n) + '</span>' +
          '<span class="rd-meta"><b>' + list.length + '</b>' +
          '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"/></svg></span></button>' +
        '<div class="report-driver-body">' + sub + "</div>" +
      "</div>";
    }).join("");
  }
  document.getElementById("reportRecList").addEventListener("click", function (e) {
    var head = e.target.closest(".report-driver-head");
    if (!head) return;
    head.closest(".report-driver").classList.toggle("open");
  });

  /* ================= INIT / POLLING ================= */
  async function renderAll() {
    var results = await Promise.all([fetchTodayFila(), fetchTodayLiberadas(), fetchTodayRecusadas()]);
    state.fila = results[0]; state.liberadas = results[1]; state.recusadas = results[2];
    document.getElementById("connBanner").hidden = true;
    renderStats();
    renderQueue();
    renderResolve();
    renderLiberadas();
    renderRefused();
  }

  var pollTimer = null;
  function startPolling() {
    stopPolling();
    // catches changes made from another device at the same ponto
    pollTimer = setInterval(function () {
      if (!state.session) return;
      var active = document.querySelector("section[data-panel].active");
      if (active && (active.dataset.panel === "fila" || active.dataset.panel === "liberar")) renderAll();
    }, 25000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  (async function init() {
    await refreshMotoristasCache();
    var { data } = await sb.auth.getSession();
    if (data && data.session && data.session.user) {
      await loadProfileAndEnter(data.session.user);
    } else {
      showLogin();
    }
  })();
})();
