"""Exports : rapport Excel (dossier de réunion), brief Markdown, vue JSON compacte."""
from __future__ import annotations

import json
from datetime import datetime

from .engine import CAT_LABEL, TO_VALIDATE, fmt_date, fmt_num, fmt_signed, ROLE_LABELS, EVENT_LABELS, _meters as _m

OWNER_FALLBACK = {"MES": "MES", "OPS": "Ops", "CTRL": "Contrôle"}


def owner_label(cfg, k):
    return (cfg.get("owners") or {}).get(k, OWNER_FALLBACK.get(k, k))


def _ev_text(ev):
    bits = [ev["event"] or "?"]
    if ev["equipment"]:
        bits.append(ev["equipment"])
    if ev["to"]:
        bits.append("→ " + ev["to"])
    if ev["comment"]:
        bits.append(f"« {ev['comment']} »")
    t = " · ".join(bits)
    if ev.get("partial"):
        t += " (clé partielle : batch absent)"
    if ev.get("post"):
        t += " (après inventaire)"
    return t


def suivi(e):
    h = e.get("history") or {}
    st = h.get("status")
    if st == "new":
        return "Nouveau" + (" (était conforme)" if h.get("was_ok") else "")
    if st == "persistent":
        t = f"Persistant · {h['occurrences']} inventaire(s) depuis le {fmt_date(h['first_seen'])}"
        return t + (" · " + " ; ".join(h["changes"]) if h.get("changes") else "")
    return ""


def merged_timeline(e):
    evs = [dict(x, side="MES") for x in e["trace_mes"]] + [dict(x, side="PHY") for x in e["trace_phys"]]
    evs.sort(key=lambda x: (x["date"] or "", 0 if x["side"] == "MES" else 1, x["row"]))
    return evs


# --------------------------------------------------------------------------- JSON compact (parité)
def compact(result):
    out = {"inventory_date": result["inventory_date"], "counts": result["counts"], "entries": [],
           "summary": result["summary"], "evolution": result.get("evolution"), "snapshot": result.get("snapshot"),
           "sources": [{k: s[k] for k in ("name", "role", "header_row", "mapping", "missing", "records",
                                          "no_batch", "roll_shapes")} for s in result["sources"]]}
    for e in result["entries"]:
        d = e.get("diag") or {}
        out["entries"].append({
            "ref_id": e.get("ref_id"), "uid": e["uid"], "category": e["category"], "roll": e["roll"],
            "batch": e["batch"], "perimeter": e["perimeter"],
            "delta": None if e["delta"] is None else round(e["delta"], 3),
            "code": d.get("code"), "confidence": d.get("confidence"), "owner": d.get("owner"),
            "hypothesis": d.get("hypothesis"), "action": d.get("action"), "evidence": d.get("evidence"),
            "trace_mes": [x["ref"] for x in e["trace_mes"]], "trace_phys": [x["ref"] for x in e["trace_phys"]],
            "excluded_mes": e["excluded_mes"],
            "decision_key": e.get("decision_key"), "stale_decision": e.get("stale_decision"), "history": e.get("history"),
        })
    return out


