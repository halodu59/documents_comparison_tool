"""Reformulation optionnelle par un LLM. Désactivée par défaut.

Le LLM ne reçoit QUE les faits déjà calculés (synthèse + diagnostic + traces condensées) et ne modifie
pas le bilan. Option `pseudonymize` : remplace les n° de rouleau / batch par des alias avant envoi.
"""
from __future__ import annotations

import json
import os
import urllib.request

from .engine import CAT_LABEL, fmt_date, fmt_num, fmt_signed

SYSTEM = (
    "Tu es analyste en contrôle d'inventaire dans une usine de cellules de batteries. On te fournit le résultat "
    "d'un rapprochement déterministe entre l'inventaire physique et le MES, avec pour chaque écart les traces MES "
    "et physiques et une hypothèse calculée par règles. Règles : (1) n'utilise QUE les faits fournis, n'invente "
    "aucun chiffre ni mouvement ; (2) cite systématiquement la référence de l'écart entre crochets, ex. [E03] ; "
    "(3) si une hypothèse calculée te paraît fragile, dis-le et indique quelle donnée manque ; (4) ne modifie jamais "
    "les quantités. Réponds en français, en bullet points concis."
)

TASK = (
    "Prépare la réunion de revue des écarts :\n"
    "1. « Grandes différences » : 3 à 6 bullet points, les plus importants d'abord (volume, récurrence, risque).\n"
    "2. « Root causes probables » : regroupe les écarts qui semblent avoir la même cause de fond (processus, poste, saisie).\n"
    "3. « Actions » : bullet points avec responsable, classés par priorité.\n"
    "4. « Questions à poser en réunion » : 3 questions maximum, là où les traces ne suffisent pas."
)


def pseudonym_map(result):
    """Alias stables R001… (rouleaux) et B001… (batches) pour tout identifiant présent dans le résultat."""
    rolls, batches = {}, {}
    for e in result["entries"]:
        recs = [e["mes"], e["phys"]] + list(e.get("candidates") or [])
        if e["roll"] not in rolls:
            rolls[e["roll"]] = f"R{len(rolls) + 1:03d}"
        for r in recs:
            if r and r["batch"] and r["batch"] not in batches:
                batches[r["batch"]] = f"B{len(batches) + 1:03d}"
        for b in e.get("excluded_batches") or []:
            if b not in batches:
                batches[b] = f"B{len(batches) + 1:03d}"
    pairs = {}
    for e in result["entries"]:
        al = rolls[e["roll"]]
        for r in [e["mes"], e["phys"]] + list(e.get("candidates") or []):
            if r:
                pairs[r["roll_raw"]] = al
                if r["batch_raw"] and r["batch"] in batches:
                    pairs[r["batch_raw"]] = batches[r["batch"]]
        pairs[e["roll"]] = al
    for b, al in batches.items():
        pairs[b] = al
    return sorted(pairs.items(), key=lambda kv: (-len(kv[0]), kv[0]))


def build_prompt(result, pseudonymize=False):
    s = result["summary"]
    lines = [f"Inventaire du {fmt_date(result['inventory_date'])}.", "", "SYNTHÈSE CALCULÉE :"]
    lines += [f"- {d}" for d in s["differences"]]
    lines += ["", "ACTIONS CALCULÉES :"] + [f"- {a['text']}" for a in s["actions"]]
    lines += ["", "DÉTAIL DES ÉCARTS :"]
    for e in result["entries"]:
        if not e.get("ref_id"):
            continue
        d = e.get("diag") or {}
        m, p = e["mes"], e["phys"]
        lines.append(f"[{e['ref_id']}] {CAT_LABEL[e['category']]} · {e['perimeter']} · rouleau {e['roll_display']} "
                     f"/ batch {e['batch'] or '?'} · MES {fmt_num(m['qty']) if m else '—'} m · "
                     f"physique {fmt_num(p['qty']) if p else '—'} m · Δ {fmt_signed(e['delta'])} m")
        if d:
            lines.append(f"  Hypothèse par règles ({d['confidence']}) : {d['hypothesis']}")
        for side, evs in (("MES", e["trace_mes"]), ("Physique", e["trace_phys"])):
            if evs:
                tl = "; ".join(f"{fmt_date(x['date'], True)} {x['event']}"
                               + (f" {x['equipment']}" if x["equipment"] else "")
                               + (f" → {x['to']}" if x["to"] else "")
                               + (f" ({fmt_num(x['qty'])} m)" if x["qty"] is not None else "") for x in evs[-8:])
                lines.append(f"  Trace {side} : {tl}")
            else:
                lines.append(f"  Trace {side} : aucune")
    text = "\n".join(lines)
    if pseudonymize:
        for real, al in pseudonym_map(result):
            if len(real) >= 3:
                text = text.replace(real, al)
    return SYSTEM, TASK + "\n\n" + text


def call_llm(system, user, provider="anthropic", model=None, api_key=None, url=None, timeout=120):
    api_key = api_key or os.environ.get("LLM_API_KEY") or os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("Aucune clé API (variable LLM_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY).")
    if provider == "anthropic":
        req = urllib.request.Request(
            url or "https://api.anthropic.com/v1/messages",
            data=json.dumps({"model": model or "claude-sonnet-4-5", "max_tokens": 2000, "system": system,
                             "messages": [{"role": "user", "content": user}]}).encode(),
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
        return "".join(b.get("text", "") for b in data.get("content", []))
    # OpenAI / Azure OpenAI (API compatible chat/completions)
    headers = {"content-type": "application/json"}
    if provider == "azure":
        headers["api-key"] = api_key
    else:
        headers["authorization"] = f"Bearer {api_key}"
    body = {"messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if model:
        body["model"] = model
    req = urllib.request.Request(url or "https://api.openai.com/v1/chat/completions",
                                 data=json.dumps(body).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"]
