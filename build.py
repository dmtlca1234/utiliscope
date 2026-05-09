#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Script de build complet pour UtiliScope.
Pipeline en 6 étapes :
  1. Nettoyage des artefacts précédents
  2. Compilation Cython (main_app.py → main_app.so)
  3. Build PyInstaller avec signature intégrée (--codesign-identity)
  4. Vérification de la signature + fallback manuel si nécessaire
  5. Création du DMG professionnel (fond, icônes, compression)
  6. Notarisation Apple (xcrun notarytool + staple)

Approche de signature :
  PyInstaller signe PENDANT le build via --codesign-identity et --osx-entitlements-file.
  C'est l'approche recommandée par PyInstaller, Briefcase et Apple.
  Les entitlements (disable-library-validation, allow-unsigned-executable-memory)
  sont appliqués uniquement à l'exécutable principal, pas aux bibliothèques.
  Un fallback manuel existe si PyInstaller échoue (détection Mach-O + inside-out signing).

Le DMG final inclut :
  - L'application UtiliScope.app positionnée à gauche
  - Un alias vers /Applications positionné à droite (drag-and-drop)
  - Un fond sombre personnalisé généré automatiquement
  - Fenêtre dimensionnée et centrée pour un look pro

Usage : python3 build.py
Prérequis : Xcode CLI tools, PyInstaller, Cython, certificat Developer ID, entitlements.plist
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# --- CONFIGURATION ---
APP_NAME = "UtiliScope Beta"
LAUNCHER_SCRIPT = "color_meter.py"
SETUP_SCRIPT = "setup.py"
ICON_FILE = "ColorScopes.icns"
BUNDLE_ID = "com.studiodmtl.utiliscope"

# --- NOTARISATION APPLE ---
# Identifiants OBLIGATOIRES via variables d'environnement.
# Définir avant le build :
#   export APPLE_ID="votre-apple-id@icloud.com"
#   export APPLE_TEAM_ID="VOTRE_TEAM_ID"
#   export APPLE_APP_PASSWORD="votre-app-specific-password"
#   export SIGNING_IDENTITY="Developer ID Application: Votre Nom (TEAM_ID)"


def _require_env(name: str) -> str:
    """Récupère une variable d'environnement obligatoire ou lève une erreur."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(
            f"\n❌ Variable d'environnement manquante : {name}\n"
            f"   Définissez-la avant de lancer le build :\n"
            f"   export {name}=\"...\"\n"
        )
    return value


# Credentials — chargés au moment du build (pas à l'import)
APPLE_ID = None
APPLE_TEAM_ID = None
APPLE_APP_PASSWORD = None
SIGNING_IDENTITY = None


def _load_credentials():
    """Charge et valide les credentials depuis les variables d'environnement."""
    global APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD, SIGNING_IDENTITY
    APPLE_ID = _require_env("APPLE_ID")
    APPLE_TEAM_ID = _require_env("APPLE_TEAM_ID")
    APPLE_APP_PASSWORD = _require_env("APPLE_APP_PASSWORD")
    SIGNING_IDENTITY = _require_env("SIGNING_IDENTITY")


# Dimensions et positionnement de la fenêtre du DMG
DMG_WINDOW_WIDTH = 600
DMG_WINDOW_HEIGHT = 450
DMG_ICON_SIZE = 128
# Position des icônes principales : app à gauche, Applications à droite
DMG_APP_ICON_X = 150
DMG_APP_ICON_Y = 170
DMG_APPS_ICON_X = 450
DMG_APPS_ICON_Y = 170
# Position des fichiers supplémentaires (en bas)
DMG_EULA_ICON_X = 200
DMG_EULA_ICON_Y = 340
DMG_WEBLOC_ICON_X = 400
DMG_WEBLOC_ICON_Y = 340

# --- BUILD UNIVERSAL2 ---
# Python.framework officiel (python.org) est un fat binary universal2.
# On utilise sa tranche x86_64 via `arch -x86_64` pour créer un environnement
# Intel séparé avec ses propres dépendances, puis on fusionne les deux apps avec lipo.
X86_PYTHON = "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12"
X86_VENV_DIR = Path("/tmp/utiliscope_x86_env")

# Modules à exclure (même liste pour arm64 et x86_64)
PYINSTALLER_EXCLUDES = [
    "PyQt5", "torch", "torchaudio", "torchvision", "transformers",
    "scipy", "pandas", "sklearn", "matplotlib", "nltk", "sympy",
    "numba", "llvmlite", "sqlalchemy", "onnxruntime", "lightning",
    "fsspec", "tensorboard", "PIL", "av", "soundfile", "jinja2",
    "pygments", "OpenGL",
]


