import io
import os
import stat
import zipfile
from pathlib import Path

import pytest
import skill_import
import vibedeck_server
from fastapi.testclient import TestClient


def write_skill(root: Path, folder: str, text: str) -> Path:
    path = root / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / "SKILL.md").write_text(text, encoding="utf-8")
    return path


@pytest.fixture
def homes(tmp_path, monkeypatch):
    claude, codex, vibe = tmp_path / "claude", tmp_path / "codex", tmp_path / "vibe"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(codex))
    monkeypatch.setenv("VIBE_HOME", str(vibe))
    return claude, codex, vibe


@pytest.fixture
def client():
    with TestClient(vibedeck_server.app, base_url="http://127.0.0.1:9377") as c:
        yield c


def by_name(sources):
    return {skill.prepared.name: skill for source in sources for skill in source.skills}


def test_valid_frontmatter_is_kept_byte_for_byte():
    text = "---\nname: lint-fix\ndescription: Fix lint.\nallowed-tools: Bash Read\n---\n\nBody\n"
    prepared = skill_import.prepare_skill_md(text, "lint-fix")
    assert (prepared.name, prepared.description, prepared.converted, prepared.text) == (
        "lint-fix", "Fix lint.", False, text)


def test_frontmatter_is_rewritten_only_where_vibe_would_reject_it():
    prepared = skill_import.prepare_skill_md(
        "---\nname: My Skill!\nmodel: opus\n---\n# Title\n\nDoes a thing\nwell.\n", "dir")
    assert prepared.converted and prepared.name == "my-skill"
    assert prepared.description == "Does a thing well."
    assert prepared.text.startswith("---\nname: my-skill\ndescription: Does a thing well.\nmodel: opus\n---\n")
    assert prepared.text.endswith("# Title\n\nDoes a thing\nwell.\n")

    bare = skill_import.prepare_skill_md("Use for reviews.\n", "Code_Review")
    assert (bare.name, bare.description, bare.converted) == ("code-review", "Use for reviews.", True)

    long = skill_import.prepare_skill_md(f"---\nname: a\ndescription: {'x' * 2000}\n---\n", "a")
    assert len(long.description) == 1024

    assert skill_import.prepare_skill_md("---\n[1, 2\n---\n", "a").error
    assert skill_import.prepare_skill_md("---\nname: a\n---\n# only a heading\n", "a").error


def test_scan_finds_claude_plugin_codex_and_project_skills(homes, tmp_path):
    claude, codex, vibe = homes
    write_skill(claude / "skills", "review", "---\nname: review\ndescription: Review code.\n---\n")
    write_skill(claude / "skills" / "synced" / "bucket", "pdf", "---\nname: pdf\ndescription: PDFs.\n---\n")
    plugin = claude / "plugins" / "cache" / "market" / "tools" / "1.0"
    (plugin / ".claude-plugin").mkdir(parents=True)
    (plugin / ".claude-plugin" / "plugin.json").write_text('{"name": "tools"}')
    write_skill(plugin / "skills", "deploy", "---\nname: deploy\ndescription: Deploy.\n---\n")
    write_skill(claude / "plugins" / "marketplaces" / "x" / "skills", "not-installed",
                "---\nname: not-installed\ndescription: No.\n---\n")
    write_skill(codex / "skills", "grill-me", "---\nname: grill-me\ndescription: Grill.\n---\n")
    write_skill(codex / "skills" / ".system", "builtin", "---\nname: builtin\ndescription: B.\n---\n")
    project = tmp_path / "proj"
    write_skill(project / ".claude" / "skills", "local", "---\nname: local\ndescription: Local.\n---\n")
    write_skill(project / ".agents" / "skills", "shared", "---\nname: shared\ndescription: Shared.\n---\n")
    write_skill(vibe / "skills", "review", "---\nname: review\ndescription: Old.\n---\n")

    sources = skill_import.scan([str(project)])
    labels = [s.label for s in sources]
    assert labels == ["Claude Code", "Claude Code plugin · tools", "Codex",
                      "proj · .claude/skills", "proj · .agents/skills"]
    skills = by_name(sources)
    assert set(skills) == {"review", "pdf", "deploy", "grill-me", "local", "shared"}
    assert skills["review"].status == "conflict" and skills["pdf"].status == "new"


