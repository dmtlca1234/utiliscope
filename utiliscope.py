import os
import shutil
import subprocess
import sys
import argparse
import logging
from pathlib import Path

# --- CONFIGURATION ---
APP_NAME = "UtiliScope"
MAIN_SCRIPT = "utiliscope.py"
ICON_FILE = "ColorScopes.icns"
BUNDLE_ID = "com.studiodmtl.utiliscope"

# Configuration du logger
logger = logging.getLogger("build")

def run_command(cmd, dry_run=False, check=True):
    """Exécute une commande shell de façon robuste."""
    logger.info(f"👉 Exécution : {cmd}")
    if dry_run:
        return 0

    try:
        # shell=True permet d'utiliser les commandes comme dans le terminal
        subprocess.run(cmd, shell=True, check=check)
    except subprocess.CalledProcessError as e:
        logger.error(f"❌ Erreur lors de la commande : {cmd}")
        if check:
            sys.exit(1)

def clean(dry_run=False):
    logger.info("🧹 Nettoyage des anciens fichiers...")
    paths_to_clean = ["build", "dist", f"{APP_NAME}.spec"]
    
    for path_str in paths_to_clean:
        path = Path(path_str)
        if path.exists():
            logger.info(f"   Suppression de {path}")
            if not dry_run:
                if path.is_dir():
                    shutil.rmtree(path)
                else:
                    path.unlink()

def build_app(dry_run=False):
    logger.info("🔨 Compilation de l'application...")
    
    if not Path(MAIN_SCRIPT).exists():
        logger.error(f"❌ Le fichier {MAIN_SCRIPT} est introuvable !")
        sys.exit(1)

    # --noupx est CRUCIAL pour la vitesse de lancement sur macOS
    cmd = (
        f'pyinstaller --noconfirm --windowed --clean --noupx '
        f'--name "{APP_NAME}" '
        f'--icon "{ICON_FILE}" '
        f'--osx-bundle-identifier "{BUNDLE_ID}" '
        f'--hidden-import "rubicon.objc" '
        f'--hidden-import "requests" '
        f'--hidden-import "mss" '
        f'--hidden-import "pyautogui" '
        f'"{MAIN_SCRIPT}"'
    )
    run_command(cmd, dry_run=dry_run)

def fix_gatekeeper(dry_run=False):
    logger.info("🛡️ Correction des permissions macOS (Gatekeeper)...")
    app_path = Path("dist") / f"{APP_NAME}.app"
    
    if not app_path.exists() and not dry_run:
        logger.error(f"❌ L'application n'a pas été trouvée : {app_path}")
        return

    # Enlève les attributs de quarantaine (empêche le message "endommagé")
    run_command(f'xattr -cr "{app_path}"', dry_run=dry_run)
    # Signature ad-hoc (pour que ça tourne localement)
    run_command(f'codesign --force --deep --sign - "{app_path}"', dry_run=dry_run)

def create_dmg(dry_run=False):
    logger.info("📦 Création du fichier DMG...")
    
    app_path = Path("dist") / f"{APP_NAME}.app"
    dmg_path = Path("dist") / f"{APP_NAME}.dmg"

    if not app_path.exists() and not dry_run:
        logger.error("❌ Impossible de créer le DMG : .app introuvable.")
        return

    # Commande create-dmg
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
        run_command(dmg_cmd, dry_run=dry_run)
    else:
        logger.warning("⚠️ 'create-dmg' n'est pas installé. Le .app est prêt, mais pas le .dmg.")
        logger.info("   Installez-le avec : brew install create-dmg")

def main():
    # Configuration des arguments de ligne de commande
    parser = argparse.ArgumentParser(description="Script de build UtiliScope")
    parser.add_argument("--no-clean", action="store_true", help="Ne pas nettoyer avant de compiler")
    parser.add_argument("--no-dmg", action="store_true", help="Ne pas créer le DMG (juste le .app)")
    parser.add_argument("--dry-run", action="store_true", help="Voir les commandes sans les exécuter")
    
    args = parser.parse_args()

    # Configuration du logging
    logging.basicConfig(level=logging.INFO, format='%(message)s')

    print("🚀 Démarrage du processus de build Automatique")
    
    if not args.no_clean:
        clean(dry_run=args.dry_run)
    
    build_app(dry_run=args.dry_run)
    fix_gatekeeper(dry_run=args.dry_run)
    
    if not args.no_dmg:
        create_dmg(dry_run=args.dry_run)
    
    print(f"\n✅ SUCCÈS ! Votre application est prête dans le dossier 'dist/'.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n🛑 Annulé par l'utilisateur.")
        sys.exit(1)