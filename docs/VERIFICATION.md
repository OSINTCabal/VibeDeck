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

[Back to VibeDeck](../README.md)
