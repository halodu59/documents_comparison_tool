"""Moteur de rapprochement inventaire physique / MES + préparation de la traçabilité des écarts.

Logique pure (aucune E/S) : reçoit des tableaux (listes de lignes) et renvoie un résultat
sérialisable. Le fichier web/engine.js implémente EXACTEMENT la même logique pour l'app web ;
toute modification ici doit être reportée là-bas (test de parité : tests/parity.py).
"""
from __future__ import annotations

import math
import re
import unicodedata
from datetime import datetime, timedelta

VERSION = "0.1.0"

# --------------------------------------------------------------------------- dictionnaires
SYNONYMS = {
    "roll": ["movable unit", "mu", "roll id", "roll", "roll number", "rouleau", "n rouleau", "no rouleau",
             "num rouleau", "numero rouleau", "numero de rouleau", "n de rouleau", "corps", "n corps",
             "id corps", "numero de corps", "container", "bobine", "id rouleau"],
    "batch": ["batch", "batch number", "batch no", "batch id", "n batch", "no batch", "numero batch",
              "numero de batch", "lot", "n lot", "numero de lot", "n de lot"],
    "qty": ["quantity", "qty", "quantite", "qte", "longueur", "longueur m", "length", "length m",
            "metrage", "metrage m", "longueur en m"],
    "date": ["date", "count date", "date inventaire", "date d inventaire", "timestamp", "datetime",
             "date heure", "last movement", "date mouvement", "posting date", "horodatage", "date comptage"],
    "time": ["heure", "time", "hour", "heure mouvement"],
    "event": ["transaction", "movement type", "type mouvement", "type de mouvement", "operation", "event",
              "action", "evenement", "mouvement"],
    "location": ["storage location", "sloc", "zone", "emplacement", "location", "magasin"],
    "from": ["from", "origine", "source location", "from location", "provenance"],
    "to": ["to", "vers", "destination", "to location", "dest"],
    "equipment": ["equipment", "machine", "line", "ligne", "poste", "equipement", "resource", "ressource"],
    "material": ["material", "article", "part number", "pn", "code article", "materiel"],
    "step": ["step", "etape", "process step", "operation step"],
    "user": ["user", "operateur", "operator", "utilisateur", "agent", "counted by", "compte par"],
    "comment": ["commentaire", "comment", "comments", "remarks", "remarque", "remarques", "observation"],
    "status": ["status", "statut"],
    "order": ["order", "of", "ordre", "production order", "ordre de fabrication"],
}

ROLE_FIELDS = {
    "mes_inv": ["roll", "batch", "qty", "location", "material", "date", "status"],
    "phys_inv": ["roll", "batch", "qty", "date", "location", "step", "material", "user", "comment"],
    "mes_trace": ["date", "time", "roll", "batch", "event", "qty", "from", "to", "equipment", "material",
                  "order", "user", "comment"],
    "phys_trace": ["date", "time", "roll", "batch", "event", "qty", "from", "to", "equipment", "user", "comment"],
}
REQUIRED = {
    "mes_inv": ["roll", "batch", "qty"],
    "phys_inv": ["roll", "qty"],
    "mes_trace": ["date", "roll", "event"],
    "phys_trace": ["date", "roll", "event"],
}
ROLE_LABELS = {
    "mes_inv": "Inventaire MES",
    "phys_inv": "Inventaire physique",
    "mes_trace": "Traçabilité MES",
    "phys_trace": "Traçabilité physique",
}

# Types d'événements canoniques (ordre = priorité de détection)
EVENT_KEYWORDS = [
    ("RETOUR", ["retour", "return", "reintegr"]),
    ("REBUT", ["rebut", "scrap", "dechet", "non conform", "waste"]),
    ("PRELEVEMENT", ["prelev", "echantillon", "sample", "cut", "coupe", "decoupe", "split", "splice"]),
    ("AJUSTEMENT", ["ajust", "adjust", "correction", "ecart inv"]),
    ("BLOCAGE", ["bloqu", "block", "hold", "quarant"]),
    ("CONSOMMATION", ["consom", "consum", "conso", "goods issue"]),
    ("PRODUCTION", ["production", "produc", "output", "goods receipt", "creat", "bobinage", "enroul"]),
    ("TRANSFERT", ["transf", "move", "deplac", "mise en stock", "stockage", "relocat"]),
]
EVENT_LABELS = {
    "RETOUR": "retour en stock", "REBUT": "rebut", "PRELEVEMENT": "prélèvement/découpe",
    "AJUSTEMENT": "ajustement", "BLOCAGE": "blocage", "CONSOMMATION": "consommation",
    "PRODUCTION": "production", "TRANSFERT": "transfert", "AUTRE": "autre",
}

CATEGORIES = [
    ("ONLY_MES", "Seulement MES"),
    ("ONLY_PHYS", "Seulement physique"),
    ("LEN", "Écart de longueur"),
    ("STEP", "Étape / article divergent"),
    ("BATCH_DIFF", "Batch divergent — à valider"),
    ("PROBABLE", "Batch manquant — à valider"),
    ("AMBIG", "Ambigu — plusieurs candidats"),
    ("DUP", "Doublon de comptage"),
    ("OK", "Conforme"),
]
CAT_LABEL = dict(CATEGORIES)
CAT_ORDER = {c: i for i, (c, _) in enumerate(CATEGORIES)}
TO_VALIDATE = ("BATCH_DIFF", "PROBABLE", "AMBIG")

CONF_ORDER = {"Élevée": 0, "Moyenne": 1, "Faible": 2}

ACTION_FAMILIES = [  # code -> libellé d'action groupée
    ("CONSO_NON_DECLAREE", "Déclarer dans MES les consommations constatées physiquement"),
    ("REBUT_NON_DECLARE", "Déclarer dans MES les rebuts constatés physiquement"),
    ("RETOUR_NON_DECLARE", "Déclarer dans MES les retours en stock"),
    ("SORTIE_MES_A_TORT", "Vérifier l'étiquette puis annuler les sorties MES contredites par le comptage"),
    ("PROD_NON_DECLAREE", "Déclarer dans MES les productions manquantes"),
    ("PRELEVEMENT_NON_DECLARE", "Ajuster les quantités MES (prélèvements/découpes non déclarés)"),
    ("ETAPE_NON_DECLAREE", "Déclarer dans MES les avancements d'étape"),
    ("EMPLACEMENT_MES", "Corriger les emplacements MES"),
    ("AJUSTEMENT_MES", "Vérifier les ajustements MES non constatés physiquement"),
    ("HORS_ZONE", "Vérifier les rouleaux transférés hors zone inventoriée"),
    ("STOCK_FANTOME", "Recompter puis sortir de stock MES si introuvable"),
    ("NON_COMPTE", "Recompter les rouleaux sans trace physique"),
    ("SAISIE_UNITE", "Corriger les métrages mal saisis"),
    ("ECART_INEXPLIQUE", "Re-mesurer les rouleaux (compteur machine vs saisie)"),
    ("BATCH_INCONNU_MES", "Relire le batch sur l'étiquette"),
    ("DOUBLON", "Supprimer les doublons de comptage"),
    ("BATCH_SAISIE", "Valider les correspondances à batch divergent"),
    ("BATCH_MANQUANT", "Valider les correspondances sans batch"),
    ("AMBIGU", "Trancher les rouleaux à plusieurs candidats MES"),
    ("CORRIGER_BATCH", "Corriger le batch dans le fichier source après validation"),
    ("INDETERMINE", "Analyser en réunion"),
]
FAMILY_LABEL = dict(ACTION_FAMILIES)
FAMILY_ORDER = {c: i for i, (c, _) in enumerate(ACTION_FAMILIES)}
OWNER_ORDER = ["MES", "OPS", "CTRL"]


