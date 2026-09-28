"""CLI du PoC de rapprochement inventaire physique / MES.

Analyse simple (le rôle de chaque fichier est deviné par son nom) :
    python -m reconcile --data data_s39 --name "Semaine 39"
Repartir d'une analyse archivée (mêmes règles + validations, nouveaux fichiers) :
    python -m reconcile --from last --data data_s40 --name "Semaine 40"
Rejouer une analyse archivée telle quelle (mêmes fichiers) :
    python -m reconcile --from 20261002-0915
Historique et comparaison :
    python -m reconcile --list
    python -m reconcile --compare <analyse A> <analyse B>
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .engine import run
from .history import baseline_of, build_analysis, files_of, list_runs, load_analysis, normalize_decisions, save_run
from .readers import read_bytes
from .report import compact, to_excel, to_markdown

ROLES = ("mes_inv", "phys_inv", "mes_trace", "phys_trace")


def guess_role(name: str):
    n = name.lower()
    is_mes = "mes" in n
    is_trace = any(k in n for k in ("trace", "traca", "traça", "tracking", "movable", "histo", "mouvement"))
    is_inv = any(k in n for k in ("inventaire", "inventory", "stock", "comptage", "count"))
    if is_mes and is_trace:
        return "mes_trace"
    if is_mes:
        return "mes_inv"
    if is_trace:
        return "phys_trace"
    if is_inv:
        return "phys_inv"
    return None


def load_decisions(path):
    """Relit la feuille « À valider » d'un rapport précédent, un .json {clé: décision} ou un CSV clé;décision."""
    if not path:
        return {}
    p = Path(path)
    if p.suffix.lower() == ".json":
        obj = json.loads(p.read_text(encoding="utf-8"))
        return obj.get("decisions", {}) if isinstance(obj, dict) and obj.get("format") == "recon-analysis" else obj
    dec = {}
    if p.suffix.lower() in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        ws = load_workbook(p, read_only=True)["À valider"]
        for i, row in enumerate(ws.iter_rows(values_only=True)):
            if i == 0 or not row or not row[0]:
                continue
            v = str(row[7]).strip() if len(row) > 7 and row[7] is not None else ""
            if v:
                dec[str(row[0])] = v
        return dec
    for line in p.read_text(encoding="utf-8").splitlines():
        if ";" in line:
            k, v = line.split(";", 1)
            dec[k.strip()] = v.strip()
    return dec


