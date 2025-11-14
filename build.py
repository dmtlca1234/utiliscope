from pathlib import Path
import shutil
import subprocess
import sys
import argparse
import logging
import shlex

# --- CONFIGURATION ---
APP_NAME = "UtiliScope"
MAIN_SCRIPT = "utiliscope.py"
ICON_FILE = "ColorScopes.icns"
BUNDLE_ID = "com.studiodmtl.utiliscope"


logger = logging.getLogger(__name__)


def run_command(cmd, dry_run=False, check=True):
    """Exécute une commande de façon robuste.

    Args:
        cmd (list|str): commande (préférer liste d'arguments pour sécurité).
        dry_run (bool): si True, n'exécute pas la commande.
        check (bool): si True, lève une exception en cas d'échec.
    """
    # Normaliser la commande en liste pour éviter shell=True
    if isinstance(cmd, str):
        cmd_list = shlex.split(cmd)
    else:
        cmd_list = list(cmd)

    cmd_display = " ".join(shlex.quote(str(x)) for x in cmd_list)
    logger.info("Exécution: %s", cmd_display)
    if dry_run:
        logger.debug("[dry-run] %s", cmd_display)
        return 0

    try:
        res = subprocess.run(cmd_list, check=check)
        return res.returncode
    except subprocess.CalledProcessError as e:
        logger.error("Erreur lors de l'exécution: %s (code=%s)", cmd_display, e.returncode)
        if check:
            raise
        return e.returncode


def clean(dry_run=False):
    logger.info("🧹 Nettoyage des anciens fichiers...")
    for p in (Path("build"), Path("dist"), Path(f"{APP_NAME}.spec")):
        if p.exists():
            logger.debug("Suppression: %s", p)
            if not dry_run:
                if p.is_dir():
                    shutil.rmtree(p)
                else:
                    p.unlink()


def build_app(script=None, dry_run=False):
    logger.info("🔨 Compilation de l'application...")
    script = script or MAIN_SCRIPT
    main = Path(script)
    if not main.exists():
        logger.error("Fichier principal introuvable: %s", script)
        raise SystemExit(1)

    # --noupx est important pour le temps de lancement
    # Construire la commande comme liste d'arguments (safe)
    cmd = [
        "pyinstaller",
        "--noconfirm",
        "--windowed",
        "--clean",
        "--noupx",
        "--name",
        APP_NAME,
        "--icon",
        ICON_FILE,
        "--osx-bundle-identifier",
        BUNDLE_ID,
        "--hidden-import",
        "rubicon.objc",
        "--hidden-import",
        "requests",
        "--hidden-import",
        "mss",
        "--hidden-import",
        "pyautogui",
        script,
    ]

    return run_command(cmd, dry_run=dry_run)


def fix_gatekeeper(dry_run=False):
    logger.info("🛡️ Correction des permissions macOS (Gatekeeper)...")
    app_path = Path("dist") / f"{APP_NAME}.app"
    if not app_path.exists():
        logger.warning("L'application n'a pas été trouvée: %s", app_path)
        return

    run_command(["xattr", "-cr", str(app_path)], dry_run=dry_run)
    run_command(["codesign", "--force", "--deep", "--sign", "-", str(app_path)], dry_run=dry_run)


def create_dmg(dry_run=False):
    logger.info("📦 Création du fichier DMG...")
    app_path = Path("dist") / f"{APP_NAME}.app"
    dmg_path = Path("dist") / f"{APP_NAME}.dmg"
    if not app_path.exists():
        logger.error("❌ L'application n'a pas été trouvée dans dist/: %s", app_path)
        return

    dmg_cmd = (
        f'create-dmg '
        f'--volname "{APP_NAME} Installer" '
        f'--window-pos 200 120 '
        f'--window-size 600 400 '
        f'--icon-size 100 '
        f'--icon "{APP_NAME}.app" 175 120 '
        f'--hide-extension "{APP_NAME}.app" '
        f'--app-drop-link 425 120 '
        f'"{dmg_path}" '
        f'"{app_path}"'
    )

    if shutil.which("create-dmg"):
        # dmg_cmd is built as string components; build list safely
        dmg_list = [
            "create-dmg",
            "--volname",
            f"{APP_NAME} Installer",
            "--window-pos",
            "200",
            "120",
            "--window-size",
            "600",
            "400",
            "--icon-size",
            "100",
            "--icon",
            f"{APP_NAME}.app",
            "175",
            "120",
            "--hide-extension",
            f"{APP_NAME}.app",
            "--app-drop-link",
            "425",
            "120",
            str(dmg_path),
            str(app_path),
        ]
        run_command(dmg_list, dry_run=dry_run)
    else:
        logger.warning("'create-dmg' n'est pas installé. Le .app est prêt mais pas le .dmg.")
        logger.info("Installez-le avec : brew install create-dmg")


def parse_args(argv=None):
    p = argparse.ArgumentParser(description="Script de build pour l'application macOS")
    p.add_argument("--no-clean", action="store_true", help="Ne pas supprimer les dossiers build/dist avant")
    p.add_argument("--no-dmg", action="store_true", help="Ne pas créer le DMG à la fin")
    p.add_argument("--dry-run", action="store_true", help="Afficher les commandes sans exécuter")
    p.add_argument("--verbose", "-v", action="count", default=0, help="Augmenter la verbosité (répéter pour plus)")
    p.add_argument("--script", "-s", default=MAIN_SCRIPT, help="Fichier script principal à compiler (défaut: %(default)s)")
    return p.parse_args(argv)


def setup_logging(verbosity: int):
    level = logging.WARNING
    if verbosity >= 2:
        level = logging.DEBUG
    elif verbosity == 1:
        level = logging.INFO
    logging.basicConfig(level=level, format="%(message)s")


def main(argv=None):
    args = parse_args(argv)
    setup_logging(args.verbose)

    logger.info("🚀 Démarrage du processus de build Automatique")
    if not args.no_clean:
        clean(dry_run=args.dry_run)

    build_app(dry_run=args.dry_run)
    fix_gatekeeper(dry_run=args.dry_run)

    if not args.no_dmg:
        create_dmg(dry_run=args.dry_run)

    logger.info("\n✅ SUCCÈS ! Les artefacts sont dans le dossier 'dist'.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        logger.warning("Interrompu par l'utilisateur")
        sys.exit(2)