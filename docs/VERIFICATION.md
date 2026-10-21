# Verification

Version 1.0.0, checked October 16, 2026. Automated tests use temporary profiles, databases, and loopback model fixtures. They do not spend subscription or API tokens.

| Check | Fedora 44 | Debian 12 |
| --- | --- | --- |
| Backend tests (187) and lint | Passed | Passed |
| JavaScript tests (43), typecheck, production build | Passed | Passed |
| Browser navigation, settings, errors, animations | Passed | Passed |
| Electron workspace and account flows | Passed | Passed |
| Desktop and CLI handoff | Passed | Passed |
| Provider and subagent routing | Passed | Passed |
| Clean source installation and first launch | Passed | Passed |

## Installation and sign-in

Clean containers started with no VibeDeck installation, database, or browser profile. Both installed the shared source installer and passed the installed-launcher check. First launch displayed Mistral sign-in, kept Mistral as the default, installed the bundled worker tools, and offered Ask, Plan, Accept edits, and Full auto. UI tests used the distribution's Chromium package and Xvfb.

Fresh browser sign-in was completed live on Fedora. Skills, Knowledge, Connectors, Libraries, Instructions, Scheduled, Docs, and Admin opened without another login. Subscription usage returned `ready`. The account stayed saved after an app restart, and Skills and Admin reopened authenticated. Sign-out cleared the disposable browser connection and restored the Sign in control. Existing desktop data stayed separate.

Debian's authentication checks use isolated fixtures. They cover browser handoff, cancellation, incomplete sign-in, cookie scope, authentication callbacks, session persistence, and sign-out.

## Application checks

- Conversation streaming, thinking, approvals, attachments, persisted history, and desktop/CLI handoff.
- Work Context navigation, file uploads, blob exports, permission prompts, account menus, and loading recovery.
- Provider and model settings, keyring errors, saved defaults, zoom, themes, and compact layouts.
- Subagent selection, requested reasoning effort, repository read/edit permissions, cancellation, and worker limits.
- Private credential writes, background event flushing, shared CLI session reconciliation, and malformed policy recovery.
- Mistral, Codex, MiniMax, and Ollama protocol coverage. Eight provider fixtures cover supported API formats and delegation in both directions.

The native handoff check makes exactly two loopback model calls. The Electron workflow makes one. Failed workers are attempted once. Settings changes and usage views make no model requests.

Browser frame timing was 16.8 ms at the 95th percentile on Fedora and 16.7 ms on Debian. These measurements come from the test machine, not every GPU or window manager.

## Remaining limits

- Live browser consent was checked on Fedora only. New connector authorizations, cloud edits, microphone/camera hardware, and paid provider generation were not repeated. Cloud writes use fixtures.
- Read-only model catalogs succeeded for Mistral, Codex, and MiniMax. Live Ollama was unavailable because its local system service was stopped; protocol and error-recovery fixtures passed.
- Linux Mint has not had a separate desktop test. Tauri remains experimental; use Electron for the supported browser connection and embedded workspace.
- Automatic worker selection uses model-name and task hints. Exact model aliases are supported. Repository workers do not run shell commands or create further agents; the main agent verifies their changes.
- Local sessions, CLI skills, and MCP configuration remain separate from web workspace data. See [web workspace boundaries](WEB_PARITY.md).

## October 21, 2026 coding-session stress run

With Vibe CLI 3.0.1, an isolated loopback model completed 100 turns in one native session, switched between two configured model aliases ten times, and resumed after the bridge restarted at turn 50. The model endpoint received exactly 100 requests. The desktop → CLI → desktop handoff, provider-format matrix, built-in subagent delegation, and read/edit worker permission and cancellation checks passed. All 187 backend tests, frontend and Electron JavaScript tests, lint, typecheck, production build, and browser workflow checks passed.

A separate 150-turn local run measured app-server resident memory at 141,072; 179,988; 169,556; and 174,760 KiB at turns 0, 50, 100, and 150 on this machine. It completed without a failure or sustained upward trend; the sample does not establish a general memory limit.

The run exposed two Vibe 3 compatibility issues: repository workers used the removed `plan` agent, and the desktop's Plan mode was rejected. Workers now use `ask` with only read/grep enabled. VibeDeck creates a read-only `plan` profile if the user has not supplied one; the native handoff check verifies that the app-server accepts it.

Live Mistral generation stopped before a model request because the current CLI profile has no `MISTRAL_API_KEY`. MiniMax's external worker route rejected its selected model, and no MiniMax provider key was detected. Their live generation remains unverified; the Mistral and MiniMax loopback protocol paths passed. Electron's live window check could not launch in this headless session because neither an X display nor Xvfb was available; its JavaScript tests and browser UI checks passed.

[Back to VibeDeck](../README.md)
