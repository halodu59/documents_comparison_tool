// Exécute le moteur JS sur un dossier (même devinette de rôle que le CLI Python) -> JSON compact
const fs = require("fs"), path = require("path");
const XLSX = require("../web/xlsx.full.min.js");
const E = require("../web/engine.js"), R = require("../web/reader.js");
const [dir, cfgPath, out, decPath, basePath] = process.argv.slice(2);
function guessRole(n) {
  n = n.toLowerCase();
  const mes = n.includes("mes"), tr = ["trace", "traca", "traça", "tracking", "movable", "histo", "mouvement"].some(k => n.includes(k));
  const inv = ["inventaire", "inventory", "stock", "comptage", "count"].some(k => n.includes(k));
  if (mes && tr) return "mes_trace"; if (mes) return "mes_inv"; if (tr) return "phys_trace"; if (inv) return "phys_inv"; return null;
}
const tables = { mes_inv: [], phys_inv: [], mes_trace: [], phys_trace: [] };
for (const f of fs.readdirSync(dir).sort()) {
  if (!/\.(xlsx|xlsm|csv)$/i.test(f) || f.startsWith("~$")) continue;
  const role = guessRole(f.replace(/\.[^.]+$/, ""));
  if (role) tables[role].push(R.readWorkbook(XLSX, fs.readFileSync(path.join(dir, f)), f));
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const dec = decPath ? JSON.parse(fs.readFileSync(decPath, "utf8")) : {};
const base = basePath ? JSON.parse(fs.readFileSync(basePath, "utf8")) : null;
fs.writeFileSync(out, JSON.stringify(E.compact(E.run(tables, cfg, dec, base)), null, 1));
console.log("ok");
