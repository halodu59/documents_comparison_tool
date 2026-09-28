"""Serveur du PoC (déploiement Railway).

- Sert l'app web (calcul dans le navigateur, comme la version fichier).
- Stocke l'historique des analyses côté serveur, partagé entre utilisateurs (volume Railway).
- Génère le rapport Excel / le brief Markdown d'une version avec le moteur Python.
- Protégé par identifiant / mot de passe (HTTP Basic), sauf /healthz.

Variables d'environnement :
  APP_USERS         "harold:motdepasse1,matthieu:motdepasse2"  (ou APP_USER + APP_PASSWORD)
  DATA_DIR          dossier de stockage (défaut : RAILWAY_VOLUME_MOUNT_PATH, sinon ./historique)
  ALLOW_NO_AUTH=1   pour lancer sans mot de passe (jeu fictif uniquement)
  MAX_UPLOAD_MB     taille maximale d'une analyse enregistrée (défaut 60)
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import logging
import os
import secrets
import threading
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, Response

from reconcile.__main__ import tables_from
from reconcile.engine import run
from reconcile.history import (FORMAT, ID_RE, baseline_of, delete_run, files_of, get_meta, get_run, list_runs,
                               rename_run, save_run)
from reconcile.report import to_excel, to_markdown

log = logging.getLogger("recon")
ROOT = Path(__file__).resolve().parent.parent
VOLUME = os.environ.get("RAILWAY_VOLUME_MOUNT_PATH", "")
DATA_DIR = Path(os.environ.get("DATA_DIR") or VOLUME or (ROOT / "historique"))
PERSISTENT = bool(os.environ.get("DATA_DIR") or VOLUME)
MAX_BYTES = int(float(os.environ.get("MAX_UPLOAD_MB", "60")) * 1024 * 1024)
ALLOW_NO_AUTH = os.environ.get("ALLOW_NO_AUTH") == "1"
LOCK = threading.Lock()


def _users():
    users = {}
    for pair in (os.environ.get("APP_USERS") or "").split(","):
        if ":" in pair:
            u, p = pair.split(":", 1)
            if u.strip() and p:
                users[u.strip()] = p
    if os.environ.get("APP_USER") and os.environ.get("APP_PASSWORD"):
        users[os.environ["APP_USER"]] = os.environ["APP_PASSWORD"]
    return users


USERS = _users()
DATA_DIR.mkdir(parents=True, exist_ok=True)
app = FastAPI(title="Rapprochement MES / inventaire physique", docs_url=None, redoc_url=None, openapi_url=None)


def _page():
    p = ROOT / "dist" / "Rapprochement_MES_physique.html"
    if not p.exists():
        raise RuntimeError("dist/Rapprochement_MES_physique.html absent : lancer « python build.py »")
    return p.read_text(encoding="utf-8")


PAGE = _page()


# --------------------------------------------------------------------------- authentification
def _check_auth(request: Request):
    if not USERS:
        return "anonyme" if ALLOW_NO_AUTH else None
    h = request.headers.get("authorization", "")
    if h.lower().startswith("basic "):
        try:
            u, p = base64.b64decode(h[6:]).decode("utf-8").split(":", 1)
        except (binascii.Error, UnicodeDecodeError, ValueError):
            return None
        ok = u in USERS and secrets.compare_digest(p.encode(), USERS[u].encode())
        return u if ok else None
    return None


@app.middleware("http")
async def guard(request: Request, call_next):
    if request.url.path == "/healthz":
        return await call_next(request)
    if not USERS and not ALLOW_NO_AUTH:
        return Response("Accès non configuré : définir la variable APP_USERS (ex. harold:motdepasse) dans Railway.",
                        status_code=503, media_type="text/plain; charset=utf-8")
    user = _check_auth(request)
    if user is None:
        return Response("Authentification requise", status_code=401,
                        headers={"WWW-Authenticate": 'Basic realm="Rapprochement MES", charset="UTF-8"'})
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > MAX_BYTES:
        return JSONResponse({"detail": f"Analyse trop volumineuse (> {MAX_BYTES // 1048576} Mo)"}, status_code=413)
    request.state.user = user
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    resp.headers.setdefault("Cache-Control", "no-store")
    return resp


# --------------------------------------------------------------------------- pages
@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    info = {"user": request.state.user, "persistent": PERSISTENT}
    return HTMLResponse(PAGE.replace("/*__SERVER__*/null", json.dumps(info), 1))


# --------------------------------------------------------------------------- API historique
def _load(run_id):
    try:
        return get_run(DATA_DIR, run_id)
    except KeyError:
        raise HTTPException(404, "Analyse introuvable")


@app.get("/api/info")
def info(request: Request):
    return {"user": request.state.user, "persistent": PERSISTENT, "count": len(list_runs(DATA_DIR))}


@app.get("/api/analyses")
def list_analyses():
    out = []
    for r in list_runs(DATA_DIR):
        try:
            out.append(get_meta(DATA_DIR, r["id"]))
        except (OSError, ValueError):
            log.warning("analyse illisible : %s", r["id"])
    return out


@app.get("/api/analyses/{run_id}")
def get_analysis(run_id: str):
    return _load(run_id)


@app.post("/api/analyses")
async def save_analysis(request: Request):
    body = await request.body()
    if len(body) > MAX_BYTES:
        raise HTTPException(413, "Analyse trop volumineuse")
    try:
        an = json.loads(body)
    except ValueError:
        raise HTTPException(400, "JSON invalide")
    if not isinstance(an, dict) or an.get("format") != FORMAT or not ID_RE.match(str(an.get("id", ""))):
        raise HTTPException(400, "Ce n'est pas une analyse exportée par l'outil")
    if not isinstance(an.get("snapshot"), dict) or not isinstance(an.get("files"), list):
        raise HTTPException(400, "Analyse incomplète (snapshot ou fichiers manquants)")
    an.pop("example", None)
    an["saved_by"] = request.state.user
    an["saved_at"] = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    with LOCK:
        save_run(DATA_DIR, an)
    return get_meta(DATA_DIR, an["id"])


@app.patch("/api/analyses/{run_id}")
async def rename_analysis(run_id: str, request: Request):
    data = await request.json()
    name = str((data or {}).get("name") or "").strip()[:120]
    if not name:
        raise HTTPException(400, "Nom vide")
    _load(run_id)
    with LOCK:
        rename_run(DATA_DIR, run_id, name)
    return get_meta(DATA_DIR, run_id)


@app.delete("/api/analyses/{run_id}")
def remove_analysis(run_id: str):
    _load(run_id)
    with LOCK:
        delete_run(DATA_DIR, run_id)
    return {"deleted": run_id}


# --------------------------------------------------------------------------- rapports (moteur Python)
def _result(run_id, compare_to):
    an = _load(run_id)
    ref = compare_to or an.get("baseline_id") or an.get("parent_id")
    base = None
    if ref and ref != "none":
        try:
            base = baseline_of(get_run(DATA_DIR, ref))
        except KeyError:
            base = None
    res = run(tables_from(files_of(an)), an["config"], an.get("decisions") or {}, base)
    return an, res


@app.get("/api/analyses/{run_id}/rapport.xlsx")
def report_xlsx(run_id: str, compare_to: str | None = None):
    an, res = _result(run_id, compare_to)
    buf = io.BytesIO()
    to_excel(res, an["config"], buf)
    return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="rapport_{run_id}.xlsx"'})


@app.get("/api/analyses/{run_id}/brief.md")
def report_md(run_id: str, compare_to: str | None = None):
    an, res = _result(run_id, compare_to)
    return Response(to_markdown(res, an["config"]), media_type="text/markdown; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="brief_{run_id}.md"'})