def run_command(cmd, check=True):
    """Exécute une commande shell et affiche le résultat. Arrête le script en cas d'erreur."""
    print(f"  Exécution : {cmd}")
    try:
        subprocess.run(cmd, shell=True, check=check, text=True)
        print(f"  Commande réussie.")
    except subprocess.CalledProcessError as e:
        print(f"  ERREUR LORS DE L'EXÉCUTION (code {e.returncode}). Arrêt.")
        sys.exit(1)


def setup_x86_env():
    """
    Crée un venv Python x86_64 (Intel) avec toutes les dépendances de l'app.
    Réutilise l'environnement existant s'il est déjà valide (build suivants rapides).
    Nécessite que Python.framework soit un fat binary universal2 (python.org).
    """
    print("\n--- PRÉPARATION : Environnement x86_64 (Intel) ---")
    pip = X86_VENV_DIR / "bin" / "pip"
    if X86_VENV_DIR.exists() and pip.exists():
        print(f"  Environnement x86_64 existant réutilisé : {X86_VENV_DIR}")
        return
    if X86_VENV_DIR.exists():
        shutil.rmtree(X86_VENV_DIR)

    print("  Création du venv x86_64...")
    subprocess.run(
        f'arch -x86_64 "{X86_PYTHON}" -m venv "{X86_VENV_DIR}"',
        shell=True, check=True, text=True
    )

    packages = [
        "numpy", "PyQt6", "PyQt6-sip", "pyqtgraph",
        "mss", "pyautogui", "rubicon-objc", "requests",
        "cython", "pyinstaller",
    ]
    print("  Installation des dépendances x86_64 (première fois : ~2-5 min)...")
    subprocess.run(
        f'arch -x86_64 "{pip}" install {" ".join(packages)} -q',
        shell=True, check=True, text=True
    )
    print("  Environnement x86_64 prêt.")


def clean():
    """Supprime tous les artefacts de build précédents (dist/, build/, .so, .c, .spec)."""
    print("\n--- ÉTAPE 1/6 : Nettoyage ---")
    paths_to_clean = ["build", "dist", f"{APP_NAME}.spec", "main_app.c", "color_meter.c"]
    for path_str in paths_to_clean:
        path = Path(path_str)
        if path.exists():
            print(f"   Suppression de {path}")
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
    for f in Path(".").glob("main_app.*.so"):
        f.unlink()
    for f in Path(".").glob("color_meter.*.so"):
        f.unlink()


def compile_cython():
    """
    Compile main_app.py et color_meter.py en binaires natifs (.so) via Cython.
    Applique ensuite :
      - strip -x : supprime les symboles locaux du .so (noms de fonctions Python)
        pour rendre le reverse engineering plus difficile (nm/objdump inutiles).
      - suppression des .c intermédiaires : ces fichiers contiennent le code C
        généré par Cython, qui peut révéler la structure du code Python d'origine.
    """
    print("\n--- ÉTAPE 2/6 : Compilation Cython + Protection ---")
    # Compilation en Universal Binary (arm64 + x86_64) pour supporter Intel ET Apple Silicon.
    # La variable ARCHFLAGS indique au compilateur C de produire un fat binary.
    import os as _os
    env = _os.environ.copy()
    env["ARCHFLAGS"] = "-arch arm64"
    print("  Compilation arm64 (Apple Silicon natif, Intel via Rosetta 2)...")
    subprocess.run(
        f'"{sys.executable}" {SETUP_SCRIPT} build_ext --inplace',
        shell=True, check=True, text=True, env=env
    )

    # Strip des symboles locaux des .so compilés
    # -x = supprimer les symboles locaux (noms de fonctions internes __pyx_pw_*)
    # Garde les symboles d'export nécessaires au dynamic linking Python
    so_files = list(Path(".").glob("main_app.*.so")) + list(Path(".").glob("color_meter.*.so"))
    for so_file in so_files:
        print(f"  Strip des symboles : {so_file}")
        run_command(f'strip -x "{so_file}"')

    # Suppression des fichiers .c intermédiaires (contiennent le code source transformé)
    for c_file in ["main_app.c", "color_meter.c"]:
        c_path = Path(c_file)
        if c_path.exists():
            print(f"  Suppression du source C intermédiaire : {c_file}")
            c_path.unlink()