def fmt_run(r):
    k = r.get("kpis") or {}
    return (f"  {r['id']:<34} {r['name'][:28]:<28} inv. {r['inventory_date']}  "
            f"{k.get('gaps', '?'):>3} écarts · {k.get('to_validate', 0)} à valider"
            + (f"   ← {r['parent_id']}" if r.get("parent_id") else ""))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="reconcile", description="Rapprochement inventaire physique / MES + dossier de traçabilité")
    ap.add_argument("--data", help="dossier contenant les fichiers (rôle deviné par le nom)")
    ap.add_argument("--mes-inv", nargs="*", default=[])
    ap.add_argument("--phys-inv", nargs="*", default=[])
    ap.add_argument("--mes-trace", nargs="*", default=[])
    ap.add_argument("--phys-trace", nargs="*", default=[])
    ap.add_argument("--config", help="config.json (défaut : celui du projet, ou celui de l'analyse --from)")
    ap.add_argument("--decisions", help="validations : rapport .xlsx précédent, .json ou .csv clé;décision")
    ap.add_argument("--name", help="nom de l'analyse dans l'historique (ex. « Anode S40 »)")
    ap.add_argument("--from", dest="from_", metavar="ANALYSE", help="repartir d'une analyse : id, début d'id, nom, 'last' ou fichier .json exporté de l'app")
    ap.add_argument("--reuse", help="éléments repris de --from : files,config,decisions (défaut : tout si aucun nouveau fichier, sinon config,decisions)")
    ap.add_argument("--keep", nargs="*", default=[], help="avec --from et de nouveaux fichiers : fichiers de l'ancienne analyse à conserver (nom sans extension)")
    ap.add_argument("--compare-to", metavar="ANALYSE", help="analyse de référence pour l'évolution (défaut : --from, sinon la dernière de l'historique ; 'none' pour aucune)")
    ap.add_argument("--history", default="historique", help="dossier de l'historique (défaut : ./historique)")
    ap.add_argument("--no-history", action="store_true", help="ne pas archiver cette analyse")
    ap.add_argument("--list", action="store_true", help="lister les analyses archivées")
    ap.add_argument("--compare", nargs=2, metavar=("A", "B"), help="comparer deux analyses archivées (B par rapport à A)")
    ap.add_argument("--out", help="rapport Excel (défaut : dans le dossier de l'analyse archivée)")
    ap.add_argument("--json", help="export JSON compact (tests)")
    ap.add_argument("--llm", choices=["anthropic", "openai", "azure"], help="reformulation LLM optionnelle")
    ap.add_argument("--llm-model")
    ap.add_argument("--llm-url")
    ap.add_argument("--pseudonymize", action="store_true", help="remplace rouleaux/batches par des alias avant envoi au LLM")
    a = ap.parse_args(argv)
    hdir = Path(a.history)

    # ---------------------------------------------------------------- consultation
    if a.list:
        runs = list_runs(hdir)
        print(f"{len(runs)} analyse(s) dans {hdir}/" + (":" if runs else ""))
        for r in runs:
            print(fmt_run(r))
        return
    if a.compare:
        A, B = load_analysis(a.compare[0], hdir), load_analysis(a.compare[1], hdir)
        tables = tables_from(files_of(B))
        res = run(tables, B["config"], B["decisions"], baseline_of(A))
        print(f"\nÉVOLUTION « {A['name']} » → « {B['name']} »")
        for b in res["evolution"]["bullets"]:
            print(" •", b)
        out = Path(a.out or f"comparaison_{A['id'][:15]}_vs_{B['id'][:15]}.xlsx")
        to_excel(res, B["config"], out)
        out.with_suffix(".md").write_text(to_markdown(res, B["config"]), encoding="utf-8")
        print(f"\n→ {out}  +  {out.with_suffix('.md')}")
        return

    # ---------------------------------------------------------------- analyse
    src = load_analysis(a.from_, hdir) if a.from_ else None
    new_files = []
    paths = {r: list(getattr(a, r)) for r in ROLES}
    if a.data:
        for f in sorted(Path(a.data).iterdir()):
            if f.suffix.lower() in (".xlsx", ".xlsm", ".csv") and not f.name.startswith("~$"):
                r = guess_role(f.stem)
                if r:
                    paths[r].append(str(f))
                else:
                    print(f"  ! rôle non reconnu, ignoré : {f.name}", file=sys.stderr)
    for r, fs in paths.items():
        for f in fs:
            new_files.append({"filename": Path(f).name, "role": r, "bytes": Path(f).read_bytes()})

    reuse = set((a.reuse or ("config,decisions" if new_files else "files,config,decisions")).split(","))
    files = []
    if src and "files" in reuse:
        files += files_of(src)
    elif src and a.keep:
        files += [f for f in files_of(src) if Path(f["filename"]).stem in a.keep]
    names = {Path(f["filename"]).stem for f in new_files}
    files = [f for f in files if Path(f["filename"]).stem not in names] + new_files

    if a.config:
        cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    elif src and "config" in reuse:
        cfg = src["config"]
    else:
        default = Path(__file__).resolve().parent.parent / "config.json"
        cfg = json.loads(default.read_text(encoding="utf-8")) if default.exists() else {}
    decisions = dict(src["decisions"]) if src and "decisions" in reuse else {}
    decisions.update(load_decisions(a.decisions))

    roles = {f["role"] for f in files}
    if "mes_inv" not in roles or "phys_inv" not in roles:
        ap.error("il faut au moins un inventaire MES et un inventaire physique (--data, --mes-inv/--phys-inv ou --from)")

    base = None
    if a.compare_to and a.compare_to.lower() != "none":
        base = load_analysis(a.compare_to, hdir)
    elif not a.compare_to and src:
        base = src
    elif not a.compare_to and list_runs(hdir):
        base = load_analysis("last", hdir)

    tables = tables_from(files)
    result = run(tables, cfg, decisions, baseline_of(base) if base else None)
    for s in result["sources"]:
        flag = f"  ⚠ colonnes manquantes : {s['missing']}" if s["missing"] else ""
        print(f"  {s['role']:<10} {s['name']:<40} en-tête L{s['header_row']} · {s['records']} lignes{flag}")
    stale = [e for e in result["entries"] if e.get("stale_decision")]
    if stale:
        print(f"  ! {len(stale)} validation(s) précédente(s) non applicable(s) (candidats MES changés) : "
              + ", ".join(e["roll_display"] for e in stale))

    name = a.name or (f"{src['name']} (suite)" if src else f"Inventaire du {result['inventory_date']}")
    an = build_analysis(name, files, cfg, normalize_decisions(result, decisions), result, parent_id=src["id"] if src else None)
    if a.no_history:
        out = Path(a.out or "rapport_rapprochement.xlsx")
    else:
        d = save_run(hdir, an)
        out = Path(a.out) if a.out else d / "rapport.xlsx"
    out.parent.mkdir(parents=True, exist_ok=True)
    to_excel(result, cfg, out)
    md = to_markdown(result, cfg)
    if a.llm:
        from .llm import build_prompt, call_llm
        system, user = build_prompt(result, a.pseudonymize)
        try:
            txt = call_llm(system, user, a.llm, a.llm_model, url=a.llm_url)
            md = md.replace("## Dossier de traçabilité par écart",
                            "## Lecture assistée (LLM — à contrôler)\n\n" + txt + "\n\n## Dossier de traçabilité par écart", 1)
        except Exception as ex:  # le LLM est optionnel : le rapport reste valable sans lui
            print(f"  ! LLM indisponible : {ex}", file=sys.stderr)
    out.with_suffix(".md").write_text(md, encoding="utf-8")
    if a.json:
        Path(a.json).write_text(json.dumps(compact(result), ensure_ascii=False, indent=1), encoding="utf-8")

    s = result["summary"]
    if result.get("evolution"):
        print("\nÉVOLUTION")
        for b in result["evolution"]["bullets"]:
            print(" •", b)
    print("\nGRANDES DIFFÉRENCES")
    for d in s["differences"]:
        print(" •", d)
    print("\nACTIONS")
    for x in s["actions"]:
        print(" •", x["text"])
    print(f"\n→ {out}  +  {out.with_suffix('.md')}")
    if not a.no_history:
        print(f"→ archivée : {an['id']} (« {name} »)" + (f", à partir de {src['id']}" if src else ""))


def tables_from(files):
    tables = {r: [] for r in ROLES}
    for f in files:
        tables[f["role"]].append(read_bytes(f["filename"], f["bytes"]))
    return tables


if __name__ == "__main__":
    main()
