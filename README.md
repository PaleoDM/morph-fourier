# Morph-Fourier

**Turn photographs of 2D outlines into shape data — no coding required.**

Morph-Fourier is a free, open-source app that carries you through a complete outline shape analysis on your own machine: bring in a folder of specimen photos, teach the app what a good result looks like on a handful of examples, let it automatically prepare the rest, review anything it was unsure about, and then compute elliptic Fourier descriptors, run a principal component analysis, and explore the result as an interactive morphospace. Everything runs locally in a web browser — nothing is uploaded anywhere.

It works for any 2D outline you can photograph: leaves, teeth, shells, bones, artifacts, tools. The core idea is that **you no longer hand-process every photo.** You carefully prepare a small, diverse handful, and the app does the bulk of the work by matching everything else against them.

<!-- screenshot: interactive morphospace with shape-along-PC strips -->

---

## Contents

1. [What you'll need](#what-youll-need)
2. [Install](#install)
3. [Launch](#launch)
4. [Try it with the tutorial data](#try-it-with-the-tutorial-data)
5. [Using your own photos](#using-your-own-photos)
6. [The workflow, stage by stage](#the-workflow-stage-by-stage)
7. [Where your results live](#where-your-results-live)
8. [Troubleshooting](#troubleshooting)
9. [License & citation](#license--citation)
10. [Credits](#credits)

---

## What you'll need

A one-time install of three free tools:

- **Python 3.10–3.13** — https://www.python.org/downloads/ (on Windows, tick *"Add python.exe to PATH"*).
- **Node.js LTS** — https://nodejs.org/ (used once, to build the interface).
- **Git** — https://git-scm.com/downloads (to download the project).

A GPU is optional. Without one, the automatic image segmentation still works; it's just slower.

## Install

Download the project and run the setup script once. It creates an isolated Python environment, installs everything, downloads the segmentation model (~375 MB), and builds the interface.

**macOS**

```
git clone https://github.com/PaleoDM/morph-fourier.git
cd morph-fourier
./setup.command
```

If double-clicking `setup.command` in Finder is blocked, right-click it → **Open**, or run the line above in Terminal.

**Windows**

```
git clone https://github.com/PaleoDM/morph-fourier.git
cd morph-fourier
```

Then double-click **`setup.bat`**.

Setup is safe to re-run, and takes about 5–10 minutes the first time.

## Launch

Once setup finishes, launch the app — it opens in your browser with no terminal window to fuss over:

- **macOS:** double-click **`Morph-Fourier.app`**. It lives in the Dock while running; **quit it** (⌘Q or right-click → Quit) to stop the server.
- **Windows:** double-click **`Morph-Fourier.vbs`**. To stop it, run **`Stop Morph-Fourier.bat`**.

Either way, your browser opens to the app at `http://localhost:8000`. The plain `run-prod.command` (macOS) also works if you prefer a visible terminal.

## Try it with the tutorial data

Morph-Fourier ships with a small example dataset — a subsample of *Passiflora* (passionflower) leaf scans — so you can walk the whole pipeline before touching your own material. On first launch, pick the **Passiflora (Tutorial)** series from the selector at the top and click through the stages described below.

## Using your own photos

The easiest way is right in the app: click **Upload photos** (on the welcome screen) or the **+** next to the series selector, name your series, and drag your images in. Each **series** is one set of photos analysed on its own (for example, a top-view and a side-view would be two series).

**Filename convention.** So the app can recognise when several photos belong to the *same specimen*, name your files like:

```
Genus_species_catalog_index.jpg
```

- `Genus` — a capitalised word (e.g. `Passiflora`)
- `species` — optional, lowercase (e.g. `edulis`)
- `catalog` — the specimen's ID number, optionally with one leading capital letter (e.g. `0007`, `A1449`)
- `index` — which photo of that specimen this is (`1`, `2`, …)

Examples: `Passiflora_edulis_0007_1.jpg`, `Quercus_A1449_2.png`. Files that don't match still upload, but won't be grouped into specimens.

*(Power-user alternative: drop a folder of photos directly into the `photos/` directory — each subfolder becomes a series — and reload.)*

## The workflow, stage by stage

The app is a numbered rail of eight stages. Work through them in order.

1. **Curation** — review each photo, mark it accepted or rejected, and choose one *canonical* photo per specimen (the representative the rest of the pipeline uses). Your originals are never moved or altered.
2. **Prime** — hand-prepare a small, deliberately *diverse* set (usually 5–15). For each, crop to the specimen, trace its outline (the app proposes one; you nudge the control points), and rotate it to a consistent orientation. Diversity matters more than quantity.
3. **Automate** — the app prepares every remaining specimen automatically by matching each to your most similar primed example. Leave it running; it flags the least-confident results for you.
4. **Review** — the flagged specimens come up first. Fix any that need it in the same editor you used to prime; the confident ones can be left as-is. Finalize when you're happy.
5. **Gallery** — every finalized outline in one view, and an optional export for use in other tools (e.g. the Momocs R package).
6. **EFA** — elliptic Fourier analysis turns each outline into descriptors. A calibration step helps you pick how much detail to keep; a live reconstruction shows the fit.
7. **PCA** — reduces the descriptors to a few axes of shape variation, with a scree plot to guide how many to keep.
8. **Morphospace** — an interactive scatter of every specimen. Colour points by any metadata you add, and see how shape changes along each axis.

## Where your results live

Everything is stored on your machine, per series, under `backend/state/<series>/`. Notably, each PCA run writes plain spreadsheet files — `scores.csv`, `loadings.csv`, `eigenvalues.csv` — so you can build a publication-quality figure in R, Python, or a spreadsheet. Because every decision is recorded, an analysis is reproducible: the same photos, worked the same way, give the same result.

The interactive morphospace is for *exploration*; for a finished figure, export those CSVs to your tool of choice.

## Troubleshooting

- **"unidentified developer" / can't open the app (macOS):** right-click `setup.command` or `Morph-Fourier.app` → **Open** the first time to approve it.
- **Nothing opens / port already in use:** something may already be on `http://localhost:8000`. Quit the other copy (macOS: quit the Dock app; Windows: `Stop Morph-Fourier.bat`) and relaunch.
- **Setup fails on `git`, Python, or Node:** confirm each is installed and on your PATH (`git --version`, `python --version` or `py --version`, `node --version`), then re-run setup.
- **Segmentation is slow:** that's expected without a GPU. It's a one-time cost per specimen during Automate.
- **The app opens but a series is empty:** make sure your photos are inside a subfolder of `photos/` (or were uploaded via the app), then reload.

## License & citation

Morph-Fourier is released under the **MIT License** (see [LICENSE](LICENSE)). You are free to use, modify, **fork**, and redistribute it. We only ask that, if it contributes to your work, you **cite the paper**:

> Peredo CM, Strauch RJ. *Introducing Morph-Fourier: a no-code, semi-automated tool for outline morphometrics.* (see [CITATION.cff](CITATION.cff))

## Credits

Morph-Fourier stands on established, widely used libraries rather than new algorithms:

- **Segment Anything Model** (Kirillov et al., 2023) — image segmentation
- **pyefd** (Blidh, 2021) — elliptic Fourier analysis
- **scikit-learn** (Pedregosa et al., 2011) — principal component analysis

Built with React and FastAPI. Our contribution is the application that ties these together into a no-code, semi-automated workflow.