def build_app():
    """
    Assemble l'application .app avec PyInstaller.

    PyInstaller gère la signature automatiquement quand --codesign-identity et
    --osx-entitlements-file sont fournis. C'est l'approche recommandée par PyInstaller,
    Briefcase et Apple : signer PENDANT le build, pas après.

    Avantages vs signature post-build manuelle :
      - PyInstaller détecte TOUS les Mach-O (y compris les exécutables sans extension)
      - Il signe de l'intérieur vers l'extérieur dans le bon ordre automatiquement
      - Les entitlements sont appliqués uniquement à l'exécutable principal (correct)
      - Pas de risque d'oublier des binaires ou de signer dans le mauvais ordre
    """
    print("\n--- ÉTAPE 3/6 : Build PyInstaller + Signature intégrée ---")

    entitlements = Path("entitlements.plist")
    if not entitlements.exists():
        print(f"  ERREUR : {entitlements} non trouvé.")
        print(f"  Ce fichier est requis pour la signature et la notarisation.")
        sys.exit(1)

    excludes = [f"--exclude-module={m}" for m in PYINSTALLER_EXCLUDES]
    cmd_parts = [
        f'"{sys.executable}" -m PyInstaller',
        "--noconfirm", "--windowed", "--clean", "--noupx",
        f'--name "{APP_NAME}"',
        f'--distpath "dist/arm64"',
        f'--workpath "build/arm64"',
        f'--icon "{ICON_FILE}"',
        f'--osx-bundle-identifier "{BUNDLE_ID}"',
        "--target-arch", "arm64",
        f'--codesign-identity "{SIGNING_IDENTITY}"',
        f'--osx-entitlements-file "{entitlements}"',
        "--hidden-import=PyQt6.QtCore",
        "--hidden-import=PyQt6.QtGui",
        "--hidden-import=PyQt6.QtWidgets",
        "--hidden-import=rubicon.objc",
        "--hidden-import=requests",
        "--hidden-import=mss",
        "--hidden-import=pyautogui",
        "--hidden-import=pyqtgraph",
        *excludes,
        LAUNCHER_SCRIPT
    ]

    # Déverrouiller le Trousseau AVANT le build pour éviter les popups
    # pendant que PyInstaller signe les centaines de binaires.
    print("  Déverrouillage du Trousseau...")
    subprocess.run(
        'security unlock-keychain -p "" login.keychain 2>/dev/null',
        shell=True, check=False
    )
    subprocess.run(
        'security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" login.keychain 2>/dev/null',
        shell=True, check=False
    )

    run_command(" ".join(cmd_parts))

    # --- Build x86_64 (Intel) + fusion universal2 ---
    build_app_x86()
    merge_apps_universal2()

    # --- Nettoyage post-build : supprimer les sources Python du bundle ---
    # PyInstaller peut empaqueter des .py/.pyc à côté des .so Cython.
    # On supprime spécifiquement nos fichiers du bundle final fusionné.
    _clean_source_from_bundle()


def build_app_x86():
    """
    Recompile les sources Cython en x86_64 et construit le bundle Intel avec PyInstaller.
    Utilise le venv x86_64 créé par setup_x86_env() pour avoir des dépendances Intel natives.
    """
    print("\n  Build x86_64 (Intel)...")
    x86_python = X86_VENV_DIR / "bin" / "python"
    x86_pyinstaller = X86_VENV_DIR / "bin" / "pyinstaller"

    # Recompiler Cython en x86_64 (écrase les .so arm64 dans le répertoire courant,
    # mais ce n'est pas grave : PyInstaller arm64 a déjà bundlé les .so arm64).
    env = os.environ.copy()
    env["ARCHFLAGS"] = "-arch x86_64"
    subprocess.run(
        f'arch -x86_64 "{x86_python}" {SETUP_SCRIPT} build_ext --inplace',
        shell=True, check=True, text=True, env=env
    )
    for so_file in list(Path(".").glob("main_app.*.so")) + list(Path(".").glob("color_meter.*.so")):
        subprocess.run(f'strip -x "{so_file}"', shell=True, check=False)
    for c_file in ["main_app.c", "color_meter.c"]:
        Path(c_file).unlink(missing_ok=True)

    excludes = [f"--exclude-module={m}" for m in PYINSTALLER_EXCLUDES]
    cmd_parts = [
        f'arch -x86_64 "{x86_pyinstaller}"',
        "--noconfirm", "--windowed", "--clean", "--noupx",
        f'--name "{APP_NAME}"',
        f'--distpath "dist/x86_64"',
        f'--workpath "build/x86_64"',
        f'--icon "{ICON_FILE}"',
        f'--osx-bundle-identifier "{BUNDLE_ID}"',
        "--target-arch", "x86_64",
        "--hidden-import=PyQt6.QtCore",
        "--hidden-import=PyQt6.QtGui",
        "--hidden-import=PyQt6.QtWidgets",
        "--hidden-import=rubicon.objc",
        "--hidden-import=requests",
        "--hidden-import=mss",
        "--hidden-import=pyautogui",
        "--hidden-import=pyqtgraph",
        *excludes,
        LAUNCHER_SCRIPT
    ]
    subprocess.run(" ".join(cmd_parts), shell=True, check=True, text=True)
    print("  Build x86_64 terminé.")


