"""Assemble l'app web en un seul fichier HTML autonome.

dist/Rapprochement_MES_physique.html : version fichier (SheetJS embarqué, fonctionne hors ligne)
dist/artifact.html                   : version publiée (SheetJS via cdnjs, sans balises html/head/body)
"""
import base64
import json
from pathlib import Path

ROOT = Path(__file__).parent
W = ROOT / "web"
DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)

import sys
sys.path.insert(0, str(ROOT))
from reconcile.__main__ import guess_role, tables_from  # noqa: E402
from reconcile.engine import run  # noqa: E402
from reconcile.history import build_analysis, normalize_decisions  # noqa: E402


def files_in(d):
    return [{"filename": f.name, "role": guess_role(f.stem), "bytes": f.read_bytes()} for f in sorted(d.glob("*.xlsx"))]


# Démo : « Semaine 39 » archivée (validations faites) + « Semaine 40 » en cours, repartie de la S39
_cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
_cfg.pop("_note", None)
f39 = files_in(ROOT / "data")
r39 = run(tables_from(f39), _cfg, {})
dec = {}
for e in r39["entries"]:
    if e["category"] in ("BATCH_DIFF", "PROBABLE", "AMBIG"):
        dec[e["decision_key"]] = "pick:1" if e["category"] == "AMBIG" else "accept"
r39 = run(tables_from(f39), _cfg, dec)
an39 = build_analysis("Semaine 39 (exemple)", f39, _cfg, normalize_decisions(r39, dec), r39)
an39["id"], an39["created_at"] = "20260925-170000-semaine-39-exemple", "2026-09-25T17:00:00"
demo = {
    "history": [an39],
    "current": {"name": "Semaine 40 (exemple)", "parent_id": an39["id"], "decisions": an39["decisions"],
                "files": [{"filename": f["filename"], "role": f["role"], "perimeter": "",
                           "b64": base64.b64encode(f["bytes"]).decode()} for f in files_in(ROOT / "data_s40")]},
}
cfg = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))

body = (W / "template.html").read_text(encoding="utf-8")
for key, val in {
    "/*__CSS__*/": (W / "app.css").read_text(encoding="utf-8"),
    "/*__READER__*/": (W / "reader.js").read_text(encoding="utf-8"),
    "/*__ENGINE__*/": (W / "engine.js").read_text(encoding="utf-8"),
    "/*__CONFIG__*/": json.dumps(cfg, ensure_ascii=False),
    "/*__DEMO__*/": json.dumps(demo),
    "/*__APP__*/": (W / "app.js").read_text(encoding="utf-8"),
}.items():
    body = body.replace(key, val.replace("</script", "<\\/script"))

xlsx_inline = "<script>\n" + (W / "xlsx.full.min.js").read_text(encoding="utf-8").replace("</script", "<\\/script") + "\n</script>"
xlsx_cdn = '<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>'

standalone = ("<!doctype html>\n<html lang=\"fr\">\n<head>\n<meta charset=\"utf-8\">\n"
              "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
              + body.replace("<!--__XLSX__-->", xlsx_inline).replace("<header", "</head>\n<body>\n<header", 1)
              + "\n</body>\n</html>\n")
(DIST / "Rapprochement_MES_physique.html").write_text(standalone, encoding="utf-8")
(DIST / "artifact.html").write_text(body.replace("<!--__XLSX__-->", xlsx_cdn), encoding="utf-8")
for f in ("Rapprochement_MES_physique.html", "artifact.html"):
    print(f, f"{(DIST / f).stat().st_size / 1024:.0f} Ko")
