/* Moteur de rapprochement inventaire physique / MES — portage 1:1 de reconcile/engine.py.
 * Toute modification doit être reportée dans les deux fichiers (test : tests/parity.py). */
(function (root) {
  "use strict";
  const VERSION = "0.1.0";

  const SYNONYMS = {
    roll: ["movable unit", "mu", "roll id", "roll", "roll number", "rouleau", "n rouleau", "no rouleau",
      "num rouleau", "numero rouleau", "numero de rouleau", "n de rouleau", "corps", "n corps",
      "id corps", "numero de corps", "container", "bobine", "id rouleau"],
    batch: ["batch", "batch number", "batch no", "batch id", "n batch", "no batch", "numero batch",
      "numero de batch", "lot", "n lot", "numero de lot", "n de lot"],
    qty: ["quantity", "qty", "quantite", "qte", "longueur", "longueur m", "length", "length m",
      "metrage", "metrage m", "longueur en m"],
    date: ["date", "count date", "date inventaire", "date d inventaire", "timestamp", "datetime",
      "date heure", "last movement", "date mouvement", "posting date", "horodatage", "date comptage"],
    time: ["heure", "time", "hour", "heure mouvement"],
    event: ["transaction", "movement type", "type mouvement", "type de mouvement", "operation", "event",
      "action", "evenement", "mouvement"],
    location: ["storage location", "sloc", "zone", "emplacement", "location", "magasin"],
    from: ["from", "origine", "source location", "from location", "provenance"],
    to: ["to", "vers", "destination", "to location", "dest"],
    equipment: ["equipment", "machine", "line", "ligne", "poste", "equipement", "resource", "ressource"],
    material: ["material", "article", "part number", "pn", "code article", "materiel"],
    step: ["step", "etape", "process step", "operation step"],
    user: ["user", "operateur", "operator", "utilisateur", "agent", "counted by", "compte par"],
    comment: ["commentaire", "comment", "comments", "remarks", "remarque", "remarques", "observation"],
    status: ["status", "statut"],
    order: ["order", "of", "ordre", "production order", "ordre de fabrication"],
  };
  const ROLE_FIELDS = {
    mes_inv: ["roll", "batch", "qty", "location", "material", "date", "status"],
    phys_inv: ["roll", "batch", "qty", "date", "location", "step", "material", "user", "comment"],
    mes_trace: ["date", "time", "roll", "batch", "event", "qty", "from", "to", "equipment", "material", "order", "user", "comment"],
    phys_trace: ["date", "time", "roll", "batch", "event", "qty", "from", "to", "equipment", "user", "comment"],
  };
  const REQUIRED = {
    mes_inv: ["roll", "batch", "qty"], phys_inv: ["roll", "qty"],
    mes_trace: ["date", "roll", "event"], phys_trace: ["date", "roll", "event"],
  };
  const ROLE_LABELS = {
    mes_inv: "Inventaire MES", phys_inv: "Inventaire physique",
    mes_trace: "Traçabilité MES", phys_trace: "Traçabilité physique",
  };
  const EVENT_KEYWORDS = [
    ["RETOUR", ["retour", "return", "reintegr"]],
    ["REBUT", ["rebut", "scrap", "dechet", "non conform", "waste"]],
    ["PRELEVEMENT", ["prelev", "echantillon", "sample", "cut", "coupe", "decoupe", "split", "splice"]],
    ["AJUSTEMENT", ["ajust", "adjust", "correction", "ecart inv"]],
    ["BLOCAGE", ["bloqu", "block", "hold", "quarant"]],
    ["CONSOMMATION", ["consom", "consum", "conso", "goods issue"]],
    ["PRODUCTION", ["production", "produc", "output", "goods receipt", "creat", "bobinage", "enroul"]],
    ["TRANSFERT", ["transf", "move", "deplac", "mise en stock", "stockage", "relocat"]],
  ];
  const EVENT_LABELS = {
    RETOUR: "retour en stock", REBUT: "rebut", PRELEVEMENT: "prélèvement/découpe",
    AJUSTEMENT: "ajustement", BLOCAGE: "blocage", CONSOMMATION: "consommation",
    PRODUCTION: "production", TRANSFERT: "transfert", AUTRE: "autre",
  };
  const CATEGORIES = [
    ["ONLY_MES", "Seulement MES"], ["ONLY_PHYS", "Seulement physique"], ["LEN", "Écart de longueur"],
    ["STEP", "Étape / article divergent"], ["BATCH_DIFF", "Batch divergent — à valider"],
    ["PROBABLE", "Batch manquant — à valider"], ["AMBIG", "Ambigu — plusieurs candidats"],
    ["DUP", "Doublon de comptage"], ["OK", "Conforme"],
  ];
  const CAT_LABEL = Object.fromEntries(CATEGORIES);
  const CAT_ORDER = Object.fromEntries(CATEGORIES.map((c, i) => [c[0], i]));
  const TO_VALIDATE = ["BATCH_DIFF", "PROBABLE", "AMBIG"];
  const ACTION_FAMILIES = [
    ["CONSO_NON_DECLAREE", "Déclarer dans MES les consommations constatées physiquement"],
    ["REBUT_NON_DECLARE", "Déclarer dans MES les rebuts constatés physiquement"],
    ["RETOUR_NON_DECLARE", "Déclarer dans MES les retours en stock"],
    ["SORTIE_MES_A_TORT", "Vérifier l'étiquette puis annuler les sorties MES contredites par le comptage"],
    ["PROD_NON_DECLAREE", "Déclarer dans MES les productions manquantes"],
    ["PRELEVEMENT_NON_DECLARE", "Ajuster les quantités MES (prélèvements/découpes non déclarés)"],
    ["ETAPE_NON_DECLAREE", "Déclarer dans MES les avancements d'étape"],
    ["EMPLACEMENT_MES", "Corriger les emplacements MES"],
    ["AJUSTEMENT_MES", "Vérifier les ajustements MES non constatés physiquement"],
    ["HORS_ZONE", "Vérifier les rouleaux transférés hors zone inventoriée"],
    ["STOCK_FANTOME", "Recompter puis sortir de stock MES si introuvable"],
    ["NON_COMPTE", "Recompter les rouleaux sans trace physique"],
    ["SAISIE_UNITE", "Corriger les métrages mal saisis"],
    ["ECART_INEXPLIQUE", "Re-mesurer les rouleaux (compteur machine vs saisie)"],
    ["BATCH_INCONNU_MES", "Relire le batch sur l'étiquette"],
    ["DOUBLON", "Supprimer les doublons de comptage"],
    ["BATCH_SAISIE", "Valider les correspondances à batch divergent"],
    ["BATCH_MANQUANT", "Valider les correspondances sans batch"],
    ["AMBIGU", "Trancher les rouleaux à plusieurs candidats MES"],
    ["CORRIGER_BATCH", "Corriger le batch dans le fichier source après validation"],
    ["INDETERMINE", "Analyser en réunion"],
  ];
  const FAMILY_LABEL = Object.fromEntries(ACTION_FAMILIES);
  const FAMILY_ORDER = Object.fromEntries(ACTION_FAMILIES.map((c, i) => [c[0], i]));
  const OWNER_ORDER = ["MES", "OPS", "CTRL"];
  const CODE_SHORT = {
    CONSO_NON_DECLAREE: "consommation non déclarée dans MES",
    REBUT_NON_DECLARE: "rebut non déclaré dans MES",
    RETOUR_NON_DECLARE: "retour en stock non déclaré dans MES",
    SORTIE_MES_A_TORT: "sortie MES contredite par le comptage",
    PROD_NON_DECLAREE: "production non déclarée dans MES",
    PRELEVEMENT_NON_DECLARE: "prélèvement/découpe non déclaré",
    ETAPE_NON_DECLAREE: "étape non déclarée dans MES",
    EMPLACEMENT_MES: "emplacement MES hors périmètre",
    AJUSTEMENT_MES: "ajustement MES non constaté",
    HORS_ZONE: "transfert hors zone inventoriée",
    STOCK_FANTOME: "stock fantôme MES probable",
    NON_COMPTE: "possiblement non compté",
    SAISIE_UNITE: "erreur de saisie/unité",
    ECART_INEXPLIQUE: "écart inexpliqué",
    BATCH_INCONNU_MES: "batch inconnu de MES (corps réutilisé)",
    DOUBLON: "doublon",
    BATCH_SAISIE: "batch mal saisi probable",
    BATCH_MANQUANT: "batch manquant, 1 candidat",
    AMBIGU: "plusieurs candidats MES",
    INDETERMINE: "indéterminé",
  };

  // ------------------------------------------------------------------ utilitaires
  function cmp(a, b) {
    for (let i = 0; i < a.length; i++) {
      const x = a[i], y = b[i];
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }
  const by = (keyFn) => (a, b) => cmp(keyFn(a), keyFn(b));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const num = (v, d) => (v === undefined || v === null ? d : v);

  function cellStr(v) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "True" : "False";
    if (typeof v === "number") {
      if (!isFinite(v)) return "";
      return String(v);
    }
    return String(v).trim();
  }
  function normText(v) {
    let s = cellStr(v).normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
    return s.replace(/[^a-z0-9]+/g, " ").trim();
  }
  const round1 = (x) => Math.floor(x * 10 + 0.5) / 10;
  function fmtNum(x) {
    if (x === null || x === undefined) return "—";
    let r = round1(x);
    const neg = r < 0;
    r = Math.abs(r);
    let ip = Math.floor(r);
    let dec = Math.floor((r - ip) * 10 + 0.5);
    if (dec === 10) { ip += 1; dec = 0; }
    let digits = String(ip);
    const groups = [];
    while (digits.length > 3) { groups.unshift(digits.slice(-3)); digits = digits.slice(0, -3); }
    groups.unshift(digits);
    const s = groups.join(" ") + (dec ? "," + dec : "");
    return neg && s !== "0" ? "-" + s : s;
  }
  function fmtSigned(x) {
    if (x === null || x === undefined) return "—";
    const s = fmtNum(x);
    return s.startsWith("-") || s === "0" ? s : "+" + s;
  }
  function sortedPrefixes(prefixes) {
    return [...(prefixes || [])].sort((a, b) => cmp([-a.length, a], [-b.length, b]));
  }
  function normRoll(v, prefixes) {
    let s = cellStr(v).toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (let p of sortedPrefixes(prefixes)) {
      p = p.toUpperCase();
      if (p && s.startsWith(p) && s.length > p.length) { s = s.slice(p.length); break; }
    }
    const s2 = s.replace(/^0+/, "");
    return s2 ? s2 : s;
  }
  function prettyRoll(raw, prefixes) {
    const s = cellStr(raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (let p of sortedPrefixes(prefixes)) {
      p = p.toUpperCase();
      if (p && s.startsWith(p) && /^\d+$/.test(s.slice(p.length))) return p + "-" + s.slice(p.length);
    }
    return s;
  }
  function normBatch(v) {
    let s = cellStr(v).toUpperCase();
    if (/^\d+\.0+$/.test(s)) s = s.split(".")[0];
    return s.replace(/[^A-Z0-9]/g, "");
  }
  function parseNum(v) {
    if (v === null || v === undefined || typeof v === "boolean") return null;
    if (typeof v === "number") return isNaN(v) ? null : v;
    let s = String(v).replace(/[\s  ]/g, "").replace(/,/g, ".");
    s = s.replace(/m$/i, "");
    return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
  }
  function excelSerialToIso(n) {
    const secs = Math.round(n * 86400);
    const d = new Date(Date.UTC(1899, 11, 30) + secs * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function parseDate(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v > 20000 && v < 80000 ? excelSerialToIso(v) : null;
    if (typeof v === "boolean") return null;
    const s = cellStr(v);
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
    if (m) return `${m[1]}-${m[2]}-${m[3]} ${pad(parseInt(m[4] || "0", 10))}:${m[5] || "00"}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2})[:h](\d{2}))?/);
    if (m) {
      const y = parseInt(m[3], 10) + (m[3].length === 2 ? 2000 : 0);
      return `${pad(y, 4)}-${pad(parseInt(m[2], 10))}-${pad(parseInt(m[1], 10))} ${pad(parseInt(m[4] || "0", 10))}:${m[5] || "00"}`;
    }
    return null;
  }
  function parseTime(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v >= 0 && v < 1 ? excelSerialToIso(v).slice(11) : null;
    if (typeof v === "boolean") return null;
    const m = cellStr(v).match(/(\d{1,2})[:h](\d{2})/);
    return m ? `${pad(parseInt(m[1], 10))}:${m[2]}` : null;
  }
  const datePart = (iso) => (iso ? iso.slice(0, 10) : null);
  function fmtDate(iso, withTime) {
    if (!iso) return "?";
    let s = `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
    const t = iso.slice(11, 16);
    if (withTime && t && t !== "00:00") s += " " + t;
    return s;
  }
  const isoToUtc = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const daysBetween = (a, b) => Math.round((isoToUtc(b) - isoToUtc(a)) / 86400000);
  function addDays(iso, n) {
    const d = new Date(isoToUtc(iso) + n * 86400000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  function eventType(raw) {
    const s = normText(raw);
    for (const [typ, kws] of EVENT_KEYWORDS) for (const kw of kws) if (s.includes(kw)) return typ;
    return "AUTRE";
  }
  function perimeterLookup(value, cfg) {
    const pm = {};
    for (const [k, v] of Object.entries(cfg.perimeter_map || {})) pm[normText(k)] = v;
    const r = pm[normText(value)];
    return r === undefined ? null : r;
  }
  const rollShape = (raw) => cellStr(raw).replace(/[0-9]/g, "9").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");

  // ------------------------------------------------------------------ colonnes
  function mapColumns(headerRow, role, overrides) {
    const fields = ROLE_FIELDS[role];
    const norms = (headerRow || []).map(normText);
    const mapping = {}, taken = new Set();
    for (const [f, h] of Object.entries(overrides || {})) {
      const hn = normText(h);
      for (let i = 0; i < norms.length; i++) {
        if (norms[i] === hn && !taken.has(i)) { mapping[f] = i; taken.add(i); break; }
      }
    }
    for (const f of fields) {
      if (f in mapping) continue;
      const syns = SYNONYMS[f];
      for (let i = 0; i < norms.length; i++) {
        if (!taken.has(i) && norms[i] && syns.includes(norms[i])) { mapping[f] = i; taken.add(i); break; }
      }
    }
    for (const f of fields) {
      if (f in mapping) continue;
      let found = null;
      for (const syn of SYNONYMS[f]) {
        if (syn.length < 3) continue;
        for (let i = 0; i < norms.length; i++) {
          if (!taken.has(i) && norms[i] && (" " + norms[i] + " ").includes(" " + syn + " ")) { found = i; break; }
        }
        if (found !== null) break;
      }
      if (found !== null) { mapping[f] = found; taken.add(found); }
    }
    return mapping;
  }
  function detectHeader(rows, role, overrides) {
    let best = [-1, 0, {}];
    for (let r = 0; r < Math.min(15, rows.length); r++) {
      const mp = mapColumns(rows[r], role, overrides);
      const score = Object.keys(mp).length + (REQUIRED[role].every((f) => f in mp) ? 100 : 0);
      if (score > best[0]) best = [score, r, mp];
    }
    return [best[1], best[2]];
  }

  // ------------------------------------------------------------------ chargement
  function loadTable(table, role, cfg) {
    const name = table.name, rows = table.rows;
    const overrides = (cfg.column_overrides || {})[name];
    const [hidx, mp] = detectHeader(rows, role, overrides);
    const header = rows.length ? rows[hidx] || [] : [];
    const missing = REQUIRED[role].filter((f) => !(f in mp));
    const prefixes = cfg.roll_prefixes || [];
    const defaults = (cfg.file_defaults || {})[name] || {};
    const recs = [];
    let skipped = 0;
    const g = (row, f) => { const i = mp[f]; return i !== undefined && i < row.length ? row[i] : null; };
    for (let ri = hidx + 1; ri < rows.length; ri++) {
      const row = rows[ri] || [];
      const rollRaw = g(row, "roll");
      if (cellStr(rollRaw) === "") { if (row.some((c) => cellStr(c))) skipped++; continue; }
      let d = parseDate(g(row, "date"));
      const t = parseTime(g(row, "time"));
      if (d && t) d = d.slice(0, 11) + t;
      const rec = {
        src: name, role, row: ri + 1,
        roll_raw: cellStr(rollRaw), roll: normRoll(rollRaw, prefixes),
        batch_raw: cellStr(g(row, "batch")), batch: normBatch(g(row, "batch")),
        qty: parseNum(g(row, "qty")), qty_raw: cellStr(g(row, "qty")),
        date: d,
        location: cellStr(g(row, "location")), material: cellStr(g(row, "material")), step: cellStr(g(row, "step")),
        event: cellStr(g(row, "event")), from: cellStr(g(row, "from")), to: cellStr(g(row, "to")),
        equipment: cellStr(g(row, "equipment")), user: cellStr(g(row, "user")), comment: cellStr(g(row, "comment")),
        order: cellStr(g(row, "order")),
      };
      rec.type = role === "mes_trace" || role === "phys_trace" ? eventType(rec.event) : null;
      if (role === "mes_inv" || role === "phys_inv") {
        let p = null;
        if (rec.step) p = perimeterLookup(rec.step, cfg) || rec.step;
        else if (rec.material) p = perimeterLookup(rec.material, cfg) || rec.material;
        rec.perimeter = p || defaults.perimeter || "Non défini";
      }
      recs.push(rec);
    }
    const mapping = {};
    for (const [f, i] of Object.entries(mp)) if (i < header.length) mapping[f] = cellStr(header[i]);
    const info = {
      name, role, header_row: hidx + 1, mapping, missing, records: recs.length, skipped,
      no_batch: recs.filter((r) => !r.batch).length,
      bad_qty: recs.filter((r) => r.qty === null && (role === "mes_inv" || role === "phys_inv")).length,
      roll_shapes: new Set(recs.map((r) => rollShape(r.roll_raw))).size,
      columns: header.map(cellStr), mapIdx: mp,
    };
    return [recs, info];
  }
  const ref = (rec) => `${rec.src}#L${rec.row}`;

  // ------------------------------------------------------------------ rapprochement
  const tolValue = (base, cfg) => Math.max(num(cfg.tolerance_abs_m, 2.0), (num(cfg.tolerance_pct, 0.0) / 100.0) * Math.abs(base || 0));
  const withinTol = (delta, base, cfg) => Math.abs(delta) <= tolValue(base, cfg) + 1e-9;
  function pairCategory(m, p, cfg) {
    if (m.perimeter !== p.perimeter && m.perimeter !== "Non défini" && p.perimeter !== "Non défini") return "STEP";
    if (m.qty === null || p.qty === null) return "LEN";
    return withinTol(p.qty - m.qty, m.qty, cfg) ? "OK" : "LEN";
  }
  const decisionKey = (p) => `${p.roll}|${p.batch}`;
  function resolveDecision(dec, candBatches) {
    if (dec === null || dec === undefined) return [null, null];
    const d = cellStr(dec).trim();
    const low = d.toLowerCase();
    if (low === "") return [null, null];
    if (["reject", "rejet", "rejeter", "non", "ko"].includes(low)) return ["reject", null];
    if (["accept", "accepter", "valider", "oui", "ok"].includes(low)) return candBatches.length === 1 ? ["accept", 0] : ["stale", null];
    if (low.startsWith("pick:")) {
      const t = low.split(":").slice(1).join(":");
      if (!/^[+-]?\d+$/.test(t.trim())) return ["stale", null];
      const k = parseInt(t, 10);
      return k >= 0 && k < candBatches.length ? ["accept", k] : ["stale", null];
    }
    const b = normBatch(low.startsWith("accept:") || low.startsWith("batch:") ? d.slice(d.indexOf(":") + 1) : d);
    const i = candBatches.indexOf(b);
    return i >= 0 ? ["accept", i] : ["stale", null];
  }
  function newEntry(cat, m, p, validated) {
    const base = p || m;
    return {
      uid: p ? ref(p) : ref(m), category: cat, mes: m, phys: p, validated: validated || null, was: null,
      roll: base.roll, roll_display: m ? m.roll_raw : p.roll_raw, batch: m ? m.batch : p.batch,
      perimeter: p ? p.perimeter : m.perimeter, candidates: [], dup_of: null,
      decision_key: null, decision: null, stale_decision: null,
      delta: m && p && m.qty !== null && p.qty !== null ? p.qty - m.qty : null,
    };
  }
  function reconcile(mes, phys, cfg, decisions) {
    decisions = decisions || {};
    const entries = [];
    const usedM = mes.map(() => false);
    const idx = new Map();
    const K = (r, b) => r + "\u0001" + b;
    mes.forEach((m, i) => { const k = K(m.roll, m.batch); if (!idx.has(k)) idx.set(k, []); idx.get(k).push(i); });
    const seen = new Map(), dupOf = new Map();
    phys.forEach((p, j) => {
      if (!p.batch) return;
      const k = K(p.roll, p.batch);
      if (seen.has(k)) dupOf.set(j, seen.get(k)); else seen.set(k, j);
    });
    const matchedP = phys.map(() => false);
    const pairs = [];
    phys.forEach((p, j) => {
      if (dupOf.has(j) || !p.batch) return;
      for (const i of idx.get(K(p.roll, p.batch)) || []) {
        if (!usedM[i]) { usedM[i] = true; matchedP[j] = true; pairs.push([i, j]); break; }
      }
    });
    const uncertain = [];
    phys.forEach((p, j) => {
      if (matchedP[j] || dupOf.has(j)) return;
      const cands = [];
      mes.forEach((m, i) => { if (!usedM[i] && m.roll === p.roll) cands.push(i); });
      cands.forEach((i) => (usedM[i] = true));
      matchedP[j] = true;
      if (!cands.length) entries.push(newEntry("ONLY_PHYS", null, p));
      else if (cands.length === 1) uncertain.push([!p.batch ? "PROBABLE" : "BATCH_DIFF", cands, j]);
      else uncertain.push(["AMBIG", cands, j]);
    });
    for (const [i, j] of pairs) entries.push(newEntry(pairCategory(mes[i], phys[j], cfg), mes[i], phys[j]));
    for (const [cat, cands, j] of uncertain) {
      const p = phys[j];
      const key = decisionKey(p);
      const dec = Object.prototype.hasOwnProperty.call(decisions, key) ? decisions[key] : decisions[ref(p)];
      const [action, k] = resolveDecision(dec, cands.map((c) => mes[c].batch));
      if (action === "accept") {
        const m = mes[cands[k]];
        const e = newEntry(pairCategory(m, p, cfg), m, p, "accept");
        e.was = cat; e.decision_key = key; e.decision = dec;
        entries.push(e);
        for (const c of cands) if (c !== cands[k]) entries.push(newEntry("ONLY_MES", mes[c], null));
        continue;
      }
      if (action === "reject") {
        const e = newEntry("ONLY_PHYS", null, p, "reject");
        e.decision_key = key; e.decision = dec;
        entries.push(e);
        for (const c of cands) {
          const x = newEntry("ONLY_MES", mes[c], null, "reject");
          x.decision_key = key; x.decision = dec;
          entries.push(x);
        }
        continue;
      }
      let e;
      if (cat === "AMBIG") { e = newEntry("AMBIG", null, p); e.candidates = cands.map((c) => mes[c]); }
      else e = newEntry(cat, mes[cands[0]], p);
      e.decision_key = key;
      if (action === "stale") e.stale_decision = dec;
      entries.push(e);
    }
    for (const [j, k] of dupOf) {
      const e = newEntry("DUP", null, phys[j]);
      e.dup_of = phys[k];
      entries.push(e);
    }
    mes.forEach((m, i) => { if (!usedM[i]) entries.push(newEntry("ONLY_MES", m, null)); });
    return entries;
  }
  const entrySortKey = (e) => [CAT_ORDER[e.category], e.perimeter, e.roll, e.batch, e.uid];

  // ------------------------------------------------------------------ traçabilité
  function traceEvents(recs, sourceLabel) {
    return recs.map((r) => ({
      source: sourceLabel, src: r.src, row: r.row, ref: ref(r), date: r.date, roll: r.roll, batch: r.batch,
      event: r.event, type: r.type, qty: r.qty, from: r.from, to: r.to, equipment: r.equipment,
      user: r.user, comment: r.comment, order: r.order,
    }));
  }
  function entryBatches(e) {
    const bs = [];
    for (const r of [e.mes, e.phys, ...(e.candidates || [])]) if (r && r.batch && !bs.includes(r.batch)) bs.push(r.batch);
    return bs;
  }
  function collectTrace(e, traceByRoll, invDate, cfg) {
    const batches = entryBatches(e);
    const lo = addDays(invDate, -parseInt(num(cfg.window_days, 45), 10));
    const hi = addDays(invDate, 7);
    const cutoff = invDate + " 23:59";
    const kept = [], excludedBatches = [];
    let excluded = 0;
    for (const ev of traceByRoll.get(e.roll) || []) {
      let partial = false;
      if (batches.length && batches.includes(ev.batch)) { /* clé complète */ }
      else if (!ev.batch || !batches.length) {
        const d = datePart(ev.date);
        if (!d || d < lo || d > hi) continue;
        partial = true;
      } else {
        excluded++;
        if (!excludedBatches.includes(ev.batch)) excludedBatches.push(ev.batch);
        continue;
      }
      kept.push(Object.assign({}, ev, { partial, post: !!(ev.date && ev.date > cutoff) }));
    }
    kept.sort(by((x) => [x.date || "", x.row]));
    return [kept, excluded, excludedBatches];
  }

  // ------------------------------------------------------------------ diagnostic
  const evd = (ev) => fmtDate(ev.date, true);
  const where = (ev) => ev.equipment || ev.to || ev.event;
  function levenshtein(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
      prev = cur;
    }
    return prev[prev.length - 1];
  }
  function diagnose(e, M, P, invDate, knownLocs, cfg) {
    const m = e.mes, p = e.phys, R = e.roll_display, B = e.batch || "?", cat = e.category;
    const D = (code, hypothesis, confidence, action, owner, evs) => ({
      code, hypothesis, confidence, action, owner,
      evidence: [...(evs || []).filter(Boolean).map((x) => x.ref), ...[m, p].filter(Boolean).map(ref)],
    });
    const last = (evs, types, pred) => { let o = null; for (const x of evs) if ((!types || types.includes(x.type)) && (!pred || pred(x))) o = x; return o; };
    const first = (evs, types, pred) => { for (const x of evs) if ((!types || types.includes(x.type)) && (!pred || pred(x))) return x; return null; };
    const outOfScope = (loc) => !!loc && !knownLocs.has(normText(loc));
    const staleN = parseInt(num(cfg.stale_days, 21), 10);

    if (cat === "DUP") {
      const d = e.dup_of;
      return D("DOUBLON", `Rouleau compté 2 fois dans ${p.src} (lignes ${d.row} et ${p.row}).`,
        "Élevée", `Supprimer la ligne ${p.row} de ${p.src}`, "OPS", []);
    }
    if (cat === "ONLY_MES") {
      const pc = last(P, ["CONSOMMATION", "REBUT"]);
      if (pc && !M.some((x) => x.type === pc.type)) {
        if (pc.type === "CONSOMMATION")
          return D("CONSO_NON_DECLAREE",
            `Consommation constatée physiquement le ${evd(pc)} (${where(pc)}) mais non déclarée dans MES : le rouleau est resté en stock MES.`,
            "Élevée", `Déclarer la consommation de ${R} / ${B} dans MES (${fmtNum(m.qty)} m)`, "MES", [pc]);
        return D("REBUT_NON_DECLARE",
          `Rebut constaté physiquement le ${evd(pc)} (${pc.event}) mais non déclaré dans MES.`,
          "Élevée", `Déclarer le rebut de ${R} / ${B} dans MES (${fmtNum(m.qty)} m)`, "MES", [pc]);
      }
      const pd = last(P, null, (x) => !!x.to);
      if (pd && outOfScope(pd.to))
        return D("HORS_ZONE",
          `Transféré physiquement vers ${pd.to} le ${evd(pd)} (${pd.event}) : hors des zones inventoriées.`,
          "Moyenne", `Vérifier la présence de ${R} en ${pd.to} ; mettre à jour l'emplacement MES ou intégrer la zone au comptage`, "OPS", [pd]);
      if (!P.length) {
        if (m.date && daysBetween(m.date, invDate) >= staleN) {
          const n = daysBetween(m.date, invDate);
          return D("STOCK_FANTOME",
            `Aucune trace physique et aucun mouvement MES depuis ${n} jours (${fmtDate(m.date)}) : stock fantôme probable.`,
            "Moyenne", `Recomptage ciblé de ${R}, puis sortie de stock MES s'il reste introuvable`, "CTRL", []);
        }
        return D("NON_COMPTE", "Aucune trace physique récente : rouleau possiblement oublié au comptage.",
          "Faible", `Recomptage ciblé de ${R}`, "OPS", []);
      }
      const lp = P[P.length - 1];
      return D("INDETERMINE",
        `Traces physiques présentes (dernier événement : ${lp.event} le ${evd(lp)}) mais sans sortie constatée.`,
        "Faible", "Analyser en réunion : vérifier l'étiquette et l'emplacement réel", "CTRL", [lp]);
    }
    if (cat === "ONLY_PHYS") {
      const mc = last(M, ["CONSOMMATION", "REBUT"]);
      if (mc) {
        const lab = EVENT_LABELS[mc.type];
        const pr = first(P, ["RETOUR"], (x) => (x.date || "") >= (mc.date || ""));
        if (pr)
          return D("RETOUR_NON_DECLARE",
            `MES a enregistré « ${mc.event} » (${lab}) le ${evd(mc)} (${where(mc)}), mais le rouleau est revenu en stock physiquement le ${evd(pr)} (${pr.event}) : retour non déclaré dans MES.`,
            "Élevée", `Déclarer le retour en stock de ${R} / ${B} dans MES (annuler « ${mc.event} »)`, "MES", [mc, pr]);
        const who = mc.user ? `, saisie ${mc.user}` : "";
        return D("SORTIE_MES_A_TORT",
          `MES a enregistré « ${mc.event} » (${lab}) le ${evd(mc)} (${where(mc)}${who}) alors que le rouleau a été compté physiquement.`,
          "Moyenne", `Vérifier l'étiquette de ${R} ; si confirmé, annuler « ${mc.event} » dans MES`, "MES", [mc]);
      }
      if (!M.length) {
        if ((e.excluded_mes || 0) > 0 && e.batch) {
          const ob = e.excluded_batches || [];
          const lst = ob.slice(0, 3).join(", ") + (ob.length > 3 ? "…" : "");
          return D("BATCH_INCONNU_MES",
            `Aucun mouvement MES pour le batch ${B} ; le corps ${R} apparaît dans MES sous ${ob.length} autre(s) batch (${lst}) : production non déclarée ou batch mal relevé.`,
            "Moyenne", `Relire le batch sur l'étiquette de ${R} ; si correct, déclarer la production dans MES`, "OPS", []);
        }
        const pp = first(P, ["PRODUCTION"]);
        if (pp)
          return D("PROD_NON_DECLAREE",
            `Aucun mouvement MES pour ce rouleau, alors que sa production est tracée physiquement le ${evd(pp)} (${where(pp)}) : production non déclarée dans MES.`,
            "Élevée", `Déclarer la production de ${R} / ${B} dans MES (${fmtNum(p.qty)} m)`, "MES", [pp]);
        return D("PROD_NON_DECLAREE", "Aucun mouvement MES ni trace physique de production pour ce rouleau.",
          "Moyenne", `Déclarer la production de ${R} / ${B} dans MES après vérification de l'étiquette`, "MES", []);
      }
      const md = last(M, null, (x) => !!x.to);
      if (md && outOfScope(md.to))
        return D("EMPLACEMENT_MES",
          `MES situe le rouleau en ${md.to} depuis le ${evd(md)} (${md.event}) : hors du périmètre de l'extraction MES.`,
          "Moyenne", `Corriger l'emplacement de ${R} dans MES`, "MES", [md]);
      const lm = M[M.length - 1];
      return D("INDETERMINE",
        `Présent dans la trace MES (dernier événement : ${lm.event} le ${evd(lm)}) mais absent de l'extraction d'inventaire MES.`,
        "Faible", "Analyser en réunion : vérifier le périmètre de l'extraction MES", "CTRL", [lm]);
    }
    if (cat === "AMBIG") {
      const cands = e.candidates;
      const stale = cands.filter((c) => c.date && daysBetween(c.date, invDate) >= staleN);
      const fresh = cands.filter((c) => !stale.includes(c));
      const lst = cands.map((c) => c.batch).join(", ");
      const head = p.batch ? `Batch relevé ${p.batch} inconnu de MES et` : "Batch non renseigné et";
      let hyp = `${head} ${cands.length} batches MES en stock sur le corps ${R} (${lst}).`;
      if (stale.length && fresh.length === 1) {
        const f0 = fresh[0];
        const same = p.qty !== null && f0.qty !== null && withinTol(p.qty - f0.qty, f0.qty, cfg);
        const olds = stale.map((s) => s.batch).join(", ");
        hyp += ` Le(s) batch(es) ${olds} n'ont plus bougé depuis plus de ${staleN} jours : reliquat MES probable d'un cycle précédent (corps réutilisé).` +
          ` Candidat le plus probable : ${f0.batch}` + (same ? " (métrage identique)." : ".");
        return D("AMBIGU", hyp, "Moyenne",
          `Relever le batch sur l'étiquette de ${R} ; si ${f0.batch}, valider et sortir ${olds} du stock MES`, "CTRL", []);
      }
      return D("AMBIGU", hyp, "Faible", `Relever le batch sur l'étiquette de ${R} et choisir le bon candidat`, "OPS", []);
    }
    const delta = e.delta;
    let lenNote = "";
    if (delta !== null) lenNote = withinTol(delta, m.qty, cfg) ? " Métrage cohérent." : ` Écart de métrage : ${fmtSigned(delta)} m.`;
    if (cat === "BATCH_DIFF") {
      const pb = p.batch, mb = m.batch;
      const dist = levenshtein(pb, mb);
      const detail = pb.split("").sort().join("") === mb.split("").sort().join("") && pb.length === mb.length
        ? "inversion de chiffres" : `${dist} caractère(s) de différence`;
      const conf = dist <= 2 && delta !== null && withinTol(delta, m.qty, cfg) ? "Élevée" : "Moyenne";
      return D("BATCH_SAISIE",
        `Batch relevé ${pb} vs MES ${mb} (${detail}) sur le même corps ${R} : erreur de saisie probable.${lenNote}`,
        conf, `Valider la correspondance puis corriger le batch dans ${p.src} (ligne ${p.row})`, "CTRL", []);
    }
    if (cat === "PROBABLE") {
      const ok = delta !== null && withinTol(delta, m.qty, cfg);
      return D("BATCH_MANQUANT",
        `Batch non renseigné dans l'inventaire physique ; un seul candidat MES sur le corps ${R} : batch ${m.batch}.${lenNote}`,
        ok ? "Moyenne" : "Faible",
        `Valider la correspondance ; faire compléter le batch dans ${p.src} (ligne ${p.row})`, "CTRL", []);
    }
    if (cat === "STEP") {
      const prM = last(M, ["PRODUCTION"]), prP = last(P, ["PRODUCTION"]);
      const later = !!prP && (!prM || (prP.date || "") > (prM.date || ""));
      const extra = later ? ` Dernière opération physique : ${prP.event} le ${evd(prP)} (${where(prP)}), absente de MES.` : "";
      const dn = delta !== null && !withinTol(delta, m.qty, cfg) ? ` Écart de métrage associé : ${fmtSigned(delta)} m.` : "";
      return D("ETAPE_NON_DECLAREE",
        `MES : ${m.perimeter} / physique : ${p.perimeter}.${extra} Avancement d'étape non déclaré dans MES.${dn}`,
        later ? "Élevée" : "Moyenne",
        `Déclarer dans MES l'opération manquante pour ${R} / ${B} (${m.perimeter} → ${p.perimeter})`, "MES",
        later ? [prP] : []);
    }
    if (cat === "LEN") {
      const qm = m.qty, qp = p.qty;
      if (qm === null || qp === null)
        return D("SAISIE_UNITE", `Métrage illisible (MES : ${m.qty_raw || "vide"} / physique : ${p.qty_raw || "vide"}).`,
          "Élevée", `Corriger le métrage dans ${p.src} (ligne ${p.row})`, "OPS", []);
      if (qm > 0 && qp > 0) {
        const r = Math.max(qm, qp) / Math.min(qm, qp);
        for (const k of [10, 100, 1000])
          if (Math.abs(r / k - 1) <= 0.03)
            return D("SAISIE_UNITE",
              `Métrage physique ${fmtNum(qp)} m vs MES ${fmtNum(qm)} m (facteur ${k}) : erreur de saisie ou d'unité probable.`,
              "Élevée", `Corriger le métrage dans ${p.src} (ligne ${p.row})`, "OPS", []);
      }
      const mtypes = new Set(M.map((x) => x.type));
      const ps = P.filter((x) => ["PRELEVEMENT", "CONSOMMATION", "REBUT"].includes(x.type) && !mtypes.has(x.type) && x.qty !== null);
      let s = 0; for (const x of ps) s += x.qty;
      const tol = tolValue(qm, cfg);
      if (delta < 0 && ps.length && Math.abs(s - Math.abs(delta)) <= tol + 1e-9) {
        const x0 = ps[ps.length - 1];
        const lab = EVENT_LABELS[x0.type];
        return D("PRELEVEMENT_NON_DECLARE",
          `${lab[0].toUpperCase() + lab.slice(1)} de ${fmtNum(s)} m constaté(e) physiquement le ${evd(x0)} (${x0.event}) mais non déclaré(e) dans MES.`,
          "Élevée", `Ajuster la quantité MES de ${R} / ${B} : ${fmtSigned(delta)} m`, "MES", ps);
      }
      const ptypes = new Set(P.map((x) => x.type));
      const ms = M.filter((x) => ["AJUSTEMENT", "PRELEVEMENT"].includes(x.type) && !ptypes.has(x.type) && x.qty !== null);
      let s2 = 0; for (const x of ms) s2 += x.qty;
      if (delta > 0 && ms.length && Math.abs(s2 - delta) <= tol + 1e-9) {
        const x0 = ms[ms.length - 1];
        return D("AJUSTEMENT_MES",
          `MES a enregistré « ${x0.event} » de ${fmtNum(s2)} m le ${evd(x0)}, non constaté physiquement.`,
          "Moyenne", `Vérifier le mouvement MES et le métrage réel de ${R}`, "MES", ms);
      }
      const pct = qm ? (Math.abs(delta) / qm) * 100 : 0;
      return D("ECART_INEXPLIQUE",
        `Écart de ${fmtSigned(delta)} m (${fmtNum(pct)} %) non expliqué par les traces MES et physique.`,
        "Faible", `Re-mesurer ${R} (compteur machine vs saisie) avant toute correction`, "OPS", []);
    }
    return null;
  }

  // ------------------------------------------------------------------ orchestration
  function run(tables, cfg, decisions, baseline) {
    cfg = cfg || {};
    const data = {}, infos = [];
    for (const role of ["mes_inv", "phys_inv", "mes_trace", "phys_trace"]) {
      data[role] = [];
      for (const t of tables[role] || []) {
        const [recs, info] = loadTable(t, role, cfg);
        data[role].push(...recs);
        infos.push(info);
      }
    }
    let invDate = cfg.inventory_date || "";
    if (!invDate) {
      const ds = data.phys_inv.filter((r) => r.date).map((r) => r.date);
      if (ds.length) invDate = ds.reduce((a, b) => (b > a ? b : a)).slice(0, 10);
      else { const n = new Date(); invDate = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`; }
    }
    invDate = invDate.slice(0, 10);

    const entries = reconcile(data.mes_inv, data.phys_inv, cfg, decisions);
    entries.sort(by(entrySortKey));

    const known = new Set((cfg.in_scope_locations || []).map(normText));
    for (const r of [...data.mes_inv, ...data.phys_inv]) if (r.location) known.add(normText(r.location));

    const mesByRoll = new Map(), physByRoll = new Map();
    for (const ev of traceEvents(data.mes_trace, "MES")) { if (!mesByRoll.has(ev.roll)) mesByRoll.set(ev.roll, []); mesByRoll.get(ev.roll).push(ev); }
    for (const ev of traceEvents(data.phys_trace, "Physique")) { if (!physByRoll.has(ev.roll)) physByRoll.set(ev.roll, []); physByRoll.get(ev.roll).push(ev); }

    const prefixes = cfg.roll_prefixes || [];
    const disp = new Map();
    for (const r of [...data.mes_inv, ...data.mes_trace]) if (!disp.has(r.roll)) disp.set(r.roll, r.roll_raw);
    for (const e of entries) e.roll_display = disp.get(e.roll) || prettyRoll(e.roll_display, prefixes);

    let n = 0;
    for (const e of entries) {
      if (e.category === "OK") e.ref_id = null;
      else { n++; e.ref_id = "E" + pad(n); }
      const eInv = e.phys && e.phys.date ? datePart(e.phys.date) : invDate;
      e.inv_date = eInv;
      const [tm, exm, exb] = collectTrace(e, mesByRoll, eInv, cfg);
      const [tp] = collectTrace(e, physByRoll, eInv, cfg);
      e.trace_mes = tm; e.trace_phys = tp; e.excluded_mes = exm; e.excluded_batches = exb;
      if (e.category === "OK" && !e.validated) { e.diag = null; continue; }
      const M = tm.filter((x) => !x.post), P = tp.filter((x) => !x.post);
      e.diag = diagnose(e, M, P, eInv, known, cfg);
      if (e.validated === "accept" && ["BATCH_DIFF", "PROBABLE", "AMBIG"].includes(e.was)) {
        (e.extra_actions = e.extra_actions || []).push({
          code: "CORRIGER_BATCH", owner: "OPS",
          action: `Corriger/compléter le batch de ${e.roll_display} dans ${e.phys.src} (ligne ${e.phys.row}) : ${e.mes.batch}`,
        });
      }
    }
    const result = {
      version: VERSION, inventory_date: invDate, sources: infos,
      counts: { mes_inv: data.mes_inv.length, phys_inv: data.phys_inv.length, mes_trace: data.mes_trace.length, phys_trace: data.phys_trace.length },
      entries,
    };
    result.summary = summarize(result, cfg);
    result.evolution = baseline && baseline.snapshot ? compare(baseline, result) : null;
    result.snapshot = makeSnapshot(result);
    return result;
  }

  // ------------------------------------------------------------------ synthèse
  function meters(e) {
    if (e.delta !== null && e.category !== "OK") return Math.abs(e.delta);
    if (e.category === "ONLY_MES" && e.mes && e.mes.qty !== null) return e.mes.qty;
    if (e.category === "ONLY_PHYS" && e.phys && e.phys.qty !== null) return e.phys.qty;
    return 0.0;
  }
  const pl = (n, s, p) => (n > 1 ? p : s);
  const pctOf = (a, b) => (b ? Math.floor((a * 100) / b + 0.5) : 0);
  function listRolls(es, n = 4) {
    const items = es.map((e) => `${e.roll_display} [${e.ref_id}]`);
    return items.slice(0, n).join(", ") + (items.length > n ? ` +${items.length - n}` : "");
  }
  const lcFirst = (s) => s[0].toLowerCase() + s.slice(1);
  function summarize(result, cfg) {
    const entries = result.entries, owners = cfg.owners || {};
    const ow = (k) => (owners[k] !== undefined ? owners[k] : k);
    const ok = entries.filter((e) => e.category === "OK");
    const gaps = entries.filter((e) => e.category !== "OK");
    const toVal = gaps.filter((e) => TO_VALIDATE.includes(e.category));
    let totalM = 0; for (const e of gaps) totalM += meters(e);
    const nPairs = entries.length;
    const physFiles = result.sources.filter((s) => s.role === "phys_inv").map((s) => s.name);
    const kpis = {
      compared: nPairs, ok: ok.length, gaps: gaps.length, to_validate: toVal.length,
      gap_meters: round1(totalM), ok_pct: pctOf(ok.length, nPairs),
      high_conf: gaps.filter((e) => e.diag && e.diag.confidence === "Élevée").length,
    };
    const diffs = [];
    diffs.push(
      `${result.counts.phys_inv} lignes d'inventaire physique (${physFiles.length} fichier${physFiles.length > 1 ? "s" : ""}) rapprochées de ` +
      `${result.counts.mes_inv} lignes MES au ${fmtDate(result.inventory_date)} : ${ok.length} rouleaux conformes ` +
      `(${kpis.ok_pct} %), ${gaps.length} écarts portant sur ${fmtNum(totalM)} m` +
      (toVal.length ? `, dont ${toVal.length} correspondances à valider.` : "."));
    const codesBreakdown = (es) => {
      const cnt = new Map();
      for (const e of es) if (e.diag) cnt.set(e.diag.code, (cnt.get(e.diag.code) || 0) + 1);
      const parts = [...cnt.entries()].sort(by((kv) => [-kv[1], num(FAMILY_ORDER[kv[0]], 99)]));
      return parts.map(([k, v]) => `${v} × ${CODE_SHORT[k] || k}`).join("; ");
    };
    const groups = [
      ["ONLY_MES", ["rouleau présent dans MES mais absent du comptage physique", "rouleaux présents dans MES mais absents du comptage physique"]],
      ["ONLY_PHYS", ["rouleau compté physiquement mais absent de l'inventaire MES", "rouleaux comptés physiquement mais absents de l'inventaire MES"]],
      ["LEN", ["écart de métrage au-delà de la tolérance", "écarts de métrage au-delà de la tolérance"]],
      ["STEP", ["rouleau à une étape différente entre MES et physique", "rouleaux à une étape différente entre MES et physique"]],
    ];
    for (const [cat, label] of groups) {
      const es = gaps.filter((e) => e.category === cat);
      if (!es.length) continue;
      let mm = 0; for (const e of es) mm += meters(e);
      diffs.push(`${es.length} ${label[es.length > 1 ? 1 : 0]} (${fmtNum(mm)} m) — ${codesBreakdown(es)} : ${listRolls(es)}.`);
    }
    const unc = gaps.filter((e) => TO_VALIDATE.includes(e.category));
    if (unc.length) diffs.push(`${unc.length} ${pl(unc.length, "correspondance incertaine", "correspondances incertaines")} faute de batch fiable — ${codesBreakdown(unc)} : ${listRolls(unc)}.`);
    const dups = gaps.filter((e) => e.category === "DUP");
    if (dups.length) diffs.push(`${dups.length} ${pl(dups.length, "doublon", "doublons")} de comptage dans l'inventaire physique : ${listRolls(dups)}.`);
    const top = gaps.filter((e) => meters(e) > 0).sort(by((e) => [-meters(e), e.ref_id])).slice(0, 3);
    if (top.length) diffs.push("Plus gros écarts : " + top.map((e) => `${e.roll_display} (${fmtNum(meters(e))} m, ${lcFirst(CAT_LABEL[e.category])})`).join(", ") + ".");
    const per = new Map();
    for (const e of entries) {
      if (!per.has(e.perimeter)) per.set(e.perimeter, [0, 0]);
      const s = per.get(e.perimeter);
      s[0]++; if (e.category !== "OK") s[1]++;
    }
    if (per.size && gaps.length) {
      const worst = [...per.entries()].sort(by((kv) => [-(kv[1][1] / kv[1][0]), -kv[1][1], kv[0]]))[0];
      diffs.push(`Périmètre le plus touché : ${worst[0]} (${worst[1][1]} ${pl(worst[1][1], "écart", "écarts")} sur ${worst[1][0]} rouleaux, ${pctOf(worst[1][1], worst[1][0])} %).`);
    }
    const q = [];
    for (const s of result.sources) {
      if (s.role !== "phys_inv") continue;
      const bits = [];
      if (s.no_batch) bits.push(`batch vide sur ${s.no_batch}/${s.records} lignes`);
      if (s.roll_shapes > 1) bits.push(`n° de rouleau saisis sous ${s.roll_shapes} formats différents`);
      if (s.bad_qty) bits.push(`${s.bad_qty} métrage(s) illisible(s)`);
      if (bits.length) q.push(`${s.name} : ` + bits.join(", "));
    }
    if (q.length) diffs.push("Qualité des sources physiques — " + q.join(" ; ") + " (formats normalisés automatiquement).");
    let excl = 0, reused = 0;
    for (const e of gaps) { excl += e.excluded_mes || 0; if ((e.excluded_mes || 0) > 0) reused++; }
    if (excl) diffs.push(`Corps réutilisés : ${excl} mouvements MES écartés sur ${reused} ${pl(reused, "écart", "écarts")} car ils portent sur d'autres batches ` +
      `du même corps — la double clé rouleau + batch est indispensable.`);

    const fam = new Map();
    const push = (owner, code, e, action) => {
      const k = owner + "|" + code;
      if (!fam.has(k)) fam.set(k, { owner, code, items: [] });
      fam.get(k).items.push([e, action]);
    };
    for (const e of gaps) if (e.diag) push(e.diag.owner, e.diag.code, e, e.diag.action);
    for (const e of entries) for (const xa of e.extra_actions || []) push(xa.owner, xa.code, e, xa.action);
    const actions = [];
    const keys = [...fam.values()].sort(by((f) => [OWNER_ORDER.includes(f.owner) ? OWNER_ORDER.indexOf(f.owner) : 9, -f.items.length, num(FAMILY_ORDER[f.code], 99)]));
    for (const f of keys) {
      const lst = f.items.map(([e]) => `${e.roll_display}/${e.batch || "?"}` + (e.ref_id ? ` [${e.ref_id}]` : "")).join(", ");
      actions.push({
        owner: ow(f.owner), owner_key: f.owner, code: f.code, label: FAMILY_LABEL[f.code] || f.code, count: f.items.length,
        text: `${ow(f.owner)} — ${FAMILY_LABEL[f.code] || f.code} (${f.items.length}) : ${lst}.`,
        refs: f.items.map(([e]) => e.ref_id || null),
      });
    }
    let nb = 0; for (const s of result.sources) if (s.role === "phys_inv") nb += s.no_batch;
    if (nb) {
      const o = owners.OPS !== undefined ? owners.OPS : "OPS";
      actions.push({
        owner: o, owner_key: "OPS", code: "STRUCTUREL", label: "Fiabiliser la saisie du batch", count: nb, refs: [],
        text: `${o} — Rendre le n° de batch obligatoire dans les fichiers d'inventaire physique (${nb} ${pl(nb, "ligne", "lignes")} sans batch) : sans double clé, le rapprochement reste manuel.`,
      });
    }
    return { kpis, differences: diffs, actions };
  }

  // ------------------------------------------------------------------ historique / comparaison
  function gapKeys(entries) {
    const out = [], seen = new Map();
    for (const e of entries) {
      const k = `${e.roll}|${e.batch || ""}` + (e.category === "DUP" ? "#DUP" : "");
      const n = (seen.get(k) || 0) + 1;
      seen.set(k, n);
      out.push(n === 1 ? k : `${k}#${n}`);
    }
    return out;
  }
  function makeSnapshot(result) {
    const keys = gapKeys(result.entries);
    const gaps = [], ok = [];
    result.entries.forEach((e, i) => {
      const k = keys[i];
      if (e.category === "OK") { ok.push(k); return; }
      const d = e.diag || {}, h = e.history || {};
      gaps.push({
        key: k, ref_id: e.ref_id || null, category: e.category, code: d.code || null, owner: d.owner || null,
        roll: e.roll, roll_display: e.roll_display, batch: e.batch, perimeter: e.perimeter, delta: e.delta,
        meters: round1(meters(e)), first_seen: h.first_seen || result.inventory_date, occurrences: h.occurrences || 1,
      });
    });
    return { inventory_date: result.inventory_date, kpis: result.summary.kpis, gaps, ok_keys: ok };
  }
  function compare(baseline, result) {
    const snap = baseline.snapshot;
    const prev = new Map(snap.gaps.map((g) => [g.key, g]));
    const prevOk = new Set(snap.ok_keys || []);
    const keys = gapKeys(result.entries);
    const curGap = new Set(), curOk = new Set(), nw = [], persistent = [];
    result.entries.forEach((e, i) => {
      const k = keys[i];
      if (e.category === "OK") { curOk.add(k); e.history = { status: "ok", was_gap: prev.has(k) }; return; }
      curGap.add(k);
      const g = prev.get(k);
      if (g) {
        const changes = [];
        if (g.category !== e.category) changes.push(`${CAT_LABEL[g.category]} → ${CAT_LABEL[e.category]}`);
        if (g.delta !== null && g.delta !== undefined && e.delta !== null && Math.abs(g.delta - e.delta) > 0.05)
          changes.push(`Δ ${fmtSigned(g.delta)} → ${fmtSigned(e.delta)} m`);
        e.history = { status: "persistent", first_seen: g.first_seen || snap.inventory_date, occurrences: (g.occurrences || 1) + (result.inventory_date !== snap.inventory_date ? 1 : 0), prev_ref: g.ref_id || null, changes };
        persistent.push(e);
      } else {
        e.history = { status: "new", first_seen: result.inventory_date, occurrences: 1, was_ok: prevOk.has(k), changes: [] };
        nw.push(e);
      }
    });
    const resolved = [];
    for (const g of snap.gaps) if (!curGap.has(g.key)) resolved.push(Object.assign({}, g, { outcome: curOk.has(g.key) ? "now_ok" : "absent" }));
    const prevM = snap.kpis.gap_meters || 0, curM = result.summary.kpis.gap_meters;
    const ev = {
      baseline: { id: baseline.id || null, name: baseline.name || "analyse précédente", inventory_date: snap.inventory_date },
      counts: { new: nw.length, persistent: persistent.length, resolved: resolved.length,
        resolved_ok: resolved.filter((r) => r.outcome === "now_ok").length, regressions: nw.filter((e) => e.history.was_ok).length },
      meters: { before: prevM, after: curM }, resolved,
      new_refs: nw.map((e) => e.ref_id), persistent_refs: persistent.map((e) => e.ref_id),
    };
    ev.bullets = evolutionBullets(ev, nw, persistent, resolved);
    return ev;
  }
  function evolutionBullets(ev, nw, persistent, resolved) {
    const c = ev.counts, b = ev.baseline;
    const out = [`Par rapport à « ${b.name} » (inventaire du ${fmtDate(b.inventory_date)}) : ` +
      `${c.new} ${pl(c.new, "nouvel écart", "nouveaux écarts")}, ${c.resolved} ${pl(c.resolved, "résolu", "résolus")}, ` +
      `${c.persistent} ${pl(c.persistent, "persistant", "persistants")} ; métrage en écart ` +
      `${fmtNum(ev.meters.before)} → ${fmtNum(ev.meters.after)} m (${fmtSigned(ev.meters.after - ev.meters.before)} m).`];
    if (resolved.length) {
      const nOk = c.resolved_ok, nAbs = resolved.length - nOk, parts = [];
      if (nOk) parts.push(`${nOk} ${pl(nOk, "désormais conforme", "désormais conformes")}`);
      if (nAbs) parts.push(`${nAbs} ${pl(nAbs, "qui n’apparaît plus", "qui n’apparaissent plus")} (consommé, doublon supprimé…)`);
      const lst = resolved.slice(0, 5).map((r) => r.roll_display).join(", ") + (resolved.length > 5 ? ` +${resolved.length - 5}` : "");
      out.push(`Résolus : ${parts.join(" et ")} — ${lst}.`);
    }
    if (persistent.length) {
      const groups = new Map();
      for (const e of [...persistent].sort(by((e) => [-e.history.occurrences, e.history.first_seen, e.ref_id]))) {
        const k = e.history.occurrences + "|" + e.history.first_seen;
        if (!groups.has(k)) groups.set(k, { occ: e.history.occurrences, first: e.history.first_seen, es: [] });
        groups.get(k).es.push(e);
      }
      const parts = [...groups.values()].slice(0, 3).map((g) => `depuis le ${fmtDate(g.first)} (${g.occ} ${pl(g.occ, "inventaire", "inventaires")}) : ` +
        g.es.slice(0, 4).map((e) => `${e.roll_display} [${e.ref_id}]`).join(", ") + (g.es.length > 4 ? ` +${g.es.length - 4}` : ""));
      const ch = persistent.filter((e) => e.history.changes.length).length;
      out.push(`Persistants (${persistent.length}), les plus anciens d'abord — ` + parts.join(" ; ") + (groups.size > 3 ? " ; …" : "") + (ch ? ` — ${ch} ${pl(ch, "a changé", "ont changé")} depuis.` : "."));
    }
    if (nw.length) {
      const lst = nw.slice(0, 5).map((e) => `${e.roll_display} [${e.ref_id}]`).join(", ") + (nw.length > 5 ? ` +${nw.length - 5}` : "");
      const reg = c.regressions;
      out.push(`Nouveaux : ${lst}` + (reg ? ` — dont ${reg} ${pl(reg, "rouleau conforme", "rouleaux conformes")} à l'analyse précédente.` : "."));
    }
    return out;
  }

  // ------------------------------------------------------------------ vue compacte (tests de parité)
  function compact(result) {
    return {
      inventory_date: result.inventory_date, counts: result.counts, summary: result.summary,
      evolution: result.evolution || null, snapshot: result.snapshot,
      sources: result.sources.map((s) => ({ name: s.name, role: s.role, header_row: s.header_row, mapping: s.mapping, missing: s.missing, records: s.records, no_batch: s.no_batch, roll_shapes: s.roll_shapes })),
      entries: result.entries.map((e) => {
        const d = e.diag || {};
        return {
          ref_id: e.ref_id || null, uid: e.uid, category: e.category, roll: e.roll, batch: e.batch, perimeter: e.perimeter,
          delta: e.delta === null ? null : Math.round(e.delta * 1000) / 1000,
          code: d.code || null, confidence: d.confidence || null, owner: d.owner || null, hypothesis: d.hypothesis || null,
          action: d.action || null, evidence: d.evidence || null,
          trace_mes: e.trace_mes.map((x) => x.ref), trace_phys: e.trace_phys.map((x) => x.ref), excluded_mes: e.excluded_mes,
          decision_key: e.decision_key || null, stale_decision: e.stale_decision === undefined ? null : e.stale_decision, history: e.history || null,
        };
      }),
    };
  }

  const api = {
    VERSION, run, compact, fmtNum, fmtSigned, fmtDate, CAT_LABEL, CATEGORIES, TO_VALIDATE, ROLE_LABELS,
    ROLE_FIELDS, REQUIRED, EVENT_LABELS, excelSerialToIso, normText, cellStr, detectHeader, SYNONYMS, makeSnapshot, gapKeys,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ReconEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