def merge_apps_universal2():
    """
    Fusionne les bundles arm64 et x86_64 en un seul .app universal2 via lipo.
    Chaque binaire Mach-O du bundle est combiné en fat binary (arm64 + x86_64).
    Le résultat tourne nativement sur Apple Silicon ET Intel sans Rosetta 2.
    """
    print("\n  Fusion arm64 + x86_64 → universal2...")
    arm64_app = Path("dist") / "arm64" / f"{APP_NAME}.app"
    x86_app   = Path("dist") / "x86_64" / f"{APP_NAME}.app"
    final_app = Path("dist") / f"{APP_NAME}.app"

    if final_app.exists():
        shutil.rmtree(final_app)

    # Copier le bundle arm64 comme base (structure, icônes, Info.plist, etc.)
    shutil.copytree(arm64_app, final_app, symlinks=True)

    # Parcourir tous les fichiers du bundle x86_64 et lipo les Mach-O correspondants
    find_result = subprocess.run(
        f'find "{x86_app}" -type f',
        shell=True, capture_output=True, text=True
    )

    merged = skipped = 0
    for x86_path_str in find_result.stdout.splitlines():
        x86_file = Path(x86_path_str.strip())
        file_info = subprocess.run(
            f'file "{x86_file}"', shell=True, capture_output=True, text=True
        )
        if "Mach-O" not in file_info.stdout:
            continue

        relative  = x86_file.relative_to(x86_app)
        base_file = final_app / relative
        if not base_file.exists():
            skipped += 1
            continue

        result = subprocess.run(
            f'lipo -create "{base_file}" "{x86_file}" -output "{base_file}"',
            shell=True, capture_output=True, text=True
        )
        if result.returncode == 0:
            merged += 1
        else:
            skipped += 1

    print(f"  {merged} binaires fusionnés, {skipped} ignorés.")

    # Vérification post-fusion : l'exécutable DOIT être universal2
    main_exe = final_app / "Contents" / "MacOS" / APP_NAME
    if main_exe.exists():
        info = subprocess.run(
            f'file "{main_exe}"', shell=True, capture_output=True, text=True
        )
        exe_info = info.stdout.strip()
        print(f"  Exécutable principal : {exe_info}")
        if "universal binary" not in exe_info or "x86_64" not in exe_info or "arm64" not in exe_info:
            print("  ERREUR CRITIQUE : L'exécutable n'est pas universal2 !")
            print("  Le build doit contenir les architectures arm64 ET x86_64.")
            sys.exit(1)
        print("  ✓ Universal Binary vérifié (arm64 + x86_64)")
    else:
        print(f"  ERREUR : Exécutable principal introuvable : {main_exe}")
        sys.exit(1)


def _clean_source_from_bundle():
    """
    Supprime les fichiers .py et .pyc de main_app et color_meter du bundle .app.
    Garde les .so compilés par Cython qui sont la version protégée du code.
    Ne touche pas aux fichiers des bibliothèques tierces (PyQt6, numpy, etc.).
    """
    app_path = Path("dist") / f"{APP_NAME}.app"
    if not app_path.exists():
        return

    our_modules = {"main_app", "color_meter"}
    removed = 0

    for py_file in app_path.rglob("*.py"):
        if py_file.stem in our_modules:
            print(f"  Suppression source exposé : {py_file.name}")
            py_file.unlink()
            removed += 1

    for pyc_file in app_path.rglob("*.pyc"):
        if any(mod in pyc_file.stem for mod in our_modules):
            print(f"  Suppression bytecode exposé : {pyc_file.name}")
            pyc_file.unlink()
            removed += 1

    if removed:
        print(f"  {removed} fichier(s) source/bytecode supprimé(s) du bundle.")
    else:
        print("  Aucun fichier source exposé trouvé dans le bundle (OK).")