# --------------------------------------------------------------------------- normalisation
def norm_text(v) -> str:
    s = cell_str(v)
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn").lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return s.strip()


def cell_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return str(v)
    if isinstance(v, (int, float)):
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            return ""
        if float(v).is_integer():
            return str(int(v))
        return repr(float(v))
    return str(v).strip()


def round1(x: float) -> float:
    return math.floor(x * 10 + 0.5) / 10


def fmt_num(x) -> str:
    """Format français : séparateur de milliers (espace fine insécable), 1 décimale max, virgule."""
    if x is None:
        return "—"
    r = round1(x)
    neg = r < 0
    r = abs(r)
    ip = int(math.floor(r))
    dec = int(math.floor((r - ip) * 10 + 0.5))
    if dec == 10:
        ip, dec = ip + 1, 0
    digits = str(ip)
    groups = []
    while len(digits) > 3:
        groups.insert(0, digits[-3:])
        digits = digits[:-3]
    groups.insert(0, digits)
    s = "\u202f".join(groups) + (f",{dec}" if dec else "")
    return ("-" + s) if neg and s != "0" else s


def fmt_signed(x) -> str:
    if x is None:
        return "—"
    s = fmt_num(x)
    return s if s.startswith("-") or s == "0" else "+" + s


def norm_roll(v, prefixes) -> str:
    s = re.sub(r"[^A-Z0-9]", "", cell_str(v).upper())
    for p in sorted(prefixes, key=lambda p: (-len(p), p)):
        p = p.upper()
        if p and s.startswith(p) and len(s) > len(p):
            s = s[len(p):]
            break
    s2 = s.lstrip("0")
    return s2 if s2 else s


def norm_batch(v) -> str:
    s = cell_str(v).upper()
    if re.fullmatch(r"\d+\.0+", s):
        s = s.split(".")[0]
    return re.sub(r"[^A-Z0-9]", "", s)


def parse_num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return None if (isinstance(v, float) and math.isnan(v)) else float(v)
    s = re.sub(r"[\s  ]", "", str(v)).replace(",", ".")
    s = re.sub(r"(?i)m$", "", s)
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return float(s)
    return None


def excel_serial_to_iso(n: float) -> str:
    secs = round(n * 86400)
    d = datetime(1899, 12, 30) + timedelta(seconds=secs)
    return d.strftime("%Y-%m-%d %H:%M")


def parse_date(v):
    """Renvoie 'YYYY-MM-DD HH:MM' ou None."""
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return excel_serial_to_iso(v) if 20000 < v < 80000 else None
    s = cell_str(v)
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?", s)
    if m:
        y, mo, d, h, mi = m.groups()
        return f"{y}-{mo}-{d} {int(h or 0):02d}:{mi or '00'}"
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T](\d{1,2})[:h](\d{2}))?", s)
    if m:
        d, mo, y, h, mi = m.groups()
        y = int(y) + (2000 if len(y) == 2 else 0)
        return f"{y:04d}-{int(mo):02d}-{int(d):02d} {int(h or 0):02d}:{mi or '00'}"
    return None


def parse_time(v):
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if 0 <= v < 1:
            return excel_serial_to_iso(v)[11:]
        return None
    m = re.search(r"(\d{1,2})[:h](\d{2})", cell_str(v))
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else None


def date_part(iso):
    return iso[:10] if iso else None


def fmt_date(iso, with_time=False):
    if not iso:
        return "?"
    s = f"{iso[8:10]}/{iso[5:7]}/{iso[:4]}"
    if with_time and iso[11:16] and iso[11:16] != "00:00":
        s += " " + iso[11:16]
    return s


def days_between(a_iso, b_iso):
    """Nombre de jours (entier) de a à b (dates seules)."""
    a = datetime.strptime(a_iso[:10], "%Y-%m-%d")
    b = datetime.strptime(b_iso[:10], "%Y-%m-%d")
    return (b - a).days


def add_days(iso, n):
    d = datetime.strptime(iso[:10], "%Y-%m-%d") + timedelta(days=n)
    return d.strftime("%Y-%m-%d")


def event_type(raw) -> str:
    s = norm_text(raw)
    for typ, kws in EVENT_KEYWORDS:
        for kw in kws:
            if kw in s:
                return typ
    return "AUTRE"


def pretty_roll(raw, prefixes) -> str:
    s = re.sub(r"[^A-Z0-9]", "", cell_str(raw).upper())
    for p in sorted(prefixes, key=lambda p: (-len(p), p)):
        p = p.upper()
        if p and s.startswith(p) and s[len(p):].isdigit():
            return p + "-" + s[len(p):]
    return s


def perimeter_lookup(value, cfg):
    pm = {norm_text(k): v for k, v in (cfg.get("perimeter_map") or {}).items()}
    return pm.get(norm_text(value))


def roll_shape(raw) -> str:
    s = cell_str(raw)
    s = re.sub(r"[0-9]", "9", s)
    s = re.sub(r"[A-Z]", "A", s)
    return re.sub(r"[a-z]", "a", s)


# --------------------------------------------------------------------------- colonnes
def map_columns(header_row, role, overrides=None):
    fields = ROLE_FIELDS[role]
    norms = [norm_text(h) for h in header_row]
    mapping, taken = {}, set()
    for f, h in (overrides or {}).items():
        hn = norm_text(h)
        for i, n in enumerate(norms):
            if n == hn and i not in taken:
                mapping[f] = i
                taken.add(i)
                break
    for f in fields:
        if f in mapping:
            continue
        syns = SYNONYMS[f]
        for i, n in enumerate(norms):
            if i not in taken and n and n in syns:
                mapping[f] = i
                taken.add(i)
                break
    for f in fields:
        if f in mapping:
            continue
        found = None
        for syn in SYNONYMS[f]:
            if len(syn) < 3:
                continue
            for i, n in enumerate(norms):
                if i not in taken and n and (" " + syn + " ") in (" " + n + " "):
                    found = i
                    break
            if found is not None:
                break
        if found is not None:
            mapping[f] = found
            taken.add(found)
    return mapping


def detect_header(rows, role, overrides=None):
    best = (-1, 0, {})
    for r in range(min(15, len(rows))):
        mp = map_columns(rows[r], role, overrides)
        score = len(mp) + (100 if all(f in mp for f in REQUIRED[role]) else 0)
        if score > best[0]:
            best = (score, r, mp)
    return best[1], best[2]


