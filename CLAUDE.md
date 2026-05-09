# UtiliScope — Contexte du projet

## Description
UtiliScope est une application macOS de mesure colorimétrique professionnelle en temps réel.
Elle affiche un vectorscope (BT.709, BT.601, BT.2020, ARRI, DCI-P3) avec skinline,
analyse la couleur sous le curseur, et offre des outils de capture, marqueurs et snapshots.
Destinée aux photographes, coloristes et vidéastes.

Version actuelle : Beta v1.2
Développeur : David-Olivier Gascon — STUDIO D MTL
Site web : https://manoirs.ca/en/ | https://utiliscope.xyz

## Stack technique
- Python 3.12 (universal2 — arm64 + x86_64)
- PyQt6 (GUI)
- pyqtgraph (vectorscope)
- NumPy (calculs couleur)
- mss (capture écran)
- pyautogui (position curseur)
- Cython (compilation .so pour protection du code)
- PyInstaller (packaging .app)
- LemonSqueezy (licence commerciale, API activation)

## Architecture des fichiers

### Fichiers principaux
- `main_app.py` — Code principal (~2300 lignes). Contient TOUT : UI, vectorscope, licence, trial, traductions, préférences.
- `color_meter.py` — Lanceur minimal qui importe main_app.so et appelle main().
- `build.py` — Pipeline de build en 6 étapes (clean, Cython, PyInstaller, codesign, DMG, notarisation).
- `setup.py` — Configuration Cython pour compiler main_app.py et color_meter.py en .so.

### Ressources
- `ColorScopes.icns` — Icône de l'app (pipette, toutes tailles macOS 16-1024px).
- `entitlements.plist` — Entitlements macOS (disable-library-validation + allow-unsigned-executable-memory).
- `UtiliScope Beta.spec` — Fichier spec PyInstaller.
- `UtiliScope_EULA.docx` — EULA bilingue FR/EN.
- `pipette.png` — Source de l'icône.

## Structure de main_app.py

### Classes principales (dans l'ordre du fichier)
1. `TrialManager` — Gère le trial de 7 jours via le Keychain macOS (commande `security`).
2. `LemonSqueezyLicense(QObject)` — Activation/validation de licence via API LemonSqueezy.
3. `LicenseWindow(QDialog)` — Fenêtre d'activation de clé de licence.
4. `UserPreferences` — Sauvegarde/restauration des préférences en JSON dans ~/Library/Application Support/UtiliScope/.
5. `ColorMeterApp(QMainWindow)` — Fenêtre principale : vectorscope, info couleur, toolbar, status bar.
6. `Splash` — Écran de chargement au démarrage.
7. `LoaderThread(QThread)` — Chargement lazy de NumPy et pyqtgraph en arrière-plan.

### Système d'internationalisation
- Dictionnaire `TRANSLATIONS` avec clés `'fr'` et `'en'` (~70 clés chacune).
- Variable globale `CURRENT_LANG` initialisée depuis UserPreferences.
- Fonction `tr(key)` retourne la traduction pour la langue active.
- Changement de langue : via Réglages, prend effet au prochain lancement.

### Système de trial (7 jours)
- `TrialManager` stocke la date de début dans le Keychain macOS (service: com.studiodmtl.utiliscope.trial).
- Premier lancement : dialogue d'accueil avec 2 options ("Essai gratuit 7 jours" / "Acheter une licence").
- Pendant le trial : bannière orange en haut de l'app avec jours restants + lien "Acheter une licence" vers utiliscope.xyz.
- Trial expiré : dialogue bloquant avec options "Acheter" / "J'ai une clé" / "Quitter".

### Système de licence
- LemonSqueezy API : activation via POST https://api.lemonsqueezy.com/v1/licenses/activate
- Machine ID : hash SHA256 de IOPlatformUUID + platform info.
- Licence locale : stockée en JSON dans ~/Library/Application Support/UtiliScope/.ls_license.
- Dev backdoor : ENABLE_DEV_BACKDOOR = False (mettre True pour dev, clé via $UTILISCOPE_DEV_KEY).

### Logique de démarrage (main())
1. Licence valide ? → run_app() directement.
2. Pas de licence, premier lancement ? → dialogue d'accueil (trial ou acheter).
3. Pas de licence, trial actif ? → run_app() avec bannière trial.
4. Pas de licence, trial expiré ? → dialogue "licence nécessaire".