def verify_signature():
    """
    Vérifie que PyInstaller a correctement signé l'application pendant le build.

    La signature est maintenant gérée par PyInstaller via --codesign-identity et
    --osx-entitlements-file (voir build_app()). Cette fonction vérifie le résultat
    et nettoie les attributs de quarantaine.

    Vérifications effectuées :
      1. L'app existe dans dist/
      2. La signature est valide (codesign --verify --deep --strict)
      3. Les entitlements sont correctement intégrés
      4. Le Hardened Runtime est activé (requis pour la notarisation)
      5. Nettoyage des attributs de quarantaine

    Si la vérification échoue, on tente une re-signature manuelle en dernier recours.
    """
    print("\n--- ÉTAPE 4/6 : Vérification de la signature ---")
    app_path = Path("dist") / f"{APP_NAME}.app"
    entitlements = Path("entitlements.plist")

    if not app_path.exists():
        print(f"  {app_path} non trouvé.")
        sys.exit(1)

    # Nettoyage des attributs de quarantaine
    run_command(f'xattr -cr "{app_path}"')

    # --- Vérification 1 : Signature valide ---
    print("  Vérification de la signature (--deep --strict)...")
    verify_result = subprocess.run(
        f'codesign --verify --deep --strict "{app_path}"',
        shell=True, capture_output=True, text=True
    )

    if verify_result.returncode != 0:
        print(f"  ATTENTION : La signature PyInstaller a échoué ou est incomplète.")
        print(f"  {verify_result.stderr.strip()}")
        print(f"  Tentative de re-signature manuelle (fallback)...")
        _fallback_sign(app_path, entitlements)
    else:
        print("  Signature valide.")

    # --- Vérification 2 : Entitlements présents ---
    print("  Vérification des entitlements...")
    ent_result = subprocess.run(
        f'codesign -d --entitlements - "{app_path}"',
        shell=True, capture_output=True, text=True
    )
    if "disable-library-validation" in ent_result.stdout or "disable-library-validation" in ent_result.stderr:
        print("  Entitlement disable-library-validation : présent")
    else:
        print("  ATTENTION : disable-library-validation absent !")
        print("  L'app risque l'erreur 'different Team IDs' au lancement.")
        print("  Tentative de re-signature avec entitlements...")
        _fallback_sign(app_path, entitlements)

    # --- Vérification 3 : Hardened Runtime activé ---
    print("  Vérification du Hardened Runtime...")
    flags_result = subprocess.run(
        f'codesign -d --verbose=2 "{app_path}"',
        shell=True, capture_output=True, text=True
    )
    combined_output = flags_result.stdout + flags_result.stderr
    if "runtime" in combined_output.lower():
        print("  Hardened Runtime : activé")
    else:
        print("  ATTENTION : Hardened Runtime non détecté.")
        print("  La notarisation Apple échouera sans Hardened Runtime.")
        print("  Tentative de re-signature avec --options runtime...")
        _fallback_sign(app_path, entitlements)

    print("  Toutes les vérifications passées.")


def _fallback_sign(app_path, entitlements):
    """
    Re-signature manuelle en dernier recours si PyInstaller n'a pas signé correctement.

    Utilise la détection Mach-O par `file` command pour trouver TOUS les binaires,
    pas seulement .so/.dylib. Signe de l'intérieur vers l'extérieur.

    Les entitlements sont appliqués UNIQUEMENT à l'exécutable principal et au bundle
    (pas aux bibliothèques — elles héritent des permissions du processus hôte).
    """
    print("  --- Re-signature manuelle (fallback) ---")

    # Déverrouiller le Trousseau pour éviter les popups répétées
    subprocess.run(
        'security unlock-keychain -p "" login.keychain 2>/dev/null',
        shell=True, check=False
    )
    subprocess.run(
        'security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" login.keychain 2>/dev/null',
        shell=True, check=False
    )

    # --- Étape 1 : Trouver TOUS les binaires Mach-O dans le bundle ---
    # On utilise `file` au lieu de glob sur .so/.dylib car PyInstaller peut
    # empaqueter des exécutables sans extension (Python, helpers, stubs).
    print("  Détection de tous les binaires Mach-O...")
    find_result = subprocess.run(
        f'find "{app_path}" -type f -exec file {{}} \\;',
        shell=True, capture_output=True, text=True
    )
    macho_files = []
    for line in find_result.stdout.splitlines():
        if "Mach-O" in line:
            # Ignorer les lignes "(for architecture ...)" des universal binaries
            # car elles ne sont pas des fichiers séparés
            if "(for architecture" in line:
                continue
            filepath = line.split(":")[0].strip()
            if filepath and filepath not in macho_files:
                macho_files.append(filepath)

    # Trier par profondeur (les plus profonds d'abord = inside-out signing)
    macho_files.sort(key=lambda p: p.count('/'), reverse=True)

    print(f"  {len(macho_files)} binaires Mach-O détectés.")

    # --- Étape 2 : Signer les binaires internes (SANS entitlements) ---
    # Les bibliothèques n'ont pas besoin d'entitlements — elles héritent
    # des permissions de l'exécutable qui les charge.
    main_exe = str(app_path / "Contents" / "MacOS" / APP_NAME)
    internal_files = [f for f in macho_files if f != main_exe]

    print(f"  Signature de {len(internal_files)} binaires internes (sans entitlements)...")
    for i, binary in enumerate(internal_files):
        if (i + 1) % 50 == 0 or (i + 1) == len(internal_files):
            print(f"    [{i + 1}/{len(internal_files)}]")
        result = subprocess.run(
            f'codesign --force --options runtime --timestamp '
            f'--sign "{SIGNING_IDENTITY}" "{binary}"',
            shell=True, capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"  Erreur signature: {result.stderr.strip()}")
            print(f"  Fichier: {binary}")
            sys.exit(1)

    # --- Étape 3 : Signer l'exécutable principal (AVEC entitlements) ---
    # Seul l'exécutable principal a besoin des entitlements. C'est lui qui
    # charge les bibliothèques et qui bénéficie de disable-library-validation.
    if Path(main_exe).exists():
        print(f"  Signature de l'exécutable principal (avec entitlements)...")
        run_command(
            f'codesign --force --options runtime --timestamp '
            f'--entitlements "{entitlements}" '
            f'--sign "{SIGNING_IDENTITY}" "{main_exe}"'
        )

    # --- Étape 4 : Signer le bundle .app (AVEC entitlements) ---
    print("  Signature du bundle .app (avec entitlements)...")
    run_command(
        f'codesign --force --options runtime --timestamp '
        f'--entitlements "{entitlements}" '
        f'--sign "{SIGNING_IDENTITY}" "{app_path}"'
    )

    # Vérification finale
    print("  Vérification post-fallback...")
    run_command(f'codesign --verify --deep --strict "{app_path}"')