# --------------------------------------------------------------------------- chargement
def load_table(table, role, cfg):
    """table = {name, rows}. Renvoie (records, info)."""
    name = table["name"]
    rows = table["rows"]
    overrides = (cfg.get("column_overrides") or {}).get(name)
    hidx, mp = detect_header(rows, role, overrides)
    header = rows[hidx] if rows else []
    missing = [f for f in REQUIRED[role] if f not in mp]
    prefixes = cfg.get("roll_prefixes") or []
    defaults = (cfg.get("file_defaults") or {}).get(name) or {}
    recs, skipped = [], 0

    def g(row, f):
        i = mp.get(f)
        return row[i] if i is not None and i < len(row) else None

    for ri in range(hidx + 1, len(rows)):
        row = rows[ri]
        roll_raw = g(row, "roll")
        if cell_str(roll_raw) == "":
            if any(cell_str(c) for c in row):
                skipped += 1
            continue
        d = parse_date(g(row, "date"))
        t = parse_time(g(row, "time"))
        if d and t:
            d = d[:11] + t
        rec = {
            "src": name, "role": role, "row": ri + 1,
            "roll_raw": cell_str(roll_raw), "roll": norm_roll(roll_raw, prefixes),
            "batch_raw": cell_str(g(row, "batch")), "batch": norm_batch(g(row, "batch")),
            "qty": parse_num(g(row, "qty")), "qty_raw": cell_str(g(row, "qty")),
            "date": d,
            "location": cell_str(g(row, "location")),
            "material": cell_str(g(row, "material")),
            "step": cell_str(g(row, "step")),
            "event": cell_str(g(row, "event")),
            "from": cell_str(g(row, "from")), "to": cell_str(g(row, "to")),
            "equipment": cell_str(g(row, "equipment")),
            "user": cell_str(g(row, "user")), "comment": cell_str(g(row, "comment")),
            "order": cell_str(g(row, "order")),
        }
        rec["type"] = event_type(rec["event"]) if role in ("mes_trace", "phys_trace") else None
        if role in ("mes_inv", "phys_inv"):
            p = None
            if rec["step"]:
                p = perimeter_lookup(rec["step"], cfg) or rec["step"]
            elif rec["material"]:
                p = perimeter_lookup(rec["material"], cfg) or rec["material"]
            rec["perimeter"] = p or defaults.get("perimeter") or "Non défini"
        recs.append(rec)
    info = {
        "name": name, "role": role, "header_row": hidx + 1,
        "mapping": {f: cell_str(header[i]) for f, i in mp.items() if i < len(header)},
        "missing": missing, "records": len(recs), "skipped": skipped,
        "no_batch": sum(1 for r in recs if not r["batch"]),
        "bad_qty": sum(1 for r in recs if r["qty"] is None and role in ("mes_inv", "phys_inv")),
        "roll_shapes": len({roll_shape(r["roll_raw"]) for r in recs}),
        "roll_reformatted": sum(1 for r in recs if re.sub(r"[^A-Z0-9]", "", r["roll_raw"].upper()) != r["roll_raw"]
                                or r["roll_raw"] != r["roll_raw"].strip()),
    }
    return recs, info


def ref(rec):
    return f"{rec['src']}#L{rec['row']}"


# --------------------------------------------------------------------------- rapprochement
def within_tol(delta, base, cfg):
    tol = max(cfg.get("tolerance_abs_m", 2.0), (cfg.get("tolerance_pct", 0.0) / 100.0) * abs(base or 0))
    return abs(delta) <= tol + 1e-9


def tol_value(base, cfg):
    return max(cfg.get("tolerance_abs_m", 2.0), (cfg.get("tolerance_pct", 0.0) / 100.0) * abs(base or 0))


def pair_category(m, p, cfg):
    if m["perimeter"] != p["perimeter"] and m["perimeter"] != "Non défini" and p["perimeter"] != "Non défini":
        return "STEP"
    if m["qty"] is None or p["qty"] is None:
        return "LEN"
    return "OK" if within_tol(p["qty"] - m["qty"], m["qty"], cfg) else "LEN"


def reconcile(mes, phys, cfg, decisions=None):
    decisions = decisions or {}
    entries = []
    used_m = [False] * len(mes)
    idx = {}
    for i, m in enumerate(mes):
        idx.setdefault((m["roll"], m["batch"]), []).append(i)

    # doublons dans l'inventaire physique
    seen, dup_of = {}, {}
    for j, p in enumerate(phys):
        if not p["batch"]:
            continue
        k = (p["roll"], p["batch"])
        if k in seen:
            dup_of[j] = seen[k]
        else:
            seen[k] = j

    matched_p = [False] * len(phys)
    pairs = []
    # 1. clé exacte rouleau + batch
    for j, p in enumerate(phys):
        if j in dup_of or not p["batch"]:
            continue
        for i in idx.get((p["roll"], p["batch"]), []):
            if not used_m[i]:
                used_m[i] = True
                matched_p[j] = True
                pairs.append(("EXACT", i, j))
                break
    # 2. clé partielle (rouleau seul) pour les lignes restantes
    uncertain = []
    for j, p in enumerate(phys):
        if matched_p[j] or j in dup_of:
            continue
        cands = [i for i, m in enumerate(mes) if not used_m[i] and m["roll"] == p["roll"]]
        for i in cands:
            used_m[i] = True
        matched_p[j] = True
        if not cands:
            entries.append(new_entry("ONLY_PHYS", None, p))
        elif len(cands) == 1:
            uncertain.append(("PROBABLE" if not p["batch"] else "BATCH_DIFF", cands, j))
        else:
            uncertain.append(("AMBIG", cands, j))

    for _, i, j in pairs:
        e = new_entry(pair_category(mes[i], phys[j], cfg), mes[i], phys[j])
        entries.append(e)

    for cat, cands, j in uncertain:
        p = phys[j]
        key = decision_key(p)
        dec = decisions.get(key, decisions.get(ref(p)))
        action, k = resolve_decision(dec, [mes[c]["batch"] for c in cands])
        if action == "accept":
            m = mes[cands[k]]
            e = new_entry(pair_category(m, p, cfg), m, p, validated="accept")
            e["was"], e["decision_key"], e["decision"] = cat, key, dec
            entries.append(e)
            for c in cands:
                if c != cands[k]:
                    entries.append(new_entry("ONLY_MES", mes[c], None))
            continue
        if action == "reject":
            e = new_entry("ONLY_PHYS", None, p, validated="reject")
            e["decision_key"], e["decision"] = key, dec
            entries.append(e)
            for c in cands:
                x = new_entry("ONLY_MES", mes[c], None, validated="reject")
                x["decision_key"], x["decision"] = key, dec
                entries.append(x)
            continue
        if cat == "AMBIG":
            e = new_entry("AMBIG", None, p)
            e["candidates"] = [mes[c] for c in cands]
        else:
            e = new_entry(cat, mes[cands[0]], p)
        e["decision_key"] = key
        if action == "stale":
            e["stale_decision"] = dec
        entries.append(e)

    for j, k in dup_of.items():
        e = new_entry("DUP", None, phys[j])
        e["dup_of"] = phys[k]
        entries.append(e)

    for i, m in enumerate(mes):
        if not used_m[i]:
            entries.append(new_entry("ONLY_MES", m, None))
    return entries


def decision_key(p):
    """Clé stable d'une décision : rouleau + batch relevé (normalisés), indépendante des n° de ligne."""
    return f"{p['roll']}|{p['batch']}"


def resolve_decision(dec, cand_batches):
    """Interprète une décision -> ('accept', index) | ('reject', None) | ('stale', None) | (None, None).
    Formats acceptés : accept · reject · pick:N · accept:<batch MES> · <batch MES>."""
    if dec is None:
        return None, None
    d = cell_str(dec).strip()
    low = d.lower()
    if low == "":
        return None, None
    if low in ("reject", "rejet", "rejeter", "non", "ko"):
        return "reject", None
    if low in ("accept", "accepter", "valider", "oui", "ok"):
        return ("accept", 0) if len(cand_batches) == 1 else ("stale", None)
    if low.startswith("pick:"):
        try:
            k = int(low.split(":", 1)[1])
        except ValueError:
            return "stale", None
        return ("accept", k) if 0 <= k < len(cand_batches) else ("stale", None)
    b = norm_batch(d.split(":", 1)[1] if low.startswith("accept:") or low.startswith("batch:") else d)
    if b in cand_batches:
        return "accept", cand_batches.index(b)
    return "stale", None


