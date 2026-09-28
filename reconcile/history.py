"""Historique des analyses : format d'archive commun à l'app web et au script (analyse.json).

Une analyse archivée contient tout ce qu'il faut pour la rejouer ou en repartir : fichiers sources
(en base64), règles, validations, et un résumé (snapshot) qui sert aux comparaisons.
"""
from __future__ import annotations

import base64
import json
import re
import unicodedata
from datetime import datetime
from pathlib import Path

from .engine import VERSION

FORMAT = "recon-analysis"


def slug(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:40] or "analyse"


def build_analysis(name, files, cfg, decisions, result, parent_id=None, source="python", decisions_meta=None):
    """files = [{filename, role, bytes, perimeter?}]"""
    now = datetime.now()
    return {
        "format": FORMAT, "format_version": 1, "engine_version": VERSION, "source": source,
        "id": f"{now:%Y%m%d-%H%M%S}-{slug(name)}", "name": name, "created_at": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "parent_id": parent_id, "inventory_date": result["inventory_date"],
        "config": cfg, "decisions": decisions or {}, "decisions_meta": decisions_meta or {},
        "files": [{"filename": f["filename"], "name": Path(f["filename"]).stem, "role": f["role"],
                   "perimeter": f.get("perimeter") or "", "b64": base64.b64encode(f["bytes"]).decode()} for f in files],
        "snapshot": result["snapshot"],
        "summary": {"kpis": result["summary"]["kpis"], "differences": result["summary"]["differences"],
                    "actions": [a["text"] for a in result["summary"]["actions"]]},
        "evolution_bullets": (result.get("evolution") or {}).get("bullets") or [],
    }


def normalize_decisions(result, decisions):
    """Réécrit les décisions appliquées sous forme explicite (accept:<batch MES>) pour qu'elles restent
    valables si l'ordre des candidats change ; conserve telles quelles les décisions non appliquées."""
    out = dict(decisions or {})
    for e in result["entries"]:
        k = e.get("decision_key")
        if not k or not e.get("validated"):
            continue
        for old in [k for k in out if k == e["uid"]]:
            out.pop(old)  # ancienne clé fichier#ligne remplacée par la clé stable
        out[k] = f"accept:{e['mes']['batch']}" if e["validated"] == "accept" else "reject"
    return out


def is_analysis(obj):
    return isinstance(obj, dict) and obj.get("format") == FORMAT


def files_of(an):
    return [{"filename": f["filename"], "role": f["role"], "perimeter": f.get("perimeter") or "",
             "bytes": base64.b64decode(f["b64"])} for f in an.get("files", [])]


# --------------------------------------------------------------------------- dossier historique
def _index_path(hdir):
    return Path(hdir) / "index.json"


def list_runs(hdir):
    p = _index_path(hdir)
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}$")


def meta_of(an):
    """L'analyse sans le contenu des fichiers (léger : sert aux listes et aux comparaisons)."""
    m = {k: v for k, v in an.items() if k != "files"}
    m["files"] = [{"filename": f["filename"], "role": f["role"], "perimeter": f.get("perimeter") or ""} for f in an.get("files", [])]
    return m


def _write_index(hdir, runs):
    runs.sort(key=lambda r: r["created_at"])
    tmp = _index_path(hdir).with_suffix(".tmp")
    tmp.write_text(json.dumps(runs, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(_index_path(hdir))


def save_run(hdir, an):
    if not ID_RE.match(an.get("id") or ""):
        raise ValueError("identifiant d'analyse invalide")
    hdir = Path(hdir)
    d = hdir / an["id"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "analyse.json").write_text(json.dumps(an, ensure_ascii=False), encoding="utf-8")
    (d / "meta.json").write_text(json.dumps(meta_of(an), ensure_ascii=False), encoding="utf-8")
    runs = [r for r in list_runs(hdir) if r["id"] != an["id"]]
    runs.append({"id": an["id"], "name": an["name"], "created_at": an["created_at"], "parent_id": an["parent_id"],
                 "inventory_date": an["inventory_date"], "kpis": an["snapshot"]["kpis"],
                 "files": [f["filename"] for f in an["files"]], "saved_by": an.get("saved_by")})
    _write_index(hdir, runs)
    return d


def get_meta(hdir, run_id):
    d = Path(hdir) / run_id
    if (d / "meta.json").exists():
        return json.loads((d / "meta.json").read_text(encoding="utf-8"))
    return meta_of(json.loads((d / "analyse.json").read_text(encoding="utf-8")))


def get_run(hdir, run_id):
    if not ID_RE.match(run_id or ""):
        raise KeyError(run_id)
    p = Path(hdir) / run_id / "analyse.json"
    if not p.exists():
        raise KeyError(run_id)
    return json.loads(p.read_text(encoding="utf-8"))


def rename_run(hdir, run_id, name):
    an = get_run(hdir, run_id)
    an["name"] = name
    save_run(hdir, an)
    return an


def delete_run(hdir, run_id):
    import shutil
    if not ID_RE.match(run_id or ""):
        raise KeyError(run_id)
    d = Path(hdir) / run_id
    if not d.exists():
        raise KeyError(run_id)
    shutil.rmtree(d)
    _write_index(hdir, [r for r in list_runs(hdir) if r["id"] != run_id])


def load_analysis(ref, hdir):
    """ref = chemin d'un .json (export de l'app ou analyse.json), un id (ou début d'id), ou 'last'."""
    p = Path(ref)
    if p.suffix.lower() == ".json" and p.exists():
        an = json.loads(p.read_text(encoding="utf-8"))
        if not is_analysis(an):
            raise ValueError(f"{p.name} n'est pas une analyse exportée")
        return an
    runs = list_runs(hdir)
    if not runs:
        raise ValueError(f"historique vide ({hdir})")
    if ref == "last":
        hit = runs[-1]
    else:
        hits = [r for r in runs if r["id"] == ref] or [r for r in runs if r["id"].startswith(ref)] \
            or [r for r in runs if r["name"] == ref]
        if not hits:
            raise ValueError(f"analyse introuvable : {ref} (voir --list)")
        hit = hits[-1]
    return json.loads((Path(hdir) / hit["id"] / "analyse.json").read_text(encoding="utf-8"))


def baseline_of(an):
    return {"id": an["id"], "name": an["name"], "snapshot": an["snapshot"]}
