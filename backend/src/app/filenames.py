"""Filename parsing and series discovery for Morph-Fourier.

Generalized from the hyoid app's `filenames.py`. The two hyoid-specific
assumptions are removed:

- **Series, not views.** The hyoid app hardcoded two view folders
  (`Fused B-T (Dorsal view)` / `... Ventral view`). Here every immediate
  subfolder of the photos root is an independently-analyzed *series*, keyed by
  a sanitized version of its folder name (`safe_key`).
- **Institution prefix is a parameter, not a constant.** The hyoid app baked in
  ``USNM``. Here `institution_code` defaults to the empty string; callers pass a
  value only if their filenames omit an institution that should appear in output.

The default filename parser keeps the hyoid convention
(``Genus_[species_]<catalog>_<index>.<ext>``) so existing datasets parse
unchanged; the extension set is widened to include PNG. Files that do not match
are **surfaced** (collected into an ``unparseable`` list), never silently
dropped.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

# No hardcoded institution — callers opt in. (The hyoid app used "USNM".)
DEFAULT_INSTITUTION_CODE = ""

# Image extensions we treat as candidate photos. Anything else (dirs, hidden
# files, sidecar text) is ignored entirely; a candidate that fails the parser is
# surfaced as unparseable rather than dropped.
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png"}

# Default parser: the hyoid convention — Genus_[species_]<catalog>_<index>.<ext>
# Catalog number may carry a single uppercase-letter prefix (e.g. A14449).
# Species token is optional. Extensions widened to include PNG.
_FILENAME_RE = re.compile(
    r"^(?P<genus>[A-Z][a-z]+)"
    r"(?:_(?P<species>[a-z]+))?"
    r"_(?P<catalog>[A-Z]?\d+)"
    r"_(?P<photo_index>\d+)"
    r"\.(?:jpe?g|png|JPE?G|PNG)$"
)


def safe_key(name: str) -> str:
    """Sanitize a folder (or id) name into a filesystem/URL-safe key.

    Lowercase; every run of non-alphanumeric characters collapses to a single
    underscore; leading/trailing underscores are trimmed. e.g.
    ``"Fused B-T (Dorsal view)"`` → ``"fused_b_t_dorsal_view"``.
    """
    key = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")
    return key


class FilenameParseError(ValueError):
    """Raised when a candidate image filename does not match the parser."""


class SeriesKeyCollisionError(ValueError):
    """Raised when two folder names sanitize to the same series safe key."""


@dataclass(frozen=True)
class PhotoRecord:
    """One parsed source photo.

    Mirrors the fields the Pydantic ``PhotoRecord`` model needs (see
    ``models.py`` / ROADMAP §3a) plus ``source_path`` for the image-processing
    layer. Series-scoped, not view-scoped.
    """

    source_path: Path
    filename: str
    series_key: str
    genus: str
    species: Optional[str]
    catalog_number: str
    photo_index: int
    institution_code: str = DEFAULT_INSTITUTION_CODE

    @property
    def specimen_id(self) -> str:
        """Human-readable id: ``"USNM 49775"`` if an institution is set, else ``"49775"``."""
        if self.institution_code:
            return f"{self.institution_code} {self.catalog_number}"
        return self.catalog_number

    @property
    def specimen_id_safe(self) -> str:
        """Filename-safe id: ``"USNM_49775"`` or just ``"49775"``."""
        if self.institution_code:
            return f"{self.institution_code}_{self.catalog_number}"
        return self.catalog_number

    @property
    def specimen_key(self) -> str:
        """Groups multi-photo specimens within a series: ``"{specimenIdSafe}__{seriesKey}"``."""
        return f"{self.specimen_id_safe}__{self.series_key}"

    @property
    def label(self) -> str:
        """Free display label parsed from the filename (genus/species)."""
        if self.species:
            return f"{self.genus} {self.species}"
        return f"{self.genus} sp."

    @property
    def record_key(self) -> str:
        """Stable per-photo id across runs: ``"{seriesKey}/{filename}"``."""
        return f"{self.series_key}/{self.filename}"


@dataclass(frozen=True)
class UnparseableFile:
    """A candidate image whose name did not match the parser — surfaced, not dropped."""

    series_key: str
    filename: str
    source_path: Path
    reason: str


@dataclass(frozen=True)
class DiscoveredSeries:
    """One series (subfolder) with its parsed records and unparseable candidates."""

    key: str
    display_name: str
    records: list[PhotoRecord]
    unparseable: list[UnparseableFile]

    @property
    def photo_count(self) -> int:
        """Number of parseable image files in the folder."""
        return len(self.records)


def parse_filename(
    filename: str,
    series_key: str,
    source_path: Path,
    institution_code: str = DEFAULT_INSTITUTION_CODE,
) -> PhotoRecord:
    """Parse one filename with the default hyoid-convention regex.

    Raises ``FilenameParseError`` if it does not match.
    """
    m = _FILENAME_RE.match(filename)
    if not m:
        raise FilenameParseError(f"Filename does not match expected pattern: {filename!r}")
    return PhotoRecord(
        source_path=source_path,
        filename=filename,
        series_key=series_key,
        genus=m.group("genus"),
        species=m.group("species"),
        catalog_number=m.group("catalog"),
        photo_index=int(m.group("photo_index")),
        institution_code=institution_code,
    )


def discover_series(
    photos_root: Path,
    institution_code: str = DEFAULT_INSTITUTION_CODE,
) -> list[DiscoveredSeries]:
    """Treat every immediate subfolder of ``photos_root`` as an independent series.

    For each subfolder: derive a ``safe_key``, parse every candidate image file,
    and collect any that don't parse into an ``unparseable`` list. If two folder
    names sanitize to the same key, raise ``SeriesKeyCollisionError`` — the
    filesystem must unambiguously map folders → series.

    Returns a list of ``DiscoveredSeries`` sorted by key. An absent or empty
    photos root yields an empty list (not an error).
    """
    photos_root = Path(photos_root)
    if not photos_root.exists():
        return []

    key_to_folder: dict[str, str] = {}
    series: list[DiscoveredSeries] = []

    for folder in sorted(p for p in photos_root.iterdir() if p.is_dir()):
        display_name = folder.name
        key = safe_key(display_name)
        if not key:
            # A folder name with no alphanumerics can't produce a usable key.
            raise SeriesKeyCollisionError(
                f"Folder {display_name!r} sanitizes to an empty series key."
            )
        if key in key_to_folder:
            raise SeriesKeyCollisionError(
                f"Folders {key_to_folder[key]!r} and {display_name!r} both sanitize "
                f"to series key {key!r}. Rename one so keys are unique."
            )
        key_to_folder[key] = display_name

        records: list[PhotoRecord] = []
        unparseable: list[UnparseableFile] = []
        for path in sorted(folder.iterdir()):
            if path.name.startswith(".") or not path.is_file():
                continue
            if path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            try:
                records.append(parse_filename(path.name, key, path, institution_code))
            except FilenameParseError as e:
                unparseable.append(
                    UnparseableFile(
                        series_key=key,
                        filename=path.name,
                        source_path=path,
                        reason=str(e),
                    )
                )
        records.sort(key=lambda r: (r.specimen_id_safe, r.photo_index))
        series.append(DiscoveredSeries(key, display_name, records, unparseable))

    return series


def group_by_specimen(records: list[PhotoRecord]) -> dict[str, list[PhotoRecord]]:
    """Group records by ``specimen_key`` (multi-photo specimens within a series)."""
    groups: dict[str, list[PhotoRecord]] = {}
    for r in records:
        groups.setdefault(r.specimen_key, []).append(r)
    for key in groups:
        groups[key].sort(key=lambda r: r.photo_index)
    return dict(sorted(groups.items()))
