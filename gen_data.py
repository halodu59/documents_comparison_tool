"""Génère un jeu de données FICTIF pour le PoC de rapprochement inventaire physique / MES.

Toutes les colonnes, formats et règles sont des HYPOTHÈSES à confirmer avec Harold.
Le jeu contient volontairement des cas pièges : formats de n° de rouleau hétérogènes,
batch manquant, corps de rouleau réutilisé, doublon, erreur d'unité, en-tête décalé...
"""
import random
from datetime import datetime, timedelta
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

random.seed(42)
OUT = Path(__file__).parent / "data"
OUT.mkdir(exist_ok=True)

INV_DAY = datetime(2026, 9, 25)
mes_inv, mes_trace = [], []
an_inv, an_trace = [], []
ca_inv, ca_trace = [], []
_batch_seq = [100]


def new_batch(day):
    _batch_seq[0] += 7
    return f"{day:%y%m%d}{_batch_seq[0]:04d}"


def dt(d, h, m=0):
    return datetime(2026, 9, d, h, m) if isinstance(d, int) else d.replace(hour=h, minute=m)


# ---------------------------------------------------------------- helpers MES
def mes_row(sloc, mat, desc, mu, batch, qty, last):
    mes_inv.append(["DK01", sloc, mat, desc, mu, batch, qty, "M", last, "Unrestricted"])


def mt(ts, mu, batch, mat, tr, frm, to, qty, eq, order=None, user="MES_AUTO"):
    mes_trace.append([ts, mu, batch, mat, tr, frm, to, qty, "M", eq, order or f"OF{random.randint(400000, 499999)}", user])


def old_cycles(mu, mat, eq_prod, eq_cons, n, start_day):
    """Historique d'un corps réutilisé : autres batches produits puis consommés."""
    d = datetime(2026, 8, start_day)
    for _ in range(n):
        b = new_batch(d)
        q = random.randint(700, 1000)
        mt(dt(d, 8), mu, b, mat, "Production declaration", eq_prod, "BUF", q, eq_prod)
        mt(dt(d + timedelta(days=2), 14), mu, b, mat, "Consumption", "BUF", eq_cons, q, eq_cons)
        d += timedelta(days=6)


# ======================================================================= ANODE
AN_MAT, AN_DESC, AN_SLOC = "AN-CAL-001", "Anode calandrée 1200mm", "AN-STK1"
AN_FMT = ["ACD-{n}", "{n}", "acd {n}", "ACD{n}"]
ops_an = ["K. L.", "S. D.", "J. M."]


def an_prod(mu, b, q, day, h=9):
    mt(dt(day, h), mu, b, AN_MAT, "Production declaration", "CAL-A01", "AN-CAL-BUF", q, "CAL-A01")
    mt(dt(day, h + 3), mu, b, AN_MAT, "Stock transfer", "AN-CAL-BUF", AN_SLOC, q, "")


def an_ptrace(day, h, m, roll, lot, op, mach, q, dest="", rem=""):
    an_trace.append([f"{day:02d}/09/2026", f"{h:02d}:{m:02d}", roll, lot, op, mach, q, dest, random.choice(ops_an), rem])


def an_pinv(roll_n, batch, q, i, comment=""):
    fmt = AN_FMT[i % 4]
    roll = fmt.format(n=roll_n)
    an_inv.append(["25/09/2026", AN_SLOC, roll, batch, q, random.choice(ops_an), comment])


# conformes 100401..100420
for i, n in enumerate(range(100401, 100421)):
    day = random.randint(12, 23)
    b = new_batch(datetime(2026, 9, day))
    q = random.randint(700, 950)
    mu = f"ACD-{n}"
    if i % 5 == 0:
        old_cycles(mu, AN_MAT, "CAL-A01", "SLT-A01", random.randint(1, 3), random.randint(1, 10))
    an_prod(mu, b, q, day)
    mes_row(AN_SLOC, AN_MAT, AN_DESC, mu, b, q, dt(day, 12))
    noise = random.choice([0, 0, 0, 0.5, -1, 1])
    batch_phys = int(b) if i % 3 else b  # parfois nombre, parfois texte
    an_pinv(n, batch_phys, q + noise, i)
    lot = "" if i % 4 == 0 else b  # traça physique : lot pas toujours rempli
    an_ptrace(day, 9, 5, str(n), lot, "Production calandrage", "CAL-A01", q)
    an_ptrace(day, 12, 20, str(n), lot, "Mise en stock", "", q, AN_SLOC)
    if n == 100405:  # doublon de comptage
        an_pinv(n, batch_phys, q + noise, i, "recompté fin de poste")

