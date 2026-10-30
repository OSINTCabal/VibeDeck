"""Git awareness for the project picker.

Discovery is a shallow, time-boxed directory walk that reads ``.git/HEAD``
directly, so listing dozens of repositories never spawns a process. Branch
listing and switching run ``git`` for one repository the user picked.
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Iterable, Optional

SKIP_DIRS = {
    "node_modules", "__pycache__", "venv", ".venv", "env", "site-packages", "dist", "build",
    "target", "vendor", "Library", "snap", "go", "Steam", "steamapps", "proc", "sys", "lost+found",
}
MAX_REPOS = 200
GIT_TIMEOUT = 10


def git_dir(path: Path) -> Optional[Path]:
    """The repository's git directory (handles worktree/submodule ``.git`` files)."""
    dot = path / ".git"
    try:
        if dot.is_dir():
            return dot
        if dot.is_file():
            text = dot.read_text(encoding="utf-8", errors="replace").strip()
            if text.startswith("gitdir:"):
                target = Path(text[len("gitdir:"):].strip())
                return target if target.is_absolute() else (path / target).resolve()
    except OSError:
        pass
    return None


def head_branch(path: Path) -> Optional[str]:
    """Current branch name, or a short commit id when HEAD is detached."""
    gd = git_dir(path)
    if gd is None:
        return None
    try:
        head = (gd / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if head.startswith("ref: refs/heads/"):
        return head[len("ref: refs/heads/"):]
    return head[:7] if head else None


def repo_info(path: Path) -> Optional[dict]:
    branch = head_branch(path)
    if branch is None:
        return None
    return {"path": str(path), "name": path.name or str(path), "branch": branch}


def find_repos(roots: Iterable[tuple[Path, int]], budget: float = 1.5) -> list[dict]:
    """Breadth-first walk of ``(root, depth)`` pairs; stops at repo roots.

    Hidden and dependency directories are skipped, and the walk ends after
    ``budget`` seconds or ``MAX_REPOS`` hits so the picker always opens fast.
    """
    deadline = time.monotonic() + budget
    found: dict[str, dict] = {}
    visited: set[str] = set()
    queue: list[tuple[Path, int]] = [(Path(r), d) for r, d in roots]
    while queue and time.monotonic() < deadline and len(found) < MAX_REPOS:
        path, depth = queue.pop(0)
        try:
            real = os.path.realpath(path)
        except OSError:
            continue
        if real in visited:
            continue
        visited.add(real)
        info = repo_info(path)
        if info:
            found.setdefault(info["path"], info)
            continue
        if depth <= 0:
            continue
        try:
            with os.scandir(path) as entries:
                children = sorted(
                    (e for e in entries
                     if not e.name.startswith(".") and e.name not in SKIP_DIRS
                     and e.is_dir(follow_symlinks=False)),
                    key=lambda e: e.name.lower(),
                )
        except OSError:
            continue
        queue.extend((Path(e.path), depth - 1) for e in children)
    return sorted(found.values(), key=lambda r: r["name"].lower())


def _git(path: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(path), *args],
        capture_output=True, text=True, timeout=GIT_TIMEOUT,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"},
    )


def repo_root(path: Path) -> Optional[Path]:
    if not path.is_dir():
        return None
    try:
        out = _git(path, "rev-parse", "--show-toplevel")
    except (OSError, subprocess.TimeoutExpired):
        return None
    return Path(out.stdout.strip()) if out.returncode == 0 and out.stdout.strip() else None


def branches(path: Path) -> Optional[dict]:
    """Local branches, the current one, and whether the work tree has changes."""
    root = repo_root(path)
    if root is None:
        return None
    refs = _git(root, "for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads")
    status = _git(root, "status", "--porcelain", "--untracked-files=no")
    names = [line for line in refs.stdout.splitlines() if line]
    return {
        "root": str(root),
        "current": head_branch(root),
        "branches": names,
        "dirty": bool(status.stdout.strip()) if status.returncode == 0 else None,
    }


def valid_branch_name(name: str) -> bool:
    if not name or name.startswith("-") or len(name) > 200:
        return False
    try:
        return subprocess.run(["git", "check-ref-format", "--branch", name],
                              capture_output=True, timeout=GIT_TIMEOUT).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def switch(path: Path, branch: str, create: bool = False) -> dict:
    """Switch (or create and switch) a branch. Git itself refuses a switch
    that would overwrite uncommitted changes; its message is passed through."""
    root = repo_root(path)
    if root is None:
        raise ValueError("Not a git repository")
    if not valid_branch_name(branch):
        raise ValueError("Invalid branch name")
    out = _git(root, "switch", *(["-c"] if create else []), branch, "--")
    if out.returncode != 0:
        message = (out.stderr or out.stdout).strip().splitlines()
        raise RuntimeError(" ".join(message[:3]) or "git switch failed")
    return branches(root) or {}
