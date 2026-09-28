"""Point d'entrée Railway : construit l'app web puis lance le serveur sur $PORT."""
import os
import runpy
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
runpy.run_path(str(ROOT / "build.py"), run_name="__main__")

import uvicorn  # noqa: E402

uvicorn.run("server.app:app", host="0.0.0.0", port=int(os.environ.get("PORT", "8000")),
            proxy_headers=True, forwarded_allow_ips="*", log_level="info")