def create_dmg():
    """
    Crée un DMG professionnel style classique macOS :
      - Fond natif du Finder (blanc/gris, comme les DMG d'Apple, Sketch, 1Password)
      - Icône de l'app à gauche, alias Applications à droite (drag-and-drop)
      - Fenêtre dimensionnée et positionnée automatiquement
      - Compression UDZO pour un fichier léger
      - Signature du DMG final

    Processus :
      1. Création d'un DMG temporaire en lecture/écriture (UDRW)
      2. Copie de l'app + lien symbolique Applications
      3. Personnalisation via AppleScript (disposition des icônes, taille fenêtre)
      4. Conversion en DMG compressé final (UDZO) + signature
    """
    print("\n--- ÉTAPE 5/6 : Création du DMG ---")

    app_path = Path("dist") / f"{APP_NAME}.app"
    final_dmg_path = Path("dist") / f"{APP_NAME}.dmg"
    temp_dmg_path = Path("dist") / f"{APP_NAME}_temp.dmg"
    volume_name = APP_NAME
    volume_mount = Path(f"/Volumes/{volume_name}")

    # Éjecter tout volume déjà monté avec le même nom (restes d'un build précédent)
    # Cherche aussi les variantes "UtiliScope Beta 1", "UtiliScope Beta 2", etc.
    for existing in Path("/Volumes").glob(f"{volume_name}*"):
        print(f"  Éjection du volume existant : {existing}")
        subprocess.run(f'hdiutil detach "{existing}" -force', shell=True, check=False)
        time.sleep(1)

    # Suppression des anciens DMG
    for p in [final_dmg_path, temp_dmg_path]:
        if p.exists():
            p.unlink()

    # --- Étape 1 : Créer un DMG temporaire en lecture/écriture ---
    print("  Création du DMG temporaire (lecture/écriture)...")

    # Calculer la taille nécessaire (taille de l'app + marge pour les métadonnées)
    app_size_mb = sum(f.stat().st_size for f in app_path.rglob('*') if f.is_file()) // (1024 * 1024)
    dmg_size_mb = app_size_mb + 20  # Marge de 20 Mo pour icônes et métadonnées

    run_command(
        f'hdiutil create -volname "{volume_name}" '
        f'-size {dmg_size_mb}m '
        f'-fs HFS+ '
        f'"{temp_dmg_path}"'
    )

    # --- Étape 2 : Monter, copier les fichiers et personnaliser ---
    print("  Montage du DMG temporaire...")
    run_command(f'hdiutil attach "{temp_dmg_path}" -readwrite -noverify -noautoopen')

    # Copier l'application dans le volume
    print("  Copie de l'application...")
    run_command(f'cp -R "{app_path}" "{volume_mount}/"')

    # Copier le PDF EULA dans le DMG
    eula_pdf = Path("UtiliScope_EULA.pdf")
    if eula_pdf.exists():
        print("  Copie de UtiliScope_EULA.pdf...")
        shutil.copy2(str(eula_pdf), str(volume_mount / "UtiliScope_EULA.pdf"))
    else:
        print("  ATTENTION : UtiliScope_EULA.pdf non trouvé, ignoré.")

    # Copier le raccourci web (.webloc) dans le DMG
    webloc_file = Path("UtiliScope Website.webloc")
    if webloc_file.exists():
        print("  Copie de UtiliScope Website.webloc...")
        shutil.copy2(str(webloc_file), str(volume_mount / "UtiliScope Website.webloc"))
    else:
        print("  ATTENTION : UtiliScope Website.webloc non trouvé, ignoré.")

    # Icône personnalisée du volume DMG
    volume_icon = Path("ColorScopes.icns")
    if volume_icon.exists():
        print("  Application de l'icône personnalisée au volume DMG...")
        shutil.copy2(str(volume_icon), str(volume_mount / ".VolumeIcon.icns"))
        # Activer le flag « custom icon » sur le volume via SetFile
        subprocess.run(f'SetFile -a C "{volume_mount}"', shell=True, check=False)
    else:
        print("  ATTENTION : ColorScopes.icns non trouvé, icône par défaut utilisée.")

    # Créer le lien symbolique vers Applications (pour le drag-and-drop)
    print("  Création du raccourci Applications...")
    apps_link = volume_mount / "Applications"
    if not apps_link.exists():
        os.symlink("/Applications", str(apps_link))

    # --- Étape 3 : Appliquer le style via AppleScript ---
    # AppleScript configure la fenêtre du Finder : taille, position des icônes.
    # Pas de fond personnalisé : le Finder utilise son fond blanc/gris natif
    # (style classique macOS, comme les DMG d'Apple, Sketch, 1Password).
    print("  Application du style visuel via AppleScript...")

    applescript = f'''
    tell application "Finder"
        tell disk "{volume_name}"
            open
            -- Petite pause pour laisser le Finder ouvrir la fenêtre
            delay 1

            set current view of container window to icon view
            set toolbar visible of container window to false
            set statusbar visible of container window to false
            set bounds of container window to {{200, 200, {200 + DMG_WINDOW_WIDTH}, {200 + DMG_WINDOW_HEIGHT}}}

            set viewOptions to the icon view options of container window
            set arrangement of viewOptions to not arranged
            set icon size of viewOptions to {DMG_ICON_SIZE}

            -- Positionnement des icônes : app à gauche, Applications à droite
            set position of item "{APP_NAME}.app" of container window to {{{DMG_APP_ICON_X}, {DMG_APP_ICON_Y}}}
            set position of item "Applications" of container window to {{{DMG_APPS_ICON_X}, {DMG_APPS_ICON_Y}}}

            -- Positionnement des fichiers supplémentaires (en bas)
            try
                set position of item "UtiliScope_EULA.pdf" of container window to {{{DMG_EULA_ICON_X}, {DMG_EULA_ICON_Y}}}
            end try
            try
                set position of item "UtiliScope Website.webloc" of container window to {{{DMG_WEBLOC_ICON_X}, {DMG_WEBLOC_ICON_Y}}}
            end try

            close
            open

            update without registering applications
            delay 1
            close
        end tell
    end tell
    '''

    # Écrire l'AppleScript dans un fichier temporaire et l'exécuter
    with tempfile.NamedTemporaryFile(mode='w', suffix='.applescript', delete=False) as f:
        f.write(applescript)
        script_path = f.name

    try:
        run_command(f'osascript "{script_path}"', check=False)
    finally:
        os.unlink(script_path)

    # Rendre le volume en lecture seule et corriger les permissions
    print("  Finalisation des permissions...")
    run_command(f'chmod -Rf go-w "{volume_mount}"', check=False)

    # --- Étape 4 : Démontage et conversion en DMG compressé ---
    print("  Démontage du volume...")
    # sync pour s'assurer que toutes les écritures sont terminées
    run_command("sync")
    # Le Finder peut garder le volume occupé après l'AppleScript.
    # On tente un détachement propre, puis un force si nécessaire.
    detach_result = subprocess.run(
        f'hdiutil detach "{volume_mount}"',
        shell=True, capture_output=True, text=True
    )
    if detach_result.returncode != 0:
        print("  Le volume est encore occupé, nouvelle tentative dans 3 secondes...")
        time.sleep(3)
        run_command(f'hdiutil detach "{volume_mount}" -force')

    print("  Compression du DMG final (UDZO)...")
    run_command(
        f'hdiutil convert "{temp_dmg_path}" '
        f'-format UDZO -imagekey zlib-level=9 '
        f'-o "{final_dmg_path}"'
    )

    # Nettoyage du DMG temporaire
    temp_dmg_path.unlink(missing_ok=True)

    # --- Étape 5 : Signature du DMG ---
    print("  Signature du DMG...")
    run_command(f'codesign --force --sign "{SIGNING_IDENTITY}" "{final_dmg_path}"')

    # --- Étape 6 : Suppression de l'attribut de quarantaine ---
    # macOS ajoute com.apple.quarantine aux fichiers créés ou téléchargés,
    # ce qui peut empêcher le DMG de s'ouvrir au double-clic avant notarisation.
    print("  Suppression de l'attribut de quarantaine...")
    run_command(f'xattr -cr "{final_dmg_path}"', check=False)

    print(f"\n  DMG professionnel créé : {final_dmg_path}")
    print(f"  Taille : {final_dmg_path.stat().st_size / (1024 * 1024):.1f} Mo")
    print(f"  Si le DMG ne s'ouvre pas au double-clic, exécutez :")
    print(f'    xattr -d com.apple.quarantine "{final_dmg_path}"')