# --------------------------------------------------------------------------- Markdown
def to_markdown(result, cfg):
    s = result["summary"]
    k = s["kpis"]
    L = [f"# Préparation réunion — rapprochement inventaire physique / MES",
         f"",
         f"Inventaire du **{fmt_date(result['inventory_date'])}** · généré le {datetime.now():%d/%m/%Y %H:%M} · "
         f"{k['compared']} rouleaux · {k['ok']} conformes ({k['ok_pct']} %) · **{k['gaps']} écarts** ({fmt_num(k['gap_meters'])} m)"
         f" · {k['to_validate']} à valider",
         ""]
    ev = result.get("evolution")
    if ev:
        L += ["## Évolution depuis l'analyse précédente", ""] + [f"- {b}" for b in ev["bullets"]] + [""]
    L += ["## Grandes différences", ""]
    L += [f"- {d}" for d in s["differences"]]
    L += ["", "## Actions à mener", ""]
    L += [f"- {a['text']}" for a in s["actions"]]
    L += ["", "## Dossier de traçabilité par écart", ""]
    for e in result["entries"]:
        if e["category"] == "OK" and not e.get("validated"):
            continue
        d = e.get("diag") or {}
        m, p = e["mes"], e["phys"]
        L.append(f"### {e.get('ref_id') or '—'} · {e['roll_display']} / {e['batch'] or '?'} — {CAT_LABEL[e['category']]}")
        L.append("")
        if suivi(e):
            L.append(f"- Suivi : {suivi(e)}")
        L.append(f"- Périmètre : {e['perimeter']} · MES : {fmt_num(m['qty']) if m else '—'} m · "
                 f"Physique : {fmt_num(p['qty']) if p else '—'} m · Δ : {fmt_signed(e['delta'])} m")
        if d:
            L.append(f"- **Hypothèse ({d['confidence'].lower()})** : {d['hypothesis']}")
            L.append(f"- **Action** : {d['action']} → {owner_label(cfg, d['owner'])}")
            L.append(f"- Sources : {', '.join(d['evidence'])}")
        if e.get("candidates"):
            L.append("- Candidats MES : " + "; ".join(
                f"{c['batch']} ({fmt_num(c['qty'])} m, dernier mvt {fmt_date(c['date'])})" for c in e["candidates"]))
        if e["excluded_mes"]:
            L.append(f"- {e['excluded_mes']} mouvement(s) MES écarté(s) : autres batches du même corps ({', '.join(e['excluded_batches'][:5])})")
        L.append("")
        tl = merged_timeline(e)
        if tl:
            L.append("| Date | Trace MES | Trace physique |")
            L.append("|---|---|---|")
            for ev in tl:
                cell = f"{_ev_text(ev)} · {fmt_num(ev['qty'])} m · `{ev['ref']}`"
                L.append(f"| {fmt_date(ev['date'], True)} | {cell if ev['side'] == 'MES' else ''} | {cell if ev['side'] == 'PHY' else ''} |")
        else:
            L.append("_Aucune trace trouvée dans les fichiers fournis._")
        L.append("")
    return "\n".join(L)


