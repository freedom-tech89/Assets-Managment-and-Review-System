// Admin panel: choose Client Wise or Platform Wise, pick an AUM and/or SIP file for any platform
// + category in the matrix, then "Upload All". Files are read in the browser (js/extract.js);
// each file and the rows read from it are saved as the next version for that platform + category,
// so earlier uploads are kept.
const Admin = (() => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.js";

  const MAX_BYTES = 4 * 1024 * 1024; // matches the server limit
  // File signatures, so a renamed file can't slip through on its extension alone.
  const FORMATS = {
    ".pdf": { format: "pdf", sig: [0x25, 0x50, 0x44, 0x46], type: "application/pdf" },
    ".xlsx": { format: "xlsx", sig: [0x50, 0x4b, 0x03, 0x04], type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    ".xls": { format: "xls", sig: [0xd0, 0xcf, 0x11, 0xe0], type: "application/vnd.ms-excel" },
  };
  const KIND_LABEL = { aum: "AUM", sip: "SIP" };

  let uploadType = "client";
  let platforms = [];      // [{id, name, product}]
  let products = [];
  let history = [];
  const picked = new Map(); // "platformId:kind" -> File
  let lastBatch = null;
  let busy = false;

  const el = {
    client: $("clientName"), clientField: $("clientField"), snap: $("snapDate"), pdfPassword: $("pdfPassword"),
    rows: $("matrixRows"), scopeLabel: $("scopeLabel"), msg: $("uploadMsg"), uploadAll: $("uploadAllBtn"), clearAll: $("clearAllBtn"),
    history: $("historyRows"), historyFor: $("historyFor"),
    addBtn: $("addPlatformBtn"), addForm: $("addPlatformForm"), newName: $("newPlatformName"), newProduct: $("newPlatformProduct"),
    platformMsg: $("platformMsg"),
    modal: $("resultModal"), resultSub: $("resultSub"), resultRows: $("resultRows"), resultMsg: $("resultMsg"),
  };
  const setMsg = (box, text, kind = "") => { box.textContent = text; box.className = "msg " + kind; };

  // ---- Upload type --------------------------------------------------------------------
  document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    uploadType = b.dataset.type;
    document.querySelectorAll(".seg-btn").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-selected", String(x === b));
    });
    el.clientField.hidden = uploadType !== "client";
    refreshHistory();
    if (uploadType === "client") el.client.focus();
  }));
  el.client.addEventListener("input", debounce(refreshHistory));

  // ---- Matrix -------------------------------------------------------------------------
  function renderMatrix() {
    if (!platforms.length) {
      el.rows.innerHTML = `<tr class="empty"><td colspan="5">No platforms yet. Use "+ Add platform".</td></tr>`;
      return;
    }
    let html = "";
    for (const prod of products) {
      const list = platforms.filter((p) => p.product === prod);
      if (!list.length) continue;
      html += `<tr class="grp"><td colspan="5">${esc(prod)}</td></tr>`;
      for (const p of list) {
        html += `<tr data-pid="${p.id}"><td class="cat">${esc(prod)}</td><td><b>${esc(p.name)}</b></td>
          <td>${pickCell(p, "aum")}</td><td>${pickCell(p, "sip")}</td><td class="last">${lastUpdate(p)}</td></tr>`;
      }
    }
    el.rows.innerHTML = html;
    updateCount();
  }

  function pickCell(p, kind) {
    const id = `f_${p.id}_${kind}`, file = picked.get(`${p.id}:${kind}`);
    return `<span class="pick ${file ? "has" : ""}" data-key="${p.id}:${kind}">
      <input type="file" id="${id}" accept=".xlsx,.xls,.pdf" data-key="${p.id}:${kind}"
        aria-label="${esc(KIND_LABEL[kind])} file for ${esc(p.name)} ${esc(p.product)}">
      <label for="${id}" title="${file ? esc(file.name) : ""}">${file ? esc(file.name) : `Choose ${KIND_LABEL[kind]} file`}</label>
      ${file ? `<button type="button" class="x" data-clear="${p.id}:${kind}" aria-label="Remove file">×</button>` : ""}
    </span>`;
  }

  // Latest AUM and SIP version for this platform + category, for the chosen client (Client Wise)
  // or from bulk files (Platform Wise).
  function lastUpdate(p) {
    const parts = ["aum", "sip"].map((kind) => {
      const u = history.find((h) => h.platform.toLowerCase() === p.name.toLowerCase() && h.product === p.product && h.kind === kind);
      return u ? `${KIND_LABEL[kind]} <b>v${u.version}</b> · ${esc(fmt.date(u.snapshotDate))}` : null;
    }).filter(Boolean);
    return parts.length ? parts.join("<br>") : "Not uploaded yet";
  }

  el.rows.addEventListener("change", (e) => {
    const input = e.target;
    if (input.type !== "file" || !input.files.length) return;
    const file = input.files[0];
    const problem = checkFileBasics(file);
    if (problem) { setMsg(el.msg, `${file.name}: ${problem}`, "err"); input.value = ""; return; }
    picked.set(input.dataset.key, file);
    setMsg(el.msg, "");
    replaceCell(input.dataset.key);
  });
  el.rows.addEventListener("click", (e) => {
    const k = e.target.dataset.clear;
    if (!k) return;
    picked.delete(k);
    replaceCell(k);
  });

  function replaceCell(k) {
    const [pid, kind] = k.split(":");
    const p = platforms.find((x) => String(x.id) === pid);
    const span = el.rows.querySelector(`.pick[data-key="${k}"]`);
    if (span && p) span.outerHTML = pickCell(p, kind);
    updateCount();
  }

  function updateCount() {
    const n = picked.size;
    el.uploadAll.disabled = busy || !n;
    el.uploadAll.textContent = n ? `Upload All (${n} file${n === 1 ? "" : "s"})` : "Upload All";
  }

  el.clearAll.addEventListener("click", () => { picked.clear(); renderMatrix(); setMsg(el.msg, ""); });

  // ---- Add platform -------------------------------------------------------------------
  el.addBtn.addEventListener("click", () => { el.addForm.hidden = false; el.newName.focus(); });
  $("cancelPlatformBtn").addEventListener("click", () => { el.addForm.hidden = true; setMsg(el.platformMsg, ""); });
  el.addForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("POST", "/platforms", { name: el.newName.value, product: el.newProduct.value });
      el.newName.value = "";
      el.addForm.hidden = true;
      setMsg(el.platformMsg, "");
      await loadMeta();
    } catch (err) { setMsg(el.platformMsg, err.message, "err"); }
  });

  // ---- Reading a file -----------------------------------------------------------------
  function checkFileBasics(file) {
    const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    if (!FORMATS[ext]) return "only Excel (.xlsx, .xls) or PDF files can be uploaded.";
    if (!file.size) return "the file is empty.";
    if (file.size > MAX_BYTES) return "files must be 4 MB or smaller.";
    return null;
  }

  async function readFile(file, kind, password) {
    const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    const info = FORMATS[ext];
    const buffer = await file.arrayBuffer();
    const head = new Uint8Array(buffer.slice(0, 4));
    if (!info.sig.every((b, i) => head[i] === b)) throw new Error(`This does not look like a real ${ext} file.`);
    let rows = [], notes = [], status;
    try {
      // pdf.js may take over the buffer, so give it a copy.
      ({ holdings: rows, notes } = await Extract.extract(buffer.slice(0), info.format, password, kind));
      status = rows.length ? "Processed" : "Nothing found";
      if (!rows.length) notes.push(kind === "sip" ? "No SIP table was recognised in this file" : "No holdings table was recognised in this file");
    } catch (e) {
      if (e && e.name === "PasswordException") {
        throw new Error(password ? "The PDF password is incorrect." : "This PDF is password protected. Enter the PDF password and upload again.");
      }
      status = "Unreadable";
      notes = [`Could not read file: ${String((e && e.message) || e).slice(0, 200)}`];
    }
    return { buffer, info, rows, notes, status };
  }

  // ---- Upload All ---------------------------------------------------------------------
  el.uploadAll.addEventListener("click", async () => {
    const clientName = tidy(el.client.value);
    if (uploadType === "client" && !clientName) { setMsg(el.msg, "Enter the client name first.", "err"); el.client.focus(); return; }
    const jobs = [...picked.entries()].map(([k, file]) => {
      const [pid, kind] = k.split(":");
      return { key: k, kind, file, platform: platforms.find((p) => String(p.id) === pid) };
    }).filter((j) => j.platform)
      .sort((a, b) => platforms.indexOf(a.platform) - platforms.indexOf(b.platform) || a.kind.localeCompare(b.kind));
    if (!jobs.length) return;

    busy = true;
    updateCount();
    el.clearAll.disabled = true;
    const batchId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const results = [];
    for (const [i, job] of jobs.entries()) {
      setMsg(el.msg, `Uploading ${i + 1} of ${jobs.length}: ${job.platform.name} ${job.platform.product} ${KIND_LABEL[job.kind]}…`);
      results.push(await uploadOne(job, { batchId, clientName }));
    }
    busy = false;
    el.clearAll.disabled = false;
    results.filter((r) => r.ok || r.skipped).forEach((r) => picked.delete(r.job.key));
    lastBatch = { id: batchId, clientName, uploadType, saved: results.filter((r) => r.ok).length };
    el.pdfPassword.value = "";
    setMsg(el.msg, "");
    await Promise.all([refreshHistory(), loadMeta(false)]);
    showResults(results);
  });

  async function uploadOne(job, { batchId, clientName }) {
    try {
      const r = await readFile(job.file, job.kind, el.pdfPassword.value);
      const created = await api("POST", "/uploads", {
        uploadType, clientName, platform: job.platform.name, product: job.platform.product, kind: job.kind, batchId,
        snapshotDate: el.snap.value || null, originalName: job.file.name, format: r.info.format,
        fileType: job.file.type || r.info.type, size: job.file.size, sha256: await sha256(r.buffer),
        status: r.status, notes: r.notes.join("; "), rows: r.rows,
      });
      try {
        await api("PUT", `/uploads/${created.id}/file`, new Blob([r.buffer]), true);
      } catch (e) {
        await api("DELETE", `/uploads/${created.id}`).catch(() => {});
        throw new Error(`The file could not be saved: ${e.message}`);
      }
      return { job, ok: true, created, status: r.status };
    } catch (e) {
      if (e.status === 409) return { job, skipped: true, error: e.message };
      return { job, error: e.message };
    }
  }

  function showResults(results) {
    const ok = results.filter((r) => r.ok), bad = results.filter((r) => r.error && !r.skipped), skipped = results.filter((r) => r.skipped);
    const card = el.modal.querySelector(".modal-card");
    card.classList.toggle("has-errors", !ok.length || bad.length > 0);
    $("resultTitle").textContent = ok.length ? (bad.length ? "Uploaded with some problems" : "Uploaded successfully") : "Nothing was uploaded";
    el.resultSub.textContent = [
      ok.length ? `${ok.length} file${ok.length === 1 ? "" : "s"} saved` : "",
      skipped.length ? `${skipped.length} already uploaded` : "",
      bad.length ? `${bad.length} failed` : "",
      lastBatch.uploadType === "client" ? `for ${lastBatch.clientName}` : "(Platform Wise)",
    ].filter(Boolean).join(" · ");
    el.resultRows.innerHTML = results.map((r) => {
      let res;
      if (r.ok) {
        const c = r.created, what = r.job.kind === "sip" ? "SIPs" : "holdings";
        const head = c.isNew ? `<span class="badge ok">Added</span>` : `<span class="badge info">Version ${c.version}</span>`;
        const detail = c.isNew ? `New data, as of ${fmt.date(c.snapshotDate)}` : `Added as version ${c.version} for ${fmt.date(c.snapshotDate)}; earlier versions kept`;
        const warn = c.rowsCount ? "" : `<span class="note">No ${what} could be read from this file.</span>`;
        res = `${head} <span class="small">${esc(detail)} · ${c.rowsCount} ${what}${uploadType === "platform" ? `, ${c.clientsCount} clients` : ""}</span>${warn}`;
      } else if (r.skipped) {
        res = `<span class="badge muted">Skipped</span> <span class="small">${esc(r.error)}</span>`;
      } else {
        res = `<span class="badge err">Failed</span> <span class="small">${esc(r.error)}</span>`;
      }
      return `<tr><td>${esc(r.job.platform.name)}</td><td>${esc(r.job.platform.product)}</td>
        <td>${KIND_LABEL[r.job.kind]}: ${esc(r.job.file.name)}</td><td>${res}</td></tr>`;
    }).join("");
    $("resultReportBtn").disabled = !ok.some((r) => r.created.rowsCount);
    setMsg(el.resultMsg, "");
    el.modal.hidden = false;
    $("resultDashBtn").focus();
  }

  const closeModal = () => { el.modal.hidden = true; renderMatrix(); };
  $("resultCloseBtn").addEventListener("click", closeModal);
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.modal.hidden) closeModal(); });
  $("resultDashBtn").addEventListener("click", () => {
    el.modal.hidden = true;
    location.hash = lastBatch.uploadType === "client" && lastBatch.clientName
      ? `#/client/${encodeURIComponent(lastBatch.clientName)}` : "#/dashboard";
  });
  $("resultReportBtn").addEventListener("click", async () => {
    setMsg(el.resultMsg, "Generating…");
    try {
      const { uploads } = await api("GET", `/export?batch=${encodeURIComponent(lastBatch.id)}`);
      const title = lastBatch.uploadType === "client" ? lastBatch.clientName : "Platform upload";
      const name = reportName(title, lastBatch.uploadType === "client" ? "Upload" : "Platform_Upload");
      download(xlsxBlob(await Report.build(title, uploads, { multiClient: lastBatch.uploadType === "platform" })), name);
      setMsg(el.resultMsg, "Report downloaded.", "ok");
    } catch (e) { setMsg(el.resultMsg, e.message, "err"); }
  });

  // ---- History ------------------------------------------------------------------------
  let histToken = 0;
  async function refreshHistory() {
    const client = tidy(el.client.value), token = ++histToken;
    const params = new URLSearchParams({ limit: "300" });
    if (uploadType === "client" && client) params.set("client", client);
    try {
      const list = await api("GET", `/uploads?${params}`);
      if (token !== histToken) return;
      const scoped = uploadType === "client"
        ? list.filter((u) => u.uploadType === "client" && client && u.clientName.toLowerCase() === client.toLowerCase())
        : list.filter((u) => u.uploadType === "platform");
      history = scoped; // newest first: used for "Last update" in the matrix
      el.scopeLabel.textContent = uploadType === "client" ? (client ? `for ${client}` : "") : "(bulk files)";
      el.historyFor.textContent = uploadType === "client" && client ? `for ${client}` : "(all uploads)";
      renderHistory(list);
      if (!busy) el.rows.querySelectorAll("tr[data-pid]").forEach((tr) => {
        const p = platforms.find((x) => String(x.id) === tr.dataset.pid);
        if (p) tr.lastElementChild.innerHTML = lastUpdate(p);
      });
    } catch (e) { /* shown elsewhere */ }
  }

  function renderHistory(list) {
    if (!list.length) {
      el.history.innerHTML = `<tr class="empty"><td colspan="11">No uploads yet.</td></tr>`;
      return;
    }
    el.history.innerHTML = list.map((u) => {
      const st = u.status === "Processed" ? "ok" : u.status === "Unreadable" ? "err" : "warn";
      return `<tr>
        <td class="nw">${esc(u.uploadedAt)}</td>
        <td>${u.uploadType === "client" ? "Client Wise" : "Platform Wise"}</td>
        <td>${u.uploadType === "client" ? esc(u.clientName) : `<span class="muted">${u.clientsCount} clients</span>`}</td>
        <td>${esc(u.platform)}</td><td>${esc(u.product)}</td>
        <td><span class="chip" style="margin:0 6px 0 0">${KIND_LABEL[u.kind]}</span>${u.hasFile ? `<a href="/api/uploads/${u.id}/file">${esc(u.originalName)}</a>` : esc(u.originalName)}
          ${u.notes ? `<span class="note">${esc(u.notes)}</span>` : ""}</td>
        <td class="nw">v${u.version} ${u.current ? `<span class="badge ok">In use</span>` : `<span class="badge muted">Older</span>`}</td>
        <td class="nw">${esc(fmt.date(u.snapshotDate))}</td>
        <td class="num">${u.rowsCount}</td>
        <td><span class="badge ${st}">${esc(u.status)}</span></td>
        <td><button class="link" data-del="${u.id}">Remove</button></td></tr>`;
    }).join("");
  }

  el.history.addEventListener("click", async (e) => {
    const id = e.target.dataset.del;
    if (!id || !confirm("Remove this upload? If it is the version in use, the previous version is used again.")) return;
    try {
      await api("DELETE", `/uploads/${id}`);
      await refreshHistory();
      setMsg(el.msg, "Upload removed.", "ok");
    } catch (err) { setMsg(el.msg, err.message, "err"); }
  });

  // ---- Loading ------------------------------------------------------------------------
  async function loadMeta(render = true) {
    const m = await api("GET", "/meta");
    products = m.products;
    platforms = m.platforms;
    $("clientList").innerHTML = m.clients.map((c) => `<option value="${esc(c)}">`).join("");
    el.newProduct.innerHTML = products.map((p) => `<option>${esc(p)}</option>`).join("");
    if (render || !el.rows.querySelector("tr[data-pid]")) renderMatrix();
  }

  function debounce(fn, ms = 300) {
    let t;
    return () => { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  // Reset all data: asks the admin to type RESET first.
  $("resetAllBtn").addEventListener("click", async () => {
    const typed = prompt("This deletes ALL uploaded data and review changes for every client. It can't be undone.\n\nType RESET to confirm.");
    if (typed === null) return;
    const msg = $("resetMsg");
    if (typed.trim() !== "RESET") { msg.className = "msg err"; msg.textContent = "Nothing was deleted: you didn't type RESET."; return; }
    const b = $("resetAllBtn");
    b.disabled = true;
    try {
      const r = await api("POST", "/reset", { confirm: "RESET" });
      msg.className = "msg ok";
      msg.textContent = `All data was reset (${r.uploadsDeleted} upload${r.uploadsDeleted === 1 ? "" : "s"} deleted).`;
      await Promise.all([refreshHistory(), loadMeta(false)]);
    } catch (e) {
      msg.className = "msg err";
      msg.textContent = `Could not reset: ${e.message}`;
    } finally {
      b.disabled = false;
    }
  });

  async function show() {
    try {
      await loadMeta(!busy);
      await refreshHistory();
    } catch (e) {
      el.rows.innerHTML = `<tr class="empty"><td colspan="5">${esc(e.message)}</td></tr>`;
    }
  }

  return { show };
})();