### Protection du code
- Cython : main_app.py et color_meter.py compilés en .so natifs.
- Directives Cython : embedsignature=False, emit_code_comments=False.
- Strip symbols : `strip -x` sur les .so après compilation.
- Anti-tampering : `_verify_bundle_integrity()` vérifie codesign au lancement (seulement si l'app est signée).
- Post-build : suppression des .py/.pyc du bundle .app.
- Fichiers .c intermédiaires supprimés après compilation.

### UI / Design
- Dark HUD theme (fond #2A2B2D).
- Apple HIG 8px grid : tous les spacings en multiples de 8.
- Boutons minimalistes (transparents, hover gris).
- Color swatches 56x56px.
- Vectorscope avec marqueurs R/G/B/C/M/Y et skinline.

## Pipeline de build (build.py)

### Étapes
1. Clean : supprime build/, dist/, .so, .c
2. Cython : compile avec ARCHFLAGS="-arch arm64 -arch x86_64" + strip -x + supprime .c
3. PyInstaller : --target-arch universal2, --codesign-identity, --windowed, --onedir
4. Vérification codesign : codesign --verify --deep --strict + fallback manuel
5. DMG : hdiutil create avec fond personnalisé, positions d'icônes, alias /Applications
6. Notarisation : xcrun notarytool submit + staple

### Configuration codesign/notarisation
- Apple ID : via $APPLE_ID
- Team ID : via $APPLE_TEAM_ID
- App-specific password : via $APPLE_APP_PASSWORD (pour notarytool)
- Signing identity : via $SIGNING_IDENTITY
- Bundle ID : com.studiodmtl.utiliscope

## Dépendances pip
PyQt6, pyqtgraph, mss, pyautogui, requests, numpy, cython, pyinstaller, pyperclip

## Commandes utiles

### Lancer en mode dev
```bash
python3.12 main_app.py
```

### Build complet
```bash
python3.12 build.py
```

### DMG seul (sans build)
```bash
hdiutil create -volname "UtiliScope Beta" -srcfolder dist/UtiliScope\ Beta.app -ov -format UDZO "dist/UtiliScope_Beta.dmg"
```

### Vérifier que le build est universal2
```bash
file dist/UtiliScope\ Beta.app/Contents/MacOS/UtiliScope\ Beta
```

### Réinitialiser le trial (pour tester)
```bash
security delete-generic-password -s "com.studiodmtl.utiliscope.trial" -a "trial_start"
```

### Supprimer la licence locale (pour tester)
```bash
rm ~/Library/Application\ Support/UtiliScope/.ls_license
```

## Audit et robustesse (avril 2026)
- Validation licence : migré de threading.Thread vers QThread (compatibilité macOS, évite SIGABRT).
- Gestion de crash global : signal handler (SIGTERM, SIGINT) + atexit pour libérer mss/timer.
- closeEvent : timer.stop() appelé AVANT sct.close() pour éviter les callbacks sur ressources détruites.
- mss init protégé : message d'erreur clair si capture d'écran échoue (permissions macOS).
- Fenêtre hors écran : vérification des limites de l'écran avant restauration de position.
- Trial : calcul précis avec total_seconds() au lieu de elapsed.days.
- main() : try/except global autour trial/licence avec fallback (l'app se lance quand même).
- IORegistry : parsing défensif (len(parts) > 3) pour les vieux Mac.
- Bare except remplacés par exceptions spécifiques partout.
- SECRET_KEY : défini dans tous les cas via $UTILISCOPE_DEV_KEY (évite AttributeError).
- primaryScreen() : null-check ajouté partout.
- URLs : toutes en HTTPS.
- LicenseWindow + LicenseValidationThread : tous les textes traduits FR/EN via tr().
- build.py : credentials via variables d'environnement, vérification post-fusion universal2.
- LICENSE.txt inclus dans le DMG.

## Notes importantes
- Python DOIT être universal2 (installé depuis python.org, pas Homebrew) pour le build.
- La vérification anti-tampering ne bloque que si l'app est signée avec Developer ID. En mode dev/ad-hoc, elle est ignorée.
- Le EULA est bilingue (FR en premier, EN en second) et affiché dans l'app via le bouton "Licence" dans la fenêtre Aide.
- Attribution Flaticon en bas de la fenêtre Aide : "Pipette icons created by Freepik - Flaticon".
- Le changement de langue prend effet au prochain lancement (stocké dans preferences.json).
