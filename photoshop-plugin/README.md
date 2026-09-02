# UtiliScope for Photoshop

Real-time professional color-measurement panel for Adobe Photoshop — a UXP port of the **UtiliScope** macOS desktop app by David-Olivier Gascon (STUDIO D MTL).

The panel renders a broadcast-style **vectorscope** (BT.709, BT.601, BT.2020, DCI-P3, ARRI) with skin-tone line and qualifier, plus **RGB parade**, **luma waveform**, and **RGB histogram** scopes, computed live from the active Photoshop document. It also provides color readouts (RGB / HEX / CbCr / Luma), color markers with JSON import/export (compatible with the desktop app's `utiliscope_markers.json`), and trace snapshots for before/after comparison.

![UtiliScope panel screenshot](docs/screenshot.png)
*(screenshot placeholder — replace with a capture of the panel docked in Photoshop)*

- Website: https://utiliscope.xyz
- Developer: David-Olivier Gascon — STUDIO D MTL

---

## Feature map — desktop app vs. Photoshop plugin

| Desktop app (macOS) | Photoshop plugin | Notes |
|---|---|---|
| Vectorscope BT.709 / BT.601 / BT.2020 / DCI-P3 / ARRI | ✅ Same color spaces, same matrices | Constants ported verbatim from `main_app.py` |
| Skinline + skin-tone qualifier | ✅ Same angles and tolerance | |
| Vectorscope zoom cycle | ✅ Same zoom steps | |
| **Color under cursor (live screen tracking)** | ❌ **Impossible in UXP** — replaced (see below) | UXP panels cannot read the cursor position over the canvas, and there is no screen capture API |
| Screen-region capture (mss) | ➡️ Whole-**document** scope and **selection** scope via the Photoshop Imaging API | Often more useful for retouching: the scopes read the actual document pixels, not the screen |
| Color info panel (swatch, RGB, HEX, CbCr, Luma) | ✅ Fed by Color Samplers and the eyedropper (foreground color) | |
| Markers (add / clear / export / import JSON) | ✅ Same JSON schema — files interchangeable with the desktop app | |
| Snapshots (freeze trace overlay) | ✅ | |
| Pause / freeze | ✅ | |
| FR / EN interface | ✅ Follows the Photoshop UI locale, manual toggle in the flyout menu | |
| Keyboard shortcuts (M, S, Space, C, Z) | ✅ When the panel has focus | UXP shortcuts are panel-scoped, not global |
| 7-day trial + LemonSqueezy license | ⏳ Deferred to a later version | See "Distribution & licensing strategy" |

### Why "color under cursor" cannot be ported

UXP panels run sandboxed inside Photoshop: they cannot track the mouse over the document canvas, cannot capture the screen, and have no equivalent of `mss`/`pyautogui`. This is a hard platform limit, not a missing feature of this plugin. The plugin replaces it with three native workflows:

1. **Document scope** — the vectorscope/waveform/parade/histogram always reflect the whole active document (downsampled for speed).
2. **Selection scope** — make any selection (marquee, lasso, Select Subject…) and switch the mode to *Selection*: the scopes analyze only the selected pixels.
3. **Point color** — use Photoshop's **Color Samplers** (eyedropper tool, up to 10 click-placed samplers) and the **eyedropper / foreground color**: the info panel shows the sampled color's RGB / HEX / CbCr / Luma, and you can add a marker from it — the same workflow as freezing the cursor color on desktop.

Scope refresh happens on document edits and selection changes (Photoshop fires events on commit, not during a drag), with a 1-second safety poll as a fallback.

---

## Requirements

- **Adobe Photoshop 25.0 or newer** (manifest v5, UXP API version 2).
- macOS or Windows (the plugin is pure JS — no native code).
- For development: **UXP Developer Tools** (free, installed from the Creative Cloud desktop app).

---

## Development setup (UXP Developer Tools)

1. **Install UXP Developer Tools (UDT)**: open the **Creative Cloud desktop app** → *Apps* → search "UXP Developer Tools" → Install. (Direct link: https://creativecloud.adobe.com/apps/download/uxp-developer-tools)
2. **Enable Developer Mode**: launch UDT — it prompts you to enable developer mode on first run (this grants the elevated permissions needed to sideload plugins). Manual fallback on macOS: create `/Library/Application Support/Adobe/UXP/Developer/settings.json` containing `{"developer": true}`.
3. **Start Photoshop** (25.0+). UDT's *Connected Applications* pane should list it.
4. In UDT: **Add Plugin** → browse to this folder's `manifest.json` (`photoshop-plugin/manifest.json`).
5. On the plugin row, open the **••• (Actions)** menu → **Load** (or **Load & Watch** to auto-reload the panel whenever a file changes — recommended while developing).
6. In Photoshop: *Plugins → UtiliScope* to open the panel.
7. To debug: **••• → Debug** opens a Chrome DevTools-style debugger (Console, Sources with breakpoints, Elements, Network). **••• → Logs** shows plugin logs.

No build step: the plugin is vanilla JS with CommonJS `require()` (supported natively by UXP). Edit, save, and Watch reloads it.

Run the pure color-math unit tests with plain Node (no Photoshop needed):

```bash
node test/colorMath.test.js
```

---

## Testing checklist

Before packaging a release, verify in Photoshop 25+:

- [ ] `node test/colorMath.test.js` passes (color matrices, targets, skin angles, luma, hex).
- [ ] Panel opens from *Plugins → UtiliScope*; no errors in the UDT Debug console.
- [ ] With **no document open**: panel shows a clear status message, no crash.
- [ ] Open an image: vectorscope, parade, waveform, histogram all render; pure red lands on the R target box (repeat for G/B/C/M/Y with test swatches).
- [ ] Switch each color space (BT.709 / BT.601 / BT.2020 / DCI-P3 / ARRI): graticule targets and trace re-project.
- [ ] Zoom cycle, skin qualifier toggle, pause, snapshot overlay all work.
- [ ] **Selection mode**: make a selection → scopes reflect only the selection; deselect → falls back to whole document.
- [ ] Place Color Samplers with the eyedropper: readouts appear; foreground-color changes update the swatch; "add marker from sampled color" works.
- [ ] Marker export → JSON file opens in the desktop app (and vice-versa: import a desktop `utiliscope_markers.json`).
- [ ] Copy HEX puts the value on the clipboard.
- [ ] Edits (brush stroke, adjustment layer, undo) refresh the scopes within ~1 s.
- [ ] Language: FR/EN toggle from the flyout menu; strings switch; preference persists after reload.
- [ ] Resize the panel to its minimum (320×480): no clipped controls (toolbar wraps).
- [ ] Light and dark Photoshop UI themes: panel remains legible.
- [ ] Load on both macOS and Windows if possible.

---

## Packaging (.ccx) and installing

A `.ccx` is simply a zip of this plugin folder renamed — there is **no code-signing step for UXP plugins** (ZXP signing is legacy CEP only).

**Package:**

1. Get a **real plugin ID** from the Adobe Developer Distribution portal (https://developer.adobe.com/developer-distribution/): create a UXP plugin listing — it generates the ID. Replace the placeholder `"id": "com.studiodmtl.utiliscope.ps"` in `manifest.json` with it. (The placeholder works for local development and direct sharing, but get a portal ID before any real distribution.)
2. In UXP Developer Tools, on the plugin row: **••• → Package** → choose an output folder → you get `UtiliScope_PS.ccx`.
   (Marketplace submissions also accept "zip the folder contents, rename to `.ccx`".)
3. Bump `"version"` in `manifest.json` for every new package (semver, must increase per marketplace submission).

**Install (end users):**

- **Double-click the `.ccx`** → the Creative Cloud desktop app installs it. For a directly-distributed (non-marketplace) plugin, the user must accept an *"unverified developer"* trust dialog — this is normal and unavoidable; document it in the install guide.
- **Command line** (CC Desktop ≥ 5.7), useful for studios/IT:
  - macOS: `"/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install UtiliScope_PS.ccx`
  - Windows: `"C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" --install UtiliScope_PS.ccx`
- You **cannot** just copy files into a plugins folder (unlike CEP). Updates outside the marketplace are manual: ship a new `.ccx`, users reinstall.

---

## Distribution & licensing strategy

Summary of the research findings (2025–2026) that drive the plan:

**Two channels, both allowed (non-exclusive):**

1. **Adobe Creative Cloud Marketplace** (via the Developer Distribution portal). Adobe reviews the plugin (~10 business days; they test functionality, UI, permissions vs. behavior; paid features need reviewer test credentials; privacy policy + ToS URLs required). Payments are handled by **FastSpring** as merchant of record (VAT/sales tax handled), with a **90% developer / 10% Adobe** revenue split. Supports paid perpetual, subscriptions, "Try Before You Buy", and optional license-code fulfillment.
2. **Direct `.ccx` sales** (own website + LemonSqueezy checkout, like the desktop app). No Adobe review, no revenue share, full price control — the buyer just sees the trust dialog on install.

**⚠️ The two-plugin-ID gotcha (most important operational point):** Creative Cloud Desktop validates the plugin ID against the user's Adobe-account entitlements. If the same ID is listed on the marketplace and a user who did NOT buy it there tries to install a directly-sold `.ccx`, **installation fails**. If you ever sell on both channels, register **two distinct plugin IDs** (one marketplace build, one direct build) on the portal.

**Licensing (LemonSqueezy) — deferred to a later version:**

- v0.1.0 ships **without** any license check and therefore without the `network` permission in `manifest.json`. When the LemonSqueezy integration is added, the manifest must gain:

  ```json
  "requiredPermissions": {
    "network": { "domains": ["https://api.lemonsqueezy.com"] }
  }
  ```

  (UXP permissions are deny-by-default; undeclared domains fail at runtime. HTTPS only on macOS. Prefer explicit domains — `"all"` is unreliable.)

- **There is no stable machine ID in UXP** (no `IOPlatformUUID`, no MAC/serial API, no shell access) — the desktop app's machine-fingerprint approach does not transfer. The plan instead: generate a UUID on first activation, send it as the LemonSqueezy `instance_name`, store the returned `instance_id` + license key in `require('uxp').storage.secureStorage`, and validate `key + instance_id` on launch. `secureStorage` is a *cache*, not durable storage (it can be wiped by updates/reinstalls), so the plugin must gracefully re-validate/re-activate when it is empty, and a self-serve "deactivate old machine" path is recommended.
- **Code protection:** UXP ships plain JS inside a zip — no Cython equivalent. Minify/obfuscate for release and keep the real entitlement decision server-side; assume a determined user can patch a local check.

**Recommended rollout:** start with **direct `.ccx` distribution** via LemonSqueezy (fastest, no review, no cut, reuses the existing UtiliScope store), then add a marketplace listing later under a **separate plugin ID** with FastSpring for discoverability.

---

## File tree

```
photoshop-plugin/
  manifest.json          UXP manifest v5 — plugin identity, PS 25.0+ host, panel
                         entrypoint (utiliscopePanel), sizes, icons, permissions
                         (clipboard + file pickers; NO network in v1)
  index.html             Panel markup: scope sections, info panel, toolbar,
                         status bar (loads only main.js)
  styles.css             Dark HUD theme (bg #2A2B2D, 8px grid) — flexbox only
                         (UXP has no CSS grid, no z-index)
  main.js                Controller: entrypoints.setup, DOM wiring, refresh
                         loop (event listeners + debounce + 1 s safety poll),
                         modes, shortcuts, flyout menu
  src/
    colorMath.js         Pure color math (no UXP imports, runs in plain Node):
                         color-space matrices, targets, skinline — constants
                         ported verbatim from the desktop main_app.py
    sampler.js           All Photoshop reads: imaging.getPixels (document /
                         selection), event subscriptions, color samplers,
                         foreground color
    scopeRenderer.js     Pure-JS rasterization of the four scopes into RGBA
                         buffers, displayed via UXP ImageBlob in <img>
                         elements (UXP canvas cannot do per-pixel drawing)
    markers.js           Marker store + JSON import/export (same schema as the
                         desktop utiliscope_markers.json)
    prefs.js             Preferences persisted in localStorage
    i18n.js              FR/EN translations dictionary + tr()
  icons/
    icon@1x.png (24px), icon@2x.png (48px)      Plugins-panel icon
    panel@1x.png (23px), panel@2x.png (46px)    Panel/toolbar icon
  test/
    colorMath.test.js    Plain-Node unit tests: node test/colorMath.test.js
```

---

# Démarrage rapide (Français)

**UtiliScope pour Photoshop** est le portage en panneau UXP de l'application macOS UtiliScope : vectorscope professionnel (BT.709, BT.601, BT.2020, DCI-P3, ARRI) avec skinline, parade RVB, waveform de luminance et histogramme, calculés en direct sur le document Photoshop actif.

**Prérequis :** Adobe Photoshop **25.0 ou plus récent**.

**Différence importante avec l'app de bureau :** UXP ne permet pas de lire la position du curseur sur le canevas (limite ferme de la plateforme). La « couleur sous le curseur » est remplacée par : l'analyse du **document entier**, l'analyse de la **sélection** active, et les **échantillonneurs de couleur** de Photoshop (pipette, jusqu'à 10 points) + l'écoute de la couleur de premier plan — le panneau d'info affiche RVB / HEX / CbCr / Luma et permet d'ajouter un marqueur depuis la couleur échantillonnée. Les marqueurs sont compatibles avec les fichiers `utiliscope_markers.json` de l'app de bureau.

**Charger le plugin en développement :**

1. Installez **UXP Developer Tools** depuis l'app Creative Cloud (Apps → « UXP Developer Tools »).
2. Lancez UDT et activez le **mode développeur** quand il le propose.
3. Ouvrez Photoshop (25+), puis dans UDT : **Add Plugin** → sélectionnez `photoshop-plugin/manifest.json`.
4. Menu **•••** du plugin → **Load & Watch** (rechargement automatique à chaque sauvegarde). **Debug** ouvre la console de débogage.
5. Dans Photoshop : *Modules externes (Plugins) → UtiliScope*.

**Empaqueter et installer :**

- UDT → **••• → Package** produit un fichier **`.ccx`**. Avant toute distribution réelle, remplacez l'`id` provisoire du manifest par un vrai identifiant obtenu sur le portail Adobe Developer Distribution.
- L'utilisateur final **double-clique le `.ccx`** : Creative Cloud l'installe (avec un dialogue « développeur non vérifié » pour la vente directe — c'est normal). Installation en ligne de commande possible via **UPIA** (`UnifiedPluginInstallerAgent --install`).

**Licence :** la version 0.1.0 ne contient **pas encore** l'activation LemonSqueezy (aucune permission réseau dans le manifest). Elle sera ajoutée plus tard avec `network.domains: ["https://api.lemonsqueezy.com"]`, un identifiant d'instance généré au premier lancement (UXP n'expose **aucun** identifiant machine stable), et un stockage dans `secureStorage`. ⚠️ Si vous vendez à la fois sur le marketplace Adobe (FastSpring, partage 90/10) et en direct, utilisez **deux plugin IDs distincts**, sinon l'installation directe échoue pour les utilisateurs n'ayant pas acheté sur le marketplace.

**Langue :** le panneau suit la langue de Photoshop (FR/EN) et peut être basculé via le menu flyout du panneau.
