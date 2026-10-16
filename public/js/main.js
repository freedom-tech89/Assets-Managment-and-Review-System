// Login, logout and page routing (#/dashboard, #/category/<name>, #/platform/<name>[/<category>],
// #/client/<name>, #/review/<client>, #/admin).
(() => {
  const loginView = $("loginView"), appView = $("appView");

  function showLogin(defaultPassword) {
    appView.hidden = true;
    loginView.hidden = false;
    $("loginHint").hidden = !defaultPassword;
    $("loginPassword").focus();
  }

  function route() {
    const [hashPath, hashQuery = ""] = location.hash.split("?");
    const [, page, arg] = hashPath.match(/^#\/([^/]+)\/?(.*)$/) || [];
    const [name, sub] = (arg || "").split("/").map((x) => decodeURIComponent(x || ""));
    const isAdmin = page === "admin";
    $("adminView").hidden = !isAdmin;
    $("dashView").hidden = isAdmin;
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === (isAdmin ? "admin" : page === "sips" ? "sips" : "dashboard")));
    window.scrollTo(0, 0);
    if (page !== "review") ReviewPage.leave();
    if (isAdmin) { document.title = "Admin Panel · Upload Details"; return Admin.show(); }
    if (page === "platform" && name) { document.title = `${name} · Upload Details`; return Dashboard.scope({ platform: name, product: sub }); }
    if (page === "sips") { document.title = "SIPs · Upload Details"; return Dashboard.sips(hashQuery); }
    if (page === "category" && name) { document.title = `${name} · Upload Details`; return Dashboard.scope({ product: name }); }
    if (page === "review" && name) { document.title = `Review Report · ${name} · Upload Details`; return ReviewPage.show(name); }
    if (page === "client" && name) { document.title = `${name} · Upload Details`; return Dashboard.client(name); }
    document.title = "Dashboard · Upload Details";
    if (location.hash !== "#/dashboard") history.replaceState(null, "", "#/dashboard");
    return Dashboard.home();
  }

  $("appVersion").textContent = `Version ${APP_VERSION}`;

  function enterApp() {
    loginView.hidden = true;
    appView.hidden = false;
    route();
  }

  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("loginMsg").textContent = "";
    try {
      await api("POST", "/login", { password: $("loginPassword").value });
      $("loginPassword").value = "";
      enterApp();
    } catch (err) {
      $("loginMsg").textContent = err.message;
    }
  });

  $("logoutBtn").addEventListener("click", async () => {
    await api("POST", "/logout").catch(() => {});
    showLogin(false);
  });

  window.addEventListener("logged-out", () => showLogin(false));
  window.addEventListener("hashchange", () => { if (!appView.hidden) route(); });

  api("GET", "/session")
    .then((s) => {
      if (!s.configured) {
        loginView.hidden = false;
        $("loginMsg").textContent = "This deployment has no ADMIN_PASSWORD set yet. Add it in the hosting settings and redeploy.";
        return;
      }
      s.loggedIn ? enterApp() : showLogin(s.defaultPassword);
    })
    .catch((e) => {
      loginView.hidden = false;
      $("loginMsg").textContent = `Can't reach the server: ${e.message}`;
    });
})();