def notarize_dmg():
    """
    Soumet le DMG aux serveurs de notarisation d'Apple via xcrun notarytool.
    La notarisation vérifie que l'app est exempte de malware et correctement signée.
    Une fois approuvée, Apple délivre un "ticket" qui est agrafé (stapled) au DMG.

    Résultat : les utilisateurs peuvent ouvrir l'app sans avertissement Gatekeeper.

    Prérequis :
      - Xcode CLI tools installés
      - Apple ID + mot de passe spécifique à l'app
      - L'app doit être signée avec un certificat Developer ID valide
      - Le DMG doit exister dans dist/
    """
    print("\n--- ÉTAPE 6/6 : Notarisation Apple ---")

    final_dmg_path = Path("dist") / f"{APP_NAME}.dmg"
    if not final_dmg_path.exists():
        print(f"  {final_dmg_path} non trouvé. Impossible de notariser.")
        sys.exit(1)

    # Soumission du DMG aux serveurs Apple
    # --wait : attend la réponse au lieu de revenir immédiatement
    # Temps typique : 2-10 minutes selon la taille et la charge des serveurs
    print("  Soumission du DMG aux serveurs Apple (peut prendre quelques minutes)...")
    result = subprocess.run(
        f'xcrun notarytool submit "{final_dmg_path}" '
        f'--apple-id "{APPLE_ID}" '
        f'--team-id "{APPLE_TEAM_ID}" '
        f'--password "{APPLE_APP_PASSWORD}" '
        f'--wait',
        shell=True, capture_output=True, text=True
    )

    print(result.stdout)
    if result.stderr:
        print(result.stderr)

    if result.returncode != 0:
        print("  La notarisation a échoué.")
        print("  Conseil : vérifiez que votre certificat Developer ID est valide")
        print("  et que le mot de passe app-specific est correct.")
        # On récupère le log détaillé si un ID de soumission est disponible
        # pour aider au diagnostic
        for line in result.stdout.split('\n'):
            if 'id:' in line.lower():
                submission_id = line.split(':')[-1].strip()
                print(f"  Récupération du log de notarisation (ID: {submission_id})...")
                subprocess.run(
                    f'xcrun notarytool log "{submission_id}" '
                    f'--apple-id "{APPLE_ID}" '
                    f'--team-id "{APPLE_TEAM_ID}" '
                    f'--password "{APPLE_APP_PASSWORD}"',
                    shell=True
                )
                break
        sys.exit(1)

    # Vérifier que la notarisation a bien été acceptée
    if "Accepted" not in result.stdout:
        print("  La notarisation n'a pas été acceptée. Voir les détails ci-dessus.")
        sys.exit(1)

    # Agrafe (staple) le ticket de notarisation au DMG
    # Le staple intègre le ticket directement dans le fichier, ce qui permet
    # à Gatekeeper de vérifier la notarisation même hors ligne.
    print("  Agrafage du ticket de notarisation au DMG...")
    run_command(f'xcrun stapler staple "{final_dmg_path}"')

    # Vérification finale
    print("  Vérification du staple...")
    run_command(f'xcrun stapler validate "{final_dmg_path}"')

    print(f"\n  Notarisation réussie ! Le DMG est prêt pour la distribution.")


