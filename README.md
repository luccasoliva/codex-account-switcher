# Codex Session Switcher

Switch between multiple Codex sessions directly from VS Code.

## Why

I built this because I use Codex with different accounts: personal, company, client, and workspace-specific accounts.

Logging out and logging back in every time was slow and annoying, so this extension makes the process faster: save your Codex sessions once, then switch between them from a small panel in VS Code.

## Features

- Add multiple Codex sessions
- Switch sessions with one click
- Activity Bar panel inside VS Code
- Shows the active session
- Creates a backup before switching
- Stores everything locally

## How it works

Codex uses a local authentication file:

```text
~/.codex/auth.json
```

Codex Session Switcher saves separate sessions in isolated folders and, when you switch, copies the selected session's `auth.json` into the active Codex location.

When adding a session, the extension runs the official Codex login flow using an isolated `CODEX_HOME`.

It does not generate tokens, bypass login, or ask for your password.

## Security

Your `auth.json` files contain authentication tokens.

Do not share or commit:

```text
~/.codex/
~/.codex-switcher/
```

The extension keeps credentials local and does not send them anywhere.

## Usage

Open the Codex Session Switcher icon in the Activity Bar.

Then you can add a session, switch sessions, remove saved sessions, open storage, or reload VS Code after switching.

## License

MIT