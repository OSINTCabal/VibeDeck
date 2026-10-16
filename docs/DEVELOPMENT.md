# Development

VibeDeck is the master source repository for Fedora and Debian. Both use the same frontend, sidecar, Electron shell, and installer. Keep platform changes here and verify them with the Linux CI matrix.

Version 1.0.0 is the first release. Source archives, a cloneable Git bundle, and checksums are kept separately from Git-tracked source. Dependencies, browser profiles, credentials, and conversation databases are excluded.

## Checks

From the repository root:

```bash
python3 -m venv .venv
.venv/bin/pip install '.[dev]'
.venv/bin/python -m pytest -q
.venv/bin/ruff check sidecar tests scripts
(cd frontend && pnpm install --frozen-lockfile && pnpm test && pnpm build)
node --test shell/electron/tests/*.js
```

Default tests use isolated data and exclude paid integration tests. Native checks need the installed Vibe CLI:

```bash
.venv/bin/python scripts/check_native_interop.py
.venv/bin/python scripts/check_provider_interop.py
.venv/bin/python scripts/check_subagents.py
```

These checks use local model fixtures. Desktop and browser checks require Playwright and the matching runtime:

```bash
.venv/bin/python scripts/check_browser.py
.venv/bin/python scripts/check_electron.py
```

The Electron check needs an active display or Xvfb. Its temporary bootstrap supplies DNS for hosted-page fixtures before loading the real shell. Production network checks stay enabled. The Linux CI matrix runs browser, Electron, provider, and CLI handoff checks on Fedora and Debian.

[Latest verification and remaining limits](VERIFICATION.md).

## Source map

| Directory | Contents |
| --- | --- |
| `frontend/` | Desktop interface |
| `sidecar/` | Local API, CLI bridge, sessions, providers |
| `shell/electron/` | Supported desktop shell and browser usage connection |
| `shell/src-tauri/` | Experimental Tauri shell |
| `packaging/` | Linux installer and launcher |
| `tests/`, `scripts/` | Regression and workflow checks |

The sidecar listens on loopback and validates local Host and browser Origin headers. Local processes can access its API; Codex bridge routes also require their existing token. API keys use the configured keyring or private environment files; model requests go to the selected services.

Screenshots in `docs/screenshots/` come from isolated UI tests with sample data.

## Web workspace boundaries

The sidecar reads configured connectors and Libraries from Mistral's public API. Library creation uses the same cloud store, with workspace ownership. Browser usage sign-in and API-key workspace access are separate. API access may return fewer items than the browser account.

Connector listing resolves user authentication before filtering. Mistral's list endpoint can report false until user data is fetched for each connector. The sidecar keeps those responses in memory and returns only display metadata. Status checks run four at a time, once per unique connector per refresh, without model calls or automatic retries.

Knowledge, Instructions, and Scheduled run in the hosted workspace inside Electron's sandboxed WebContentsView. The persistent partition has no preload or access to local IPC; only secure Mistral cookies from the app-owned sign-in browser enter that partition. Docs stays anonymous. Admin uses its own persistent partition and imports only Admin and shared Mistral authentication cookies. Its Sign in control opens Admin in regular Chrome; Google cookies never enter Electron. Authentication callbacks keep their original partition, and Refresh restarts expired login flows from the service page. Sign-out clears all workspace partitions and the saved browser connection. Mistral Studio stays in the browser; full desktop integration is planned. Local conversations and CLI skills are not automatically uploaded. The Extensions page links to Mistral's one-way `/teleport` flow for eligible Code sessions.

Workspace tests check pagination, safe metadata, credential redaction, validation, and failed writes without automatic retries. Browser checks cover the Context tree, Work thinking, shared Library creation, error recovery, Extensions, and compact windows.

## Before publishing

Choose a license before making the repository public. Review the README screenshots and run the checks above, then scan the history with `gitleaks git --redact --log-opts=--all .`.

The private repository is `https://github.com/OSINTCabal/VibeDeck`. Check `git remote -v` before pushing. Release tags use `vMAJOR.MINOR.PATCH`, starting at `v1.0.0`.

[Back to VibeDeck](../README.md)


## Built-in worker limits

The bundled MCP tools are installed into Vibe's user configuration on first launch. Settings live in VIBE_HOME/vibedeck/agents.json and are read for each delegation. The default is delegation on request. A marked section in VIBE_HOME/AGENTS.md carries policy to the native model prompt; existing user instructions are preserved. Saving policy marks desktop sessions for instruction refresh once idle. Automatic jobs are read-only; exact provider/model/effort constraints fail without substitution when unavailable.

Context workers make one request with a bounded reply. Repository workers run the existing Vibe CLI with six turns, 24,000 cumulative tokens, a 175-second timeout, zero provider retries, and an explicit read/grep or read/edit tool allowlist. They have no shell or delegation tools. Two workers run concurrently per MCP process; a project lock prevents overlapping worker edits across processes. Cancelling a job terminates its CLI process group. The main agent reviews edits and runs commands under its own approval mode. Native CLI sessions keep repository-worker history available for inspection.

Selection uses name-based tier and task hints among allowed aliases. These are transparent defaults, not measured provider rankings; use an exact alias when a particular model is required. No external Fleet service is used.

## Failure recovery

Credential files use exclusive private temporary files in the private app configuration directory. Background conversation events flush without relying on animation frames. Session reconciliation removes missing CLI-imported registry metadata only after a complete successful listing, preserving usage records.

Malformed subagent policy reads return HTTP 409 with `code: invalid_agent_settings`. The existing settings form presents an unsaved policy-Off draft; only an explicit save replaces the policy. Permission failures do not offer replacement defaults. Codex effort is validated against native model capabilities and sent as `turn/start.effort`; omitted effort retains native defaults.
