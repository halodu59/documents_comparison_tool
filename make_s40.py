"""Dérive un second jeu FICTIF « semaine 40 » (inventaire du 02/10/2026) à partir de data/ (semaine 39).
Raconte une évolution réaliste : écarts corrigés, écarts persistants, nouveaux écarts, lignes triées autrement."""
import shutil
from datetime import datetime
from pathlib import Path
from openpyxl import load_workbook

SRC, DST = Path("data"), Path("data_s40")
shutil.rmtree(DST, ignore_errors=True)
DST.mkdir()


def wb(name):
    w = load_workbook(SRC / name)
    return w, w.active


def rows_where(ws, col, pred, start=2):
    return [r for r in range(start, ws.max_row + 1) if pred(ws.cell(r, col).value)]


def norm(v):
    return "".join(ch for ch in str(v or "").upper() if ch.isalnum()).replace("ACD", "").replace("CCD", "")


# ---- MES inventaire (colonnes : Plant, SLoc, Material, Desc, MU, Batch, Qty, UoM, Last, Status)
w, ws = wb("MES_inventaire_export.xlsx")
drop = []
batch_of = {}
for r in range(2, ws.max_row + 1):
    mu = ws.cell(r, 5).value
    batch_of.setdefault(mu, []).append(ws.cell(r, 6).value)
    if mu in ("ACD-100423", "CCD-200232"):          # consommations enfin déclarées
        drop.append(r)
    if mu == "ACD-100421":                          # quantité ajustée après prélèvement labo
        ws.cell(r, 7).value = 790; ws.cell(r, 9).value = datetime(2026, 9, 26, 9)
    if mu == "CCD-200224":                          # calandrage déclaré
        ws.cell(r, 3).value = "CA-CAL-001"; ws.cell(r, 4).value = "Cathode calandrée NMC"; ws.cell(r, 7).value = 1150
        ws.cell(r, 9).value = datetime(2026, 9, 27, 10)
for r in sorted(drop, reverse=True):
    ws.delete_rows(r)
w.save(DST / "MES_inventaire_export.xlsx")

# ---- MES trace (Timestamp, MU, Batch, Material, Transaction, From, To, Qty, UoM, Equipment, Order, User)
w, ws = wb("MES_trace_MovableUnit.xlsx")
add = [
    [datetime(2026, 9, 26, 8, 30), "ACD-100423", batch_of["ACD-100423"][0], "AN-CAL-001", "Consumption", "AN-STK1", "SLT-A01", 880, "M", "SLT-A01", "OF481120", "MES_BAPT"],
    [datetime(2026, 9, 26, 9, 0), "ACD-100421", batch_of["ACD-100421"][0], "AN-CAL-001", "Quantity adjustment", "AN-STK1", "AN-STK1", 60, "M", "", "", "MES_BAPT"],
    [datetime(2026, 9, 26, 9, 20), "CCD-200232", batch_of["CCD-200232"][0], "CA-NOT-001", "Consumption", "CA-STK2", "STK-01", 780, "M", "STK-01", "OF481131", "MES_BAPT"],
    [datetime(2026, 9, 27, 10, 0), "CCD-200224", batch_of["CCD-200224"][0], "CA-CAL-001", "Production declaration", "CAL-C02", "CA-STK1", 1150, "M", "CAL-C02", "OF481140", "MES_BAPT"],
]
for a in add:
    ws.append(a)
w.save(DST / "MES_trace_MovableUnit.xlsx")

# ---- Inventaire physique anode (Date inventaire, Zone, N° rouleau, N° batch, Longueur, Opérateur, Commentaire)
w, ws = wb("Inventaire_physique_Anode.xlsx")
data = [[c.value for c in row] for row in ws.iter_rows(min_row=2)]
out, seen405 = [], False
for d in data:
    k = norm(d[2])
    d[0] = "02/10/2026"
    if k == "100405":
        if seen405:
            continue                                  # doublon supprimé
        seen405 = True
    if k == "100410":
        continue                                      # nouveau : rouleau oublié au comptage
    if k == "100422":
        d[4] = 912                                    # erreur d'unité corrigée
    if k == "100430":
        d[3] = 2609180213                             # batch corrigé
    out.append(d)
out.sort(key=lambda d: norm(d[2]), reverse=True)      # le fichier ops a été retrié : n° de ligne différents
ws.delete_rows(2, ws.max_row)
for d in out:
    ws.append(d)
w.save(DST / "Inventaire_physique_Anode.xlsx")

# ---- Inventaire cathode (titre sur 2 lignes ; Step, Roll ID, Batch Number, Length, Count date, Counted by, Remarks)
w, ws = wb("Inventaire_tournant_Cathode_S39.xlsx")
ws["A1"] = "Inventaire tournant cathode - semaine 40"
for r in range(4, ws.max_row + 1):
    ws.cell(r, 5).value = datetime(2026, 10, 2)
    k = norm(ws.cell(r, 2).value)
    if k == "200207":
        ws.cell(r, 4).value = (ws.cell(r, 4).value or 0) - 30   # nouveau : découpe non déclarée
        b207 = ws.cell(r, 3).value
    if k == "200212":
        ws.cell(r, 3).value = None                              # nouveau : batch oublié
ws.append(["Calendered", "CCD200240", 2609300777, 1010, datetime(2026, 10, 2), "R. B.", ""])  # nouveau rouleau
w.save(DST / "Inventaire_tournant_Cathode_S40.xlsx")

# ---- Traces physiques
shutil.copy(SRC / "Traca_APU_Anode.xlsx", DST / "Traca_APU_Anode.xlsx")
w, ws = wb("Tracking_rolls_Cathode.xlsx")
ws.append([datetime(2026, 9, 30, 14, 10), "CCD200207", str(b207).replace(".0", ""), "Cut splice", "NOT-C03", 30, "", "raboutage retiré"])
ws.append([datetime(2026, 9, 30, 7, 40), "CCD200240", "2609300777", "Calendering output", "CAL-C02", 1010, "", ""])
w.save(DST / "Tracking_rolls_Cathode.xlsx")
print("data_s40 prêt :", sorted(p.name for p in DST.iterdir()))