# A1 écart de longueur : prélèvement labo non déclaré dans MES
b = new_batch(datetime(2026, 9, 20)); an_prod("ACD-100421", b, 850, 20)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100421", b, 850, dt(20, 12))
an_pinv(100421, int(b), 790, 1)
an_ptrace(20, 9, 0, "100421", b, "Production calandrage", "CAL-A01", 850)
an_ptrace(20, 12, 10, "100421", b, "Mise en stock", "", 850, AN_SLOC)
an_ptrace(23, 10, 30, "100421", b, "Prélèvement labo", "LAB", 60, "", "contrôle adhérence")

# A2 erreur de saisie (facteur 10)
b = new_batch(datetime(2026, 9, 19)); an_prod("ACD-100422", b, 912, 19)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100422", b, 912, dt(19, 12))
an_pinv(100422, int(b), "91,2", 2)
an_ptrace(19, 9, 0, "100422", b, "Production calandrage", "CAL-A01", 912)

# A3 seulement MES : consommation non déclarée
b = new_batch(datetime(2026, 9, 18)); an_prod("ACD-100423", b, 880, 18)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100423", b, 880, dt(18, 12))
an_ptrace(18, 9, 0, "100423", b, "Production calandrage", "CAL-A01", 880)
an_ptrace(24, 6, 45, "100423", b, "Consommé refendeuse", "SLT-A01", 880, "", "poste de nuit")

# A4 seulement MES : rebut non déclaré
b = new_batch(datetime(2026, 9, 17)); an_prod("ACD-100424", b, 640, 17)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100424", b, 640, dt(17, 12))
an_ptrace(17, 9, 0, "100424", b, "Production calandrage", "CAL-A01", 640)
an_ptrace(23, 15, 10, "100424", "", "Rebut - défaut enduction", "CAL-A01", 640, "", "cloques bord opérateur")

# A5 seulement MES : stock fantôme (aucun mouvement depuis août, pas de trace physique)
b = new_batch(datetime(2026, 8, 28)); an_prod("ACD-100425", b, 720, datetime(2026, 8, 28))
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100425", b, 720, datetime(2026, 8, 28, 12))

# A6 seulement physique : MES déclare consommé, retour stock physique non déclaré
b = new_batch(datetime(2026, 9, 20)); an_prod("ACD-100426", b, 830, 20)
mt(dt(22, 10), "ACD-100426", b, AN_MAT, "Consumption", AN_SLOC, "SLT-A01", 830, "SLT-A01", user="OP_SLT2")
an_pinv(100426, int(b), 830, 3)
an_ptrace(22, 9, 40, "100426", b, "Chargé sur refendeuse", "SLT-A01", 830)
an_ptrace(22, 15, 0, "100426", b, "Retour stock (bobine non consommée)", "SLT-A01", 830, AN_SLOC, "changement OF")

# A7 seulement physique : batch inconnu de MES, corps réutilisé sous d'autres batches
old_cycles("ACD-100427", AN_MAT, "CAL-A01", "SLT-A01", 2, 3)
b = new_batch(datetime(2026, 9, 21))
an_pinv(100427, int(b), 905, 0)
an_ptrace(21, 11, 0, "100427", b, "Production calandrage", "CAL-A01", 905)

# A8 batch manquant, un seul candidat MES
b = new_batch(datetime(2026, 9, 19)); an_prod("ACD-100428", b, 760, 19)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100428", b, 760, dt(19, 12))
an_pinv(100428, "", 759, 1)

# A9 batch manquant, deux candidats MES (ancien batch jamais sorti de MES)
b_old = new_batch(datetime(2026, 8, 25)); an_prod("ACD-100429", b_old, 790, datetime(2026, 8, 25))
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100429", b_old, 790, datetime(2026, 8, 25, 12))
b_new = new_batch(datetime(2026, 9, 22)); an_prod("ACD-100429", b_new, 815, 22)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100429", b_new, 815, dt(22, 12))
an_pinv(100429, "", 815, 2)
an_ptrace(22, 9, 0, "100429", "", "Production calandrage", "CAL-A01", 815)

