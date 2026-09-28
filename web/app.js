/* Interface du PoC. S'appuie sur ReconEngine (engine.js), ReconReader (reader.js) et XLSX (SheetJS).
 * Historique : chaque analyse enregistrée est une version immuable (fichiers + règles + validations + résumé),
 * stockée dans le navigateur (IndexedDB) et exportable au même format que le script Python (analyse.json). */
(function () {
  "use strict";
  const E = window.ReconEngine, RD = window.ReconReader;
  const DEMO = window.__DEMO__ || { history: [], current: null };
  const DEFAULT_CFG = JSON.parse(JSON.stringify(window.__CONFIG__ || {}));
  delete DEFAULT_CFG._note;

  const ROLES = ["mes_inv", "phys_inv", "mes_trace", "phys_trace"];
  const ROLE_COLOR = { mes_inv: "var(--mes)", mes_trace: "var(--mes)", phys_inv: "var(--phy)", phys_trace: "var(--phy)" };
  const FIELD_LABEL = {
    roll: "N° rouleau", batch: "Batch", qty: "Longueur", date: "Date", time: "Heure", event: "Événement",
    location: "Emplacement", from: "Depuis", to: "Vers", equipment: "Machine", material: "Article",
    step: "Étape", user: "Opérateur", comment: "Commentaire", status: "Statut", order: "OF",
  };
  const CONF_CLS = { "Élevée": "h", "Moyenne": "m", "Faible": "f" };
  const OWNER_COLOR = { MES: "var(--mes)", OPS: "var(--phy)", CTRL: "var(--val)" };
  const TABS = ["synthese", "ecarts", "dossier", "valider", "sources", "historique", "ia"];

  const S = {
    files: [], cfg: JSON.parse(JSON.stringify(DEFAULT_CFG)), decisions: {}, decisionsMeta: {}, result: null,
    current: { id: null, name: "Nouvelle analyse", parent_id: null }, baseline: null, dirty: false,
    history: [], dbOk: false, guard: null, confirmDel: null, renaming: null,
    tab: "synthese", filter: { cat: "GAPS", owner: "ALL", q: "" }, demo: false,
    llm: { provider: "anthropic", url: "", model: "claude-sonnet-4-5", key: "", pseudo: true, out: "", busy: false, err: "" },
    error: "",
  };
  let fileSeq = 0;

  // ------------------------------------------------------------ utilitaires
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = E.fmtNum, fmtS = E.fmtSigned, fmtD = E.fmtDate;
  const pad = (n) => String(n).padStart(2, "0");
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast"; t.textContent = msg; t.setAttribute("role", "status");
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function bytesToB64(u8) {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function nowIso() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function slug(s) { return (s || "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "analyse"; }
  const fmtDT = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}` : "");
  async function download(name, data, mime) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: mime || "application/octet-stream" });
    let ns = null;
    if (window.claude && typeof window.claude.use === "function") {
      try { ns = await window.claude.use("downloads"); } catch (e) { ns = null; }
    }
    if (ns) {
      try { await ns.save({ filename: name, data: blob }); toast(`Enregistré : ${name}`); }
      catch (e) {
        const c = e && e.code;
        toast(c === "declined" ? "Téléchargement annulé" : c === "rate_limited" ? "Une demande est déjà ouverte" : "Téléchargement indisponible dans cette vue");
      }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    toast(`Téléchargement : ${name}`);
  }
  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg || "Copié"); }
    catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text; ta.className = "hidden-input"; document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch (_) { /* ignore */ }
      ta.remove();
      toast(ok ? (okMsg || "Copié") : "Copie refusée par le navigateur : utilisez le téléchargement .md");
    }
  }
  function store(k, v) { try { localStorage.setItem("recon." + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } }
  function load(k) { try { const v = localStorage.getItem("recon." + k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }

  // ------------------------------------------------------------ historique (IndexedDB, dans ce navigateur)
  const IDB = {
    db: null,
    open() {
      return new Promise((resolve) => {
        try {
          const req = indexedDB.open("recon-poc", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("analyses", { keyPath: "id" });
          req.onsuccess = () => { IDB.db = req.result; resolve(true); };
          req.onerror = () => resolve(false);
          req.onblocked = () => resolve(false);
        } catch (e) { resolve(false); }
      });
    },
    tx(mode, fn) {
      return new Promise((resolve, reject) => {
        try {
          const t = IDB.db.transaction("analyses", mode);
          const r = fn(t.objectStore("analyses"));
          t.oncomplete = () => resolve(r && r.result);
          t.onerror = () => reject(t.error);
        } catch (e) { reject(e); }
      });
    },
    all() { return IDB.tx("readonly", (s) => s.getAll()); },
    put(an) { return IDB.tx("readwrite", (s) => s.put(an)); },
    del(id) { return IDB.tx("readwrite", (s) => s.delete(id)); },
  };
  // Déployé (Railway) : historique partagé côté serveur ; sinon : navigateur (IndexedDB)
  const SERVER = window.__SERVER__ || null;
  async function api(method, url, body) {
    const res = await fetch(url, { method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      let msg = res.status + "";
      try { const j = await res.json(); msg = j.detail || msg; } catch (e) { /* texte */ }
      throw new Error(msg);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.blob();
  }
  const Store = SERVER ? {
    label: "sur le serveur, partagées avec toute l'équipe",
    async init() { return true; },
    async list() { return (await api("GET", "/api/analyses")) || []; },
    async full(id) { return api("GET", `/api/analyses/${encodeURIComponent(id)}`); },
    async put(an) { return api("POST", "/api/analyses", an); },
    async rename(id, name) { return api("PATCH", `/api/analyses/${encodeURIComponent(id)}`, { name }); },
    async del(id) { return api("DELETE", `/api/analyses/${encodeURIComponent(id)}`); },
  } : {
    label: "dans ce navigateur, sur ce poste",
    async init() { return typeof indexedDB !== "undefined" && IDB.open(); },
    async list() { return (await IDB.all()) || []; },
    async full(id) { return (await IDB.all()).find((a) => a.id === id); },
    async put(an) { return IDB.put(an); },
    async rename(id, name) { const a = await Store.full(id); a.name = name; return IDB.put(a); },
    async del(id) { return IDB.del(id); },
  };
  async function fullAnalysis(id) {
    const a = findAnalysis(id);
    if (a && (a.example || (a.files || []).every((f) => f.b64))) return a;
    return Store.full(id);
  }
  async function refreshHistory() {
    let stored = [];
    if (S.dbOk) { try { stored = await Store.list(); } catch (e) { stored = []; toast("Historique indisponible : " + e.message); } }
    const ex = (DEMO.history || []).map((a) => Object.assign({}, a, { example: true }));
    const ids = new Set(stored.map((a) => a.id));
    S.history = [...stored, ...ex.filter((a) => !ids.has(a.id))].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  const findAnalysis = (id) => S.history.find((a) => a.id === id) || null;

  // ------------------------------------------------------------ fichiers
  function guessRoleByName(n) {
    n = n.toLowerCase();
    const mes = n.includes("mes"), tr = ["trace", "traca", "traça", "tracking", "movable", "histo", "mouvement"].some((k) => n.includes(k));
    const inv = ["inventaire", "inventory", "stock", "comptage", "count"].some((k) => n.includes(k));
    if (mes && tr) return "mes_trace"; if (mes) return "mes_inv"; if (tr) return "phys_trace"; if (inv) return "phys_inv";
    return null;
  }
  function guessRoleByColumns(rows) {
    let best = ["phys_inv", -1];
    for (const role of ROLES) {
      const [, mp] = E.detectHeader(rows, role, null);
      const ok = E.REQUIRED[role].every((f) => f in mp);
      const score = (ok ? 100 : 0) + Object.keys(mp).length + ("event" in mp && role.endsWith("trace") ? 5 : 0);
      if (score > best[1]) best = [role, score];
    }
    return best[0];
  }
  function addTable(filename, bytes, role, perimeter) {
    const t = RD.readWorkbook(XLSX, bytes, filename);
    const f = {
      id: ++fileSeq, filename, name: t.name, rows: t.rows, bytes,
      role: role || guessRoleByName(t.name) || guessRoleByColumns(t.rows),
    };
    const known = (S.cfg.file_defaults || {})[t.name];
    f.perimeter = perimeter || (known && known.perimeter ? known.perimeter : "");
    S.files = S.files.filter((x) => x.name !== f.name || x.role === "ignore"); // une nouvelle version remplace l'ancienne
    S.files.push(f);
    return f;
  }
  async function addFiles(fileList) {
    const arr = [...fileList];
    const tables = arr.filter((f) => /\.(xlsx|xlsm|xls|csv|txt)$/i.test(f.name));
    const jsons = arr.filter((f) => /\.json$/i.test(f.name));
    for (const f of jsons) {
      try { await importJson(JSON.parse(await f.text()), f.name); }
      catch (e) { toast(`JSON illisible : ${f.name}`); }
    }
    if (!tables.length) { if (!jsons.length) toast("Formats acceptés : .xlsx, .xls, .csv, .json"); return; }
    if (S.demo) { S.files = []; S.decisions = {}; S.decisionsMeta = {}; S.demo = false; S.current = { id: null, name: "Nouvelle analyse", parent_id: null }; S.baseline = null; }
    let replaced = 0;
    for (const f of tables) {
      try {
        const before = S.files.length;
        addTable(f.name, new Uint8Array(await f.arrayBuffer()));
        if (S.files.length === before) replaced++;
      } catch (e) { toast(`Lecture impossible : ${f.name}`); }
    }
    if (replaced) toast(`${replaced} fichier(s) remplacé(s) par leur nouvelle version (même nom)`);
    S.tab = "sources";
    compute(true);
  }
  async function importJson(obj, filename) {
    if (obj && obj.format === "recon-analysis") {
      if (S.dbOk) { try { await Store.put(obj); } catch (e) { toast("Import impossible : " + e.message); return; } }
      else if (!S.history.some((a) => a.id === obj.id)) DEMO.history.push(obj);
      await refreshHistory();
      toast(`Analyse importée : ${obj.name}`);
      S.tab = "historique"; render();
      return;
    }
    if (obj && ("tolerance_abs_m" in obj || "perimeter_map" in obj || "roll_prefixes" in obj)) {
      S.cfg = Object.assign(JSON.parse(JSON.stringify(DEFAULT_CFG)), obj); delete S.cfg._note;
      toast(`Règles importées : ${filename}`); compute(true); return;
    }
    if (obj && typeof obj === "object" && Object.values(obj).every((v) => typeof v === "string")) {
      Object.assign(S.decisions, obj); toast(`${Object.keys(obj).length} validation(s) importée(s)`); compute(true); return;
    }
    toast(`Fichier JSON non reconnu : ${filename}`);
  }

  // ------------------------------------------------------------ analyses (versions)
  function normalizedDecisions() {
    const out = Object.assign({}, S.decisions);
    if (!S.result) return out;
    for (const e of S.result.entries) {
      if (!e.decision_key || !e.validated) continue;
      if (out[e.uid] !== undefined) delete out[e.uid];
      out[e.decision_key] = e.validated === "accept" ? `accept:${e.mes.batch}` : "reject";
    }
    return out;
  }
  function buildAnalysis() {
    const d = new Date();
    const name = S.current.name || `Inventaire du ${S.result.inventory_date}`;
    return {
      format: "recon-analysis", format_version: 1, engine_version: E.VERSION, source: "web",
      id: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${slug(name)}`,
      name, created_at: nowIso(), parent_id: S.current.id || S.current.parent_id || null,
      inventory_date: S.result.inventory_date,
      config: S.effectiveCfg, decisions: normalizedDecisions(), decisions_meta: S.decisionsMeta,
      files: S.files.filter((f) => f.role !== "ignore").map((f) => ({ filename: f.filename, name: f.name, role: f.role, perimeter: f.perimeter || "", b64: bytesToB64(f.bytes) })),
      snapshot: S.result.snapshot,
      summary: { kpis: S.result.summary.kpis, differences: S.result.summary.differences, actions: S.result.summary.actions.map((a) => a.text) },
      evolution_bullets: S.result.evolution ? S.result.evolution.bullets : [],
      baseline_id: S.baseline ? S.baseline.id : null,
    };
  }
  async function saveAnalysis() {
    if (!S.result) { toast("Rien à enregistrer : lancez d'abord un rapprochement"); return false; }
    const an = buildAnalysis();
    if (S.dbOk) {
      try { await Store.put(an); } catch (e) { toast("Enregistrement impossible (" + e.message + ") : utilisez « Exporter (.json) »"); return false; }
    } else DEMO.history.push(an);
    S.decisions = an.decisions;
    S.current = { id: an.id, name: an.name, parent_id: an.parent_id };
    S.dirty = false; S.demo = false;
    await refreshHistory();
    toast(S.dbOk ? `Version enregistrée${SERVER ? " sur le serveur" : ""} : ${an.name}` : "Version gardée pour cette session (stockage navigateur indisponible)");
    render();
    return true;
  }
  function withGuard(label, fn) {
    if (S.dirty && S.files.length && !S.demo) { S.guard = { label, fn }; render(); window.scrollTo({ top: 0 }); return; }
    fn();
  }
  function openAnalysis(an, fork) {
    S.files = []; fileSeq = 0;
    S.cfg = JSON.parse(JSON.stringify(an.config || DEFAULT_CFG));
    for (const f of an.files || []) {
      try { addTable(f.filename, b64ToBytes(f.b64), f.role, f.perimeter || ""); } catch (e) { toast(`Fichier illisible dans l'archive : ${f.filename}`); }
    }
    S.decisions = Object.assign({}, an.decisions || {});
    S.decisionsMeta = Object.assign({}, an.decisions_meta || {});
    S.demo = false; S.guard = null;
    if (fork) {
      S.current = { id: null, name: `${an.name} (suite)`, parent_id: an.id };
      S.baseline = an;
      S.tab = "sources";
      compute(true);
      toast("Nouvelle version : remplacez les fichiers qui ont changé (même nom = remplacement)");
    } else {
      S.current = { id: an.id, name: an.name, parent_id: an.parent_id || null };
      S.baseline = (an.baseline_id && findAnalysis(an.baseline_id)) || (an.parent_id && findAnalysis(an.parent_id)) || null;
      S.tab = "synthese";
      compute(false);
    }
  }
  function newAnalysis() {
    S.files = []; S.decisions = {}; S.decisionsMeta = {}; S.demo = false; S.guard = null;
    S.current = { id: null, name: "Nouvelle analyse", parent_id: null };
    S.baseline = null; S.tab = "sources";
    compute(false);
  }
  function loadDemo() {
    S.cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
    S.files = []; fileSeq = 0;
    const cur = DEMO.current;
    if (!cur) { newAnalysis(); return; }
    for (const f of cur.files) addTable(f.filename, b64ToBytes(f.b64), f.role, f.perimeter);
    S.decisions = Object.assign({}, cur.decisions || {});
    S.current = { id: null, name: cur.name, parent_id: cur.parent_id };
    S.baseline = findAnalysis(cur.parent_id);
    S.demo = true;
    compute(false);
  }

  // ------------------------------------------------------------ calcul
  function compute(markDirty) {
    S.error = "";
    if (markDirty) S.dirty = true;
    const tables = { mes_inv: [], phys_inv: [], mes_trace: [], phys_trace: [] };
    const cfg = JSON.parse(JSON.stringify(S.cfg));
    cfg.file_defaults = cfg.file_defaults || {};
    for (const f of S.files) {
      if (!f.role || f.role === "ignore") continue;
      tables[f.role].push({ name: f.name, rows: f.rows });
      if (f.role === "phys_inv") {
        if (f.perimeter) cfg.file_defaults[f.name] = { perimeter: f.perimeter };
        else delete cfg.file_defaults[f.name];
      }
    }
    if (!tables.mes_inv.length || !tables.phys_inv.length) {
      S.result = null;
      S.error = S.files.length
        ? "Il manque un inventaire MES ou un inventaire physique : vérifiez le rôle de chaque fichier ci-dessous."
        : "Déposez les exports de l'inventaire à analyser (au minimum un inventaire MES et un inventaire physique).";
    } else {
      const base = S.baseline ? { id: S.baseline.id, name: S.baseline.name, snapshot: S.baseline.snapshot } : null;
      try { S.result = E.run(tables, cfg, S.decisions, base); }
      catch (e) { S.result = null; S.error = "Erreur de calcul : " + e.message; console.error(e); }
    }
    S.effectiveCfg = cfg;
    render();
  }

  // ------------------------------------------------------------ rendu
  const pill = (cat) => `<span class="pill c-${cat}">${esc(E.CAT_LABEL[cat])}</span>`;
  const conf = (c) => (c ? `<span class="conf ${CONF_CLS[c] || "f"}"><i></i>${esc(c)}</span>` : "");
  const ownerName = (k) => (S.cfg.owners || {})[k] || k;
  const refBtn = (id) => (id ? `<button class="refchip" data-go="${esc(id)}">${esc(id)}</button>` : "");
  function linkRefs(text) {
    return esc(text).replace(/\[(E\d{2,})\]/g, (_, id) => `<button class="refchip" data-go="${id}">${id}</button>`);
  }
  function trk(e, long) {
    const h = e.history;
    if (!h) return "";
    if (h.status === "new") return `<span class="trk trk-new" title="${h.was_ok ? "Conforme à l'analyse précédente" : "Absent de l'analyse précédente"}">Nouveau${h.was_ok && long ? " · était conforme" : ""}</span>`;
    if (h.status === "persistent") {
      const t = `Persistant depuis le ${fmtD(h.first_seen)}` + (h.changes.length ? " · " + h.changes.join(" ; ") : "");
      return `<span class="trk trk-pers" title="${esc(t)}">${long ? esc(t) : `Persistant · ${h.occurrences} inv.`}</span>`;
    }
    return "";
  }
  function gaps() { return S.result ? S.result.entries.filter((e) => e.category !== "OK") : []; }
  function toValidate() { return S.result ? S.result.entries.filter((e) => E.TO_VALIDATE.includes(e.category)) : []; }
  function validatedKeys() {
    const m = new Map();
    if (S.result) for (const e of S.result.entries) if (e.validated && e.decision_key && !m.has(e.decision_key)) m.set(e.decision_key, e);
    return m;
  }

  function render() {
    const r = S.result;
    const nVal = toValidate().length;
    const tabs = [
      ["synthese", "Synthèse", null],
      ["ecarts", "Écarts", r ? gaps().length : null],
      ["dossier", "Dossier réunion", null],
      ["valider", "À valider", nVal, nVal > 0],
      ["sources", "Sources & règles", S.files.length],
      ["historique", "Historique", S.history.length],
      ["ia", "Assistant IA", null],
    ];
    $("#tabs").innerHTML = tabs.map(([id, label, n, hot]) =>
      `<button class="tab" role="tab" id="tab-${id}" aria-selected="${S.tab === id}" data-tab="${id}">${label}${n !== null && n !== undefined ? `<span class="cnt${hot ? " hot" : ""}">${n}</span>` : ""}</button>`).join("");
    $("#demo-badge").hidden = !S.demo;
    const nameInput = $("#an-name");
    if (document.activeElement !== nameInput) nameInput.value = S.current.name;
    const bits = [];
    if (r) bits.push(`Inventaire du ${fmtD(r.inventory_date)}`);
    bits.push(`${S.files.filter((f) => f.role !== "ignore").length} fichier(s)`);
    if (S.baseline) bits.push(`comparée à « ${esc(S.baseline.name)} »`);
    if (SERVER) bits.push(`connecté : ${esc(SERVER.user)}`);
    const state = S.current.id && !S.dirty ? `<span class="saved">● enregistrée</span>` : `<span class="dirty">● non enregistrée</span>`;
    $("#sub").innerHTML = bits.join(" · ") + " · " + state;
    $("#btn-save").disabled = !r || (!!S.current.id && !S.dirty);
    $("#kpis").innerHTML = r ? kpisHtml(r) : "";
    const view = $("#view");
    const guard = S.guard ? `<div class="guard" role="alert"><span>L'analyse en cours n'est pas enregistrée. ${esc(S.guard.label)} ?</span>
        <span class="vactions"><button class="btn small primary" data-act="guard-save">Enregistrer puis continuer</button><button class="btn small" data-act="guard-go">Continuer sans enregistrer</button><button class="btn ghost small" data-act="guard-cancel">Annuler</button></span></div>` : "";
    if (!r && !["sources", "ia", "historique"].includes(S.tab)) {
      view.innerHTML = guard + `<div class="callout">${esc(S.error)} <button class="btn small" data-tab="sources">Ouvrir les sources</button> <button class="btn small" data-tab="historique">Ouvrir l'historique</button></div>`;
      return;
    }
    view.innerHTML = guard + {
      synthese: viewSynthese, ecarts: viewEcarts, dossier: viewDossier, valider: viewValider, sources: viewSources, historique: viewHistorique, ia: viewIA,
    }[S.tab]();
    view.setAttribute("aria-labelledby", "tab-" + S.tab);
  }

  function kpisHtml(r) {
    const k = r.summary.kpis, ev = r.evolution;
    const bk = ev ? S.baseline && S.baseline.snapshot && S.baseline.snapshot.kpis : null;
    const dlt = (cur, prev, goodDown) => {
      if (prev === undefined || prev === null) return "";
      const d = Math.round((cur - prev) * 10) / 10;
      if (!d) return `<span class="dk">=</span>`;
      const good = goodDown ? d < 0 : d > 0;
      return `<span class="dk ${good ? "good" : "bad"}">${d > 0 ? "+" : ""}${fmt(d)}</span>`;
    };
    return [
      ["", "Rouleaux rapprochés", k.compared, ""],
      ["ok", "Conformes", k.ok, `<small>${k.ok_pct} %</small>` + (bk ? dlt(k.ok, bk.ok, false) : "")],
      ["crit", "Écarts", k.gaps, bk ? dlt(k.gaps, bk.gaps, true) : ""],
      ["", "Métrage en écart", fmt(k.gap_meters), "<small>m</small>" + (bk ? dlt(k.gap_meters, bk.gap_meters, true) : "")],
      ["val", "À valider", k.to_validate, validatedKeys().size ? `<small>${validatedKeys().size} tranché(s)</small>` : ""],
      ev ? ["", "Nouveaux · résolus", `${ev.counts.new}<small>·</small>${ev.counts.resolved}`, `<small>${ev.counts.persistent} persist.</small>`]
        : ["", "Hypothèses fortes", k.high_conf, `<small>/ ${k.gaps}</small>`],
    ].map(([c, l, v, x]) => `<div class="kpi ${c}"><span class="l">${l}</span><span class="v">${v}${x}</span></div>`).join("");
  }

  // ---- Synthèse
  function evolutionPanel() {
    const ev = S.result.evolution;
    if (!ev) {
      return S.history.length ? `<div class="callout">Aucune analyse de référence : dans <button class="refchip" data-tab="historique">Historique</button>, choisissez « Comparer » pour suivre les écarts nouveaux, persistants et résolus.</div>` : "";
    }
    return `<section class="panel"><div class="panel-h"><h2>Évolution depuis « ${esc(ev.baseline.name)} »</h2><span class="note">inventaire du ${esc(fmtD(ev.baseline.inventory_date))} · <button class="refchip" data-tab="historique">changer de référence</button></span></div>
      <div class="panel-b stack"><div class="evo">
        <div class="evo-c new"><b>${ev.counts.new}</b><span>nouveaux</span></div>
        <div class="evo-c pers"><b>${ev.counts.persistent}</b><span>persistants</span></div>
        <div class="evo-c res"><b>${ev.counts.resolved}</b><span>résolus</span></div></div>
        <ul class="bullets">${ev.bullets.slice(1).map((b) => `<li>${linkRefs(b)}</li>`).join("")}</ul></div></section>`;
  }
  function viewSynthese() {
    const s = S.result.summary;
    const byOwner = new Map();
    for (const a of s.actions) {
      if (!byOwner.has(a.owner_key)) byOwner.set(a.owner_key, []);
      byOwner.get(a.owner_key).push(a);
    }
    const entryByRef = new Map(S.result.entries.filter((e) => e.ref_id).map((e) => [e.ref_id, e]));
    const actionsHtml = [...byOwner.entries()].map(([k, list]) => `
      <div class="owner-group">
        <div class="owner-h"><span class="owner-dot" style="background:${OWNER_COLOR[k] || "var(--muted)"}"></span>${esc(ownerName(k))}
          <span class="faint" style="font-weight:400">· ${list.reduce((a, x) => a + (x.code === "STRUCTUREL" ? 0 : x.count), 0)} action(s)</span></div>
        ${list.map((a) => `<div class="act"><span class="n">${a.code === "STRUCTUREL" ? "↻" : a.count}</span><div>
          <div class="t">${esc(a.label)}</div>
          ${a.refs.filter(Boolean).length ? `<div class="rolls">${a.refs.filter(Boolean).map((id) => {
            const e = entryByRef.get(id);
            const old = e && e.history && e.history.status === "persistent" ? ` title="Persistant depuis le ${esc(fmtD(e.history.first_seen))}"` : "";
            return `<button class="chip${old ? " old" : ""}" data-go="${id}"${old}><b>${id}</b>${esc(e ? e.roll_display : "")}</button>`; }).join("")}</div>`
            : `<div class="note">${esc(a.text.split(" — ")[1] || a.text)}</div>`}
        </div></div>`).join("")}
      </div>`).join("");
    return `<div class="grid2">
      <div class="stack">
        ${evolutionPanel()}
        <section class="panel"><div class="panel-h"><h2>Grandes différences</h2>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" data-act="copy-summary">Copier la synthèse</button><button class="btn small" data-act="dl-md">Brief .md</button></div></div>
          <div class="panel-b"><ul class="bullets">${s.differences.map((d, i) => `<li class="${i === 0 ? "lead" : ""}">${linkRefs(d)}</li>`).join("")}</ul></div></section>
        <section class="panel"><div class="panel-h"><h2>Écarts par périmètre</h2>${legendHtml()}</div><div class="panel-b">${perimeterBars()}</div></section>
      </div>
      <section class="panel"><div class="panel-h"><h2>Actions à mener</h2><span class="note">groupées par responsable · cliquer un rouleau ouvre sa traçabilité${S.result.evolution ? " · pointillé = écart persistant" : ""}</span></div>
        <div class="panel-b">${actionsHtml || '<p class="muted">Aucune action.</p>'}</div></section>
    </div>`;
  }
  const BAR_CATS = [["ONLY_MES", "var(--crit)", "Absent physique"], ["ONLY_PHYS", "color-mix(in srgb, var(--crit) 55%, var(--surface))", "Absent MES"], ["LEN", "var(--warn)", "Métrage / étape"], ["UNC", "var(--val)", "À valider / doublon"]];
  function legendHtml() {
    return `<div class="legend">${BAR_CATS.map(([, c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join("")}<span><i style="background:var(--ok-soft);border:1px solid var(--line)"></i>Conforme</span></div>`;
  }
  function perimeterBars() {
    const per = new Map();
    for (const e of S.result.entries) {
      if (!per.has(e.perimeter)) per.set(e.perimeter, { n: 0, ONLY_MES: 0, ONLY_PHYS: 0, LEN: 0, UNC: 0 });
      const p = per.get(e.perimeter); p.n++;
      if (e.category === "ONLY_MES" || e.category === "ONLY_PHYS") p[e.category]++;
      else if (e.category === "LEN" || e.category === "STEP") p.LEN++;
      else if (e.category !== "OK") p.UNC++;
    }
    const rows = [...per.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return `<div class="bars">${rows.map(([name, p]) => {
      const g = p.ONLY_MES + p.ONLY_PHYS + p.LEN + p.UNC;
      return `<div class="bar-row"><span>${esc(name)}</span><div class="bar" role="img" aria-label="${esc(name)} : ${g} écarts sur ${p.n}">${BAR_CATS.map(([k, c]) => p[k] ? `<i style="width:${(p[k] / p.n) * 100}%;background:${c}"></i>` : "").join("")}</div><span class="num muted">${g}/${p.n}</span></div>`;
    }).join("")}</div>`;
  }

  // ---- Écarts
  function filtered() {
    const f = S.filter, q = f.q.trim().toLowerCase();
    return S.result.entries.filter((e) => {
      if (f.cat === "GAPS" && e.category === "OK") return false;
      if (f.cat === "NEW" && !(e.history && e.history.status === "new")) return false;
      if (f.cat === "PERS" && !(e.history && e.history.status === "persistent")) return false;
      if (!["GAPS", "ALL", "NEW", "PERS"].includes(f.cat) && e.category !== f.cat) return false;
      if (f.owner !== "ALL" && (!e.diag || e.diag.owner !== f.owner)) return false;
      if (q) {
        const hay = [e.ref_id, e.roll_display, e.roll, e.batch, e.perimeter, e.diag && e.diag.hypothesis, e.diag && e.diag.action].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function viewEcarts() {
    const cnt = {}; for (const e of S.result.entries) cnt[e.category] = (cnt[e.category] || 0) + 1;
    const ev = S.result.evolution;
    const chips = [["GAPS", "Tous les écarts", gaps().length],
      ...(ev ? [["NEW", "Nouveaux", ev.counts.new], ["PERS", "Persistants", ev.counts.persistent]] : []),
      ...E.CATEGORIES.filter(([c]) => cnt[c]).map(([c, l]) => [c, l, cnt[c]]), ["ALL", "Tout", S.result.entries.length]];
    const owners = [["ALL", "Tous responsables"], ["MES", ownerName("MES")], ["OPS", ownerName("OPS")], ["CTRL", ownerName("CTRL")]];
    const rows = filtered();
    return `<section class="panel"><div class="panel-h"><h2>Tableau des écarts</h2><span class="note">${rows.length} ligne(s) · cliquer une ligne ouvre la traçabilité</span></div>
      <div class="filters">${chips.map(([c, l, n]) => `<button class="fchip" data-fcat="${c}" aria-pressed="${S.filter.cat === c}">${esc(l)} <span class="num">${n}</span></button>`).join("")}</div>
      <div class="filters">${owners.map(([c, l]) => `<button class="fchip" data-fown="${c}" aria-pressed="${S.filter.owner === c}">${esc(l)}</button>`).join("")}
        <input class="search" id="q" type="search" placeholder="Rouleau, batch, mot-clé…" value="${esc(S.filter.q)}" aria-label="Rechercher"></div>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Réf.</th><th>Catégorie</th>${ev ? "<th>Suivi</th>" : ""}<th>Rouleau</th><th>Batch</th><th>Périmètre</th><th class="r">MES (m)</th><th class="r">Physique (m)</th><th class="r">Δ (m)</th><th>Hypothèse</th><th>Confiance</th><th>Responsable</th></tr></thead>
      <tbody>${rows.map((e) => {
        const d = e.diag || {};
        const dcls = e.delta === null ? "" : e.delta < 0 ? "neg" : e.delta > 0 ? "pos" : "";
        return `<tr class="row" data-go="${esc(e.ref_id || "")}" tabindex="0">
          <td class="mono">${esc(e.ref_id || "—")}</td><td>${pill(e.category)}</td>${ev ? `<td>${trk(e)}</td>` : ""}
          <td class="mono">${esc(e.roll_display)}</td><td class="mono">${esc(e.batch || (e.candidates.length ? "?" : "—"))}</td>
          <td>${esc(e.perimeter)}</td><td class="r">${e.mes ? fmt(e.mes.qty) : "—"}</td><td class="r">${e.phys ? fmt(e.phys.qty) : "—"}</td>
          <td class="r ${dcls}">${e.delta === null ? "—" : fmtS(e.delta)}</td>
          <td><div class="hyp">${esc(d.hypothesis || (e.category === "OK" ? (e.validated ? "Conforme après validation" : "Rapprochement conforme") : ""))}</div></td>
          <td>${conf(d.confidence)}</td><td>${esc(d.owner ? ownerName(d.owner) : "")}</td></tr>`;
      }).join("") || `<tr><td colspan="12" class="muted">Aucune ligne pour ces filtres.</td></tr>`}</tbody></table></div></section>`;
  }

  // ---- Dossier réunion
  function evHtml(x, side) {
    const extra = [x.equipment, x.to ? "→ " + x.to : "", x.qty !== null ? fmt(x.qty) + " m" : "", x.user].filter(Boolean).join(" · ");
    const flags = (x.partial ? `<span class="tag">clé partielle</span>` : "") + (x.post ? `<span class="tag">après inventaire</span>` : "");
    return `<div class="ev ${side}"><span class="e">${esc(x.event || "?")}<span class="tag t-${x.type}">${esc(E.EVENT_LABELS[x.type] || x.type)}</span>${flags}</span>
      ${extra ? `<span class="x">${esc(extra)}</span>` : ""}${x.comment ? `<span class="x">« ${esc(x.comment)} »</span>` : ""}
      <span class="rf">${esc(x.ref)}</span></div>`;
  }
  function sortedEvents(e) {
    return [...e.trace_mes.map((x) => ({ x, s: "mes" })), ...e.trace_phys.map((x) => ({ x, s: "phy" }))]
      .sort((a, b) => ((a.x.date || "") < (b.x.date || "") ? -1 : (a.x.date || "") > (b.x.date || "") ? 1 : a.s === b.s ? a.x.row - b.x.row : a.s === "mes" ? -1 : 1));
  }
  function caseHtml(e) {
    const d = e.diag || {};
    const evs = sortedEvents(e);
    const tl = evs.length
      ? evs.map(({ x, s }) => `<div class="tl-c">${s === "mes" ? evHtml(x, "mes") : ""}</div><div class="tl-c tl-d">${esc(fmtD(x.date, true))}</div><div class="tl-c">${s === "phy" ? evHtml(x, "phy") : ""}</div>`).join("")
      : `<div class="tl-empty">Aucune trace trouvée pour cette clé dans les fichiers de traçabilité fournis.</div>`;
    const cands = e.candidates && e.candidates.length
      ? `<div><span class="eyebrow">Candidats MES</span><p>${e.candidates.map((c) => `<span class="mono">${esc(c.batch)}</span> · ${fmt(c.qty)} m · dernier mvt ${esc(fmtD(c.date))}`).join("<br>")}</p></div>` : "";
    return `<article class="case" id="case-${esc(e.ref_id)}">
      <header class="case-h"><span class="case-id">${esc(e.ref_id)}</span><span class="case-roll">${esc(e.roll_display)}</span>
        <span class="mono muted">batch ${esc(e.batch || "?")}</span>${pill(e.category)}${trk(e, true)}
        <span class="case-meta"><span>${esc(e.perimeter)}</span><span>MES <b>${e.mes ? fmt(e.mes.qty) + " m" : "—"}</b></span><span>Physique <b>${e.phys ? fmt(e.phys.qty) + " m" : "—"}</b></span>${e.delta !== null ? `<span>Δ <b>${fmtS(e.delta)} m</b></span>` : ""}</span></header>
      <div class="case-diag">
        <div><span class="eyebrow">Hypothèse · ${conf(d.confidence)}</span><p>${esc(d.hypothesis || "")}</p>${cands}</div>
        <div><span class="eyebrow">Action proposée · ${esc(d.owner ? ownerName(d.owner) : "")}</span><p>${esc(d.action || "")}</p>
          <span class="eyebrow" style="margin-top:4px">Lignes sources</span><div class="evid">${(d.evidence || []).map((x) => `<span>${esc(x)}</span>`).join("")}</div></div>
      </div>
      <div class="tl"><div class="tl-h mes">Trace MES</div><div class="tl-h d">Date</div><div class="tl-h phy">Trace physique</div>${tl}</div>
      ${e.excluded_mes ? `<div class="excl">${e.excluded_mes} mouvement(s) MES écarté(s) : le corps a porté d'autres batches (${esc(e.excluded_batches.join(", "))}). Seuls les mouvements de la clé rouleau + batch sont affichés.</div>` : ""}
    </article>`;
  }
  function viewDossier() {
    const list = gaps();
    return `<div class="stack"><div class="callout">Pour chaque écart : traces MES et physiques retrouvées avec la clé <b>rouleau + batch</b>, côte à côte par ordre chronologique, avec la ligne source de chaque événement. L'hypothèse et l'action sont calculées par règles ; elles restent à confirmer en réunion.</div>
      <div class="dossier">${list.map(caseHtml).join("")}</div></div>`;
  }

  // ---- À valider
  function diffHighlight(a, b) {
    if (!a || !b || a.length !== b.length) return esc(a);
    return [...a].map((ch, i) => (ch !== b[i] ? `<span class="diffchar">${esc(ch)}</span>` : esc(ch))).join("");
  }
  function mesBox(m, i, p, key) {
    return `<div class="vbox mes"><span class="eyebrow" style="color:var(--mes)">MES${key ? ` · candidat ${i + 1}` : ""}</span>
      <span class="k">${esc(m.roll_raw)} / ${p && p.batch ? diffHighlight(m.batch, p.batch) : esc(m.batch)}</span>
      <dl><dt>Longueur</dt><dd>${fmt(m.qty)} m</dd><dt>Dernier mvt</dt><dd>${esc(fmtD(m.date, true))}</dd><dt>Article</dt><dd>${esc(m.perimeter)}</dd><dt>Source</dt><dd class="mono">${esc(m.src)}#L${m.row}</dd></dl>
      ${key ? `<div class="vactions"><button class="btn small" data-dec="${esc(key)}" data-val="accept:${esc(m.batch)}">Choisir ce batch</button></div>` : ""}</div>`;
  }
  function viewValider() {
    const pending = toValidate();
    const done = [...validatedKeys().values()];
    const physBox = (p, m) => `<div class="vbox phy"><span class="eyebrow" style="color:var(--phy)">Inventaire physique</span>
      <span class="k">${esc(p.roll_raw)} / ${p.batch ? (m ? diffHighlight(p.batch, m.batch) : esc(p.batch)) : '<span class="muted">batch vide</span>'}</span>
      <dl><dt>Longueur</dt><dd>${fmt(p.qty)} m</dd><dt>Compté le</dt><dd>${esc(fmtD(p.date))}</dd><dt>Périmètre</dt><dd>${esc(p.perimeter)}</dd><dt>Source</dt><dd class="mono">${esc(p.src)}#L${p.row}</dd></dl></div>`;
    const cards = pending.map((e) => {
      const d = e.diag || {};
      const multi = e.category === "AMBIG";
      return `<div class="vcard"><div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">${refBtn(e.ref_id)} ${pill(e.category)} ${conf(d.confidence)} ${trk(e)}</div>
        ${e.stale_decision ? `<div class="warn-line">Décision précédente « ${esc(e.stale_decision)} » non applicable : les candidats MES ont changé depuis.</div>` : ""}
        <p style="margin:0;max-width:90ch">${esc(d.hypothesis)}</p>
        <div class="vrow">${physBox(e.phys, multi ? null : e.mes)}${multi ? e.candidates.map((c, i) => mesBox(c, i, e.phys, e.decision_key)).join("") : mesBox(e.mes, 0, e.phys, null)}</div>
        <div class="vactions">${multi ? "" : `<button class="btn small primary" data-dec="${esc(e.decision_key)}" data-val="accept:${esc(e.mes.batch)}">Valider la correspondance</button>`}
          <button class="btn small" data-dec="${esc(e.decision_key)}" data-val="reject">Ce n'est pas le même rouleau</button>
          <span class="note">Rejeter sépare les lignes en « seulement MES » et « seulement physique ».</span></div></div>`;
    }).join("");
    const doneHtml = done.length ? `<section class="panel"><div class="panel-h"><h2>Décisions prises (${done.length})</h2><button class="btn small" data-act="dl-dec">Exporter les décisions (.json)</button></div>
      <div class="panel-b"><ul class="bullets">${done.map((e) => {
        const when = S.decisionsMeta[e.decision_key];
        return `<li><span class="mono">${esc(e.roll_display)}</span> · ${e.validated === "accept" ? `rattaché au batch MES <span class="mono">${esc(e.mes.batch)}</span> → ${esc(E.CAT_LABEL[e.category])}` : "correspondance rejetée"}
          <span class="faint">${when ? "· " + esc(fmtDT(when)) : "· décision reprise d'une analyse précédente"}</span>
          <button class="btn ghost small" data-undo="${esc(e.decision_key)}">Annuler</button></li>`;
      }).join("")}</ul>
        <p class="note">Les décisions sont rattachées au rouleau + batch relevé : elles se reportent automatiquement sur les analyses suivantes, même si le fichier Excel est trié autrement.</p></div></section>` : "";
    return `<div class="stack">${pending.length ? `<div class="callout">Aucune correspondance incertaine n'est imposée : chaque cas ci-dessous attend votre décision. Les écarts, le dossier et la synthèse se recalculent immédiatement.</div><div class="vcards">${cards}</div>` : `<div class="callout">Toutes les correspondances incertaines ont été tranchées.</div>`}${doneHtml}</div>`;
  }

  // ---- Sources & règles
  function viewSources() {
    const infoByName = new Map((S.result ? S.result.sources : []).map((s) => [s.role + "|" + s.name, s]));
    const files = S.files.map((f) => {
      const info = infoByName.get(f.role + "|" + f.name);
      const fields = f.role && f.role !== "ignore" ? E.ROLE_FIELDS[f.role] : [];
      const cols = info ? info.columns : [];
      const ov = ((S.cfg.column_overrides || {})[f.name]) || {};
      const maps = fields.map((fl) => {
        const cur = info && info.mapping[fl] !== undefined ? info.mapping[fl] : "";
        const req = E.REQUIRED[f.role].includes(fl);
        const miss = req && !cur;
        return `<span class="map ${req ? "req" : ""} ${miss ? "miss" : ""}">${FIELD_LABEL[fl] || fl}${req ? "*" : ""}
          <select aria-label="Colonne pour ${FIELD_LABEL[fl]}" data-map="${f.id}" data-field="${fl}">
            <option value="">—</option>${cols.filter(Boolean).map((c) => `<option ${c === cur ? "selected" : ""} value="${esc(c)}">${esc(c)}</option>`).join("")}</select>${ov[fl] ? '<span class="faint" title="forcé">•</span>' : ""}</span>`;
      }).join("");
      return `<div class="file"><div class="file-h"><div><div class="file-name"><span class="role-dot" style="background:${ROLE_COLOR[f.role] || "var(--faint)"}"></span>${esc(f.filename)}</div>
          <div class="note">${info ? `en-tête ligne ${info.header_row} · ${info.records} lignes lues${info.no_batch && f.role.endsWith("inv") ? ` · ${info.no_batch} sans batch` : ""}${info.skipped ? ` · ${info.skipped} ignorée(s)` : ""}` : "non utilisé"}</div>
          ${info && info.missing.length ? `<div class="warn-line">Colonne(s) obligatoire(s) non reconnue(s) : ${info.missing.map((m) => FIELD_LABEL[m]).join(", ")} — choisissez-la(les) ci-dessous.</div>` : ""}</div>
        <div class="file-ctl"><select class="sel" data-role="${f.id}" aria-label="Rôle du fichier">
          ${[...ROLES, "ignore"].map((r) => `<option value="${r}" ${f.role === r ? "selected" : ""}>${r === "ignore" ? "Ignorer" : E.ROLE_LABELS[r]}</option>`).join("")}</select>
          ${f.role === "phys_inv" ? `<input class="inp" style="width:170px" data-perim="${f.id}" placeholder="Périmètre par défaut" value="${esc(f.perimeter)}" aria-label="Périmètre par défaut">` : ""}
          <button class="btn ghost small" data-rm="${f.id}" aria-label="Retirer ${esc(f.filename)}">Retirer</button></div></div>
        ${fields.length ? `<div class="file-b"><div class="maps">${maps}</div></div>` : ""}</div>`;
    }).join("");
    const c = S.cfg;
    const forkNote = S.current.parent_id && !S.current.id && findAnalysis(S.current.parent_id)
      ? `<div class="callout">Nouvelle version de « ${esc(findAnalysis(S.current.parent_id).name)} » : règles et validations reprises. Déposez les nouveaux exports ; un fichier de même nom remplace l'ancien, les autres se retirent avec « Retirer ».</div>` : "";
    return `<div class="stack">${forkNote}
      <label class="drop" id="drop" for="fileinput"><strong>Déposer les exports ici</strong><span class="note">Exports MES (inventaire, traçabilité Movable Unit) et fichiers Excel des opérations (inventaire, traçabilité APU) · .xlsx .xls .csv · aussi : analyse, règles ou décisions exportées (.json) · rien ne quitte ce navigateur</span></label>
      ${S.error ? `<div class="callout">${esc(S.error)}</div>` : ""}
      <div class="files">${files || '<p class="muted">Aucun fichier.</p>'}</div>
      <section class="panel"><div class="panel-h"><h2>Règles de rapprochement</h2><span class="note">Hypothèses à confirmer avec Harold</span></div><div class="panel-b stack">
        <div class="params">
          <div class="field"><label for="p-tabs">Tolérance absolue (m)</label><input class="inp" id="p-tabs" type="number" step="0.1" data-cfg="tolerance_abs_m" value="${esc(c.tolerance_abs_m)}"></div>
          <div class="field"><label for="p-tpct">Tolérance relative (%)</label><input class="inp" id="p-tpct" type="number" step="0.1" data-cfg="tolerance_pct" value="${esc(c.tolerance_pct)}"></div>
          <div class="field"><label for="p-stale">Stock dormant après (jours)</label><input class="inp" id="p-stale" type="number" data-cfg="stale_days" value="${esc(c.stale_days)}"></div>
          <div class="field"><label for="p-win">Fenêtre clé partielle (jours)</label><input class="inp" id="p-win" type="number" data-cfg="window_days" value="${esc(c.window_days)}"></div>
          <div class="field"><label for="p-pref">Préfixes n° rouleau (retirés pour la clé)</label><input class="inp" id="p-pref" data-cfg="roll_prefixes" value="${esc((c.roll_prefixes || []).join(", "))}"></div>
          <div class="field"><label for="p-date">Date d'inventaire (vide = auto)</label><input class="inp" id="p-date" type="date" data-cfg="inventory_date" value="${esc(c.inventory_date || "")}"></div>
        </div>
        <div class="field"><label for="p-json">Configuration complète (JSON, partagée avec le script Python)</label><textarea class="inp" id="p-json">${esc(JSON.stringify(Object.assign({}, c, { file_defaults: (S.effectiveCfg || c).file_defaults }), null, 2))}</textarea></div>
        <div class="vactions"><button class="btn small" data-act="apply-json">Appliquer le JSON</button><button class="btn small" data-act="import">Importer config.json</button><button class="btn small" data-act="dl-cfg">Télécharger config.json</button><button class="btn ghost small" data-act="reset-cfg">Règles par défaut</button></div>
      </div></section></div>`;
  }

  // ---- Historique
  function viewHistorique() {
    const cur = S.current;
    const byId = new Map(S.history.map((a) => [a.id, a]));
    const rows = S.history.map((a) => {
      const k = (a.snapshot && a.snapshot.kpis) || (a.summary && a.summary.kpis) || {};
      const isCur = cur.id === a.id, isBase = S.baseline && S.baseline.id === a.id;
      const parent = a.parent_id ? byId.get(a.parent_id) : null;
      const nameCell = S.renaming === a.id
        ? `<span class="vactions"><input class="inp" id="rename-inp" value="${esc(a.name)}" aria-label="Nouveau nom"><button class="btn small" data-hact="rename-ok" data-id="${esc(a.id)}">OK</button></span>`
        : `<span class="h-name">${esc(a.name)}</span>`;
      return `<div class="hrow${isCur ? " cur" : ""}">
        <div class="h-main">${nameCell}
          <div class="note">Inventaire du ${esc(fmtD(a.inventory_date))} · enregistrée le ${esc(fmtDT(a.created_at))}${a.saved_by ? " par " + esc(a.saved_by) : ""} · ${(a.files || []).length} fichiers${a.source === "python" ? " · script Python" : ""}</div>
          <div class="h-tags">${isCur ? '<span class="trk trk-new">ouverte</span>' : ""}${isBase ? '<span class="trk trk-pers">référence de comparaison</span>' : ""}${a.example ? '<span class="trk">exemple fictif</span>' : ""}${parent ? `<span class="note">← repart de « ${esc(parent.name)} »</span>` : a.parent_id ? '<span class="note">← repart d\'une analyse absente d\'ici</span>' : ""}</div>
        </div>
        <div class="h-k num"><b>${k.gaps !== undefined ? k.gaps : "?"}</b> écarts<br><span class="muted">${fmt(k.gap_meters)} m · ${k.to_validate || 0} à valider</span></div>
        <div class="h-act">
          <button class="btn small" data-hact="open" data-id="${esc(a.id)}">Ouvrir</button>
          <button class="btn small" data-hact="fork" data-id="${esc(a.id)}">Repartir de celle-ci</button>
          ${S.result && !isCur ? `<button class="btn small" data-hact="${isBase ? "uncompare" : "compare"}" data-id="${esc(a.id)}">${isBase ? "Ne plus comparer" : "Comparer"}</button>` : ""}
          ${SERVER && !a.example ? `<button class="btn ghost small" data-hact="report" data-id="${esc(a.id)}" title="Rapport Excel mis en forme, généré par le moteur Python du serveur">Rapport Excel</button>` : ""}
          <button class="btn ghost small" data-hact="export" data-id="${esc(a.id)}">Exporter</button>
          ${a.example ? "" : `<button class="btn ghost small" data-hact="rename" data-id="${esc(a.id)}">Renommer</button>
          ${S.confirmDel === a.id ? `<button class="btn small danger" data-hact="del-ok" data-id="${esc(a.id)}">Confirmer la suppression</button>` : `<button class="btn ghost small" data-hact="del" data-id="${esc(a.id)}">Supprimer</button>`}`}
        </div></div>`;
    }).join("");
    const ev = S.result && S.result.evolution;
    const resolved = ev && ev.resolved.length ? `<section class="panel"><div class="panel-h"><h2>Écarts résolus depuis « ${esc(ev.baseline.name)} »</h2><span class="note">${ev.resolved.length} · absents de l'analyse ouverte</span></div>
      <div class="tbl-wrap"><table class="t"><thead><tr><th>Rouleau</th><th>Batch</th><th>Catégorie avant</th><th>Périmètre</th><th class="r">Métrage (m)</th><th>Issue</th><th>Suivi depuis</th></tr></thead><tbody>
      ${ev.resolved.map((g) => `<tr><td class="mono">${esc(g.roll_display)}</td><td class="mono">${esc(g.batch || "?")}</td><td>${pill(g.category)}</td><td>${esc(g.perimeter)}</td><td class="r">${fmt(g.meters)}</td>
        <td>${g.outcome === "now_ok" ? '<span class="pill c-OK">Désormais conforme</span>' : '<span class="pill c-DUP">N\'apparaît plus</span>'}</td><td>${esc(fmtD(g.first_seen))}</td></tr>`).join("")}
      </tbody></table></div></section>` : "";
    const cmpOnly = ev ? `<section class="panel"><div class="panel-h"><h2>Comparaison en cours</h2></div><div class="panel-b"><ul class="bullets">${ev.bullets.map((b) => `<li>${linkRefs(b)}</li>`).join("")}</ul></div></section>` : "";
    return `<div class="stack">
      <div class="callout">Chaque « Enregistrer » crée une version datée et immuable : fichiers, règles, validations et résultat. ${S.dbOk ? `Elles sont stockées ${Store.label}.` : "Le stockage du navigateur est indisponible ici : les versions ne durent que le temps de la session."}${SERVER && !SERVER.persistent ? ' <b class="warn-line">Aucun volume Railway n\'est attaché : l\'historique sera perdu au prochain redéploiement.</b>' : ""} Pour partager ou archiver ailleurs, « Exporter » produit un .json que l'app et le script Python savent rouvrir.
        <span class="vactions" style="margin-top:8px"><button class="btn small" data-act="import">Importer une analyse (.json)</button><button class="btn small" data-act="new">Nouvelle analyse</button></span></div>
      ${cmpOnly}
      <section class="panel"><div class="panel-h"><h2>Versions enregistrées</h2><span class="note">${S.history.length} · la plus récente en premier</span></div>
        <div class="hlist">${rows || '<p class="muted" style="padding:0 16px 16px">Aucune analyse enregistrée pour l\'instant.</p>'}</div></section>
      ${resolved}</div>`;
  }

  // ---- Assistant IA
  function viewIA() {
    if (!S.result) return `<div class="callout">${esc(S.error)}</div>`;
    const L = S.llm;
    const [sys, user] = buildPrompt(S.result, L.pseudo);
    return `<div class="grid2"><section class="panel"><div class="panel-h"><h2>Lecture assistée par un LLM</h2><span class="note">optionnel · ne modifie pas le bilan</span></div><div class="panel-b stack">
      <p class="note" style="margin:0">Le LLM reçoit uniquement les faits déjà calculés (synthèse, évolution, hypothèses, traces condensées) et doit citer les références [E01]… Il propose des regroupements de root causes et des questions pour la réunion.</p>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px"><input type="checkbox" id="llm-pseudo" ${L.pseudo ? "checked" : ""}> Pseudonymiser rouleaux et batches (R001, B001…) avant envoi</label>
      <div class="vactions"><button class="btn small primary" data-act="copy-prompt">Copier le prompt</button><span class="note">à coller dans Copilot, Claude ou ChatGPT (outil interne autorisé)</span></div>
      <div class="params">
        <div class="field"><label for="llm-prov">Appel direct : fournisseur</label><select class="sel" id="llm-prov">${[["anthropic", "Anthropic"], ["openai", "OpenAI"], ["azure", "Azure OpenAI"]].map(([v, l]) => `<option value="${v}" ${L.provider === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>
        <div class="field"><label for="llm-model">Modèle</label><input class="inp" id="llm-model" value="${esc(L.model)}"></div>
        <div class="field"><label for="llm-url">URL (vide = défaut ; obligatoire pour Azure)</label><input class="inp" id="llm-url" value="${esc(L.url)}" placeholder="https://…"></div>
        <div class="field"><label for="llm-key">Clé API (gardée en mémoire, jamais enregistrée)</label><input class="inp" id="llm-key" type="password" value="${esc(L.key)}" autocomplete="off"></div>
      </div>
      <div class="vactions"><button class="btn small" data-act="run-llm" ${L.busy ? "disabled" : ""}>${L.busy ? "Analyse en cours…" : "Lancer l'analyse"}</button>
        <span class="note">L'appel direct fonctionne depuis le fichier HTML ouvert en local ; il est bloqué dans l'aperçu claude.ai.</span></div>
      ${L.err ? `<div class="warn-line">${esc(L.err)}</div>` : ""}
      ${L.out ? `<div><span class="eyebrow">Réponse (à contrôler)</span><div class="llm-out">${linkRefs(L.out)}</div></div>` : ""}
    </div></section>
    <section class="panel"><div class="panel-h"><h2>Prompt envoyé</h2><span class="note">${(sys.length + user.length).toLocaleString("fr-FR")} caractères</span></div>
      <div class="panel-b"><div class="prompt-box">${esc(sys + "\n\n" + user)}</div></div></section></div>`;
  }

  // ------------------------------------------------------------ prompt LLM (même contenu que reconcile/llm.py, + évolution)
  const SYSTEM = "Tu es analyste en contrôle d'inventaire dans une usine de cellules de batteries. On te fournit le résultat " +
    "d'un rapprochement déterministe entre l'inventaire physique et le MES, avec pour chaque écart les traces MES " +
    "et physiques et une hypothèse calculée par règles. Règles : (1) n'utilise QUE les faits fournis, n'invente " +
    "aucun chiffre ni mouvement ; (2) cite systématiquement la référence de l'écart entre crochets, ex. [E03] ; " +
    "(3) si une hypothèse calculée te paraît fragile, dis-le et indique quelle donnée manque ; (4) ne modifie jamais " +
    "les quantités. Réponds en français, en bullet points concis.";
  const TASK = "Prépare la réunion de revue des écarts :\n" +
    "1. « Grandes différences » : 3 à 6 bullet points, les plus importants d'abord (volume, récurrence, risque).\n" +
    "2. « Root causes probables » : regroupe les écarts qui semblent avoir la même cause de fond (processus, poste, saisie).\n" +
    "3. « Actions » : bullet points avec responsable, classés par priorité.\n" +
    "4. « Questions à poser en réunion » : 3 questions maximum, là où les traces ne suffisent pas.";
  function pseudonymMap(r) {
    const rolls = new Map(), batches = new Map(), pairs = new Map();
    for (const e of r.entries) {
      if (!rolls.has(e.roll)) rolls.set(e.roll, "R" + String(rolls.size + 1).padStart(3, "0"));
      for (const x of [e.mes, e.phys, ...(e.candidates || [])]) if (x && x.batch && !batches.has(x.batch)) batches.set(x.batch, "B" + String(batches.size + 1).padStart(3, "0"));
      for (const b of e.excluded_batches || []) if (!batches.has(b)) batches.set(b, "B" + String(batches.size + 1).padStart(3, "0"));
    }
    for (const g of (r.evolution && r.evolution.resolved) || []) if (!rolls.has(g.roll)) rolls.set(g.roll, "R" + String(rolls.size + 1).padStart(3, "0"));
    for (const e of r.entries) {
      const al = rolls.get(e.roll);
      for (const x of [e.mes, e.phys, ...(e.candidates || [])]) if (x) { pairs.set(x.roll_raw, al); if (x.batch_raw && batches.has(x.batch)) pairs.set(x.batch_raw, batches.get(x.batch)); }
      pairs.set(e.roll, al);
    }
    for (const g of (r.evolution && r.evolution.resolved) || []) { pairs.set(g.roll_display, rolls.get(g.roll)); pairs.set(g.roll, rolls.get(g.roll)); if (g.batch && !batches.has(g.batch)) batches.set(g.batch, "B" + String(batches.size + 1).padStart(3, "0")); }
    for (const [b, al] of batches) pairs.set(b, al);
    return [...pairs.entries()].sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  }
  function buildPrompt(r, pseudo) {
    const s = r.summary;
    const lines = [`Inventaire du ${fmtD(r.inventory_date)}.`, ""];
    if (r.evolution) lines.push("ÉVOLUTION DEPUIS L'ANALYSE PRÉCÉDENTE :", ...r.evolution.bullets.map((b) => "- " + b), "");
    lines.push("SYNTHÈSE CALCULÉE :", ...s.differences.map((d) => "- " + d), "", "ACTIONS CALCULÉES :", ...s.actions.map((a) => "- " + a.text), "", "DÉTAIL DES ÉCARTS :");
    for (const e of r.entries) {
      if (!e.ref_id) continue;
      const d = e.diag, m = e.mes, p = e.phys, h = e.history;
      lines.push(`[${e.ref_id}] ${E.CAT_LABEL[e.category]} · ${e.perimeter} · rouleau ${e.roll_display} / batch ${e.batch || "?"} · MES ${m ? fmt(m.qty) : "—"} m · physique ${p ? fmt(p.qty) : "—"} m · Δ ${fmtS(e.delta)} m` +
        (h && h.status === "persistent" ? ` · persistant sur ${h.occurrences} inventaires depuis le ${fmtD(h.first_seen)}` : h && h.status === "new" ? " · nouveau" : ""));
      if (d) lines.push(`  Hypothèse par règles (${d.confidence}) : ${d.hypothesis}`);
      for (const [side, evs] of [["MES", e.trace_mes], ["Physique", e.trace_phys]]) {
        if (evs.length) lines.push(`  Trace ${side} : ` + evs.slice(-8).map((x) => `${fmtD(x.date, true)} ${x.event}` + (x.equipment ? " " + x.equipment : "") + (x.to ? " → " + x.to : "") + (x.qty !== null ? ` (${fmt(x.qty)} m)` : "")).join("; "));
        else lines.push(`  Trace ${side} : aucune`);
      }
    }
    let text = lines.join("\n");
    if (pseudo) for (const [real, al] of pseudonymMap(r)) if (real && real.length >= 3) text = text.split(real).join(al);
    return [SYSTEM, TASK + "\n\n" + text];
  }
  async function runLlm() {
    const L = S.llm;
    L.err = ""; L.out = "";
    if (!L.key) { L.err = "Renseignez une clé API, ou utilisez « Copier le prompt »."; render(); return; }
    const [system, user] = buildPrompt(S.result, L.pseudo);
    L.busy = true; render();
    try {
      let res, data;
      if (L.provider === "anthropic") {
        res = await fetch(L.url || "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": L.key, "anthropic-version": "2023-06-01", "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({ model: L.model, max_tokens: 2000, system, messages: [{ role: "user", content: user }] }),
        });
        data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || res.status);
        L.out = (data.content || []).map((b) => b.text || "").join("");
      } else {
        const headers = { "content-type": "application/json" };
        if (L.provider === "azure") headers["api-key"] = L.key; else headers.authorization = "Bearer " + L.key;
        if (L.provider === "azure" && !L.url) throw new Error("URL Azure requise (…/openai/deployments/<nom>/chat/completions?api-version=…)");
        const body = { messages: [{ role: "system", content: system }, { role: "user", content: user }] };
        if (L.model) body.model = L.model;
        res = await fetch(L.url || "https://api.openai.com/v1/chat/completions", { method: "POST", headers, body: JSON.stringify(body) });
        data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || res.status);
        L.out = data.choices[0].message.content;
      }
    } catch (e) {
      L.err = "Appel impossible : " + (e.message || e) + ". Depuis l'aperçu claude.ai, les appels externes sont bloqués : ouvrez le fichier HTML en local ou copiez le prompt.";
    }
    L.busy = false; render();
  }

  // ------------------------------------------------------------ exports
  function suiviText(e) {
    const h = e.history;
    if (!h) return "";
    if (h.status === "new") return "Nouveau" + (h.was_ok ? " (était conforme)" : "");
    if (h.status === "persistent") return `Persistant · ${h.occurrences} inventaire(s) depuis le ${fmtD(h.first_seen)}` + (h.changes.length ? " · " + h.changes.join(" ; ") : "");
    return "";
  }
  function markdown() {
    const r = S.result, s = r.summary, k = s.kpis;
    const L = [`# ${S.current.name} — rapprochement inventaire physique / MES`, "",
      `Inventaire du **${fmtD(r.inventory_date)}** · ${k.compared} rouleaux · ${k.ok} conformes (${k.ok_pct} %) · **${k.gaps} écarts** (${fmt(k.gap_meters)} m) · ${k.to_validate} à valider`, ""];
    if (r.evolution) L.push("## Évolution depuis l'analyse précédente", "", ...r.evolution.bullets.map((b) => "- " + b), "");
    L.push("## Grandes différences", "", ...s.differences.map((d) => "- " + d), "", "## Actions à mener", "", ...s.actions.map((a) => "- " + a.text), "", "## Dossier de traçabilité par écart", "");
    for (const e of gaps()) {
      const d = e.diag || {}, m = e.mes, p = e.phys;
      L.push(`### ${e.ref_id} · ${e.roll_display} / ${e.batch || "?"} — ${E.CAT_LABEL[e.category]}`, "");
      if (suiviText(e)) L.push(`- Suivi : ${suiviText(e)}`);
      L.push(`- Périmètre : ${e.perimeter} · MES : ${m ? fmt(m.qty) : "—"} m · Physique : ${p ? fmt(p.qty) : "—"} m · Δ : ${fmtS(e.delta)} m`);
      if (d.code) L.push(`- **Hypothèse (${d.confidence.toLowerCase()})** : ${d.hypothesis}`, `- **Action** : ${d.action} → ${ownerName(d.owner)}`, `- Sources : ${d.evidence.join(", ")}`);
      if (e.excluded_mes) L.push(`- ${e.excluded_mes} mouvement(s) MES écarté(s) : autres batches du même corps (${e.excluded_batches.slice(0, 5).join(", ")})`);
      L.push("");
      const evs = sortedEvents(e);
      if (evs.length) {
        L.push("| Date | Trace MES | Trace physique |", "|---|---|---|");
        for (const { x, s: side } of evs) {
          const cell = [x.event, x.equipment, x.to ? "→ " + x.to : "", x.comment ? `« ${x.comment} »` : ""].filter(Boolean).join(" · ") + ` · ${fmt(x.qty)} m · \`${x.ref}\`` + (x.partial ? " (clé partielle)" : "");
          L.push(`| ${fmtD(x.date, true)} | ${side === "mes" ? cell : ""} | ${side === "phy" ? cell : ""} |`);
        }
      } else L.push("_Aucune trace trouvée dans les fichiers fournis._");
      L.push("");
    }
    return L.join("\n");
  }
  function summaryText() {
    const r = S.result, s = r.summary;
    return [...(r.evolution ? ["Évolution", ...r.evolution.bullets.map((b) => "• " + b), ""] : []),
      "Grandes différences", ...s.differences.map((d) => "• " + d), "", "Actions", ...s.actions.map((a) => "• " + a.text)].join("\n");
  }
  function exportExcel() {
    const r = S.result, wb = XLSX.utils.book_new(), s = r.summary, k = s.kpis;
    const syn = [[`${S.current.name} — rapprochement inventaire physique / MES`], [`Inventaire du ${fmtD(r.inventory_date)}`], [],
      ["Rouleaux rapprochés", "Conformes", "Écarts", "Métrage en écart (m)", "À valider", "Hypothèses fortes"],
      [k.compared, k.ok, k.gaps, k.gap_meters, k.to_validate, k.high_conf], [],
      ...(r.evolution ? [["Évolution depuis l'analyse précédente"], ...r.evolution.bullets.map((b) => ["• " + b]), []] : []),
      ["Grandes différences"], ...s.differences.map((d) => ["• " + d]), [], ["Actions"], ...s.actions.map((a) => ["• " + a.text])];
    const ws1 = XLSX.utils.aoa_to_sheet(syn); ws1["!cols"] = [{ wch: 140 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Synthèse");
    if (r.evolution) {
      const evRows = [["Statut", "Réf.", "Rouleau", "Batch", "Catégorie", "Périmètre", "Métrage (m)", "Depuis", "Nb d'inventaires", "Changement"]];
      for (const e of gaps()) if (e.history && e.history.status !== "ok")
        evRows.push([e.history.status === "new" ? "Nouveau" + (e.history.was_ok ? " (était conforme)" : "") : "Persistant", e.ref_id, e.roll_display, e.batch, E.CAT_LABEL[e.category], e.perimeter, e.delta !== null ? Math.abs(Math.round(e.delta * 10) / 10) : (e.mes || e.phys || {}).qty, fmtD(e.history.first_seen), e.history.occurrences, (e.history.changes || []).join(" ; ")]);
      for (const g of r.evolution.resolved) evRows.push([g.outcome === "now_ok" ? "Résolu · conforme" : "Résolu · n'apparaît plus", g.ref_id, g.roll_display, g.batch, E.CAT_LABEL[g.category] + " (avant)", g.perimeter, g.meters, fmtD(g.first_seen), g.occurrences, ""]);
      const wsE = XLSX.utils.aoa_to_sheet(evRows); wsE["!cols"] = [22, 6, 14, 13, 26, 18, 11, 12, 10, 50].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, wsE, "Évolution");
    }
    const ec = [["Réf.", "Catégorie", "Suivi", "Périmètre", "Rouleau", "Batch MES", "Batch physique", "Long. MES (m)", "Long. physique (m)", "Δ (m)", "Hypothèse", "Confiance", "Action", "Responsable", "Validation", "Lignes sources", "Mvts MES écartés"]];
    for (const e of gaps()) {
      const d = e.diag || {};
      ec.push([e.ref_id, E.CAT_LABEL[e.category], suiviText(e), e.perimeter, e.roll_display, e.mes ? e.mes.batch : e.candidates.map((c) => c.batch).join(", "), e.phys ? e.phys.batch_raw : "",
        e.mes ? e.mes.qty : "", e.phys ? e.phys.qty : "", e.delta === null ? "" : Math.round(e.delta * 10) / 10, d.hypothesis || "", d.confidence || "", d.action || "",
        d.owner ? ownerName(d.owner) : "", e.validated === "accept" ? "Validée" : e.validated === "reject" ? "Rejetée" : E.TO_VALIDATE.includes(e.category) ? "À valider" : "",
        (d.evidence || []).join(" | "), e.excluded_mes || ""]);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(ec); ws2["!cols"] = [6, 22, 26, 18, 14, 13, 13, 11, 11, 9, 70, 10, 50, 24, 11, 50, 10].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws2, "Écarts");
    const dos = [["Réf.", "Rouleau", "Batch", "Date", "Trace MES", "Qté MES", "Réf. MES", "Trace physique", "Qté phys.", "Réf. physique"]];
    for (const e of gaps()) {
      const d = e.diag || {};
      dos.push([e.ref_id, e.roll_display, e.batch, "", `${E.CAT_LABEL[e.category]} — ${d.hypothesis || ""}`]);
      dos.push(["", "", "", "", `Action : ${d.action || ""} → ${d.owner ? ownerName(d.owner) : ""}`]);
      for (const { x, s: side } of sortedEvents(e)) {
        const t = [x.event, x.equipment, x.to ? "→ " + x.to : "", x.comment].filter(Boolean).join(" · ") + (x.partial ? " (clé partielle)" : "");
        dos.push(side === "mes" ? [e.ref_id, "", "", fmtD(x.date, true), t, x.qty, x.ref, "", "", ""] : [e.ref_id, "", "", fmtD(x.date, true), "", "", "", t, x.qty, x.ref]);
      }
      dos.push([]);
    }
    const ws3 = XLSX.utils.aoa_to_sheet(dos); ws3["!cols"] = [6, 13, 12, 16, 55, 9, 30, 55, 9, 30].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws3, "Dossier réunion");
    const val = [["Clé rouleau|batch (ne pas modifier)", "Rouleau", "Batch physique", "Décision (accept / reject / pick:N / n° de batch MES)"]];
    const seen = new Set();
    for (const e of r.entries) {
      if (!e.decision_key || seen.has(e.decision_key)) continue;
      seen.add(e.decision_key);
      val.push([e.decision_key, e.roll_display, e.phys ? e.phys.batch_raw || "(vide)" : "", normalizedDecisions()[e.decision_key] || ""]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(val), "À valider");
    const all = [["Réf.", "Catégorie", "Périmètre", "Rouleau", "Batch", "Rouleau MES", "Rouleau physique", "Long. MES", "Long. physique", "Δ", "Ligne MES", "Ligne physique"]];
    for (const e of r.entries) all.push([e.ref_id || "", E.CAT_LABEL[e.category], e.perimeter, e.roll, e.batch, e.mes ? e.mes.roll_raw : "", e.phys ? e.phys.roll_raw : "", e.mes ? e.mes.qty : "", e.phys ? e.phys.qty : "", e.delta === null ? "" : Math.round(e.delta * 10) / 10, e.mes ? `${e.mes.src}#L${e.mes.row}` : "", e.phys ? `${e.phys.src}#L${e.phys.row}` : ""]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(all), "Rapprochement complet");
    const src = [["Fichier", "Rôle", "Ligne d'en-tête", "Lignes lues", "Sans batch", "Colonnes reconnues", "Manquantes"]];
    for (const s2 of r.sources) src.push([s2.name, E.ROLE_LABELS[s2.role], s2.header_row, s2.records, s2.no_batch, Object.entries(s2.mapping).map(([f, h]) => `${f} ← ${h}`).join(", "), s2.missing.join(", ")]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(src), "Sources & colonnes");
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    download(`rapprochement_${slug(S.current.name)}_${r.inventory_date}.xlsx`, new Blob([out], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  }

  // ------------------------------------------------------------ navigation
  function goTo(refId) {
    if (!refId) return;
    S.tab = "dossier"; render();
    requestAnimationFrame(() => {
      const el = document.getElementById("case-" + refId);
      if (!el) return;
      el.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1600);
    });
  }

  // ------------------------------------------------------------ événements
  async function historyAction(act, id) {
    const an = findAnalysis(id);
    if (!an) return;
    const withFull = async (fn) => { try { fn(await fullAnalysis(id)); } catch (e) { toast("Chargement impossible : " + e.message); } };
    if (act === "open") withGuard(`Ouvrir « ${an.name} »`, () => withFull((f) => openAnalysis(f, false)));
    else if (act === "fork") withGuard(`Repartir de « ${an.name} »`, () => withFull((f) => openAnalysis(f, true)));
    else if (act === "report") {
      try {
        const q = S.baseline && S.current.id === id ? `?compare_to=${encodeURIComponent(S.baseline.id)}` : "";
        download(`rapport_${id}.xlsx`, await api("GET", `/api/analyses/${encodeURIComponent(id)}/rapport.xlsx${q}`));
      } catch (e) { toast("Rapport indisponible : " + e.message); }
    }
    else if (act === "compare") { S.baseline = an; compute(false); toast(`Comparée à « ${an.name} »`); }
    else if (act === "uncompare") { S.baseline = null; compute(false); }
    else if (act === "export") withFull((f) => { const clean = Object.assign({}, f); delete clean.example; download(`analyse_${f.id}.json`, JSON.stringify(clean), "application/json"); });
    else if (act === "rename") { S.renaming = id; render(); const i = $("#rename-inp"); if (i) { i.focus(); i.select(); } }
    else if (act === "rename-ok") {
      const v = ($("#rename-inp") || {}).value;
      if (v && v.trim()) {
        an.name = v.trim();
        if (S.dbOk) { try { await Store.rename(id, an.name); } catch (e) { toast("Renommage impossible : " + e.message); } }
        if (S.current.id === id) S.current.name = an.name;
      }
      S.renaming = null; await refreshHistory(); render();
    } else if (act === "del") { S.confirmDel = id; render(); }
    else if (act === "del-ok") {
      if (S.dbOk) { try { await Store.del(id); } catch (e) { toast("Suppression impossible : " + e.message); S.confirmDel = null; render(); return; } }
      DEMO.history = (DEMO.history || []).filter((a) => a.id !== id || a.example);
      if (S.baseline && S.baseline.id === id) S.baseline = null;
      if (S.current.id === id) { S.current.id = null; S.dirty = true; }
      S.confirmDel = null; await refreshHistory(); compute(false); toast("Version supprimée");
    }
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-tab],[data-go],[data-act],[data-fcat],[data-fown],[data-dec],[data-undo],[data-rm],[data-hact]");
    if (!t) return;
    if (t.dataset.hact) { historyAction(t.dataset.hact, t.dataset.id); return; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; S.confirmDel = null; store("tab", S.tab); render(); window.scrollTo({ top: 0 }); return; }
    if (t.dataset.go !== undefined) { goTo(t.dataset.go); return; }
    if (t.dataset.fcat) { S.filter.cat = t.dataset.fcat; render(); return; }
    if (t.dataset.fown) { S.filter.owner = t.dataset.fown; render(); return; }
    if (t.dataset.dec) {
      S.decisions[t.dataset.dec] = t.dataset.val; S.decisionsMeta[t.dataset.dec] = nowIso();
      compute(true); toast(t.dataset.val === "reject" ? "Correspondance rejetée" : "Correspondance validée"); return;
    }
    if (t.dataset.undo) {
      const k = t.dataset.undo;
      delete S.decisions[k]; delete S.decisionsMeta[k];
      if (S.result) for (const e of S.result.entries) if (e.decision_key === k) delete S.decisions[e.uid];
      compute(true); return;
    }
    if (t.dataset.rm) { S.files = S.files.filter((f) => String(f.id) !== t.dataset.rm); compute(true); return; }
    const a = t.dataset.act;
    if (a === "new") withGuard("Démarrer une nouvelle analyse", newAnalysis);
    else if (a === "save") saveAnalysis();
    else if (a === "guard-save") { const g = S.guard; saveAnalysis().then((ok) => { if (ok && g) { S.guard = null; g.fn(); } }); }
    else if (a === "guard-go") { const g = S.guard; S.guard = null; S.dirty = false; if (g) g.fn(); }
    else if (a === "guard-cancel") { S.guard = null; render(); }
    else if (a === "import" || a === "open-files") $("#fileinput").click();
    else if (a === "demo") loadDemo();
    else if (a === "xlsx") S.result ? exportExcel() : toast("Rien à exporter");
    else if (a === "dl-md") S.result ? download(`brief_${slug(S.current.name)}_${S.result.inventory_date}.md`, markdown(), "text/markdown;charset=utf-8") : toast("Rien à exporter");
    else if (a === "copy-summary") copy(summaryText(), "Synthèse copiée");
    else if (a === "copy-prompt") { const [s1, u] = buildPrompt(S.result, S.llm.pseudo); copy(s1 + "\n\n" + u, "Prompt copié"); }
    else if (a === "run-llm") runLlm();
    else if (a === "dl-dec") download("decisions.json", JSON.stringify(normalizedDecisions(), null, 2), "application/json");
    else if (a === "dl-cfg") download("config.json", JSON.stringify(Object.assign({}, S.cfg, { file_defaults: (S.effectiveCfg || S.cfg).file_defaults }), null, 2), "application/json");
    else if (a === "reset-cfg") { S.cfg = JSON.parse(JSON.stringify(DEFAULT_CFG)); compute(true); toast("Règles par défaut rétablies"); }
    else if (a === "apply-json") {
      try { S.cfg = JSON.parse($("#p-json").value); compute(true); toast("Configuration appliquée"); }
      catch (e) { toast("JSON invalide : " + e.message); }
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && ev.target.matches("tr.row")) goTo(ev.target.dataset.go);
    if (ev.key === "Enter" && ev.target.id === "rename-inp") { const b = document.querySelector("[data-hact=rename-ok]"); if (b) b.click(); }
    if (ev.key === "Escape" && S.renaming) { S.renaming = null; render(); }
  });
  document.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.id === "fileinput") { addFiles(t.files); t.value = ""; return; }
    if (t.id === "an-name") { S.current.name = t.value.trim() || "Analyse sans nom"; S.dirty = true; render(); return; }
    if (t.dataset.role) { const f = S.files.find((x) => String(x.id) === t.dataset.role); f.role = t.value; compute(true); return; }
    if (t.dataset.perim) { const f = S.files.find((x) => String(x.id) === t.dataset.perim); f.perimeter = t.value.trim(); compute(true); return; }
    if (t.dataset.map) {
      const f = S.files.find((x) => String(x.id) === t.dataset.map);
      S.cfg.column_overrides = S.cfg.column_overrides || {};
      const ov = (S.cfg.column_overrides[f.name] = S.cfg.column_overrides[f.name] || {});
      if (t.value) ov[t.dataset.field] = t.value; else delete ov[t.dataset.field];
      compute(true); return;
    }
    if (t.dataset.cfg) {
      const k = t.dataset.cfg;
      if (k === "roll_prefixes") S.cfg[k] = t.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
      else if (k === "inventory_date") S.cfg[k] = t.value;
      else S.cfg[k] = parseFloat(t.value) || 0;
      compute(true); return;
    }
    if (t.id === "llm-pseudo") { S.llm.pseudo = t.checked; render(); return; }
    if (t.id === "llm-prov") { S.llm.provider = t.value; S.llm.model = t.value === "anthropic" ? "claude-sonnet-4-5" : t.value === "openai" ? "gpt-4o" : ""; render(); return; }
  });
  document.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "q") {
      S.filter.q = t.value;
      const pos = t.selectionStart; render();
      const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); }
    }
    if (t.id === "llm-key") S.llm.key = t.value;
    if (t.id === "llm-model") S.llm.model = t.value;
    if (t.id === "llm-url") S.llm.url = t.value;
  });
  ["dragenter", "dragover"].forEach((n) => document.addEventListener(n, (ev) => {
    if (ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) { ev.preventDefault(); const d = $("#drop"); if (d) d.classList.add("over"); }
  }));
  ["dragleave", "drop"].forEach((n) => document.addEventListener(n, (ev) => { const d = $("#drop"); if (d && (n === "drop" || ev.target === d)) d.classList.remove("over"); }));
  document.addEventListener("drop", (ev) => {
    if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files.length) { ev.preventDefault(); addFiles(ev.dataTransfer.files); }
  });

  // ------------------------------------------------------------ démarrage
  (async function start() {
    const savedTab = load("tab");
    if (savedTab && TABS.includes(savedTab)) S.tab = savedTab;
    S.dbOk = await Store.init();
    await refreshHistory();
    const latest = SERVER ? S.history.find((a) => !a.example) : null;
    if (latest) {
      try { openAnalysis(await fullAnalysis(latest.id), false); return; } catch (e) { toast("Ouverture de la dernière version impossible : " + e.message); }
    }
    loadDemo();
  })();
})();
