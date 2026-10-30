"""Import skills that other coding agents installed on this machine.

Claude Code, Codex and project ``.claude``/``.agents`` folders use the same
``<name>/SKILL.md`` layout with YAML frontmatter that Vibe loads from
``$VIBE_HOME/skills``. Vibe is stricter about two fields (``name`` must be a
lowercase-hyphen slug that matches the folder, ``description`` must be 1-1024
characters), so frontmatter is rewritten only when one of them would fail.

Detected skills are referenced by an id derived from their resolved folder, so
an import request never carries a source path; the sources are scanned again
and only matching ids are copied. Copies keep files that resolve inside the
skill folder and drop symlinks that point anywhere else.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Iterable, Optional

import yaml

NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
FM_BOUNDARY = re.compile(r"^-{3,}\s*$", re.MULTILINE)
MAX_NAME = 64
MAX_DESCRIPTION = 1024
MAX_FILES = 2000
MAX_BYTES = 25 * 1024 * 1024
MAX_SKILL_MD = 1024 * 1024
MAX_WALK_DIRS = 5000
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".trash", "marketplaces", "__MACOSX"}
STAGING_TTL = 24 * 3600


class SkillImportError(Exception):
    pass


def vibe_skills_dir() -> Path:
    return Path(os.environ.get("VIBE_HOME", Path.home() / ".vibe")) / "skills"


def claude_home() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude")


def codex_home() -> Path:
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:MAX_NAME].strip("-")


# ---------------------------------------------------------------- SKILL.md


@dataclass
class Prepared:
    name: str = ""
    description: str = ""
    text: str = ""
    converted: bool = False
    error: Optional[str] = None


def _first_paragraph(body: str) -> str:
    lines: list[str] = []
    fenced = False
    for raw in body.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            fenced = not fenced
            continue
        if fenced or line.startswith("#") or line.startswith("<!--"):
            if lines:
                break
            continue
        if not line:
            if lines:
                break
            continue
        lines.append(line)
    text = " ".join(lines)
    return text if len(text) <= MAX_DESCRIPTION else text[:MAX_DESCRIPTION - 1].rstrip() + "…"


def prepare_skill_md(text: str, dir_name: str) -> Prepared:
    """Return SKILL.md text Vibe accepts, rewriting frontmatter only when needed."""
    text = text.lstrip("﻿")
    splits = FM_BOUNDARY.split(text, 2)
    if len(splits) >= 3 and not splits[0].strip():
        try:
            frontmatter = yaml.safe_load(splits[1])
        except yaml.YAMLError:
            return Prepared(error="Frontmatter is not valid YAML")
        if frontmatter is None:
            frontmatter = {}
        if not isinstance(frontmatter, dict):
            return Prepared(error="Frontmatter is not a mapping")
        body, had_frontmatter = splits[2], True
    else:
        frontmatter, body, had_frontmatter = {}, text, False

    name = frontmatter.get("name")
    if isinstance(name, str) and NAME_RE.match(name) and len(name) <= MAX_NAME:
        new_name = name
    else:
        new_name = slugify(name if isinstance(name, str) and name.strip() else dir_name)
    if not new_name:
        return Prepared(error="No usable skill name")

    description = frontmatter.get("description")
    if isinstance(description, str) and description.strip() and len(description) <= MAX_DESCRIPTION:
        new_description = description
    elif isinstance(description, str) and description.strip():
        new_description = description.strip()[:MAX_DESCRIPTION - 1].rstrip() + "…"
    else:
        new_description = _first_paragraph(body)
    if not new_description:
        return Prepared(name=new_name, error="No description in the frontmatter or the text")

    changed = not had_frontmatter or new_name != name or new_description != description
    metadata = frontmatter.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        changed = True
    if not changed:
        return Prepared(name=new_name, description=new_description, text=text)

    rest = {k: v for k, v in frontmatter.items() if k not in ("name", "description")}
    if "metadata" in rest and not isinstance(rest["metadata"], dict):
        del rest["metadata"]
    document = {"name": new_name, "description": new_description, **rest}
    dumped = yaml.safe_dump(document, sort_keys=False, allow_unicode=True, width=10**6)
    out = f"---\n{dumped}---\n\n{body.lstrip()}"
    return Prepared(name=new_name, description=new_description, text=out, converted=True)


def _read_skill_md(skill_dir: Path) -> str:
    path = skill_dir / "SKILL.md"
    if path.stat().st_size > MAX_SKILL_MD:
        raise SkillImportError("SKILL.md is larger than 1 MB")
    return path.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------- discovery


@dataclass
class Candidate:
    id: str
    dir: Path
    prepared: Prepared
    status: str = "new"


@dataclass
class Source:
    id: str
    label: str
    root: Path
    depth: int = 1
    note: Optional[str] = None
    always: bool = False
    skills: list[Candidate] = field(default_factory=list)


def find_skill_dirs(root: Path, max_depth: int) -> list[Path]:
    """Folders under ``root`` that hold a SKILL.md, without descending into a skill."""
    found: list[Path] = []
    seen: set[Path] = set()
    queue: list[tuple[Path, int]] = [(root, 0)]
    walked = 0
    while queue and walked < MAX_WALK_DIRS:
        current, depth = queue.pop(0)
        try:
            resolved = current.resolve()
        except OSError:
            continue
        if resolved in seen:
            continue
        seen.add(resolved)
        walked += 1
        if (current / "SKILL.md").is_file():
            found.append(current)
            continue
        if depth >= max_depth:
            continue
        try:
            children = sorted(current.iterdir())
        except OSError:
            continue
        for child in children:
            if child.name in SKIP_DIRS or child.name.startswith("."):
                continue
            if child.is_dir():
                queue.append((child, depth + 1))
    return found


def _plugin_sources(base: Path) -> list[Source]:
    """Installed Claude Code plugins: ``<plugin>/skills/<skill>/SKILL.md``."""
    sources: list[Source] = []
    for skills_root in _find_named_dirs(base, "skills", 6):
        manifest = skills_root.parent / ".claude-plugin" / "plugin.json"
        name = skills_root.parent.name
        try:
            name = json.loads(manifest.read_text(encoding="utf-8")).get("name") or name
        except (OSError, ValueError, AttributeError):
            pass
        digest = hashlib.sha256(str(skills_root).encode()).hexdigest()[:10]
        sources.append(Source(f"claude-plugin-{digest}", f"Claude Code plugin · {name}", skills_root))
    return sources


def _find_named_dirs(base: Path, name: str, max_depth: int) -> list[Path]:
    out: list[Path] = []
    queue: list[tuple[Path, int]] = [(base, 0)]
    walked = 0
    while queue and walked < MAX_WALK_DIRS:
        current, depth = queue.pop(0)
        walked += 1
        try:
            children = sorted(c for c in current.iterdir() if c.is_dir() and not c.is_symlink())
        except OSError:
            continue
        for child in children:
            if child.name in SKIP_DIRS:
                continue
            if child.name == name:
                out.append(child)
            elif depth + 1 < max_depth:
                queue.append((child, depth + 1))
    return out


def build_sources(projects: Iterable[str] = (), paths: Iterable[str] = ()) -> list[Source]:
    claude = claude_home()
    sources = [Source("claude", "Claude Code", claude / "skills", depth=3)]
    for base in (claude / "plugins" / "cache", claude / "plugins" / "synced"):
        if base.is_dir():
            sources.extend(_plugin_sources(base))
    sources.append(Source("codex", "Codex", codex_home() / "skills", depth=2))
    for project in dict.fromkeys(projects):
        root = Path(project).expanduser()
        if not root.is_absolute() or not root.is_dir():
            continue
        digest = hashlib.sha256(str(root).encode()).hexdigest()[:10]
        sources.append(Source(f"project-claude-{digest}", f"{root.name} · .claude/skills",
                              root / ".claude" / "skills"))
        sources.append(Source(f"project-agents-{digest}", f"{root.name} · .agents/skills",
                              root / ".agents" / "skills",
                              note="Vibe already loads these in this project; importing makes them global."))
    for raw in dict.fromkeys(paths):
        sources.append(Source(f"folder-{hashlib.sha256(raw.encode()).hexdigest()[:10]}",
                              f"Chosen · {Path(raw).name or raw}", custom_path(raw), depth=3, always=True))
    return sources


def custom_path(raw: str) -> Path:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise SkillImportError("Choose an absolute folder path")
    if path.is_file() and path.name == "SKILL.md":
        path = path.parent
    if not path.is_dir():
        raise SkillImportError("That folder does not exist")
    return path


def _status(prepared: Prepared, skill_dir: Path) -> str:
    if prepared.error:
        return "invalid"
    dest = vibe_skills_dir() / prepared.name
    if not dest.exists() and not dest.is_symlink():
        return "new"
    try:
        if dest.resolve() == skill_dir.resolve():
            return "imported"
        current = (dest / "SKILL.md").read_text(encoding="utf-8", errors="replace").lstrip("﻿")
    except OSError:
        return "conflict"
    return "imported" if current == prepared.text else "conflict"


def scan(projects: Iterable[str] = (), paths: Iterable[str] = ()) -> list[Source]:
    vibe_root = vibe_skills_dir().resolve()
    seen: set[Path] = set()
    out: list[Source] = []
    for source in build_sources(projects, paths):
        if not source.root.is_dir():
            if source.always:
                out.append(source)
            continue
        for skill_dir in find_skill_dirs(source.root, source.depth):
            resolved = skill_dir.resolve()
            if resolved in seen or resolved.is_relative_to(vibe_root):
                continue
            seen.add(resolved)
            try:
                prepared = prepare_skill_md(_read_skill_md(skill_dir), skill_dir.name)
            except (OSError, SkillImportError) as e:
                prepared = Prepared(name=slugify(skill_dir.name), error=str(e) or "Could not read SKILL.md")
            candidate_id = hashlib.sha256(str(resolved).encode()).hexdigest()[:16]
            source.skills.append(Candidate(candidate_id, skill_dir, prepared, _status(prepared, skill_dir)))
        if source.skills or source.always:
            out.append(source)
    return out


def serialize(sources: list[Source]) -> dict:
    return {
        "dest": str(vibe_skills_dir()),
        "sources": [{
            "id": s.id, "label": s.label, "root": str(s.root), "note": s.note,
            "skills": [{
                "id": c.id, "name": c.prepared.name, "dirName": c.dir.name,
                "description": c.prepared.description, "path": str(c.dir),
                "status": c.status, "converted": c.prepared.converted, "error": c.prepared.error,
            } for c in s.skills],
        } for s in sources],
    }


# ---------------------------------------------------------------- copying


def _skill_files(skill_dir: Path) -> list[tuple[PurePosixPath, Path]]:
    """Regular files inside the skill folder; symlinks must resolve inside it."""
    root = skill_dir.resolve()
    files: list[tuple[PurePosixPath, Path]] = []
    total = 0
    for current, dirs, names in os.walk(root, followlinks=False):
        here = Path(current)
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not (here / d).is_symlink()]
        for name in names:
            path = here / name
            try:
                target = path.resolve(strict=True)
            except (OSError, RuntimeError):
                continue
            if not target.is_relative_to(root) or not target.is_file():
                continue
            rel = PurePosixPath(path.relative_to(root).as_posix())
            if rel == PurePosixPath("SKILL.md"):
                continue
            total += target.stat().st_size
            files.append((rel, target))
            if len(files) > MAX_FILES or total > MAX_BYTES:
                raise SkillImportError("Skill folder is too large to import (over 2000 files or 25 MB)")
    return files


def install(candidate: Candidate, overwrite: bool = False) -> Path:
    prepared = candidate.prepared
    if prepared.error:
        raise SkillImportError(prepared.error)
    if not NAME_RE.match(prepared.name) or len(prepared.name) > MAX_NAME:
        raise SkillImportError("Invalid skill name")
    dest_root = vibe_skills_dir()
    dest_root.mkdir(parents=True, exist_ok=True)
    dest = dest_root / prepared.name
    exists = dest.exists() or dest.is_symlink()
    if exists and not overwrite:
        raise SkillImportError(f"A skill named {prepared.name} already exists")
    token = uuid.uuid4().hex[:8]
    staging = dest_root / f".import-{prepared.name}-{token}"
    try:
        staging.mkdir()
        for rel, source in _skill_files(candidate.dir):
            target = staging.joinpath(*rel.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        (staging / "SKILL.md").write_text(prepared.text, encoding="utf-8")
        if exists:
            backup = dest_root / f".replaced-{prepared.name}-{token}"
            os.replace(dest, backup)
            os.replace(staging, dest)
            if backup.is_symlink() or backup.is_file():
                backup.unlink()
            else:
                shutil.rmtree(backup, ignore_errors=True)
        else:
            os.replace(staging, dest)
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return dest


def import_selected(items: list[tuple[str, bool]], projects: Iterable[str] = (),
                    paths: Iterable[str] = ()) -> dict:
    by_id = {c.id: c for s in scan(projects, paths) for c in s.skills}
    imported: list[dict] = []
    failed: list[dict] = []
    for item_id, overwrite in items:
        candidate = by_id.get(item_id)
        if candidate is None:
            failed.append({"id": item_id, "name": None, "error": "Skill is no longer available"})
            continue
        try:
            dest = install(candidate, overwrite)
            imported.append({"id": item_id, "name": candidate.prepared.name, "path": str(dest)})
        except (OSError, SkillImportError) as e:
            failed.append({"id": item_id, "name": candidate.prepared.name, "error": str(e) or "Copy failed"})
    return {"imported": imported, "failed": failed}


# ---------------------------------------------------------------- uploads


def _extract_zip(data: bytes, dest: Path) -> None:
    import io
    root = dest.resolve()
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise SkillImportError("Not a valid zip file") from None
    with archive:
        members = [m for m in archive.infolist() if not m.is_dir()]
        if len(members) > MAX_FILES or sum(m.file_size for m in members) > MAX_BYTES:
            raise SkillImportError("Zip is too large to import (over 2000 files or 25 MB)")
        for member in members:
            parts = PurePosixPath(member.filename.replace("\\", "/")).parts
            if not parts or member.filename.startswith("/") or ".." in parts or ":" in parts[0]:
                raise SkillImportError("Zip contains an unsafe path")
            if parts[0] in SKIP_DIRS or stat.S_ISLNK(member.external_attr >> 16):
                continue
            target = root.joinpath(*parts)
            if not target.resolve().is_relative_to(root):
                raise SkillImportError("Zip contains an unsafe path")
            target.parent.mkdir(parents=True, exist_ok=True)
            written = 0
            with archive.open(member) as src, open(target, "wb") as out:
                while chunk := src.read(65536):
                    written += len(chunk)
                    if written > MAX_BYTES:
                        raise SkillImportError("Zip is too large to import")
                    out.write(chunk)


def stage_upload(data: bytes, filename: str, staging_root: Path) -> Path:
    """Unpack an uploaded zip or SKILL.md into a fresh folder and return it."""
    if len(data) > MAX_BYTES:
        raise SkillImportError("File is larger than 25 MB")
    staging_root.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for old in staging_root.iterdir():
        try:
            if now - old.stat().st_mtime > STAGING_TTL:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    outer = staging_root / uuid.uuid4().hex
    dest = outer / (slugify(Path(filename).stem) or "upload")
    dest.mkdir(parents=True)
    try:
        if filename.lower().endswith(".zip") or data[:4] == b"PK\x03\x04":
            _extract_zip(data, dest)
        else:
            if len(data) > MAX_SKILL_MD:
                raise SkillImportError("SKILL.md is larger than 1 MB")
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                raise SkillImportError("Choose a SKILL.md text file or a .zip") from None
            stem = Path(filename).stem
            prepared = prepare_skill_md(text, "" if stem.upper() == "SKILL" else stem)
            folder = prepared.name or slugify(stem) or "skill"
            (dest / folder).mkdir()
            (dest / folder / "SKILL.md").write_text(text, encoding="utf-8")
    except BaseException:
        shutil.rmtree(outer, ignore_errors=True)
        raise
    return dest
