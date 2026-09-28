"""Test de parité : moteur Python vs moteur JS, sur une chaîne d'analyses réaliste :
S39 brute → S39 avec validations (comparée à S39) → S40 repartie de S39 validée (comparée, validations reportées)."""
import json, subprocess, sys, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from reconcile.engine import run
from reconcile.readers import read_file
from reconcile.report import compact
from reconcile.history import normalize_decisions
from reconcile.__main__ import guess_role


def tables_of(data):
    tables = {r: [] for r in ("mes_inv", "phys_inv", "mes_trace", "phys_trace")}
    for f in sorted(Path(data).iterdir()):
        if f.suffix.lower() in (".xlsx", ".xlsm", ".csv"):
            r = guess_role(f.stem)
            if r: tables[r].append(read_file(f))
    return tables


def diff(a, b, path=""):
    out = []
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            out += diff(a.get(k), b.get(k), f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b): out.append(f"{path}: len {len(a)} != {len(b)}")
        for i, (x, y) in enumerate(zip(a, b)): out += diff(x, y, f"{path}[{i}]")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool):
        if abs(a - b) > 1e-6: out.append(f"{path}: {a} != {b}")
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")
    return out


def check(data, cfg_path, dec, baseline=None):
    cfg = json.loads(Path(cfg_path).read_text(encoding="utf-8"))
    raw = run(tables_of(data), cfg, dec, baseline)
    py = json.loads(json.dumps(compact(raw), ensure_ascii=False))
    with tempfile.TemporaryDirectory() as td:
        dp = Path(td) / "dec.json"; dp.write_text(json.dumps(dec))
        bp = Path(td) / "base.json"; bp.write_text(json.dumps(baseline) if baseline else "null")
        out = Path(td) / "js.json"
        subprocess.run(["node", str(ROOT / "tests/run_js.js"), str(data), str(cfg_path), str(out), str(dp), str(bp)],
                       check=True, capture_output=True)
        js = json.loads(out.read_text(encoding="utf-8"))
    return raw, py, diff(py, js)


if __name__ == "__main__":
    cfgp = ROOT / "config.json"
    fails = 0
    raw0, py0, d0 = check(ROOT / "data", cfgp, {})
    dec = {}
    for e in raw0["entries"]:
        if e["category"] in ("BATCH_DIFF", "PROBABLE", "AMBIG"):
            dec[e["decision_key"]] = {"BATCH_DIFF": "accept", "PROBABLE": "accept", "AMBIG": "pick:1"}[e["category"]]
    base0 = {"id": "s39", "name": "S39", "snapshot": py0["snapshot"]}
    raw1, py1, d1 = check(ROOT / "data", cfgp, dec, base0)
    dec_n = normalize_decisions(raw1, dec)
    base1 = {"id": "s39v", "name": "S39 validée", "snapshot": py1["snapshot"]}
    raw2, py2, d2 = check(ROOT / "data_s40", cfgp, dec_n, base1)
    # décisions « reject » + ancienne clé fichier#ligne (rétro-compatibilité)
    old = {e["uid"]: "reject" for e in raw0["entries"] if e["category"] in ("PROBABLE",)}
    raw3, py3, d3 = check(ROOT / "data", cfgp, old)
    for name, py, d in (("S39 brute", py0, d0), ("S39 validée vs S39", py1, d1), ("S40 vs S39 validée", py2, d2),
                        ("S39 rejet (ancienne clé)", py3, d3)):
        ev = py.get("evolution") or {}
        print(f"[{name}] {len(py['entries'])} lignes · {py['summary']['kpis']['gaps']} écarts"
              + (f" · évolution {ev['counts']}" if ev else "") + f" · {len(d)} différence(s) Python/JS")
        for x in d[:20]: print("   ", x)
        fails += len(d)
    applied = [e for e in raw2["entries"] if e.get("validated")]
    print("   décisions reportées sur S40 :", [(e["roll_display"], e["validated"]) for e in applied])
    print("   décisions normalisées :", dec_n)
    sys.exit(1 if fails else 0)
