# Install VibeDeck

Fedora and Debian use the same VibeDeck source and Electron installer. Follow the system package instructions for your OS below. You need Python 3.11+, Node 22.12+, npm, pnpm 9.15.9, the Vibe CLI, and an unlocked desktop keyring.

## System packages

**Fedora 44**

```bash
sudo dnf install python3 nodejs npm curl chromium libsecret nss atk at-spi2-atk mesa-libgbm alsa-lib
```

**Debian 12**

```bash
sudo apt update
sudo apt install python3 python3-venv curl chromium libsecret-1-0 libnss3 libatk-bridge2.0-0 libgbm1 libasound2
```

Debian 12 ships Node 18. Install Node 22.12+ and npm separately from [Node.js](https://nodejs.org/en/download). Recent Ubuntu/Mint may use `libasound2t64` instead of `libasound2`. Chrome also works if you prefer it to Chromium.

## Set up and launch

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then run:

```bash
npm install --global --prefix "$HOME/.local" pnpm@9.15.9
export PATH="$HOME/.local/bin:$PATH"
uv tool install mistral-vibe==2.26.0 --python 3.14
vibe --setup
```

From the VibeDeck repository:

```bash
bash packaging/install.sh
vibedeck
```

The installer writes to `~/.local/share/vibedeck` and adds a launcher in `~/.local/bin`. It preserves your data and Vibe sessions. For upgrades, finish active turns, close the app, and stop its sidecar before reinstalling.

## Connect your services

- Open **Settings → Providers** to connect services, then **Models** to load or add model IDs.
- Install the official Codex CLI for ChatGPT sign-in. Keep the VibeDeck sidecar running when using its Codex bridge from the terminal.
- Install Chrome or Chromium for Mistral usage. Choose **Connect usage**, sign in through the browser, then **I've signed in** in VibeDeck. The same connection opens all Work Context pages and Scheduled without signing in or refreshing each page. This does not replace `vibe --setup` or an API key for local API tools.
- Finish a CLI conversation before choosing **Continue in desktop**. Only one process can write to the session at a time.
- Docs & API and Admin open inside the desktop. Admin reuses your saved browser sign-in in a separate page session. If it needs authentication, use the Sign in button beside Vibe, finish in Chrome, and choose **I've signed in**. Mistral Studio opens in the browser; full desktop integration is planned.
- **Settings → Config** includes saved zoom and seven themes.
- Code mode includes Ask, Plan, Accept edits, and Full auto. Subagent policy, quality, and batch size are under **Settings → Config → Subagents**. First launch installs the shared worker tools, including for a Mistral-only setup. Configure additional models before asking for their providers. Reopen an already-running CLI after changing delegation policy; idle desktop sessions refresh automatically.
- Work → Context and Scheduled use your signed-in Mistral web workspace inside Electron. The separate API tools require a Mistral API key with matching workspace permissions.

[Back to VibeDeck](../README.md)