# --------------------------------------------------------------------------- Excel
def to_excel(result, cfg, path):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    H = Font(bold=True, color="FFFFFF")
    HF = PatternFill("solid", fgColor="1F2937")
    TITLE = Font(bold=True, size=14)
    WRAP = Alignment(wrap_text=True, vertical="top")
    GREY = Font(color="888888", italic=True)
    thin = Side(style="thin", color="D1D5DB")
    BOX = Border(top=thin, bottom=thin, left=thin, right=thin)
    CAT_FILL = {
        "ONLY_MES": "FDE2E2", "ONLY_PHYS": "FDE2E2", "LEN": "FEF3C7", "STEP": "FEF3C7",
        "BATCH_DIFF": "E0E7FF", "PROBABLE": "E0E7FF", "AMBIG": "E0E7FF", "DUP": "F3F4F6", "OK": "DCFCE7",
    }

    def header(ws, row, cols, widths=None):
        for i, c in enumerate(cols, 1):
            cell = ws.cell(row=row, column=i, value=c)
            cell.font, cell.fill, cell.alignment, cell.border = H, HF, WRAP, BOX
        if widths:
            for i, w in enumerate(widths, 1):
                ws.column_dimensions[get_column_letter(i)].width = w

    s = result["summary"]
    k = s["kpis"]
    # ---- Synthèse
    ws = wb.active
    ws.title = "Synthèse"
    ws["A1"] = "Rapprochement inventaire physique / MES — synthèse"
    ws["A1"].font = TITLE
    ws["A2"] = (f"Inventaire du {fmt_date(result['inventory_date'])} · généré le {datetime.now():%d/%m/%Y %H:%M} · "
                f"moteur v{result.get('version', '')}")
    ws["A2"].font = GREY
    kp = [("Rouleaux rapprochés", k["compared"]), ("Conformes", k["ok"]), ("Écarts", k["gaps"]),
          ("Métrage en écart (m)", k["gap_meters"]), ("À valider", k["to_validate"]),
          ("Écarts à hypothèse forte", k["high_conf"])]
    for i, (a, b) in enumerate(kp):
        ws.cell(row=4, column=1 + i, value=a).font = Font(bold=True, size=9, color="555555")
        ws.cell(row=5, column=1 + i, value=b).font = Font(bold=True, size=16)
    r = 7
    ev = result.get("evolution")
    if ev:
        ws.cell(row=r, column=1, value="Évolution depuis l'analyse précédente").font = Font(bold=True, size=12)
        r += 1
        for b in ev["bullets"]:
            ws.cell(row=r, column=1, value="• " + b).alignment = WRAP
            ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=8)
            ws.row_dimensions[r].height = 15 * (1 + len(b) // 120)
            r += 1
        r += 1
    ws.cell(row=r, column=1, value="Grandes différences").font = Font(bold=True, size=12)
    r += 1
    for d in s["differences"]:
        ws.cell(row=r, column=1, value="• " + d).alignment = WRAP
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=8)
        ws.row_dimensions[r].height = 15 * (1 + len(d) // 120)
        r += 1
    r += 1
    ws.cell(row=r, column=1, value="Actions à mener").font = Font(bold=True, size=12)
    r += 1
    for a in s["actions"]:
        ws.cell(row=r, column=1, value="• " + a["text"]).alignment = WRAP
        ws.merge_cells(start_row=r, start_column=1, end_row=r, end_column=8)
        ws.row_dimensions[r].height = 15 * (1 + len(a["text"]) // 120)
        r += 1
    for i in range(1, 9):
        ws.column_dimensions[get_column_letter(i)].width = 22

    # ---- Écarts
    ws = wb.create_sheet("Écarts")
    cols = ["Réf.", "Catégorie", "Suivi", "Périmètre", "Rouleau", "Batch MES", "Batch physique", "Long. MES (m)",
            "Long. physique (m)", "Δ phys − MES (m)", "Hypothèse", "Confiance", "Action", "Responsable",
            "Validation", "Lignes sources", "Mvts MES écartés (autres batches)"]
    header(ws, 1, cols, [6, 22, 22, 18, 14, 13, 13, 11, 11, 11, 60, 10, 45, 22, 11, 40, 12])
    r = 2
    for e in result["entries"]:
        if e["category"] == "OK" and not e.get("validated"):
            continue
        d = e.get("diag") or {}
        m, p = e["mes"], e["phys"]
        vals = [e.get("ref_id"), CAT_LABEL[e["category"]], suivi(e) or None, e["perimeter"], e["roll_display"],
                m["batch"] if m else (", ".join(c["batch"] for c in e.get("candidates") or []) or None),
                p["batch_raw"] if p else None, m["qty"] if m else None, p["qty"] if p else None,
                None if e["delta"] is None else round(e["delta"], 1), d.get("hypothesis"), d.get("confidence"),
                d.get("action"), owner_label(cfg, d["owner"]) if d else None,
                {"accept": "Validée", "reject": "Rejetée"}.get(e.get("validated"), "À valider" if e["category"] in TO_VALIDATE else ""),
                "\n".join(d.get("evidence") or []), e["excluded_mes"] or None]
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=r, column=i, value=v)
            c.alignment, c.border = WRAP, BOX
        ws.cell(row=r, column=2).fill = PatternFill("solid", fgColor=CAT_FILL[e["category"]])
        r += 1
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:{get_column_letter(len(cols))}{max(r - 1, 1)}"

    # ---- Dossier réunion
    ws = wb.create_sheet("Dossier réunion")
    widths = [15, 48, 10, 26, 3, 48, 10, 26]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws["A1"] = "Dossier de traçabilité par écart — trace MES et trace physique côte à côte (ordre chronologique)"
    ws["A1"].font = TITLE
    r = 3
    for e in result["entries"]:
        if e["category"] == "OK" and not e.get("validated"):
            continue
        d = e.get("diag") or {}
        m, p = e["mes"], e["phys"]
        t = (f"{e.get('ref_id') or ''} · {e['roll_display']} / {e['batch'] or '?'} · {CAT_LABEL[e['category']]} · "
             f"{e['perimeter']} · MES {fmt_num(m['qty']) if m else '—'} m / physique {fmt_num(p['qty']) if p else '—'} m")
        c = ws.cell(row=r, column=1, value=t)
        c.font = Font(bold=True, color="FFFFFF")
        for i in range(1, 9):
            ws.cell(row=r, column=i).fill = PatternFill("solid", fgColor="1F2937")
        r += 1
        if d:
            ws.cell(row=r, column=1, value=f"Hypothèse ({d['confidence']})").font = Font(bold=True)
            ws.cell(row=r, column=2, value=d["hypothesis"]).alignment = WRAP
            ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
            ws.row_dimensions[r].height = 15 * (1 + len(d["hypothesis"]) // 140)
            r += 1
            ws.cell(row=r, column=1, value="Action").font = Font(bold=True)
            ws.cell(row=r, column=2, value=f"{d['action']} → {owner_label(cfg, d['owner'])}").alignment = WRAP
            ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
            r += 1
        if e.get("candidates"):
            ws.cell(row=r, column=1, value="Candidats MES").font = Font(bold=True)
            ws.cell(row=r, column=2, value="; ".join(
                f"{c['batch']} ({fmt_num(c['qty'])} m, dernier mvt {fmt_date(c['date'])}, {c['src']}#L{c['row']})"
                for c in e["candidates"]))
            ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
            r += 1
        if e["excluded_mes"]:
            ws.cell(row=r, column=1, value="Écartés").font = GREY
            ws.cell(row=r, column=2, value=f"{e['excluded_mes']} mouvement(s) MES sur d'autres batches du même corps : "
                                           f"{', '.join(e['excluded_batches'])}").font = GREY
            ws.merge_cells(start_row=r, start_column=2, end_row=r, end_column=8)
            r += 1
        for i, h in enumerate(["Date", "Trace MES", "Qté (m)", "Réf. source", "", "Trace physique", "Qté (m)", "Réf. source"], 1):
            cc = ws.cell(row=r, column=i, value=h)
            cc.font = Font(bold=True)
            cc.fill = PatternFill("solid", fgColor="E5E7EB")
        r += 1
        tl = merged_timeline(e)
        if not tl:
            ws.cell(row=r, column=2, value="Aucune trace trouvée dans les fichiers fournis").font = GREY
            r += 1
        for ev in tl:
            ws.cell(row=r, column=1, value=fmt_date(ev["date"], True))
            off = 2 if ev["side"] == "MES" else 6
            c1 = ws.cell(row=r, column=off, value=_ev_text(ev))
            c1.alignment = WRAP
            ws.cell(row=r, column=off + 1, value=ev["qty"])
            ws.cell(row=r, column=off + 2, value=ev["ref"]).font = GREY
            if ev.get("post") or ev.get("partial"):
                c1.font = Font(italic=True, color="92400E")
            r += 1
        r += 1

    # ---- À valider
    ws = wb.create_sheet("À valider")
    header(ws, 1, ["Clé rouleau|batch (ne pas modifier)", "Réf.", "Rouleau", "Batch physique", "Long. physique",
                   "Candidat(s) MES", "Proposition", "Décision (accept / reject / pick:N / n° de batch MES)"],
                   [26, 6, 14, 14, 12, 60, 50, 26])
    r = 2
    seen_keys = set()
    for e in result["entries"]:
        if e["category"] not in TO_VALIDATE and not (e.get("decision_key") and e.get("validated")):
            continue
        if e["decision_key"] in seen_keys:
            continue
        seen_keys.add(e["decision_key"])
        p = e["phys"] or {}
        cands = e.get("candidates") or ([e["mes"]] if e["mes"] else [])
        ctext = "\n".join(f"{i}: {c['batch']} · {fmt_num(c['qty'])} m · dernier mvt {fmt_date(c['date'])}" for i, c in enumerate(cands))
        prop = (e.get("diag") or {}).get("action") if e["category"] in TO_VALIDATE else f"Déjà tranché : {e['decision']}"
        if e.get("stale_decision"):
            prop = f"Décision précédente « {e['stale_decision']} » non applicable (candidats changés). " + (prop or "")
        vals = [e["decision_key"], e.get("ref_id"), e["roll_display"], p.get("batch_raw") or "(vide)", p.get("qty"), ctext,
                prop, e.get("decision") or ""]
        for i, v in enumerate(vals, 1):
            c = ws.cell(row=r, column=i, value=v)
            c.alignment, c.border = WRAP, BOX
        ws.cell(row=r, column=8).fill = PatternFill("solid", fgColor="FEF9C3")
        r += 1

    # ---- Évolution
    ev = result.get("evolution")
    if ev:
        ws = wb.create_sheet("Évolution", 1)
        ws["A1"] = f"Évolution depuis « {ev['baseline']['name']} » (inventaire du {fmt_date(ev['baseline']['inventory_date'])})"
        ws["A1"].font = TITLE
        header(ws, 3, ["Statut", "Réf.", "Rouleau", "Batch", "Catégorie", "Périmètre", "Métrage (m)", "Depuis", "Nb d'inventaires", "Changement"],
               [18, 6, 14, 13, 24, 18, 11, 12, 10, 50])
        r = 4
        rows = []
        for e in result["entries"]:
            h = e.get("history") or {}
            if h.get("status") in ("new", "persistent"):
                rows.append(("Nouveau" + (" (était conforme)" if h.get("was_ok") else "") if h["status"] == "new" else "Persistant",
                             e.get("ref_id"), e["roll_display"], e["batch"], CAT_LABEL[e["category"]], e["perimeter"],
                             round(_m(e), 1), fmt_date(h["first_seen"]), h["occurrences"], " ; ".join(h.get("changes") or [])))
        for g in ev["resolved"]:
            rows.append(("Résolu · conforme" if g["outcome"] == "now_ok" else "Résolu · n'apparaît plus", g.get("ref_id"),
                         g["roll_display"], g["batch"], CAT_LABEL[g["category"]] + " (avant)", g["perimeter"], g["meters"],
                         fmt_date(g.get("first_seen")), g.get("occurrences"), ""))
        order = {"N": 0, "P": 1, "R": 2}
        for row in sorted(rows, key=lambda x: (order[x[0][0]], -(x[8] or 0))):
            for i, v in enumerate(row, 1):
                c = ws.cell(row=r, column=i, value=v)
                c.alignment, c.border = WRAP, BOX
            ws.cell(row=r, column=1).fill = PatternFill("solid", fgColor={"N": "FDE2E2", "P": "FEF3C7", "R": "DCFCE7"}[row[0][0]])
            r += 1

    # ---- Rapprochement complet
    ws = wb.create_sheet("Rapprochement complet")
    header(ws, 1, ["Réf.", "Catégorie", "Périmètre", "Rouleau (clé)", "Batch (clé)", "Rouleau MES", "Rouleau physique",
                   "Long. MES", "Long. physique", "Δ", "Ligne MES", "Ligne physique"], [6, 22, 18, 12, 13, 14, 14, 10, 10, 8, 32, 36])
    r = 2
    for e in result["entries"]:
        m, p = e["mes"], e["phys"]
        vals = [e.get("ref_id"), CAT_LABEL[e["category"]], e["perimeter"], e["roll"], e["batch"],
                m["roll_raw"] if m else None, p["roll_raw"] if p else None, m["qty"] if m else None,
                p["qty"] if p else None, None if e["delta"] is None else round(e["delta"], 1),
                f"{m['src']}#L{m['row']}" if m else None, f"{p['src']}#L{p['row']}" if p else None]
        for i, v in enumerate(vals, 1):
            ws.cell(row=r, column=i, value=v).border = BOX
        ws.cell(row=r, column=2).fill = PatternFill("solid", fgColor=CAT_FILL[e["category"]])
        r += 1
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:L{max(r - 1, 1)}"

    # ---- Sources
    ws = wb.create_sheet("Sources & colonnes")
    header(ws, 1, ["Fichier", "Rôle", "Ligne d'en-tête", "Lignes lues", "Sans batch", "Formats n° rouleau",
                   "Colonnes reconnues", "Colonnes obligatoires manquantes"], [34, 20, 10, 10, 10, 12, 80, 20])
    for i, src in enumerate(result["sources"], 2):
        vals = [src["name"], ROLE_LABELS[src["role"]], src["header_row"], src["records"], src["no_batch"],
                src["roll_shapes"], ", ".join(f"{f} ← « {h} »" for f, h in src["mapping"].items()),
                ", ".join(src["missing"])]
        for j, v in enumerate(vals, 1):
            ws.cell(row=i, column=j, value=v).alignment = WRAP
    ws = wb.create_sheet("Paramètres")
    ws["A1"] = json.dumps({k: v for k, v in cfg.items() if not k.startswith("_")}, ensure_ascii=False, indent=2)
    ws["A1"].alignment = WRAP
    ws.column_dimensions["A"].width = 120
    wb.save(path)
    return path
