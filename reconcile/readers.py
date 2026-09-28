"""Lecture des fichiers sources (xlsx / xlsm / csv) en tableaux de lignes brutes."""
from __future__ import annotations

import csv
from datetime import date, datetime, time
from pathlib import Path


def _cell(v):
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d %H:%M")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d 00:00")
    if isinstance(v, time):
        return v.strftime("%H:%M")
    return v


def read_file(path, sheet=None):
    """Renvoie {name, rows} ; rows[i] = valeurs de la ligne Excel i+1."""
    path = Path(path)
    return read_bytes(path.name, path.read_bytes(), sheet)


def read_bytes(filename, raw, sheet=None):
    """Même chose à partir du contenu du fichier (utilisé pour rejouer une analyse archivée)."""
    import io
    path = Path(filename)
    ext = path.suffix.lower()
    if ext in (".xlsx", ".xlsm"):
        from openpyxl import load_workbook
        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb[sheet] if sheet else next((w for w in wb.worksheets if w.max_row and w.max_row > 1), wb.worksheets[0])
        rows = []
        for r in ws.iter_rows(min_row=1, values_only=True):
            rows.append([_cell(v) for v in r])
        wb.close()
        # retire les colonnes/lignes vides de fin
        while rows and not any(c not in (None, "") for c in rows[-1]):
            rows.pop()
    elif ext in (".csv", ".txt"):
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        first = text.splitlines()[0] if text else ""
        delim = ";" if first.count(";") >= first.count(",") else ","
        rows = [[c if c != "" else None for c in r] for r in csv.reader(text.splitlines(), delimiter=delim)]
    else:
        raise ValueError(f"Format non supporté : {path.name}")
    return {"name": path.stem, "rows": rows}
