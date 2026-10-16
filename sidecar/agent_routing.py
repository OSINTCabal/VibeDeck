"""Shared worker policy and deterministic selection. No model requests here."""
from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Effort = Literal['auto', 'off', 'low', 'medium', 'high', 'max']


class AgentSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    policy: Literal['requested', 'auto', 'off'] = 'requested'
    quality: Literal['fast', 'balanced', 'strong'] = 'balanced'
    max_workers: int = Field(default=2, ge=1, le=3)


class AgentJob(BaseModel):
    model_config = ConfigDict(extra='forbid')
    task: str = Field(min_length=1, max_length=20000)
    model: str = 'auto'
    provider: str | None = None
    kind: Literal['general', 'coding', 'review', 'reasoning'] = 'general'
    quality: Literal['fast', 'balanced', 'strong'] | None = None
    effort: Effort = 'auto'
    access: Literal['context', 'read', 'edit'] = 'read'


def settings_path() -> Path:
    return Path(os.environ.get('VIBE_HOME', Path.home() / '.vibe')).expanduser() / 'vibedeck/agents.json'


def read_settings() -> AgentSettings:
    try:
        return AgentSettings.model_validate_json(settings_path().read_text())
    except FileNotFoundError:
        return AgentSettings()
    except (ValueError, OSError) as exc:
        raise ValueError('Could not read subagent settings. Save them again in Settings → Config.') from exc


def write_settings(settings: AgentSettings) -> None:
    _instruction_document(settings_path().parent.parent, settings)
    target = settings_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.agents-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(settings.model_dump_json(indent=2) + '\n')
        os.replace(temporary, target)
        sync_instructions(target.parent.parent, settings)
    finally:
        Path(temporary).unlink(missing_ok=True)


def delegation_instructions(settings: AgentSettings | None = None) -> str:
    if settings is None:
        try:
            settings = read_settings()
        except ValueError:
            settings = AgentSettings(policy='off')
    rule = {
        'off': 'Do not delegate; subagents are disabled.',
        'requested': 'Delegate when the user asks for agents, including casual requests to send off subagents.',
        'auto': 'Proactively delegate substantial independent work when it improves quality. Keep trivial or tightly coupled work local.',
    }[settings.policy]
    return (f'VibeDeck subagents: {rule} Default quality: {settings.quality}; batch limit: {settings.max_workers}. '
            'Use the bundled mcp_vibedeck_providers delegate tool for Mistral or other provider models. '
            'Use automatic=true only for jobs not requested by the user. Discover configured aliases with list_models. '
            'Honor named providers, model aliases and thinking levels without substitution. Select task kind and quality for the work. '
            'Prefer one worker, at most two independent streams; no duplicate or recursive jobs. '
            'Worker sessions must never delegate. Automatic workers are read-only. Request edits explicitly within the current approval mode; Plan remains planning. '
            'Use context access for supplied excerpts, read for repository inspection. Review results and run final checks yourself. '
            'Do not retry failed workers automatically or claim they executed commands.')


def traits(model) -> tuple[int, set[str]]:
    name = f'{model.alias} {model.name}'.lower()
    tier = 1
    if re.search(r'large|reasoner|reasoning|\bpro\b|opus|glm-5|deepseek-v[34]|minimax-m[23]|gpt-5', name):
        tier = 2
    if re.search(r'(?:^|[- _])mini(?:[- _]|$)|small|flash|lite|air|(?:^|[- _])[378]b\b', name):
        tier = 0
    strengths = set()
    if re.search(r'codex|codestral|devstral|coder|coding', name):
        strengths.add('coding')
    if re.search(r'reason|\br1\b|thinking', name):
        strengths.add('reasoning')
    return tier, strengths


def select_model(models: dict, job: AgentJob, settings: AgentSettings):
    if not job.task.strip():
        raise ValueError('Worker task cannot be blank.')
    candidates = [m for m in models.values() if not job.provider or m.provider == job.provider]
    if job.model != 'auto':
        selected = models.get(job.model)
        if selected is None or selected not in candidates:
            raise ValueError('Requested model/provider is not configured or allowed. No fallback was made.')
        reason = 'Exact requested model'
    else:
        if not candidates:
            raise ValueError('Requested provider has no configured models. No fallback was made.')
        quality = job.quality or settings.quality
        target_tier = {'fast': 0, 'balanced': 1, 'strong': 2}[quality]
        kind = 'coding' if job.kind == 'review' else job.kind
        # shortcut: name hints are not benchmarks; exact aliases override these until providers expose comparable capability scores.
        def score(model):
            tier, strengths = traits(model)
            version = tuple(int(n) for n in re.findall(r'\d+', model.name))
            return (-abs(tier-target_tier), kind in strengths, model.provider == 'mistral', version, model.alias)
        selected = max(candidates, key=score)
        reason = f'{quality} {job.kind} selection from configured aliases using model-name hints'
    levels = list(selected.thinking_levels)
    effort = job.effort
    if effort == 'auto':
        effort = ('high' if (job.quality or settings.quality) == 'strong' or job.kind == 'reasoning' else selected.thinking)
        if effort not in levels:
            effort = selected.thinking if selected.thinking in levels else levels[-1]
    if effort not in levels:
        raise ValueError(f'Requested thinking level is unsupported by {selected.alias}; no request was sent.')
    return selected.model_copy(update={'thinking': effort}), reason


def describe_models(models: dict) -> list[dict]:
    return [{'model': m.alias, 'provider': m.provider, 'tier': ['fast', 'balanced', 'strong'][traits(m)[0]],
             'strengths': sorted(traits(m)[1]), 'thinking_levels': m.thinking_levels}
            for m in models.values()]


_START = '<!-- VibeDeck subagents:start -->'
_END = '<!-- VibeDeck subagents:end -->'


def _instruction_document(home: Path, settings: AgentSettings) -> tuple[Path, str, str]:
    target = home / 'AGENTS.md'
    if target.is_symlink():
        raise ValueError('VIBE_HOME/AGENTS.md is a symlink; a regular Vibe instructions file is needed for managed subagent policy.')
    original = target.read_text() if target.exists() else ''
    section = _START + '\n' + delegation_instructions(settings) + '\n' + _END
    if _START in original or _END in original:
        if original.count(_START) != 1 or original.count(_END) != 1 or original.index(_END) < original.index(_START):
            raise ValueError('The managed VibeDeck section in VIBE_HOME/AGENTS.md is malformed; repair its markers before saving.')
        start = original.index(_START)
        end = original.index(_END) + len(_END)
        updated = original[:start] + section + original[end:]
    else:
        updated = original + ('\n\n' if original else '') + section + '\n'
    return target, original, updated


def sync_instructions(home: Path, settings: AgentSettings | None = None) -> None:
    if settings is None:
        path = home / 'vibedeck/agents.json'
        settings = AgentSettings.model_validate_json(path.read_text()) if path.exists() else AgentSettings()
    target, original, updated = _instruction_document(home, settings)
    if updated == original:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.agents-doc-', dir=target.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(updated)
        if target.exists():
            os.chmod(temporary, target.stat().st_mode & 0o777)
        if (target.read_text() if target.exists() else '') != original:
            raise ValueError('Vibe instructions changed externally; refresh before saving.')
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)
