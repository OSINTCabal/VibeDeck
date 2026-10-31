"""The installed Vibe CLI: its version and the release notes it ships.

Both are read from the ``vibe`` package next to ``vibe-app-server`` (a uv
tool environment), so no process is spawned. ``vibe --version`` is the
fallback for installs laid out differently.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Optional

# Vibe 3.0.4 fixed teleport in reftable repositories and subagent answers,
# and lets models define their own thinking levels.
RECOMMENDED = (3, 0, 4)
UPGRADE_COMMAND = "uv tool upgrade mistral-vibe"
_VERSION = re.compile(r'__version__\s*=\s*["\']([^"\']+)["\']')


def package_dir(app_server: Optional[str]) -> Optional[Path]:
    """``site-packages/vibe`` of the environment that runs ``app_server``."""
    if not app_server:
        return None
    env = Path(os.path.realpath(app_server)).parent.parent
    for init in sorted(env.glob("lib/python*/site-packages/vibe/__init__.py")):
        return init.parent
    return None


def parse_version(text: str) -> Optional[tuple[int, ...]]:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(p) for p in m.groups()) if m else None


_cache: dict[str, tuple[float, Optional[str]]] = {}


def version(app_server: Optional[str]) -> Optional[str]:
    if not app_server or not os.path.exists(app_server):
        return None
    try:
        stamp = os.stat(os.path.realpath(app_server)).st_mtime
    except OSError:
        return None
    cached = _cache.get(app_server)
    if cached and cached[0] == stamp:
        return cached[1]
    found = _read_version(app_server)
    _cache[app_server] = (stamp, found)
    return found


def _read_version(app_server: str) -> Optional[str]:
    pkg = package_dir(app_server)
    if pkg is not None:
        try:
            m = _VERSION.search((pkg / "__init__.py").read_text(encoding="utf-8"))
            if m:
                return m.group(1)
        except OSError:
            pass
    cli = shutil.which("vibe")
    if not cli:
        return None
    try:
        out = subprocess.run([cli, "--version"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    parsed = parse_version(out.stdout)
    return ".".join(map(str, parsed)) if parsed else None


def info(app_server: Optional[str]) -> dict:
    current = version(app_server)
    parsed = parse_version(current or "")
    return {
        "version": current,
        "recommended": ".".join(map(str, RECOMMENDED)),
        "outdated": parsed is not None and parsed < RECOMMENDED,
        "upgradeCommand": UPGRADE_COMMAND,
    }


def release_notes(app_server: Optional[str]) -> list[dict]:
    """Markdown release notes bundled with Vibe, newest first.

    Vibe up to 3.0.3 ships ``whats_new.md`` for its own version; 3.0.4 and
    later ship one ``whats_new/<version>.md`` per release, without a heading.
    """
    pkg = package_dir(app_server)
    if pkg is None:
        return []
    files = [pkg / "whats_new.md", *(pkg / "whats_new").glob("*.md"), *(pkg / "release_notes").glob("*.md")]
    notes: dict[str, dict] = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        if not text:
            continue
        ver = parse_version(text.splitlines()[0]) or parse_version(path.stem)
        key = ".".join(map(str, ver)) if ver else path.stem
        if not text.startswith("#"):
            text = f"# What's new in v{key}\n\n{text}"
        notes.setdefault(key, {"version": key, "markdown": text, "_order": ver or (0,)})
    ordered = sorted(notes.values(), key=lambda n: n["_order"], reverse=True)
    return [{"version": n["version"], "markdown": n["markdown"]} for n in ordered]
