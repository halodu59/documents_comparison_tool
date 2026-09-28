import asyncio, json
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out"

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(viewport={"width": 1360, "height": 900}, color_scheme="dark", accept_downloads=True)
        pg = await ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "TUNNEL" not in m.text else None)
        url = (ROOT / "dist/Rapprochement_MES_physique.html").as_uri()
        await pg.goto(url); await pg.wait_for_selector(".kpi")
        await pg.click("#tab-synthese"); await pg.wait_for_timeout(100)
        print("sous-titre :", await pg.inner_text("#sub"))
        print("évolution :", await pg.locator(".evo").inner_text())
        await pg.screenshot(path=str(OUT / "h_synthese.png"), full_page=True)
        await pg.click("#tab-ecarts"); await pg.screenshot(path=str(OUT / "h_ecarts.png"))
        await pg.click("#tab-valider")
        print("à valider :", await pg.locator(".vcard").count(), "· décisions reprises :", await pg.locator("[data-undo]").count())
        await pg.locator("[data-dec]").first.click()
        # enregistrer
        await pg.fill("#an-name", "Semaine 40 test"); await pg.press("#an-name", "Tab")
        await pg.click("#btn-save"); await pg.wait_for_timeout(300)
        await pg.click("#tab-historique"); await pg.wait_for_timeout(100)
        print("versions :", await pg.locator(".hrow").count(), "·", await pg.inner_text("#sub"))
        await pg.screenshot(path=str(OUT / "h_historique.png"), full_page=True)
        # exporter la version enregistrée
        async with pg.expect_download() as d:
            await pg.locator(".hrow.cur [data-hact=export]").click()
        dl = await d.value; path = OUT / dl.suggested_filename; await dl.save_as(path)
        an = json.loads(path.read_text()); print("export :", dl.suggested_filename, "· fichiers", len(an["files"]), "· décisions", len(an["decisions"]))
        # recharger : l'historique persiste
        await pg.reload(); await pg.wait_for_selector(".kpi"); await pg.click("#tab-historique")
        print("après rechargement :", await pg.locator(".hrow").count(), "versions")
        # nouvelle analyse (garde-fou car démo non modifiée ? -> pas de garde-fou)
        await pg.click("[data-act=new]"); await pg.wait_for_timeout(100)
        print("nouvelle analyse :", await pg.inner_text("#sub"))
        await pg.set_input_files("#fileinput", [str(f) for f in sorted((ROOT / "data").glob("*.xlsx"))])
        await pg.wait_for_selector(".kpi .v"); print("S39 chargée :", await pg.locator(".kpi").nth(2).inner_text())
        # repartir de la version enregistrée -> garde-fou
        await pg.click("#tab-historique")
        await pg.locator(".hrow", has_text="Semaine 40 test").locator("[data-hact=fork]").click()
        print("garde-fou :", await pg.locator(".guard").count())
        await pg.click("[data-act=guard-go]"); await pg.wait_for_timeout(200)
        print("fork :", await pg.inner_text("#sub"), "· nom", await pg.input_value("#an-name"))
        # remplacement d'un fichier de même nom
        await pg.set_input_files("#fileinput", [str(ROOT / "data/Inventaire_physique_Anode.xlsx")])
        await pg.wait_for_timeout(200)
        print("fichiers après remplacement :", await pg.locator(".file").count())
        # import json d'analyse
        await pg.set_input_files("#fileinput", [str(path)]); await pg.wait_for_timeout(300)
        # suppression en 2 temps
        await pg.click("#tab-historique")
        n0 = await pg.locator(".hrow").count()
        await pg.locator(".hrow", has_text="Semaine 40 test").first.locator("[data-hact=del]").click()
        await pg.locator("[data-hact=del-ok]").click(); await pg.wait_for_timeout(200)
        print("suppression :", n0, "->", await pg.locator(".hrow").count())
        # comparer à l'exemple
        await pg.locator(".hrow", has_text="Semaine 39 (exemple)").locator("[data-hact=open]").click(); await pg.wait_for_timeout(100)
        if await pg.locator(".guard").count(): await pg.click("[data-act=guard-go]")
        await pg.wait_for_timeout(200); print("ouverte :", await pg.input_value("#an-name"), "·", await pg.inner_text("#sub"))
        async with pg.expect_download() as d:
            await pg.click("[data-act=xlsx]")
        print("export excel :", (await d.value).suggested_filename)
        await pg.set_viewport_size({"width": 390, "height": 800})
        await pg.click("#tab-historique"); await pg.wait_for_timeout(100)
        print("largeur mobile :", await pg.evaluate("document.documentElement.scrollWidth"))
        await pg.screenshot(path=str(OUT / "h_mobile.png"))
        print("erreurs JS :", errs or "aucune")
        await b.close()
asyncio.run(main())
