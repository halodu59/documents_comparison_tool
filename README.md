# PoC — Rapprochement inventaire physique / MES et dossier de traçabilité

Deux étapes, un seul moteur de règles :

1. **Rapprocher** l'inventaire physique (Excel des opérations) avec l'extraction d'inventaire MES, sur la clé **n° de rouleau + batch**.
2. **Préparer la réunion** : pour chaque écart, l'outil va chercher toute la traçabilité MES (export Movable Unit) et physique (fichiers APU), la met côte à côte par ordre chronologique, propose une hypothèse et une action, et cite la ligne source de chaque fait.

La synthèse finale tient en quelques bullet points : les grandes différences, puis les actions groupées par responsable.

## Deux façons de l'utiliser

| | App web (`Rapprochement_MES_physique.html`) | Script Python (`python -m reconcile`) |
|---|---|---|
| Pour qui | Harold, en réunion, sans installation | Automatisation, future industrialisation (Databricks / VIBE) |
| Entrées | glisser-déposer .xlsx / .xls / .csv | dossier ou fichiers en arguments |
| Validation des cas incertains | boutons dans l'onglet « À valider » | colonne « Décision » de la feuille « À valider », relue avec `--decisions` |
| Historique | onglet « Historique » (navigateur) + export/import .json | dossier `historique/` + `--list`, `--from`, `--compare` |
| Sorties | écrans + export Excel + brief .md | rapport Excel (7 feuilles) + brief .md |
| LLM (optionnel) | bouton « Copier le prompt » (Copilot) ou appel API direct | `--llm anthropic|openai|azure` |

Les deux implémentations produisent **exactement** le même résultat (test : `python tests/parity.py` sur une chaîne S39 → S39 validée → S40, avec comparaison et report des validations).
Tout le calcul est local : aucune donnée ne sort du poste, sauf si l'on déclenche soi-même l'appel LLM.

```bash
pip install openpyxl                       # seule dépendance Python
python -m reconcile --data data --name "Semaine 39"                  # analyse archivée dans ./historique/
python -m reconcile --mes-inv export_MES.xlsx --phys-inv inv_anode.xlsx inv_cathode.xlsx \
                    --mes-trace trace_MU.xlsx --phys-trace traca_APU_*.xlsx --name "Anode S39"
python -m reconcile --from last --decisions historique/<id>/rapport.xlsx --name "Semaine 39 validée"  # après validation
python -m reconcile --from last --data data_s40 --name "Semaine 40"  # nouvelle semaine : règles + validations reprises
python -m reconcile --list                                           # versions archivées
python -m reconcile --compare "Semaine 39" "Semaine 40"              # évolution entre deux versions
python build.py                            # régénère l'app web depuis web/ (moteur JS + jeu de démo)
```

## Historique, versions et comparaison

