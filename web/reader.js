/* Lecture xlsx/xls/csv -> {name, rows} avec la même convention que reconcile/readers.py :
 * dates -> "YYYY-MM-DD HH:MM", heures seules -> "HH:MM", cellules vides -> null, rows[i] = ligne Excel i+1. */
(function (root) {
  "use strict";
  const pad = (n) => String(n).padStart(2, "0");
  function serialToIso(n) {
    const secs = Math.round(n * 86400);
    const d = new Date(Date.UTC(1899, 11, 30) + secs * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  function stem(filename) { return filename.replace(/\.[^.]+$/, ""); }

  function sheetRows(XLSX, ws) {
    if (!ws || !ws["!ref"]) return [];
    const rg = XLSX.utils.decode_range(ws["!ref"]);
    const rows = [];
    for (let r = 0; r <= rg.e.r; r++) {
      const row = [];
      for (let c = 0; c <= rg.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        let v = null;
        if (cell && cell.t !== "z" && cell.t !== "e") {
          if (cell.t === "n") {
            if (cell.z && XLSX.SSF.is_date(cell.z)) v = cell.v < 1 && cell.v >= 0 ? serialToIso(cell.v).slice(11) : serialToIso(cell.v);
            else v = cell.v;
          } else if (cell.t === "d") {
            const d = cell.v;
            v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
          } else if (cell.t === "s") v = cell.v === "" ? null : cell.v;
          else v = cell.v;
        }
        row.push(v);
      }
      while (row.length && row[row.length - 1] === null) row.pop();
      rows.push(row);
    }
    while (rows.length && !rows[rows.length - 1].some((c) => c !== null && c !== "")) rows.pop();
    return rows;
  }

  /** data: ArrayBuffer | Uint8Array | Buffer ; renvoie {name, rows, sheets} */
  function readWorkbook(XLSX, data, filename, sheetName) {
    const isCsv = /\.(csv|txt)$/i.test(filename);
    let wb;
    if (isCsv) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch (e) { text = new TextDecoder("windows-1252").decode(bytes); }
      text = text.replace(/^﻿/, "");
      const first = text.split(/\r?\n/)[0] || "";
      const delim = (first.match(/;/g) || []).length >= (first.match(/,/g) || []).length ? ";" : ",";
      const rows = text.split(/\r?\n/).filter((l, i, a) => !(i === a.length - 1 && l === "")).map((l) => parseCsvLine(l, delim));
      return { name: stem(filename), rows, sheets: ["CSV"] };
    }
    wb = XLSX.read(data, { type: data instanceof ArrayBuffer ? "array" : "buffer", cellDates: false, cellNF: true });
    let ws;
    if (sheetName && wb.Sheets[sheetName]) ws = wb.Sheets[sheetName];
    else {
      const nm = wb.SheetNames.find((n) => { const s = wb.Sheets[n]; return s["!ref"] && XLSX.utils.decode_range(s["!ref"]).e.r >= 1; }) || wb.SheetNames[0];
      ws = wb.Sheets[nm];
      sheetName = nm;
    }
    return { name: stem(filename), rows: sheetRows(XLSX, ws), sheets: wb.SheetNames, sheet: sheetName };
  }
  function parseCsvLine(line, delim) {
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { out.push(cur === "" ? null : cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur === "" ? null : cur);
    return out;
  }
  const api = { readWorkbook, sheetRows };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ReconReader = api;
})(typeof window !== "undefined" ? window : globalThis);
