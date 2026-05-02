# Codex Account Switcher

A clean VS Code extension for switching between multiple local Codex accounts.

Codex Account Switcher lets you save multiple Codex `auth.json` sessions and switch the active account from a dedicated VS Code Activity Bar panel.

> This extension is designed for local use. It does not upload, sync, or share your Codex credentials.

## Features

- Add Codex accounts through the regular `codex login` flow
- Store each account in an isolated `CODEX_HOME`
- Switch the active Codex account with one click
- Dedicated Activity Bar view
- Minimal, native-looking VS Code UI
- Status Bar indicator showing the active account
- Automatic backup before replacing the active `auth.json`
- Local-only credential storage

## Requirements

- VS Code 1.90.0 or higher.
- Codex CLI / Extension installed.

## How it works

> *Note: All paths below (`~/.codex` and `~/.codex-switcher`) are configurable in your VS Code settings.*

Codex normally uses an active authentication file at:

```text
~/.codex/auth.json
```

On Windows, this is usually:

```text
C:\Users\<you>\.codex\auth.json
```

This extension stores account-specific auth files under:

```text
~/.codex-switcher/accounts/<account-id>/auth.json
```

On Windows:

```text
C:\Users\<you>\.codex-switcher\accounts\<account-id>\auth.json
```

When you switch accounts, the extension copies the selected account's `auth.json` into the active Codex location:

```text
~/.codex/auth.json
```

Before replacing the active file, it creates a backup under:

```text
~/.codex-switcher/backups/
```

## Usage

Open the Codex icon in the VS Code Activity Bar.

From there you can:

- Add a new account
- View the active account
- Switch to a saved account
- Remove a saved account
- Open the local storage folder
- Reload VS Code after switching accounts

## Adding an account

Click **Add account**.

The extension will:

1. Ask for an account name.
2. Create an isolated account folder.
3. Open a VS Code terminal.
4. Run `codex login` with a dedicated `CODEX_HOME`.
5. Wait for Codex to create `auth.json`.
6. Save the account locally.

You still authenticate through the official Codex login flow. The extension does not ask for your password or manually generate tokens.

## Switching accounts

Click **Use** next to a saved account.

The extension will:

1. Back up the current `~/.codex/auth.json`.
2. Copy the selected saved account's `auth.json` to `~/.codex/auth.json`.
3. Mark that account as active.
4. Prompt you to reload VS Code.

Reloading VS Code is recommended because the official Codex extension or CLI integration may keep credentials in memory.

## Extension Settings

This extension contributes the following settings:

* `codexAccountSwitcher.codexHome`: Codex home path where the active `auth.json` is updated. Defaults to `~/.codex`.
* `codexAccountSwitcher.switcherHome`: Path for the extension's local storage and backups. Defaults to `~/.codex-switcher`.
* `codexAccountSwitcher.promptReloadAfterSwitch`: Ask to reload VS Code after switching the Codex account. Defaults to `true`.
* `codexAccountSwitcher.autoUseNewAccount`: Automatically activate a newly added Codex account after login. Defaults to `false`.

## Security

`auth.json` contains access tokens and should be treated like a password.

Do not commit or share files from:

```text
~/.codex/
~/.codex-switcher/
```

This extension stores credentials locally only. It does not send credentials to any external service.

## Development

Install dependencies:

```bash
npm install
```

Compile TypeScript:

```bash
npm run compile
```

Run the extension in a VS Code Extension Development Host:

```text
Press F5
```

If VS Code asks for a debugger, create `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Run Codex Account Switcher",
      "type": "extensionHost",
      "request": "launch",
      "args": [
        "--extensionDevelopmentPath=${workspaceFolder}"
      ],
      "outFiles": [
        "${workspaceFolder}/out/**/*.js"
      ],
      "preLaunchTask": "npm: compile"
    }
  ]
}
```

## Packaging

Install the VS Code extension packaging tool:

```bash
npm install --save-dev @vscode/vsce
```

Build a local VSIX package:

```bash
npx @vscode/vsce package
```

This generates a file like:

```text
codex-account-switcher-0.0.1.vsix
```

Install it locally:

```bash
code --install-extension ./codex-account-switcher-0.0.1.vsix --force
```

## Recommended repository contents

Commit these files and folders:

```text
.vscode/
media/
src/
.gitignore
README.md
package-lock.json
package.json
tsconfig.json
```

Do not commit generated or local files:

```text
node_modules/
out/
*.vsix
.vscode-test/
```

## License

Private/internal use.