- **Une version = une analyse enregistrée, immuable** : fichiers sources, règles, validations et résultat. Le format (`analyse.json`) est le même dans l'app (bouton « Enregistrer », onglet « Historique », stockage dans le navigateur) et dans le script (dossier `historique/<id>/` avec `analyse.json`, `rapport.xlsx`, `brief.md`, plus `index.json`). Une version exportée depuis l'app se relance en Python (`--from analyse.json`), et inversement (« Importer » dans l'app).
- **Repartir d'une version** : règles et validations sont reprises ; on remplace les fichiers qui ont changé (dans l'app, un fichier de même nom remplace l'ancien ; en Python, `--from` + nouveaux fichiers, `--keep` pour garder certains anciens). La nouvelle version garde le lien vers sa version d'origine.
- **Comparaison** : chaque écart est suivi par sa clé rouleau + batch → *nouveau* (et s'il était conforme avant), *persistant* (depuis quand, sur combien d'inventaires, ce qui a changé), *résolu* (désormais conforme, ou n'apparaît plus). Par défaut, la référence est la version d'origine (ou, en Python, la dernière version archivée) ; on peut en choisir une autre.
- **Validations stables** : une décision est rattachée au rouleau + batch relevé (et au batch MES choisi), pas au numéro de ligne. Elle se reporte sur les analyses suivantes même si le fichier a été trié ; si les candidats MES ont changé, elle n'est pas appliquée et l'écran le signale.
- **Limites** : l'historique de l'app est propre à un navigateur sur un poste (exporter le .json pour le partager ou l'archiver) ; les données restent locales.

## Ce que fait le moteur

- **Lecture tolérante** : en-tête détecté automatiquement (même en ligne 3), colonnes reconnues par synonymes FR/EN (`N° rouleau`, `Roll ID`, `Movable Unit`…), forçage manuel possible (app : menus déroulants ; Python : `column_overrides` dans `config.json`).
- **Normalisation des clés** : `acd 100401`, `ACD100401`, `100401` → même rouleau ; batch `2609150142.0` → `2609150142`.
- **Rapprochement** : clé exacte rouleau + batch, puis clé partielle (rouleau seul) pour les lignes restantes. Une correspondance incertaine n'est jamais imposée : elle part en « À valider ».
- **Catégories** : conforme · seulement MES · seulement physique · écart de longueur · étape divergente · batch divergent · batch manquant · ambigu (plusieurs candidats) · doublon.
- **Traçabilité par écart** : filtrée sur rouleau + batch, parce qu'un corps de rouleau est réutilisé ; les mouvements des autres batches sont écartés et comptés.
- **Diagnostic par règles** (confiance élevée / moyenne / faible) : consommation, rebut, retour ou production non déclarés dans MES, prélèvement ou découpe non déclaré, transfert hors zone, stock fantôme, erreur d'unité (facteur 10/100/1000), étape non déclarée, batch inversé…

## Hypothèses à confirmer avec Harold

Les jeux de données `data/` (semaine 39) et `data_s40/` (semaine 40, dérivée par `make_s40.py` : écarts corrigés, persistants, nouveaux, fichier retrié) sont **fictifs**. Avant de brancher les vrais fichiers, il faut confirmer :

1. La clé : n° de corps + batch, et le format réel des deux (préfixes, zéros, rouleau mère ou fille).
2. Les colonnes réelles de chaque source (inventaire MES, export Movable Unit de Kader, fichiers de chaque tech supply APU).
3. Les libellés de mouvements MES et physiques (consommation, rebut, retour, découpe…) : ils déterminent les hypothèses.
4. La tolérance de métrage acceptable (par défaut 2 m ou 0,5 %) et la règle « stock dormant » (21 jours).
5. Les emplacements qui font partie du périmètre d'inventaire (sinon « hors zone »).
6. Les responsables par type d'action (libellés dans `config.json > owners`).

Pour démarrer : deux petits exemples anonymisés de chaque source suffisent, dont un cas où le batch manque.

## Et après

- Mesurer le temps complet gagné (export → import → validation → réunion) et le taux de rapprochements validés sans reprise manuelle.
- L'historique alimente l'étape suivante : repérer les écarts récurrents (par poste, type de mouvement, périmètre) et tester des alertes. Avec un seul export, l'outil décrit les écarts ; il ne peut pas les prédire.

## Arborescence

```
reconcile/   moteur Python (engine.py), lecture, historique (history.py), rapports Excel/Markdown, LLM, CLI
web/         moteur JS (engine.js, portage 1:1), lecture, interface, template
data/        jeu fictif semaine 39 (6 fichiers) — gen_data.py le régénère
data_s40/    jeu fictif semaine 40 — make_s40.py le dérive de data/
historique/  versions archivées par le script (créé au premier lancement)
tests/       parity.py (Python = JS), ui_test.py (test navigateur)
config.json  règles partagées par l'app et le script
dist/        app web assemblée
```

## Déploiement Railway (historique partagé)

Le serveur (`server/`, FastAPI) sert l'app, stocke les versions pour toute l'équipe et génère le rapport Excel avec le moteur Python. Il reconstruit l'app au démarrage (`python -m server`, déjà configuré dans `railway.json`).

1. Créer un service Railway à partir de ce dossier : repo GitHub, `railway up`, ou connecteur Railway de Claude. Choisir de préférence la région **EU West**.
2. Variables : `APP_USERS=harold:<mot de passe>,matthieu:<mot de passe>`. Sans cette variable, le serveur refuse l'accès (503), sauf si `ALLOW_NO_AUTH=1` (jeu fictif uniquement).
3. Attacher un **volume** au service (point de montage `/data`, par exemple). Sans volume, l'historique est perdu à chaque redéploiement, et l'app l'affiche.
4. Contrôle de santé : `/healthz`. Routes : `GET /`, `GET|POST /api/analyses`, `GET|PATCH|DELETE /api/analyses/<id>`, `GET /api/analyses/<id>/rapport.xlsx` et `/brief.md` (paramètre facultatif `?compare_to=<id>`).

Tester en local : `pip install -r requirements.txt && APP_USERS=moi:test python -m server`, puis ouvrir http://localhost:8000.

Avant d'y mettre de vraies données Verkor, vérifier que l'hébergement externe est autorisé : les fichiers déposés dans une version enregistrée sont stockés sur le serveur.