# A10 batch divergent (inversion de chiffres)
b = "2609180213"; an_prod("ACD-100430", b, 700, 18)
mes_row(AN_SLOC, AN_MAT, AN_DESC, "ACD-100430", b, 700, dt(18, 12))
an_pinv(100430, 2609180231, 700, 3)

# ===================================================================== CATHODE
CA = {  # étape -> (material, description, sloc, machine)
    "Coated": ("CA-COA-001", "Cathode enduite NMC", "CA-STK1", "COA-C01"),
    "Calendered": ("CA-CAL-001", "Cathode calandrée NMC", "CA-STK1", "CAL-C02"),
    "Notched": ("CA-NOT-001", "Cathode notchée NMC", "CA-STK2", "NOT-C03"),
}
CA_FMT = ["CCD{n}", "CCD-{n}", "{n}", "ccd {n} "]


def ca_prod(mu, b, q, day, step, h=8):
    mat, _, sloc, eq = CA[step]
    mt(dt(day, h), mu, b, mat, "Production declaration", eq, eq + "-BUF", q, eq)
    mt(dt(day, h + 2), mu, b, mat, "Stock transfer", eq + "-BUF", sloc, q, "")


def ca_mes(mu, b, q, day, step):
    mat, desc, sloc, _ = CA[step]
    mes_row(sloc, mat, desc, mu, b, q, dt(day, 10))


def ca_ptrace(ts, roll, b, ev, line, q, dest="", com=""):
    ca_trace.append([ts, roll, b, ev, line, q, dest, com])


def ca_pinv(step, n, b, q, i, rem=""):
    ca_inv.append([step, CA_FMT[i % 4].format(n=n), b, q, INV_DAY, random.choice(["R. B.", "A. T."]), rem])


steps = list(CA)
for i, n in enumerate(range(200201, 200219)):
    step = steps[i % 3]
    day = random.randint(10, 23)
    b = new_batch(datetime(2026, 9, day))
    q = random.randint(800, 1200)
    mu = f"CCD-{n}"
    if i % 4 == 1:
        old_cycles(mu, CA[step][0], CA[step][3], "STK-01", random.randint(1, 3), random.randint(1, 12))
    ca_prod(mu, b, q, day, step)
    ca_mes(mu, b, q, day, step)
    bp = f"{b}.0" if i % 5 == 2 else (int(b) if i % 2 else b)
    ca_pinv(step, n, bp, q + random.choice([0, 0, 1.2, -0.8]), i)
    ev = {"Coated": "Coating output", "Calendered": "Calendering output", "Notched": "Notching output"}[step]
    ca_ptrace(dt(day, 8, 10), f"CCD{n}", b, ev, CA[step][3], q)
    ca_ptrace(dt(day, 10, 15), f"CCD{n}", b, "Moved to storage", "", q, CA[step][2])

# C1 découpe non déclarée
b = new_batch(datetime(2026, 9, 19)); ca_prod("CCD-200219", b, 1020, 19, "Calendered"); ca_mes("CCD-200219", b, 1020, 19, "Calendered")
ca_pinv("Calendered", 200219, int(b), 985, 0)
ca_ptrace(dt(19, 8, 5), "CCD200219", b, "Calendering output", "CAL-C02", 1020)
ca_ptrace(dt(21, 13, 40), "CCD200219", b, "Cut splice", "CAL-C02", 35, "", "raboutage retiré")

# C2 écart inexpliqué
b = new_batch(datetime(2026, 9, 20)); ca_prod("CCD-200220", b, 640, 20, "Notched"); ca_mes("CCD-200220", b, 640, 20, "Notched")
ca_pinv("Notched", 200220, int(b), 612, 1)
ca_ptrace(dt(20, 8, 0), "CCD200220", b, "Notching output", "NOT-C03", 640)

# C3 seulement MES : transféré en quarantaine
b = new_batch(datetime(2026, 9, 16)); ca_prod("CCD-200221", b, 1100, 16, "Coated"); ca_mes("CCD-200221", b, 1100, 16, "Coated")
ca_ptrace(dt(16, 8, 0), "CCD200221", b, "Coating output", "COA-C01", 1100)
ca_ptrace(dt(23, 16, 20), "CCD200221", b, "Transfer to quarantine", "", 1100, "QUAR-Q2", "suspicion défaut grammage")