def new_entry(cat, m, p, validated=None):
    base = p or m
    e = {
        "uid": ref(p) if p else ref(m),
        "category": cat, "mes": m, "phys": p, "validated": validated, "was": None,
        "roll": base["roll"],
        "roll_display": (m["roll_raw"] if m else p["roll_raw"]),
        "batch": (m["batch"] if m else p["batch"]),
        "perimeter": (p["perimeter"] if p else m["perimeter"]),
        "candidates": [], "dup_of": None, "decision_key": None, "decision": None, "stale_decision": None,
    }
    if m and p and m["qty"] is not None and p["qty"] is not None:
        e["delta"] = p["qty"] - m["qty"]
    else:
        e["delta"] = None
    return e


def entry_sort_key(e):
    return (CAT_ORDER[e["category"]], e["perimeter"], e["roll"], e["batch"], e["uid"])


# --------------------------------------------------------------------------- traçabilité
def trace_events(recs, source_label):
    out = []
    for r in recs:
        out.append({
            "source": source_label, "src": r["src"], "row": r["row"], "ref": ref(r),
            "date": r["date"], "roll": r["roll"], "batch": r["batch"], "event": r["event"],
            "type": r["type"], "qty": r["qty"], "from": r["from"], "to": r["to"],
            "equipment": r["equipment"], "user": r["user"], "comment": r["comment"],
            "order": r["order"],
        })
    return out


def entry_batches(e):
    bs = []
    for r in [e["mes"], e["phys"]] + list(e.get("candidates") or []):
        if r and r["batch"] and r["batch"] not in bs:
            bs.append(r["batch"])
    return bs


def collect_trace(e, trace_by_roll, inv_date, cfg):
    batches = entry_batches(e)
    lo = add_days(inv_date, -int(cfg.get("window_days", 45)))
    hi = add_days(inv_date, 7)
    cutoff = inv_date + " 23:59"
    kept, excluded_batches, excluded = [], [], 0
    for ev in trace_by_roll.get(e["roll"], []):
        partial = False
        if batches and ev["batch"] in batches:
            pass
        elif not ev["batch"] or not batches:
            d = date_part(ev["date"])
            if not d or d < lo or d > hi:
                continue
            partial = True
        else:
            excluded += 1
            if ev["batch"] not in excluded_batches:
                excluded_batches.append(ev["batch"])
            continue
        x = dict(ev)
        x["partial"] = partial
        x["post"] = bool(ev["date"] and ev["date"] > cutoff)
        kept.append(x)
    kept.sort(key=lambda x: (x["date"] or "", x["row"]))
    return kept, excluded, excluded_batches


# --------------------------------------------------------------------------- diagnostic
def _evd(ev):
    return fmt_date(ev["date"], True)


def _where(ev):
    return ev["equipment"] or ev["to"] or ev["event"]