def test_import_copies_files_and_never_overwrites_without_asking(homes, tmp_path):
    claude, _, vibe = homes
    skill = write_skill(claude / "skills", "review", "---\nname: review\ndescription: Review code.\n---\n")
    (skill / "scripts").mkdir()
    (skill / "scripts" / "run.sh").write_text("echo hi\n")
    secret = tmp_path / "secret.txt"
    secret.write_text("private")
    os.symlink(secret, skill / "leak.txt")
    os.symlink(tmp_path, skill / "outside")
    os.symlink(skill / "scripts" / "run.sh", skill / "alias.sh")

    candidate = by_name(skill_import.scan())["review"]
    result = skill_import.import_selected([(candidate.id, False)])
    assert [item["name"] for item in result["imported"]] == ["review"]
    dest = vibe / "skills" / "review"
    assert (dest / "scripts" / "run.sh").read_text() == "echo hi\n"
    assert (dest / "alias.sh").read_text() == "echo hi\n" and not (dest / "alias.sh").is_symlink()
    assert not (dest / "leak.txt").exists() and not (dest / "outside").exists()
    assert by_name(skill_import.scan())["review"].status == "imported"

    (skill / "SKILL.md").write_text("---\nname: review\ndescription: Newer.\n---\n")
    candidate = by_name(skill_import.scan())["review"]
    assert candidate.status == "conflict"
    result = skill_import.import_selected([(candidate.id, False)])
    assert result["failed"][0]["error"] == "A skill named review already exists"
    assert "Review code." in (dest / "SKILL.md").read_text()
    result = skill_import.import_selected([(candidate.id, True)])
    assert result["imported"] and "Newer." in (dest / "SKILL.md").read_text()
    assert [p.name for p in (vibe / "skills").iterdir()] == ["review"]


def test_unknown_ids_cannot_name_arbitrary_paths(homes):
    result = skill_import.import_selected([("../../etc", False)])
    assert result == {"imported": [], "failed": [
        {"id": "../../etc", "name": None, "error": "Skill is no longer available"}]}


def make_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            if mode:
                info.external_attr = mode << 16
            archive.writestr(info, data)
    return buffer.getvalue()


def test_zip_upload_rejects_traversal_and_skips_symlinks(tmp_path):
    with pytest.raises(skill_import.SkillImportError, match="unsafe path"):
        skill_import.stage_upload(make_zip([("../evil/SKILL.md", "x", 0)]), "a.zip", tmp_path / "up")
    assert not (tmp_path / "evil").exists()
    assert list((tmp_path / "up").iterdir()) == []
    assert not (tmp_path / "evil").exists()

    staged = skill_import.stage_upload(make_zip([
        ("pack/one/SKILL.md", "---\nname: one\ndescription: One.\n---\n", 0),
        ("pack/one/link", "/etc/passwd", stat.S_IFLNK | 0o777),
    ]), "pack.zip", tmp_path / "up")
    assert staged.name == "pack" and (staged / "pack" / "one" / "SKILL.md").is_file()
    assert not (staged / "pack" / "one" / "link").exists()


def test_api_round_trip_with_uploaded_skill_md(homes, client):
    claude, _, vibe = homes
    write_skill(claude / "skills", "other", "---\nname: other\ndescription: Other.\n---\n")
    text = "---\nname: Upload Me\ndescription: From a file.\n---\nBody\n"
    response = client.post("/api/skills/import/upload?filename=SKILL.md", content=text.encode())
    assert response.status_code == 200
    data = response.json()
    [source] = data["sources"]
    assert source["label"] == "Chosen · skill"
    [skill] = source["skills"]
    assert skill["name"] == "upload-me" and skill["converted"] and skill["status"] == "new"

    response = client.post("/api/skills/import", json={"paths": [data["path"]], "items": [{"id": skill["id"]}]})
    assert response.status_code == 200 and response.json()["imported"][0]["name"] == "upload-me"
    assert (vibe / "skills" / "upload-me" / "SKILL.md").read_text().startswith("---\nname: upload-me\n")

    listed = client.get("/api/skills/importable", params={"path": data["path"]}).json()
    assert listed["sources"][-1]["skills"][0]["status"] == "imported"
    assert client.get("/api/skills/importable", params={"path": "relative/dir"}).status_code == 400
    assert client.post("/api/skills/import", json={"items": []}).status_code == 422