# C4 seulement physique : MES déclare rebut alors que présent
b = new_batch(datetime(2026, 9, 21)); ca_prod("CCD-200222", b, 700, 21, "Notched")
mt(dt(24, 11), "CCD-200222", b, "CA-NOT-001", "Scrap declaration", "CA-STK2", "SCRAP", 700, "NOT-C03", user="QA_USR4")
ca_pinv("Notched", 200222, int(b), 700, 2)
ca_ptrace(dt(21, 8, 5), "CCD200222", b, "Notching output", "NOT-C03", 700)
ca_ptrace(dt(21, 10, 0), "CCD200222", b, "Moved to storage", "", 700, "CA-STK2")

# C5 seulement physique : production jamais déclarée dans MES
b = new_batch(datetime(2026, 9, 23))
ca_pinv("Calendered", 200223, int(b), 990, 3)
ca_ptrace(dt(23, 7, 50), "CCD200223", b, "Calendering output", "CAL-C02", 990)

# C6 étape non déclarée (MES = enduit, physique = calandré)
b = new_batch(datetime(2026, 9, 18)); ca_prod("CCD-200224", b, 1100, 18, "Coated"); ca_mes("CCD-200224", b, 1100, 18, "Coated")
ca_pinv("Calendered", 200224, int(b), 1150, 0)
ca_ptrace(dt(18, 8, 0), "CCD200224", b, "Coating output", "COA-C01", 1100)
ca_ptrace(dt(22, 14, 30), "CCD200224", b, "Calendering output", "CAL-C02", 1150)

# C7 CCD-200232 : seulement MES, consommé physiquement ; corps très réutilisé
old_cycles("CCD-200232", "CA-NOT-001", "NOT-C03", "STK-01", 4, 1)
b = new_batch(datetime(2026, 9, 20)); ca_prod("CCD-200232", b, 780, 20, "Notched"); ca_mes("CCD-200232", b, 780, 20, "Notched")
ca_ptrace(dt(20, 8, 0), "CCD200232", b, "Notching output", "NOT-C03", 780)
ca_ptrace(dt(24, 9, 15), "CCD200232", b, "Consumed at stacking", "STK-01", 780)


# ======================================================================= WRITE
def save(name, header, rows, title_rows=None, sort_key=None):
    wb = Workbook(); ws = wb.active; ws.title = "Export"
    for t in title_rows or []:
        ws.append(t)
    ws.append(header)
    for c in ws[ws.max_row]:
        c.font = Font(bold=True); c.fill = PatternFill("solid", fgColor="DDDDDD")
    for r in sorted(rows, key=sort_key) if sort_key else rows:
        ws.append(r)
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 16
    wb.save(OUT / name)
    print(f"{name}: {len(rows)} lignes")


random.shuffle(an_inv)
save("MES_inventaire_export.xlsx",
     ["Plant", "Storage Location", "Material", "Material Description", "Movable Unit", "Batch", "Quantity", "UoM", "Last Movement", "Status"],
     mes_inv, sort_key=lambda r: (r[1], r[4]))
save("MES_trace_MovableUnit.xlsx",
     ["Timestamp", "Movable Unit", "Batch", "Material", "Transaction", "From", "To", "Qty", "UoM", "Equipment", "Order", "User"],
     mes_trace, sort_key=lambda r: r[0])
save("Inventaire_physique_Anode.xlsx",
     ["Date inventaire", "Zone", "N° rouleau", "N° batch", "Longueur (m)", "Opérateur", "Commentaire"], an_inv)
save("Inventaire_tournant_Cathode_S39.xlsx",
     ["Step", "Roll ID", "Batch Number", "Length [m]", "Count date", "Counted by", "Remarks"], ca_inv,
     title_rows=[["Inventaire tournant cathode - semaine 39"], []])
save("Traca_APU_Anode.xlsx",
     ["Date", "Heure", "Rouleau", "Lot", "Opération", "Machine", "Longueur (m)", "Vers", "Opérateur", "Remarque"],
     an_trace, sort_key=lambda r: (r[0][3:5] + r[0][:2], r[1]))
save("Tracking_rolls_Cathode.xlsx",
     ["Datetime", "Roll", "Batch", "Event", "Line", "Length_m", "Destination", "Comment"], ca_trace, sort_key=lambda r: r[0])
