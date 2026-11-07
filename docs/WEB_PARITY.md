# Mistral web workspace

VibeDeck runs Mistral's hosted workspace inside a sandboxed Electron view. Context pages save to the signed-in web account. Native coding sessions share history and configuration with the Vibe CLI. Embedding the web app does not upload local chats, skills, or MCP servers.

## Pages

| Page | Desktop integration |
| --- | --- |
| Skills | `/skills`, with the hosted editor, imports, search, filters, and enabled switches |
| Knowledge | `/knowledge`, with search, folders, view controls, Update, and Clean up |
| Connectors | `/connections`, with account-managed services and browser authorization |
| Libraries | `/libraries`, with library management, indexing, and uploads |
| Instructions | Work's Instructions panel, including tone, additional instructions, preview, and Save |
| Scheduled | `/tasks`, with task setup, recurrence, context, and connector permissions |
| Docs & API | Mistral documentation in its own anonymous desktop session |
| Admin | Mistral Admin in its own persistent authenticated session |
| Studio | Opens the browser console; full desktop integration is planned |

Instructions uses Work's visible navigation because no panel deep link is documented. If automatic selection fails, its own Context menu remains available. Cloud features depend on Mistral's network availability, account permissions, and plan.

## Sign-in

Google and email authentication take place in regular Chrome or Chromium. Only secure Mistral cookies from VibeDeck's own sign-in profile enter Electron. Google cookies are excluded. Admin imports its own scoped Mistral cookies, while Docs stays anonymous. Hosted pages have no local preload, Node access, or desktop IPC bridge.

After browser sign-in, choose **I've signed in** in VibeDeck. The connection is saved across app launches until it expires, is revoked, or the user signs out. Cancellation preserves the existing workspace. Account status checks do not wait for billing requests.

Admin authentication callbacks keep their original session. Refresh restarts expired authentication flows from the service page. Sign-out clears the saved browser connection and all hosted workspace partitions, while preserving CLI credentials, API keys, and local conversations.

## Files and connectors

Uploads use Chromium's file picker. Downloads keep the native Save As dialog and report completion or failure. Blob exports stay in their owning session. Clipboard reads require permission, which clears on sign-out.

**Connect services** opens Mistral Connections in the regular browser for third-party authorization, then returns to the desktop. The Connectors view also lists local CLI MCP servers. Local servers are not automatically registered as web connectors.

Native Skills exposes Vibe's experimental shared registry setting. It requires suitable Mistral API credentials and applies to new CLI and desktop sessions. Browser sign-in alone does not upload local skill files or enable registry access.

## Verification

Fedora and Debian passed isolated browser and Electron checks for navigation, uploads/downloads, cookie scope, session persistence, cancellation, sign-out, and CLI handoff. Fresh browser sign-in and hosted pages were also checked live on Fedora. Fixtures verify integration behavior; they do not establish successful cloud edits or task execution.

[Verification and limits](VERIFICATION.md) · [Back to VibeDeck](../README.md)
