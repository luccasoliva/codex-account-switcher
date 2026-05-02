import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

type AccountMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type AccountsJson = {
  active?: string;
  accounts: AccountMeta[];
};

type Paths = {
  codexHome: string;
  switcherHome: string;
  codexAuthPath: string;
  accountsJsonPath: string;
  accountsDir: string;
  backupsDir: string;
};

let statusBar: vscode.StatusBarItem;
let webviewProvider: CodexAccountsWebviewProvider | undefined;

function expandHome(input: string): string {
  const value = input.trim();

  if (!value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return value;
}

function getConfig() {
  return vscode.workspace.getConfiguration("codexAccountSwitcher");
}

function getPaths(): Paths {
  const config = getConfig();

  const codexHomeConfig = config.get<string>("codexHome") || "";
  const switcherHomeConfig = config.get<string>("switcherHome") || "";

  const codexHome =
    expandHome(codexHomeConfig) || path.join(os.homedir(), ".codex");

  const switcherHome =
    expandHome(switcherHomeConfig) ||
    path.join(os.homedir(), ".codex-switcher");

  return {
    codexHome,
    switcherHome,
    codexAuthPath: path.join(codexHome, "auth.json"),
    accountsJsonPath: path.join(switcherHome, "accounts.json"),
    accountsDir: path.join(switcherHome, "accounts"),
    backupsDir: path.join(switcherHome, "backups")
  };
}

function normalizeAccountId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function accountHomePath(accountId: string): string {
  return path.join(getPaths().accountsDir, accountId);
}

function accountAuthPath(accountId: string): string {
  return path.join(accountHomePath(accountId), "auth.json");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureStorage(): Promise<void> {
  const p = getPaths();

  await fs.mkdir(p.codexHome, { recursive: true });
  await fs.mkdir(p.switcherHome, { recursive: true });
  await fs.mkdir(p.accountsDir, { recursive: true });
  await fs.mkdir(p.backupsDir, { recursive: true });

  if (!(await exists(p.accountsJsonPath))) {
    const initial: AccountsJson = {
      accounts: []
    };

    await fs.writeFile(
      p.accountsJsonPath,
      JSON.stringify(initial, null, 2),
      "utf8"
    );
  }
}

async function readAccounts(): Promise<AccountsJson> {
  await ensureStorage();

  const p = getPaths();
  const raw = await fs.readFile(p.accountsJsonPath, "utf8");

  try {
    const parsed = JSON.parse(raw) as AccountsJson;

    if (!Array.isArray(parsed.accounts)) {
      return { accounts: [] };
    }

    return parsed;
  } catch {
    return { accounts: [] };
  }
}

async function writeAccounts(data: AccountsJson): Promise<void> {
  await ensureStorage();

  const p = getPaths();

  await fs.writeFile(
    p.accountsJsonPath,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function secureCopy(source: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(source, target);

  if (process.platform !== "win32") {
    await fs.chmod(target, 0o600);
  }
}

async function backupCurrentAuth(): Promise<void> {
  const p = getPaths();

  if (!(await exists(p.codexAuthPath))) {
    return;
  }

  await fs.mkdir(p.backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(p.backupsDir, `auth-${stamp}.json`);

  await secureCopy(p.codexAuthPath, backupPath);
}

async function saveAccountMetadata(id: string, name: string): Promise<void> {
  const data = await readAccounts();
  const now = new Date().toISOString();

  const existing = data.accounts.find((account) => account.id === id);

  if (existing) {
    existing.name = name;
    existing.updatedAt = now;
  } else {
    data.accounts.push({
      id,
      name,
      createdAt: now,
      updatedAt: now
    });
  }

  data.active = id;

  await writeAccounts(data);
  await refreshUi();
}

async function setActiveAccount(id: string): Promise<void> {
  const data = await readAccounts();
  data.active = id;

  await writeAccounts(data);
  await refreshUi();
}

async function getActiveAccount(): Promise<AccountMeta | undefined> {
  const data = await readAccounts();

  if (!data.active) {
    return undefined;
  }

  return data.accounts.find((account) => account.id === data.active);
}

async function updateStatusBar(): Promise<void> {
  if (!statusBar) return;

  const active = await getActiveAccount();

  if (active) {
    statusBar.text = `$(account) Codex: ${active.name}`;
    statusBar.tooltip = `Active Codex account: ${active.name}\nClick to switch account.`;
  } else {
    statusBar.text = "$(account) Codex: No account";
    statusBar.tooltip = "No Codex account tracked. Click to open Codex Account Switcher.";
  }

  statusBar.command = "codexAccounts.focusView";
  statusBar.show();
}

async function refreshUi(): Promise<void> {
  await updateStatusBar();
  await webviewProvider?.refresh();
}

async function waitForAuthJson(authPath: string, timeoutMs: number): Promise<boolean> {
  if (await exists(authPath)) {
    return true;
  }

  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (await exists(authPath)) {
      return true;
    }
  }

  return false;
}

function sendCodexLoginToTerminal(terminal: vscode.Terminal): void {
  terminal.sendText("codex login");
}

async function addAccount(): Promise<void> {
  await ensureStorage();

  const name = await vscode.window.showInputBox({
    title: "Add Codex Account",
    prompt: "Enter a name for this Codex account.",
    placeHolder: "Personal, Work, Client X..."
  });

  if (!name) return;

  const id = normalizeAccountId(name);

  if (!id) {
    vscode.window.showErrorMessage("Invalid account name.");
    return;
  }

  const accountHome = accountHomePath(id);
  const authPath = accountAuthPath(id);

  if (await exists(authPath)) {
    const overwrite = await vscode.window.showWarningMessage(
      `The account "${name}" already has a saved auth.json. Do you want to login again and overwrite?`,
      "Overwrite",
      "Cancel"
    );

    if (overwrite !== "Overwrite") {
      return;
    }
  }

  await fs.mkdir(accountHome, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: `Codex Login: ${name}`,
    env: {
      CODEX_HOME: accountHome
    }
  });

  terminal.show();
  sendCodexLoginToTerminal(terminal);

  vscode.window.showInformationMessage(
    `Please login in the browser for account "${name}". The extension will automatically detect auth.json.`
  );

  await webviewProvider?.setBusy(
    true,
    `Waiting for login for account "${name}"...`
  );

  const detected = await waitForAuthJson(authPath, 180000);

  await webviewProvider?.setBusy(false);

  if (!detected) {
    vscode.window.showWarningMessage(
      `Did not detect auth.json for "${name}" yet. When login completes, try adding the account again.`
    );
    await refreshUi();
    return;
  }

  await saveAccountMetadata(id, name);

  const autoUseNewAccount =
    getConfig().get<boolean>("autoUseNewAccount") ?? false;

  if (autoUseNewAccount) {
    await switchToAccount(id, name);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Account "${name}" added successfully.`,
    "Use now",
    "Close"
  );

  if (action === "Use now") {
    await switchToAccount(id, name);
  }
}

async function switchAccount(): Promise<void> {
  const data = await readAccounts();

  if (data.accounts.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No Codex accounts saved yet.",
      "Add account"
    );

    if (action === "Add account") {
      await addAccount();
    }

    return;
  }

  const items = data.accounts.map((account) => {
    const isActive = account.id === data.active;

    return {
      label: `${isActive ? "$(check) " : "$(account) "}${account.name}`,
      description: isActive ? "Active" : account.id,
      detail: accountAuthPath(account.id),
      account
    };
  });

  items.push({
    label: "$(add) Add new account",
    description: "Run codex login in isolated CODEX_HOME",
    detail: "Add a new Codex account",
    account: {
      id: "__add__",
      name: "Add new account",
      createdAt: "",
      updatedAt: ""
    }
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: "Switch Codex Account",
    placeHolder: "Choose the Codex account to activate"
  });

  if (!selected) return;

  if (selected.account.id === "__add__") {
    await addAccount();
    return;
  }

  await switchToAccount(selected.account.id, selected.account.name);
}

async function switchToAccount(id: string, name: string): Promise<void> {
  const p = getPaths();
  const source = accountAuthPath(id);
  const target = p.codexAuthPath;

  if (!(await exists(source))) {
    vscode.window.showErrorMessage(
      `auth.json not found for account "${name}".`
    );
    return;
  }

  await webviewProvider?.setBusy(true, `Switching to "${name}"...`);

  try {
    await backupCurrentAuth();
    await secureCopy(source, target);
    await setActiveAccount(id);
  } finally {
    await webviewProvider?.setBusy(false);
  }

  const shouldPromptReload =
    getConfig().get<boolean>("promptReloadAfterSwitch") ?? true;

  if (!shouldPromptReload) {
    vscode.window.showInformationMessage(`Codex switched to "${name}".`);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Codex switched to "${name}". Please reload VS Code to ensure the Codex extension rereads auth.json.`,
    "Reload Window",
    "Later"
  );

  if (action === "Reload Window") {
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

async function showActive(): Promise<void> {
  const active = await getActiveAccount();

  if (!active) {
    vscode.window.showInformationMessage("No active Codex account registered.");
    return;
  }

  const authPath = accountAuthPath(active.id);

  vscode.window.showInformationMessage(
    `Active Codex account: ${active.name}\n${authPath}`
  );
}

async function openStorage(): Promise<void> {
  await ensureStorage();

  const p = getPaths();
  const uri = vscode.Uri.file(p.switcherHome);

  await vscode.env.openExternal(uri);
}

async function removeAccount(): Promise<void> {
  const data = await readAccounts();

  if (data.accounts.length === 0) {
    vscode.window.showInformationMessage("No saved accounts to remove.");
    return;
  }

  const selected = await vscode.window.showQuickPick(
    data.accounts.map((account) => ({
      label: account.name,
      description: account.id === data.active ? "Active" : account.id,
      detail: accountAuthPath(account.id),
      account
    })),
    {
      title: "Remove Saved Codex Account",
      placeHolder: "Choose a saved account to remove"
    }
  );

  if (!selected) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove saved account "${selected.account.name}"? This deletes the local copy in .codex-switcher, but does not log out of the site.`,
    "Remove",
    "Cancel"
  );

  if (confirm !== "Remove") return;

  const accountHome = accountHomePath(selected.account.id);

  await fs.rm(accountHome, {
    recursive: true,
    force: true
  });

  const nextAccounts = data.accounts.filter(
    (account) => account.id !== selected.account.id
  );

  const nextData: AccountsJson = {
    accounts: nextAccounts,
    active: data.active === selected.account.id ? undefined : data.active
  };

  await writeAccounts(nextData);
  await refreshUi();

  vscode.window.showInformationMessage(
    `Account "${selected.account.name}" removed from switcher.`
  );
}

async function removeAccountById(id: string): Promise<void> {
  const data = await readAccounts();
  const account = data.accounts.find((item) => item.id === id);

  if (!account) {
    vscode.window.showErrorMessage("Account not found.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove saved account "${account.name}"?`,
    "Remove",
    "Cancel"
  );

  if (confirm !== "Remove") return;

  await fs.rm(accountHomePath(id), {
    recursive: true,
    force: true
  });

  const nextAccounts = data.accounts.filter((item) => item.id !== id);

  await writeAccounts({
    accounts: nextAccounts,
    active: data.active === id ? undefined : data.active
  });

  await refreshUi();

  vscode.window.showInformationMessage(`Account "${account.name}" removed.`);
}

async function reloadWindow(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function focusView(): Promise<void> {
  await vscode.commands.executeCommand("codexAccountsView.focus");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class CodexAccountsWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private busy = false;
  private busyMessage = "";

  constructor(private readonly extensionUri: vscode.Uri) { }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.type) {
          case "add":
            await addAccount();
            break;

          case "switch":
            if (typeof message.id === "string" && typeof message.name === "string") {
              await switchToAccount(message.id, message.name);
            }
            break;

          case "remove":
            if (typeof message.id === "string") {
              await removeAccountById(message.id);
            }
            break;

          case "openStorage":
            await openStorage();
            break;

          case "reload":
            await reloadWindow();
            break;

          case "refresh":
            await this.refresh();
            break;

          case "showActive":
            await showActive();
            break;
        }
      } catch (error) {
        vscode.window.showErrorMessage(String(error));
        await this.setBusy(false);
        await this.refresh();
      }
    });

    this.refresh();
  }

  async setBusy(value: boolean, message = ""): Promise<void> {
    this.busy = value;
    this.busyMessage = message;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;

    const data = await readAccounts();
    const p = getPaths();

    this.view.webview.html = this.getHtml(data, p);
  }

  private getHtml(data: AccountsJson, p: Paths): string {
    const accounts = data.accounts;
    const active = accounts.find((item) => item.id === data.active);

    const accountRows =
      accounts.length === 0
        ? `
        <div class="empty">
          <div class="empty-title">No accounts yet</div>
          <div class="empty-text">Add a Codex account to get started.</div>
        </div>
      `
        : accounts
          .map((account) => {
            const isActive = account.id === data.active;
            const safeId = escapeHtml(account.id);
            const safeName = escapeHtml(account.name);
            const safeAuthPath = escapeHtml(accountAuthPath(account.id));

            return `
              <div class="account-row ${isActive ? "active" : ""}">
                <div class="account-main">
                  <div class="account-title-row">
                    <span class="status-dot ${isActive ? "on" : ""}"></span>
                    <span class="account-name">${safeName}</span>
                    ${isActive ? `<span class="active-pill">Active</span>` : ""}
                  </div>
                  <div class="account-path">${safeAuthPath}</div>
                </div>

                <div class="account-actions">
                  ${isActive
                ? `<button class="icon-button" title="Use again" data-action="switch" data-id="${safeId}" data-name="${safeName}">↻</button>`
                : `<button class="small-button" data-action="switch" data-id="${safeId}" data-name="${safeName}">Use</button>`
              }
                  <button class="icon-button danger" title="Remove" data-action="remove" data-id="${safeId}">×</button>
                </div>
              </div>
            `;
          })
          .join("");

    return `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8" />
      <meta
        http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"
      />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />

      <style>
        :root {
          --bg: var(--vscode-sideBar-background);
          --fg: var(--vscode-sideBar-foreground);
          --muted: var(--vscode-descriptionForeground);
          --border: var(--vscode-panel-border);
          --button-bg: var(--vscode-button-background);
          --button-fg: var(--vscode-button-foreground);
          --button-hover: var(--vscode-button-hoverBackground);
          --secondary-bg: var(--vscode-button-secondaryBackground);
          --secondary-fg: var(--vscode-button-secondaryForeground);
          --secondary-hover: var(--vscode-button-secondaryHoverBackground);
          --input-bg: var(--vscode-input-background);
          --focus: var(--vscode-focusBorder);
          --error: var(--vscode-errorForeground);
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          padding: 0;
          background: var(--bg);
          color: var(--fg);
          font-family: var(--vscode-font-family);
          font-size: var(--vscode-font-size);
        }

        .page {
          padding: 12px;
        }

        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 14px;
        }

        .brand {
          min-width: 0;
        }

        .brand-title {
          font-size: 13px;
          font-weight: 600;
          line-height: 1.3;
          margin: 0;
        }

        .brand-subtitle {
          margin-top: 2px;
          color: var(--muted);
          font-size: 11px;
          line-height: 1.3;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .refresh-button {
          width: 26px;
          height: 26px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          border-radius: 5px;
          cursor: pointer;
          flex: 0 0 auto;
          font-size: 14px;
          line-height: 1;
        }

        .refresh-button:hover {
          background: var(--secondary-bg);
          color: var(--secondary-fg);
        }

        .active-card {
          border: 1px solid var(--border);
          background: rgba(127, 127, 127, 0.05);
          border-radius: 8px;
          padding: 10px;
          margin-bottom: 12px;
        }

        .section-label {
          font-size: 10px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-weight: 600;
          margin-bottom: 5px;
        }

        .active-name {
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .busy {
          margin-top: 8px;
          color: var(--muted);
          font-size: 11px;
          line-height: 1.4;
        }

        .toolbar {
          display: grid;
          grid-template-columns: 1fr;
          gap: 6px;
          margin-bottom: 14px;
        }

        button {
          font-family: var(--vscode-font-family);
        }

        .primary-button {
          width: 100%;
          border: 0;
          border-radius: 5px;
          padding: 7px 9px;
          background: var(--button-bg);
          color: var(--button-fg);
          cursor: pointer;
          font-size: 12px;
          font-weight: 500;
        }

        .primary-button:hover {
          background: var(--button-hover);
        }

        .ghost-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 6px;
        }

        .ghost-button {
          border: 1px solid var(--border);
          background: transparent;
          color: var(--fg);
          border-radius: 5px;
          padding: 6px 7px;
          cursor: pointer;
          font-size: 11px;
        }

        .ghost-button:hover {
          background: var(--secondary-bg);
          color: var(--secondary-fg);
        }

        .section-title {
          margin: 0 0 7px;
          color: var(--muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 10px;
          font-weight: 600;
        }

        .account-list {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .account-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
        }

        .account-row:hover {
          background: rgba(127, 127, 127, 0.06);
        }

        .account-row.active {
          border-color: var(--border);
          background: rgba(127, 127, 127, 0.07);
        }

        .account-main {
          min-width: 0;
          flex: 1;
        }

        .account-title-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 999px;
          background: var(--muted);
          opacity: 0.45;
          flex: 0 0 auto;
        }

        .status-dot.on {
          background: var(--focus);
          opacity: 1;
        }

        .account-name {
          font-size: 12px;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          min-width: 0;
        }

        .active-pill {
          font-size: 9px;
          color: var(--muted);
          border: 1px solid var(--border);
          border-radius: 999px;
          padding: 1px 5px;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          flex: 0 0 auto;
        }

        .account-path {
          margin-top: 3px;
          color: var(--muted);
          font-size: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .account-actions {
          display: flex;
          align-items: center;
          gap: 4px;
          flex: 0 0 auto;
        }

        .small-button {
          border: 1px solid var(--border);
          background: transparent;
          color: var(--fg);
          border-radius: 5px;
          padding: 4px 8px;
          cursor: pointer;
          font-size: 11px;
        }

        .small-button:hover {
          background: var(--button-bg);
          color: var(--button-fg);
          border-color: transparent;
        }

        .icon-button {
          width: 24px;
          height: 24px;
          border: 1px solid transparent;
          background: transparent;
          color: var(--muted);
          border-radius: 5px;
          cursor: pointer;
          font-size: 14px;
          line-height: 1;
        }

        .icon-button:hover {
          background: var(--secondary-bg);
          color: var(--secondary-fg);
        }

        .icon-button.danger:hover {
          color: var(--error);
          background: rgba(255, 100, 100, 0.08);
        }

        .empty {
          border: 1px dashed var(--border);
          border-radius: 8px;
          padding: 14px 10px;
          text-align: center;
          color: var(--muted);
        }

        .empty-title {
          color: var(--fg);
          font-size: 12px;
          font-weight: 600;
          margin-bottom: 4px;
        }

        .empty-text {
          font-size: 11px;
          line-height: 1.4;
        }

        .footer {
          margin-top: 14px;
          padding-top: 10px;
          border-top: 1px solid var(--border);
          color: var(--muted);
          font-size: 10px;
          line-height: 1.45;
        }

        .footer div {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        code {
          font-family: var(--vscode-editor-font-family);
          font-size: 0.95em;
        }
      </style>
    </head>

    <body>
      <div class="page">
        <div class="header">
          <div class="brand">
            <div class="brand-title">Codex Accounts</div>
            <div class="brand-subtitle">Switch local Codex sessions</div>
          </div>

          <button class="refresh-button" title="Refresh" data-action="refresh">↻</button>
        </div>

        <div class="active-card">
          <div class="section-label">Active account</div>
          <div class="active-name">${active ? escapeHtml(active.name) : "None"}</div>
          ${this.busy
        ? `<div class="busy">${escapeHtml(this.busyMessage || "Working...")}</div>`
        : ""
      }
        </div>

        <div class="toolbar">
          <button class="primary-button" data-action="add">Add account</button>

          <div class="ghost-row">
            <button class="ghost-button" data-action="reload">Reload</button>
            <button class="ghost-button" data-action="openStorage">Storage</button>
          </div>
        </div>

        <div class="section-title">Saved accounts</div>

        <div class="account-list">
          ${accountRows}
        </div>

        <div class="footer">
          <div title="${escapeHtml(p.codexAuthPath)}"><b>Active file:</b> ${escapeHtml(p.codexAuthPath)}</div>
          <div title="${escapeHtml(p.switcherHome)}"><b>Storage:</b> ${escapeHtml(p.switcherHome)}</div>
        </div>
      </div>

      <script>
        const vscode = acquireVsCodeApi();

        document.addEventListener("click", (event) => {
          const button = event.target.closest("button");
          if (!button) return;

          const action = button.getAttribute("data-action");

          if (action === "add") {
            vscode.postMessage({ type: "add" });
            return;
          }

          if (action === "switch") {
            vscode.postMessage({
              type: "switch",
              id: button.getAttribute("data-id"),
              name: button.getAttribute("data-name")
            });
            return;
          }

          if (action === "remove") {
            vscode.postMessage({
              type: "remove",
              id: button.getAttribute("data-id")
            });
            return;
          }

          if (action === "openStorage") {
            vscode.postMessage({ type: "openStorage" });
            return;
          }

          if (action === "reload") {
            vscode.postMessage({ type: "reload" });
            return;
          }

          if (action === "refresh") {
            vscode.postMessage({ type: "refresh" });
            return;
          }
        });
      </script>
    </body>
    </html>
  `;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  context.subscriptions.push(statusBar);

  webviewProvider = new CodexAccountsWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codexAccountsView",
      webviewProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexAccounts.add", addAccount),
    vscode.commands.registerCommand("codexAccounts.switch", switchAccount),
    vscode.commands.registerCommand("codexAccounts.showActive", showActive),
    vscode.commands.registerCommand("codexAccounts.openStorage", openStorage),
    vscode.commands.registerCommand("codexAccounts.reloadWindow", reloadWindow),
    vscode.commands.registerCommand("codexAccounts.remove", removeAccount),
    vscode.commands.registerCommand("codexAccounts.refreshView", async () => {
      await refreshUi();
    }),
    vscode.commands.registerCommand("codexAccounts.focusView", focusView)
  );

  ensureStorage()
    .then(refreshUi)
    .catch((error) => {
      vscode.window.showErrorMessage(
        `Codex Account Switcher failed to initialize: ${String(error)}`
      );
    });
}

export function deactivate(): void { }