# --- SCRIPT PRINCIPAL ---
if __name__ == "__main__":
    try:
        _load_credentials()

        print(f"{'='*60}")
        print(f"  BUILD PIPELINE — {APP_NAME}")
        print(f"  Bundle ID : {BUNDLE_ID}")
        print(f"  Signature : {SIGNING_IDENTITY}")
        print(f"  Notarisation : {APPLE_ID} (Team {APPLE_TEAM_ID})")
        print(f"{'='*60}")

        setup_x86_env()    # Prépare l'environnement Intel (réutilisé si déjà créé)
        clean()
        compile_cython()
        build_app()        # arm64 + x86_64 + fusion universal2
        verify_signature() # Vérifie + fallback si nécessaire
        create_dmg()
        notarize_dmg()

        print(f"\n{'='*60}")
        print(f"  BUILD TERMINÉ AVEC SUCCÈS")
        print(f"  1. Application : dist/{APP_NAME}.app")
        print(f"  2. Installateur : dist/{APP_NAME}.dmg (signé + notarisé)")
        print(f"{'='*60}")

    except KeyboardInterrupt:
        print("\n  Annulé par l'utilisateur.")
        # Nettoyage d'urgence : démonter le volume si encore monté
        volume_mount = Path(f"/Volumes/{APP_NAME}")
        if volume_mount.exists():
            subprocess.run(f'hdiutil detach "{volume_mount}"', shell=True, check=False)
        sys.exit(1)