def diagnose(e, M, P, inv_date, known_locs, cfg):
    """Renvoie un dict diagnostic. M/P = événements MES/physiques retenus (hors post-inventaire)."""
    m, p = e["mes"], e["phys"]
    R = e["roll_display"]
    B = e["batch"] or "?"
    cat = e["category"]
    ev_refs = []

    def D(code, hyp, conf, action, owner, evs=()):
        refs = [x["ref"] for x in evs if x] + [ref(r) for r in (m, p) if r]
        return {"code": code, "hypothesis": hyp, "confidence": conf, "action": action,
                "owner": owner, "evidence": refs}

    def last(evs, types=None, pred=None):
        out = None
        for x in evs:
            if (types is None or x["type"] in types) and (pred is None or pred(x)):
                out = x
        return out

    def first(evs, types=None, pred=None):
        for x in evs:
            if (types is None or x["type"] in types) and (pred is None or pred(x)):
                return x
        return None

    def out_of_scope(loc):
        return bool(loc) and norm_text(loc) not in known_locs

    if cat == "DUP":
        d = e["dup_of"]
        return D("DOUBLON", f"Rouleau compté 2 fois dans {p['src']} (lignes {d['row']} et {p['row']}).",
                 "Élevée", f"Supprimer la ligne {p['row']} de {p['src']}", "OPS", [])

    if cat == "ONLY_MES":
        pc = last(P, ("CONSOMMATION", "REBUT"))
        if pc and not any(x["type"] == pc["type"] for x in M):
            if pc["type"] == "CONSOMMATION":
                return D("CONSO_NON_DECLAREE",
                         f"Consommation constatée physiquement le {_evd(pc)} ({_where(pc)}) mais non déclarée dans MES : le rouleau est resté en stock MES.",
                         "Élevée", f"Déclarer la consommation de {R} / {B} dans MES ({fmt_num(m['qty'])} m)", "MES", [pc])
            return D("REBUT_NON_DECLARE",
                     f"Rebut constaté physiquement le {_evd(pc)} ({pc['event']}) mais non déclaré dans MES.",
                     "Élevée", f"Déclarer le rebut de {R} / {B} dans MES ({fmt_num(m['qty'])} m)", "MES", [pc])
        pd = last(P, pred=lambda x: bool(x["to"]))
        if pd and out_of_scope(pd["to"]):
            return D("HORS_ZONE",
                     f"Transféré physiquement vers {pd['to']} le {_evd(pd)} ({pd['event']}) : hors des zones inventoriées.",
                     "Moyenne", f"Vérifier la présence de {R} en {pd['to']} ; mettre à jour l'emplacement MES ou intégrer la zone au comptage", "OPS", [pd])
        if not P:
            if m["date"] and days_between(m["date"], inv_date) >= int(cfg.get("stale_days", 21)):
                n = days_between(m["date"], inv_date)
                return D("STOCK_FANTOME",
                         f"Aucune trace physique et aucun mouvement MES depuis {n} jours ({fmt_date(m['date'])}) : stock fantôme probable.",
                         "Moyenne", f"Recomptage ciblé de {R}, puis sortie de stock MES s'il reste introuvable", "CTRL", [])
            return D("NON_COMPTE", "Aucune trace physique récente : rouleau possiblement oublié au comptage.",
                     "Faible", f"Recomptage ciblé de {R}", "OPS", [])
        lp = P[-1]
        return D("INDETERMINE",
                 f"Traces physiques présentes (dernier événement : {lp['event']} le {_evd(lp)}) mais sans sortie constatée.",
                 "Faible", "Analyser en réunion : vérifier l'étiquette et l'emplacement réel", "CTRL", [lp])

    if cat == "ONLY_PHYS":
        mc = last(M, ("CONSOMMATION", "REBUT"))
        if mc:
            lab = EVENT_LABELS[mc["type"]]
            pr = first(P, ("RETOUR",), lambda x: (x["date"] or "") >= (mc["date"] or ""))
            if pr:
                return D("RETOUR_NON_DECLARE",
                         f"MES a enregistré « {mc['event']} » ({lab}) le {_evd(mc)} ({_where(mc)}), mais le rouleau est revenu en stock physiquement le {_evd(pr)} ({pr['event']}) : retour non déclaré dans MES.",
                         "Élevée", f"Déclarer le retour en stock de {R} / {B} dans MES (annuler « {mc['event']} »)", "MES", [mc, pr])
            who = f", saisie {mc['user']}" if mc["user"] else ""
            return D("SORTIE_MES_A_TORT",
                     f"MES a enregistré « {mc['event']} » ({lab}) le {_evd(mc)} ({_where(mc)}{who}) alors que le rouleau a été compté physiquement.",
                     "Moyenne", f"Vérifier l'étiquette de {R} ; si confirmé, annuler « {mc['event']} » dans MES", "MES", [mc])
        if not M:
            if e.get("excluded_mes", 0) > 0 and e["batch"]:
                ob = e.get("excluded_batches", [])
                lst = ", ".join(ob[:3]) + ("…" if len(ob) > 3 else "")
                return D("BATCH_INCONNU_MES",
                         f"Aucun mouvement MES pour le batch {B} ; le corps {R} apparaît dans MES sous {len(ob)} autre(s) batch ({lst}) : production non déclarée ou batch mal relevé.",
                         "Moyenne", f"Relire le batch sur l'étiquette de {R} ; si correct, déclarer la production dans MES", "OPS", [])
            pp = first(P, ("PRODUCTION",))
            if pp:
                return D("PROD_NON_DECLAREE",
                         f"Aucun mouvement MES pour ce rouleau, alors que sa production est tracée physiquement le {_evd(pp)} ({_where(pp)}) : production non déclarée dans MES.",
                         "Élevée", f"Déclarer la production de {R} / {B} dans MES ({fmt_num(p['qty'])} m)", "MES", [pp])
            return D("PROD_NON_DECLAREE", "Aucun mouvement MES ni trace physique de production pour ce rouleau.",
                     "Moyenne", f"Déclarer la production de {R} / {B} dans MES après vérification de l'étiquette", "MES", [])
        md = last(M, pred=lambda x: bool(x["to"]))
        if md and out_of_scope(md["to"]):
            return D("EMPLACEMENT_MES",
                     f"MES situe le rouleau en {md['to']} depuis le {_evd(md)} ({md['event']}) : hors du périmètre de l'extraction MES.",
                     "Moyenne", f"Corriger l'emplacement de {R} dans MES", "MES", [md])
        lm = M[-1]
        return D("INDETERMINE",
                 f"Présent dans la trace MES (dernier événement : {lm['event']} le {_evd(lm)}) mais absent de l'extraction d'inventaire MES.",
                 "Faible", "Analyser en réunion : vérifier le périmètre de l'extraction MES", "CTRL", [lm])

    if cat == "AMBIG":
        cands = e["candidates"]
        stale_n = int(cfg.get("stale_days", 21))
        stale = [c for c in cands if c["date"] and days_between(c["date"], inv_date) >= stale_n]
        fresh = [c for c in cands if c not in stale]
        lst = ", ".join(c["batch"] for c in cands)
        head = (f"Batch relevé {p['batch']} inconnu de MES et" if p["batch"] else "Batch non renseigné et")
        hyp = f"{head} {len(cands)} batches MES en stock sur le corps {R} ({lst})."
        if stale and len(fresh) == 1:
            f0 = fresh[0]
            same = (p["qty"] is not None and f0["qty"] is not None and within_tol(p["qty"] - f0["qty"], f0["qty"], cfg))
            olds = ", ".join(s["batch"] for s in stale)
            hyp += (f" Le(s) batch(es) {olds} n'ont plus bougé depuis plus de {stale_n} jours : reliquat MES probable d'un cycle précédent (corps réutilisé)."
                    f" Candidat le plus probable : {f0['batch']}" + (" (métrage identique)." if same else "."))
            return D("AMBIGU", hyp, "Moyenne",
                     f"Relever le batch sur l'étiquette de {R} ; si {f0['batch']}, valider et sortir {olds} du stock MES", "CTRL", [])
        return D("AMBIGU", hyp, "Faible", f"Relever le batch sur l'étiquette de {R} et choisir le bon candidat", "OPS", [])

    # --- catégories avec une paire MES / physique
    delta = e["delta"]
    len_note = ""
    if delta is not None:
        len_note = (" Métrage cohérent." if within_tol(delta, m["qty"], cfg)
                    else f" Écart de métrage : {fmt_signed(delta)} m.")

    if cat == "BATCH_DIFF":
        pb, mb = p["batch"], m["batch"]
        dist = levenshtein(pb, mb)
        detail = ("inversion de chiffres" if sorted(pb) == sorted(mb) and len(pb) == len(mb)
                  else f"{dist} caractère(s) de différence")
        conf = "Élevée" if dist <= 2 and delta is not None and within_tol(delta, m["qty"], cfg) else "Moyenne"
        return D("BATCH_SAISIE",
                 f"Batch relevé {pb} vs MES {mb} ({detail}) sur le même corps {R} : erreur de saisie probable.{len_note}",
                 conf, f"Valider la correspondance puis corriger le batch dans {p['src']} (ligne {p['row']})", "CTRL", [])

    if cat == "PROBABLE":
        ok = delta is not None and within_tol(delta, m["qty"], cfg)
        return D("BATCH_MANQUANT",
                 f"Batch non renseigné dans l'inventaire physique ; un seul candidat MES sur le corps {R} : batch {m['batch']}.{len_note}",
                 "Moyenne" if ok else "Faible",
                 f"Valider la correspondance ; faire compléter le batch dans {p['src']} (ligne {p['row']})", "CTRL", [])

    if cat == "STEP":
        pr_m = last(M, ("PRODUCTION",))
        pr_p = last(P, ("PRODUCTION",))
        later = pr_p and (not pr_m or (pr_p["date"] or "") > (pr_m["date"] or ""))
        extra = f" Dernière opération physique : {pr_p['event']} le {_evd(pr_p)} ({_where(pr_p)}), absente de MES." if later else ""
        dn = f" Écart de métrage associé : {fmt_signed(delta)} m." if delta is not None and not within_tol(delta, m["qty"], cfg) else ""
        return D("ETAPE_NON_DECLAREE",
                 f"MES : {m['perimeter']} / physique : {p['perimeter']}.{extra} Avancement d'étape non déclaré dans MES.{dn}",
                 "Élevée" if later else "Moyenne",
                 f"Déclarer dans MES l'opération manquante pour {R} / {B} ({m['perimeter']} → {p['perimeter']})", "MES",
                 [pr_p] if later else [])

    if cat in ("LEN", "OK"):
        if cat == "OK":
            return None
        qm, qp = m["qty"], p["qty"]
        if qm is None or qp is None:
            return D("SAISIE_UNITE", f"Métrage illisible (MES : {m['qty_raw'] or 'vide'} / physique : {p['qty_raw'] or 'vide'}).",
                     "Élevée", f"Corriger le métrage dans {p['src']} (ligne {p['row']})", "OPS", [])
        if qm > 0 and qp > 0:
            r = max(qm, qp) / min(qm, qp)
            for k in (10, 100, 1000):
                if abs(r / k - 1) <= 0.03:
                    return D("SAISIE_UNITE",
                             f"Métrage physique {fmt_num(qp)} m vs MES {fmt_num(qm)} m (facteur {k}) : erreur de saisie ou d'unité probable.",
                             "Élevée", f"Corriger le métrage dans {p['src']} (ligne {p['row']})", "OPS", [])
        mtypes = {x["type"] for x in M}
        ps = [x for x in P if x["type"] in ("PRELEVEMENT", "CONSOMMATION", "REBUT") and x["type"] not in mtypes and x["qty"] is not None]
        s = sum(x["qty"] for x in ps)
        tol = tol_value(qm, cfg)
        if delta < 0 and ps and abs(s - abs(delta)) <= tol + 1e-9:
            x0 = ps[-1]
            lab = EVENT_LABELS[x0["type"]]
            return D("PRELEVEMENT_NON_DECLARE",
                     f"{lab[0].upper() + lab[1:]} de {fmt_num(s)} m constaté(e) physiquement le {_evd(x0)} ({x0['event']}) mais non déclaré(e) dans MES.",
                     "Élevée", f"Ajuster la quantité MES de {R} / {B} : {fmt_signed(delta)} m", "MES", ps)
        ptypes = {x["type"] for x in P}
        ms = [x for x in M if x["type"] in ("AJUSTEMENT", "PRELEVEMENT") and x["type"] not in ptypes and x["qty"] is not None]
        s2 = sum(x["qty"] for x in ms)
        if delta > 0 and ms and abs(s2 - delta) <= tol + 1e-9:
            x0 = ms[-1]
            return D("AJUSTEMENT_MES",
                     f"MES a enregistré « {x0['event']} » de {fmt_num(s2)} m le {_evd(x0)}, non constaté physiquement.",
                     "Moyenne", f"Vérifier le mouvement MES et le métrage réel de {R}", "MES", ms)
        pct = abs(delta) / qm * 100 if qm else 0
        return D("ECART_INEXPLIQUE",
                 f"Écart de {fmt_signed(delta)} m ({fmt_num(pct)} %) non expliqué par les traces MES et physique.",
                 "Faible", f"Re-mesurer {R} (compteur machine vs saisie) avant toute correction", "OPS", [])
    return None


