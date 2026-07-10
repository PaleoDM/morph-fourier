# Morph-Fourier — Shape Analysis Pipeline

A Mac app that walks you through a whole 2D shape analysis: curate your photos, teach the app what a good result looks like on a handful of examples, let it auto-process the rest, review and fix anything it got wrong — and then it computes elliptic Fourier descriptors, runs PCA, and gives you an interactive morphospace plot. Everything runs locally in one web app on your own machine.

This is the next generation of the old "Whale Hyoids" Streamlit app. Same math, much nicer editing tools, and — the big change — **you no longer hand-process every single photo.** You teach it on a diverse few and it does the bulk of the work.

**Current use:** the fused basihyoid+thyrohyoid ("basithyoid") bones, dorsal and ventral views — the same photos as before.

> **New to the terminal?** This guide assumes nothing. Every command is one line you copy-paste and press Return. If you used the old hyoid app, this will feel familiar — the setup rhythm is the same, and there's a troubleshooting section at the bottom for the usual Mac hiccups.

---

## Contents

1. [The big idea: Prime → Automate → Review](#the-big-idea-prime--automate--review)
2. [First-time setup](#first-time-setup-one-time)
3. [Pointing the app at your photos](#pointing-the-app-at-your-photos)
4. [Launching the app](#launching-the-app)
5. [Bringing your old curation across](#bringing-your-old-curation-across-optional)
6. [The eight stages, step by step](#the-eight-stages-step-by-step)
7. [Sending your progress back](#sending-your-progress-back)
8. [Troubleshooting](#troubleshooting)

---

## The big idea: Prime → Automate → Review

The old app made you do **every** stage by hand for **every** specimen: orient all ~48, crop all ~48, mask all ~48. Slow.

The new app works differently, and this is the whole point:

1. **Prime** — you fully process a small, *diverse* handful of specimens (say 5–15): crop, mask, and orient each one yourself in a guided editor. These become the app's "training examples" — its reference for what a correct result looks like.
2. **Automate** — you click one button and the app processes *all the remaining* specimens automatically, matching each one against your primed examples to crop, orient, and mask it.
3. **Review** — the app shows you every auto-result, **flagged ones first** (the specimens it wasn't confident about). You fix those, spot-check the rest, and lock it in.

So instead of hand-processing 48 bones, you carefully do ~10 and then supervise. The goal is for the app to nail 75–80% on its own and for you to only touch the tricky ones.

Everything after that (Gallery, EFA, PCA, Morphospace) is analysis — same as before, no per-specimen handwork.

---

## First-time setup (one-time)

You'll do these steps once. From then on you only launch the app (one command) to work.

You need **two** things installed: **Python** (you already have this from the old hyoid app) and **Node.js** (new — the app's interface is built on it). The setup script checks for both and sets up everything else.

### 1. Check Python 3

This app needs **Python 3.10, 3.11, 3.12, or 3.13**. You almost certainly already have one from the hyoid project. To check, open **Terminal** (press **Cmd-Space**, type "Terminal", press Return) and paste:

```bash
python3.13 --version
```

If you see `Python 3.13.x` (or `3.10`/`3.11`/`3.12`), you're set — skip to step 2.

If it says "command not found," install Python 3.13:

1. Go to https://www.python.org/downloads/release/python-3135/ (this is the 3.13 page — do **not** use the homepage's big "Download 3.14" button; PyTorch doesn't support 3.14 yet)
2. Scroll to the bottom, download **macOS 64-bit universal2 installer** (`.pkg`), and run it
3. Close and reopen Terminal, then re-run `python3.13 --version` to confirm

### 2. Install Node.js (new)

The app's interface needs **Node.js** — this is the one new thing versus the old app.

In Terminal:

```bash
node --version
```

If you see a version number (anything v18 or higher), skip to step 3.

If it says "command not found":

1. Go to https://nodejs.org/
2. Download the **LTS** version (the left-hand button — "Recommended for Most Users")
3. Run the `.pkg` installer and follow it
4. Close and reopen Terminal, then re-run `node --version` to confirm

### 3. Get the project

If Carlos gave you a `git clone` link, clone it onto your machine (not into Desktop or Documents — iCloud can evict files there; use your home folder or Downloads):

```bash
cd ~
git clone <the-github-url-carlos-gives-you> whale-hyoids
cd whale-hyoids/apps/morph-fourier
```

If you already have the repo from before, just update it and move into the app folder:

```bash
cd ~/whale-hyoids        # wherever your copy lives
git pull
cd apps/morph-fourier
```

> **Where you run commands matters now.** This app lives in a subfolder, `apps/morph-fourier`, because the repo holds two apps side by side. All the commands below assume you're **inside `apps/morph-fourier`**. If a command isn't found, run `pwd` — it should end in `.../whale-hyoids/apps/morph-fourier`.

### 4. Run the setup script

From inside `apps/morph-fourier`:

```bash
./setup.command
```

This creates a Python environment, installs all the Python libraries, installs the Node.js libraries, and downloads the SAM model file (~375 MB). It's safe to re-run anytime. Total time: **5–10 minutes** — grab coffee.

When it finishes you'll see `✅ Setup complete!`.

---

## Pointing the app at your photos

Unlike the old app, the photos **don't live inside this repo** — they're too big and they're shared to you separately (via Dropbox). You tell the app where they are, once.

The app treats **every subfolder** of its photos folder as one "series" (the new, general word for what used to be a "view"). So point it at the folder that contains your two view folders:

```
your photos folder/
├── Fused B-T (Dorsal view)/     ← becomes the "dorsal" series
│   ├── Megaptera_13656_2.jpg
│   └── ...
└── Fused B-T (Ventral view)/    ← becomes the "ventral" series
    └── ...
```

**Simplest option (recommended): copy your two view folders into the app's `photos/` folder.** In Finder, open your Dropbox photos folder, and copy `Fused B-T (Dorsal view)` and `Fused B-T (Ventral view)` into `apps/morph-fourier/photos/`. Then the app finds them automatically with zero configuration.

> **Keep the folder names exactly as they are** — `Fused B-T (Dorsal view)` and `Fused B-T (Ventral view)`. The app derives each series' internal name from the folder name, and (if you migrate your old curation, below) those names have to match up. Renaming a folder here means starting curation fresh for it.

**Alternative (avoids duplicating ~545 MB): tell the app where the photos already are.** Instead of copying, set an environment variable before launching, pointing at the folder that holds the two view folders:

```bash
export MORPH_FOURIER_PHOTOS_ROOT="/Users/you/Dropbox/.../Cetacean hyoids"
./run-prod.command
```

You'd need to re-run that `export` line each time you open a new Terminal. Copying into `photos/` avoids that entirely, so start there unless disk space is tight.

---

## Launching the app

From inside `apps/morph-fourier`, run:

```bash
./run-prod.command
```

The first launch builds the interface (takes a minute); later launches are quicker. When you see the banner, open your browser to:

**http://localhost:8000**

That's the whole app. To stop it, press **Ctrl-C** in the Terminal window, or just close the window.

> **You can also double-click `run-prod.command` in Finder.** If macOS blocks it with "cannot be opened because Apple cannot check it for malicious software," right-click the file → **Open** → confirm. You only do this once per file. (See troubleshooting if it still won't run.)

> **⚠️ Important if you use VS Code:** don't run the app from VS Code's built-in terminal. VS Code's Python extension likes to "helpfully" activate a Python environment in the terminal — it does this by sending a Ctrl-C followed by an activate command, which **kills the running app server out from under you**. Run from the regular **Terminal.app** instead (Cmd-Space → "Terminal"). If you really want to use VS Code's terminal, first turn that behavior off: open Settings, search `python.terminal.activateEnvironment`, and uncheck it. See troubleshooting for the symptom.

---

## Bringing your old curation across (optional)

If you already did **Stage 1 (Curation)** — the accept/reject/canonical decisions — in the old hyoid app, you don't have to redo it. There's a one-time converter that reads your old `curation.json` and loads those decisions into the new app.

> **Do this first — before you start curating in the new app.** The converter *replaces* the new app's curation for each series with your old decisions. Run it up front on a clean install and you're safe. (If you ever run it after you've already done some curating here, it won't lose that work silently — it copies the current file to a `curation.json.bak` next to it first — but the tidy path is simply: migrate first, then open the app.)

You need the old `curation.json` file. **It's probably at the top level of your old hyoid folder** — e.g. `~/whale-hyoids/curation.json` or wherever you cloned the old project before the app was split in two. (It predates the reorganization, so it won't be down inside `apps/`.)

From inside `apps/morph-fourier`, run the converter and give it the path:

```bash
./migrate_curation.command ~/whale-hyoids/curation.json
```

Or just double-click `migrate_curation.command` in Finder — it'll prompt you for the file (you can drag the file from Finder into the Terminal window to paste its path). To preview without changing anything, add `--dry-run`.

It splits your decisions into the new per-series format and reports what it did. When you next open the app, Stage 1 will already show your accept/reject/canonical marks.

> If you're not sure where your old file is, or you'd rather not risk it, send the `curation.json` to Carlos and he'll run the conversion and hand it back — it's a 5-second job on his side.

---

## The eight stages, step by step

The app has eight stages down the left rail: **Curation → Prime → Automate → Review → Gallery → EFA → PCA → Morphospace**. Work through them in order; each one builds on the last. Pick your series (dorsal or ventral) at the top — the two are analyzed completely separately, exactly as before.

### Stage 1 — Curation

**Goal:** for each specimen, decide which photos are usable and pick exactly one "canonical" — the single photo the app will actually analyze.

For each photo: mark **Accept / Reject** (with a reason — occluded, wrong view, out of focus, duplicate, not fully in view, other), and for accepted photos, **mark one as canonical** per specimen. Decisions save automatically.

(If you migrated your old curation, this is already filled in — just glance through it.)

### Stage 2 — Prime  ⭐ the new part

**Goal:** fully process a small, **diverse** training set so the app learns what "correct" looks like.

You'll see a counter — "*N of ~K primed*" — telling you how many examples the app wants (it scales with your dataset, usually 5–15). Click any specimen to open the guided editor and process it end to end:

1. **Crop** — drag the box around the bone.
2. **Mask** — the app proposes an outline with SAM; drag the anchor points to refine it (this is the pen-tool editor — much nicer than the old click-seeding).
3. **Orient** — rotate so anterior is up, long axis horizontal (same convention as always).
4. **Save** — it joins your training set.

**Pick a spread, not the easy ones.** Prime a big blunt one and a slender pointy one, a huge whale and a tiny porpoise — cover the range of shapes. The more variety in your examples, the better the app matches everything else. There's a little diversity hint to nudge you.

### Stage 3 — Automate  ⭐

**Goal:** let the app process every remaining specimen at once.

Click **Automate all**. The app runs SAM over each non-primed specimen, finds the bone, and auto-crops, auto-orients, and auto-masks it by matching against your primed examples. When it's done you get a summary: how many it **confidently matched**, how many it **auto-isolated**, and how many it **flagged** for your attention.

> **⏳ On your Mac, this batch is slow — and that's normal, not a freeze.** Your Mac is an Intel model, so the segmentation runs on the CPU. Expect roughly **10–20 minutes** for the full ~48-photo set (on the newer Apple-Silicon Macs the same job is ~2 minutes — but yours will take longer, and that's expected). The button will say "Automating…" the whole time. Leave it running and grab coffee; don't refresh the page. If it's still going after ~30 minutes with no progress, check the Terminal window for errors.

### Stage 4 — Review & Finalize  ⭐

**Goal:** inspect the auto-results and fix anything wrong.

You get a grid of every specimen's outline, **flagged ones first** — those are the specimens the app wasn't confident about (low confidence, or it couldn't cleanly find the bone). A counter at the top shows how many are flagged.

Click any specimen to open the **same guided editor** from Prime and fix its crop / mask / orientation. Work through the flagged ones, spot-check the confident ones, and when you're happy click **🔒 Lock** to finalize. Locking gates the analysis stages.

### Stage 5 — Gallery

A read-only grid of every final outline (just the shape, no photo). Scroll through for a last sanity check — anything that looks wildly wrong (a skinny sliver where you expected a wide V) means that specimen's mask needs another pass back in Review. There's also an optional export button that writes a bundle for R/Momocs if you ever want it.

### Stage 6 — EFA (Elliptic Fourier Analysis)

Turns each outline into shape coefficients. Click **Calibrate** to let it recommend how many harmonics to use (or set the slider yourself — 12 is a fine default), then **Compute**. Each specimen shows its outline with the reconstruction overlaid so you can see the fit.

### Stage 7 — PCA

Reduces those coefficients to a few principal components. Click **Run PCA**, look at the scree plot (each bar = one component's share of shape variation), and drag the slider to choose how many components to carry into the morphospace.

### Stage 8 — Morphospace

The payoff — an interactive scatter of every specimen in shape space. Set the X and Y axes (which PCs), color by any metadata column you define in the taxonomy editor (Family, Diet, etc.), and hover any point for its details. Below the scatter, the app draws how the bone shape changes along each axis (−2σ to +2σ), so you can see what each PC actually *means*.

**Making your own figures.** This morphospace is for exploring, not a finished publication figure. Every time you run PCA, the app also writes plain spreadsheet files — `scores.csv`, `loadings.csv`, and `eigenvalues.csv` — into `backend/state/<your series>/pca/`. Open those in R, Python, Excel, or Illustrator to build a figure exactly the way you want it.

---

## Sending your progress back

All your decisions live in the folder `backend/state/` — one subfolder per series, each with small JSON files (your curation, primed examples, crops, orientations, masks, EFA/PCA settings, taxonomy). That's everything Carlos needs to regenerate the rest on his end.

To send your work back, zip that folder and share it (Dropbox, Slack, email — whatever's easiest):

1. In Finder, open `apps/morph-fourier/backend/`
2. Right-click the `state` folder → **Compress "state"**
3. Send the resulting `state.zip` to Carlos

You don't need to send the photos, the built app, the model file, or any of the generated image/CSV caches — Carlos regenerates those from your `state/` folder plus the source photos.

---

## Troubleshooting

### The app server dies the moment it starts (especially in VS Code)

If you launched from **VS Code's** terminal and the server quit right after starting — sometimes with a stray `^C` or an `activate` line appearing — that's VS Code's Python extension auto-activating an environment and killing the server. Two fixes:

- **Easiest:** run the app from the regular **Terminal.app** (Cmd-Space → "Terminal"), not VS Code's built-in terminal.
- **Or:** in VS Code, open Settings (Cmd-,), search `python.terminal.activateEnvironment`, and **uncheck** it. Then the VS Code terminal is safe to use.

### `command not found` when I run a `.command` file

Make the scripts executable — from inside `apps/morph-fourier`:

```bash
chmod +x setup.command run-prod.command run-dev.command migrate_curation.command
```

Then try again.

### macOS says the file is "from an unidentified developer" / "cannot be opened"

Right-click the `.command` file in Finder → **Open** → click **Open** in the dialog. You only do this once per file.

### `./run-prod.command` says setup hasn't run

Run `./setup.command` first (from inside `apps/morph-fourier`). If you did and still see it, your Terminal might be in the wrong folder — run `pwd` and make sure it ends in `.../apps/morph-fourier`.

### The Automate batch seems stuck

On your Intel Mac the full batch legitimately takes **10–20 minutes** — the button stays on "Automating…" the whole time. That's the CPU doing the segmentation; it's not frozen. Only worry if it's past ~30 minutes with nothing happening — then check the Terminal window where you launched the app for a red error message and send Carlos a screenshot.

### The app opens but a series is empty / no photos show up

The app isn't finding your photos. Check that either (a) your two view folders are inside `apps/morph-fourier/photos/`, or (b) you set `MORPH_FOURIER_PHOTOS_ROOT` to the folder that contains them, before launching. The folder names must be the original view names (`Fused B-T (Dorsal view)` etc.).

### My migrated curation doesn't line up with the photos

The converter names each series from the original folder name. If you renamed a view folder (e.g. dropped the "(Dorsal view)" part), the migrated decisions won't match the photos. Keep the folder names as they came, re-copy the photos, and re-run `./migrate_curation.command`.

### Setup fails partway through

Usually a download glitch. Run `./setup.command` again — it picks up where it left off. If it still fails, remove the Python environment and retry:

```bash
rm -rf backend/.venv
./setup.command
```

### The setup script complains it can't find a compatible Python or Node

- **Python:** it needs 3.10–3.13. If you're on 3.14, install 3.13 (see setup step 1) — you don't have to uninstall 3.14, the script prefers 3.13 automatically.
- **Node:** install the LTS from https://nodejs.org/ (setup step 2), reopen Terminal, and re-run `./setup.command`.

### I want to start a series over from scratch

Delete that series' state folder and reopen the app:

```bash
rm -rf backend/state/fused_b_t_dorsal_view    # start dorsal over
```

Your source photos are never touched.