def levenshtein(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


# --------------------------------------------------------------------------- orchestration
def run(tables, cfg, decisions=None, baseline=None):
    """tables = {role: [ {name, rows}, ... ]}. baseline = analyse précédente {name, id, snapshot} (optionnel).
    Renvoie le résultat complet (dict sérialisable)."""
    data, infos = {}, []
    for role in ("mes_inv", "phys_inv", "mes_trace", "phys_trace"):
        data[role] = []
        for t in tables.get(role, []):
            recs, info = load_table(t, role, cfg)
            data[role].extend(recs)
            infos.append(info)

    inv_date = cfg.get("inventory_date") or ""
    if not inv_date:
        ds = [r["date"] for r in data["phys_inv"] if r["date"]]
        inv_date = max(ds)[:10] if ds else datetime.now().strftime("%Y-%m-%d")
    inv_date = inv_date[:10]

    entries = reconcile(data["mes_inv"], data["phys_inv"], cfg, decisions)
    entries.sort(key=entry_sort_key)

    known = set(norm_text(x) for x in (cfg.get("in_scope_locations") or []))
    known |= {norm_text(r["location"]) for r in data["mes_inv"] + data["phys_inv"] if r["location"]}

    mes_by_roll, phys_by_roll = {}, {}
    for ev in trace_events(data["mes_trace"], "MES"):
        mes_by_roll.setdefault(ev["roll"], []).append(ev)
    for ev in trace_events(data["phys_trace"], "Physique"):
        phys_by_roll.setdefault(ev["roll"], []).append(ev)

    prefixes = cfg.get("roll_prefixes") or []
    disp = {}
    for r in data["mes_inv"] + data["mes_trace"]:
        disp.setdefault(r["roll"], r["roll_raw"])
    for e in entries:
        e["roll_display"] = disp.get(e["roll"]) or pretty_roll(e["roll_display"], prefixes)

    n = 0
    for e in entries:
        if e["category"] == "OK":
            e["ref_id"] = None
        else:
            n += 1
            e["ref_id"] = f"E{n:02d}"
        e_inv = date_part(e["phys"]["date"]) if e["phys"] and e["phys"]["date"] else inv_date
        e["inv_date"] = e_inv
        tm, exm, exb = collect_trace(e, mes_by_roll, e_inv, cfg)
        tp, _, _ = collect_trace(e, phys_by_roll, e_inv, cfg)
        e["trace_mes"], e["trace_phys"] = tm, tp
        e["excluded_mes"], e["excluded_batches"] = exm, exb
        if e["category"] == "OK" and not e.get("validated"):
            e["diag"] = None
            continue
        M = [x for x in tm if not x["post"]]
        P = [x for x in tp if not x["post"]]
        e["diag"] = diagnose(e, M, P, e_inv, known, cfg)
        if e.get("validated") == "accept" and e.get("was") in ("BATCH_DIFF", "PROBABLE", "AMBIG"):
            e.setdefault("extra_actions", []).append({
                "code": "CORRIGER_BATCH", "owner": "OPS",
                "action": f"Corriger/compléter le batch de {e['roll_display']} dans {e['phys']['src']} (ligne {e['phys']['row']}) : {e['mes']['batch']}",
            })

    result = {
        "version": VERSION, "inventory_date": inv_date, "sources": infos,
        "counts": {"mes_inv": len(data["mes_inv"]), "phys_inv": len(data["phys_inv"]),
                   "mes_trace": len(data["mes_trace"]), "phys_trace": len(data["phys_trace"])},
        "entries": entries,
    }
    result["summary"] = summarize(result, cfg)
    result["evolution"] = compare(baseline, result) if baseline and baseline.get("snapshot") else None
    result["snapshot"] = make_snapshot(result)
    return result


# --------------------------------------------------------------------------- synthèse
def _meters(e):
    if e["delta"] is not None and e["category"] != "OK":
        return abs(e["delta"])
    if e["category"] == "ONLY_MES" and e["mes"] and e["mes"]["qty"] is not None:
        return e["mes"]["qty"]
    if e["category"] == "ONLY_PHYS" and e["phys"] and e["phys"]["qty"] is not None:
        return e["phys"]["qty"]
    return 0.0


def pl(n, s, p):
    return p if n > 1 else s


def _pct(a, b):
    return int(math.floor(a * 100 / b + 0.5)) if b else 0


def _list_rolls(es, n=4):
    items = [f"{e['roll_display']} [{e['ref_id']}]" for e in es]
    return ", ".join(items[:n]) + (f" +{len(items) - n}" if len(items) > n else "")


def summarize(result, cfg):
    entries = result["entries"]
    owners = cfg.get("owners") or {}
    ok = [e for e in entries if e["category"] == "OK"]
    gaps = [e for e in entries if e["category"] != "OK"]
    to_val = [e for e in gaps if e["category"] in TO_VALIDATE]
    total_m = sum(_meters(e) for e in gaps)
    n_pairs = len(entries)
    phys_files = [s["name"] for s in result["sources"] if s["role"] == "phys_inv"]
    kpis = {
        "compared": n_pairs, "ok": len(ok), "gaps": len(gaps), "to_validate": len(to_val),
        "gap_meters": round1(total_m), "ok_pct": _pct(len(ok), n_pairs),
        "high_conf": sum(1 for e in gaps if e.get("diag") and e["diag"]["confidence"] == "Élevée"),
    }
    diffs = []
    diffs.append(
        f"{result['counts']['phys_inv']} lignes d'inventaire physique ({len(phys_files)} fichier{'s' if len(phys_files) > 1 else ''}) rapprochées de "
        f"{result['counts']['mes_inv']} lignes MES au {fmt_date(result['inventory_date'])} : {len(ok)} rouleaux conformes "
        f"({kpis['ok_pct']} %), {len(gaps)} écarts portant sur {fmt_num(total_m)} m"
        + (f", dont {len(to_val)} correspondances à valider." if to_val else "."))

    def codes_breakdown(es):
        cnt = {}
        for e in es:
            if e.get("diag"):
                c = e["diag"]["code"]
                cnt[c] = cnt.get(c, 0) + 1
        parts = sorted(cnt.items(), key=lambda kv: (-kv[1], FAMILY_ORDER.get(kv[0], 99)))
        return "; ".join(f"{v} × {CODE_SHORT.get(k, k)}" for k, v in parts)

    groups = [
        ("ONLY_MES", ("rouleau présent dans MES mais absent du comptage physique",
                      "rouleaux présents dans MES mais absents du comptage physique")),
        ("ONLY_PHYS", ("rouleau compté physiquement mais absent de l'inventaire MES",
                       "rouleaux comptés physiquement mais absents de l'inventaire MES")),
        ("LEN", ("écart de métrage au-delà de la tolérance", "écarts de métrage au-delà de la tolérance")),
        ("STEP", ("rouleau à une étape différente entre MES et physique", "rouleaux à une étape différente entre MES et physique")),
    ]
    for cat, label in groups:
        es = [e for e in gaps if e["category"] == cat]
        if not es:
            continue
        m = sum(_meters(e) for e in es)
        diffs.append(f"{len(es)} {label[len(es) > 1]} ({fmt_num(m)} m) — {codes_breakdown(es)} : {_list_rolls(es)}.")
    unc = [e for e in gaps if e["category"] in TO_VALIDATE]
    if unc:
        diffs.append(f"{len(unc)} {pl(len(unc), 'correspondance incertaine', 'correspondances incertaines')} faute de batch fiable — {codes_breakdown(unc)} : {_list_rolls(unc)}.")
    dups = [e for e in gaps if e["category"] == "DUP"]
    if dups:
        diffs.append(f"{len(dups)} {pl(len(dups), 'doublon', 'doublons')} de comptage dans l'inventaire physique : {_list_rolls(dups)}.")

    top = sorted([e for e in gaps if _meters(e) > 0], key=lambda e: (-_meters(e), e["ref_id"]))[:3]
    if top:
        diffs.append("Plus gros écarts : " + ", ".join(
            f"{e['roll_display']} ({fmt_num(_meters(e))} m, {CAT_LABEL[e['category']][0].lower() + CAT_LABEL[e['category']][1:]})" for e in top) + ".")

    per = {}
    for e in entries:
        s = per.setdefault(e["perimeter"], [0, 0])
        s[0] += 1
        if e["category"] != "OK":
            s[1] += 1
    if per and gaps:
        worst = sorted(per.items(), key=lambda kv: (-(kv[1][1] / kv[1][0]), -kv[1][1], kv[0]))[0]
        diffs.append(f"Périmètre le plus touché : {worst[0]} ({worst[1][1]} {pl(worst[1][1], 'écart', 'écarts')} sur {worst[1][0]} rouleaux, "
                     f"{_pct(worst[1][1], worst[1][0])} %).")

    q = []
    for s in result["sources"]:
        if s["role"] != "phys_inv":
            continue
        bits = []
        if s["no_batch"]:
            bits.append(f"batch vide sur {s['no_batch']}/{s['records']} lignes")
        if s["roll_shapes"] > 1:
            bits.append(f"n° de rouleau saisis sous {s['roll_shapes']} formats différents")
        if s["bad_qty"]:
            bits.append(f"{s['bad_qty']} métrage(s) illisible(s)")
        if bits:
            q.append(f"{s['name']} : " + ", ".join(bits))
    if q:
        diffs.append("Qualité des sources physiques — " + " ; ".join(q) + " (formats normalisés automatiquement).")
    excl = sum(e.get("excluded_mes", 0) for e in gaps)
    reused = sum(1 for e in gaps if e.get("excluded_mes", 0) > 0)
    if excl:
        diffs.append(f"Corps réutilisés : {excl} mouvements MES écartés sur {reused} {pl(reused, 'écart', 'écarts')} car ils portent sur d'autres batches "
                     f"du même corps — la double clé rouleau + batch est indispensable.")

    # --- actions groupées par responsable
    fam = {}
    for e in gaps:
        d = e.get("diag")
        if d:
            fam.setdefault((d["owner"], d["code"]), []).append((e, d["action"]))
    for e in entries:
        for xa in e.get("extra_actions", []):
            fam.setdefault((xa["owner"], xa["code"]), []).append((e, xa["action"]))
    actions = []
    keys = sorted(fam.keys(), key=lambda k: (OWNER_ORDER.index(k[0]) if k[0] in OWNER_ORDER else 9,
                                             -len(fam[k]), FAMILY_ORDER.get(k[1], 99)))
    for owner, code in keys:
        items = fam[(owner, code)]
        lst = ", ".join(f"{e['roll_display']}/{e['batch'] or '?'}" + (f" [{e['ref_id']}]" if e.get("ref_id") else "") for e, _ in items)
        actions.append({
            "owner": owners.get(owner, owner), "owner_key": owner, "code": code,
            "label": FAMILY_LABEL.get(code, code), "count": len(items),
            "text": f"{owners.get(owner, owner)} — {FAMILY_LABEL.get(code, code)} ({len(items)}) : {lst}.",
            "refs": [e.get("ref_id") for e, _ in items],
        })
    nb = sum(s["no_batch"] for s in result["sources"] if s["role"] == "phys_inv")
    if nb:
        txt = (f"{owners.get('OPS', 'OPS')} — Rendre le n° de batch obligatoire dans les fichiers d'inventaire physique "
               f"({nb} {pl(nb, 'ligne', 'lignes')} sans batch) : sans double clé, le rapprochement reste manuel.")
        actions.append({"owner": owners.get("OPS", "OPS"), "owner_key": "OPS", "code": "STRUCTUREL",
                        "label": "Fiabiliser la saisie du batch", "count": nb, "text": txt, "refs": []})
    return {"kpis": kpis, "differences": diffs, "actions": actions}


# --------------------------------------------------------------------------- historique / comparaison
def gap_keys(entries):
    """Clé stable par ligne de rapprochement (rouleau|batch, suffixée pour doublons). Ordre = ordre des entrées."""
    out, seen = [], {}
    for e in entries:
        k = f"{e['roll']}|{e['batch'] or ''}" + ("#DUP" if e["category"] == "DUP" else "")
        n = seen.get(k, 0) + 1
        seen[k] = n
        out.append(k if n == 1 else f"{k}#{n}")
    return out


def make_snapshot(result):
    """Résumé compact et stable d'une analyse, conservé dans l'historique et utilisé pour les comparaisons."""
    keys = gap_keys(result["entries"])
    gaps, ok = [], []
    for k, e in zip(keys, result["entries"]):
        if e["category"] == "OK":
            ok.append(k)
            continue
        d = e.get("diag") or {}
        h = e.get("history") or {}
        gaps.append({
            "key": k, "ref_id": e.get("ref_id"), "category": e["category"], "code": d.get("code"),
            "owner": d.get("owner"), "roll": e["roll"], "roll_display": e["roll_display"], "batch": e["batch"],
            "perimeter": e["perimeter"], "delta": e["delta"], "meters": round1(_meters(e)),
            "first_seen": h.get("first_seen") or result["inventory_date"], "occurrences": h.get("occurrences") or 1,
        })
    return {"inventory_date": result["inventory_date"], "kpis": result["summary"]["kpis"], "gaps": gaps, "ok_keys": ok}


def compare(baseline, result):
    """Compare le résultat courant à une analyse précédente. Annote chaque écart courant (e['history'])."""
    snap = baseline["snapshot"]
    prev = {g["key"]: g for g in snap["gaps"]}
    prev_ok = set(snap.get("ok_keys") or [])
    keys = gap_keys(result["entries"])
    cur_gap_keys, cur_ok = set(), set()
    new, persistent = [], []
    for k, e in zip(keys, result["entries"]):
        if e["category"] == "OK":
            cur_ok.add(k)
            e["history"] = {"status": "ok", "was_gap": k in prev}
            continue
        cur_gap_keys.add(k)
        g = prev.get(k)
        if g:
            changes = []
            if g["category"] != e["category"]:
                changes.append(f"{CAT_LABEL[g['category']]} → {CAT_LABEL[e['category']]}")
            if g.get("delta") is not None and e["delta"] is not None and abs(g["delta"] - e["delta"]) > 0.05:
                changes.append(f"Δ {fmt_signed(g['delta'])} → {fmt_signed(e['delta'])} m")
            e["history"] = {"status": "persistent", "first_seen": g.get("first_seen") or snap["inventory_date"],
                            "occurrences": (g.get("occurrences") or 1) + (1 if result["inventory_date"] != snap["inventory_date"] else 0),
                            "prev_ref": g.get("ref_id"),
                            "changes": changes}
            persistent.append(e)
        else:
            e["history"] = {"status": "new", "first_seen": result["inventory_date"], "occurrences": 1,
                            "was_ok": k in prev_ok, "changes": []}
            new.append(e)
    resolved = []
    for g in snap["gaps"]:
        if g["key"] not in cur_gap_keys:
            r = dict(g)
            r["outcome"] = "now_ok" if g["key"] in cur_ok else "absent"
            resolved.append(r)
    prev_m = snap["kpis"].get("gap_meters") or 0
    cur_m = result["summary"]["kpis"]["gap_meters"]
    name = baseline.get("name") or "analyse précédente"
    ev = {
        "baseline": {"id": baseline.get("id"), "name": name, "inventory_date": snap["inventory_date"]},
        "counts": {"new": len(new), "persistent": len(persistent), "resolved": len(resolved),
                   "resolved_ok": sum(1 for r in resolved if r["outcome"] == "now_ok"),
                   "regressions": sum(1 for e in new if e["history"]["was_ok"])},
        "meters": {"before": prev_m, "after": cur_m},
        "resolved": resolved,
        "new_refs": [e["ref_id"] for e in new], "persistent_refs": [e["ref_id"] for e in persistent],
    }
    ev["bullets"] = evolution_bullets(ev, new, persistent, resolved)
    return ev


def evolution_bullets(ev, new, persistent, resolved):
    c, b = ev["counts"], ev["baseline"]
    out = [f"Par rapport à « {b['name']} » (inventaire du {fmt_date(b['inventory_date'])}) : "
           f"{c['new']} {pl(c['new'], 'nouvel écart', 'nouveaux écarts')}, {c['resolved']} {pl(c['resolved'], 'résolu', 'résolus')}, "
           f"{c['persistent']} {pl(c['persistent'], 'persistant', 'persistants')} ; métrage en écart "
           f"{fmt_num(ev['meters']['before'])} → {fmt_num(ev['meters']['after'])} m "
           f"({fmt_signed(ev['meters']['after'] - ev['meters']['before'])} m)."]
    if resolved:
        n_ok = c["resolved_ok"]
        n_abs = len(resolved) - n_ok
        parts = []
        if n_ok:
            parts.append(f"{n_ok} {pl(n_ok, 'désormais conforme', 'désormais conformes')}")
        if n_abs:
            parts.append(f"{n_abs} {pl(n_abs, 'qui n’apparaît plus', 'qui n’apparaissent plus')} (consommé, doublon supprimé…)")
        lst = ", ".join(r["roll_display"] for r in resolved[:5]) + (f" +{len(resolved) - 5}" if len(resolved) > 5 else "")
        out.append(f"Résolus : {' et '.join(parts)} — {lst}.")
    if persistent:
        groups = {}
        for e in sorted(persistent, key=lambda e: (-e["history"]["occurrences"], e["history"]["first_seen"], e["ref_id"])):
            groups.setdefault((e["history"]["occurrences"], e["history"]["first_seen"]), []).append(e)
        parts = []
        for (occ, first), es in list(groups.items())[:3]:
            lst = ", ".join(f"{e['roll_display']} [{e['ref_id']}]" for e in es[:4]) + (f" +{len(es) - 4}" if len(es) > 4 else "")
            parts.append(f"depuis le {fmt_date(first)} ({occ} {pl(occ, 'inventaire', 'inventaires')}) : {lst}")
        ch = sum(1 for e in persistent if e["history"]["changes"])
        out.append(f"Persistants ({len(persistent)}), les plus anciens d'abord — " + " ; ".join(parts)
                   + (" ; …" if len(groups) > 3 else "") + (f" — {ch} {pl(ch, 'a changé', 'ont changé')} depuis." if ch else "."))
    if new:
        lst = ", ".join(f"{e['roll_display']} [{e['ref_id']}]" for e in new[:5]) + (f" +{len(new) - 5}" if len(new) > 5 else "")
        reg = c["regressions"]
        out.append(f"Nouveaux : {lst}" + (f" — dont {reg} {pl(reg, 'rouleau conforme', 'rouleaux conformes')} à l'analyse précédente." if reg else "."))
    return out


CODE_SHORT = {
    "CONSO_NON_DECLAREE": "consommation non déclarée dans MES",
    "REBUT_NON_DECLARE": "rebut non déclaré dans MES",
    "RETOUR_NON_DECLARE": "retour en stock non déclaré dans MES",
    "SORTIE_MES_A_TORT": "sortie MES contredite par le comptage",
    "PROD_NON_DECLAREE": "production non déclarée dans MES",
    "PRELEVEMENT_NON_DECLARE": "prélèvement/découpe non déclaré",
    "ETAPE_NON_DECLAREE": "étape non déclarée dans MES",
    "EMPLACEMENT_MES": "emplacement MES hors périmètre",
    "AJUSTEMENT_MES": "ajustement MES non constaté",
    "HORS_ZONE": "transfert hors zone inventoriée",
    "STOCK_FANTOME": "stock fantôme MES probable",
    "NON_COMPTE": "possiblement non compté",
    "SAISIE_UNITE": "erreur de saisie/unité",
    "ECART_INEXPLIQUE": "écart inexpliqué",
    "BATCH_INCONNU_MES": "batch inconnu de MES (corps réutilisé)",
    "DOUBLON": "doublon",
    "BATCH_SAISIE": "batch mal saisi probable",
    "BATCH_MANQUANT": "batch manquant, 1 candidat",
    "AMBIGU": "plusieurs candidats MES",
    "INDETERMINE": "indéterminé",
}
