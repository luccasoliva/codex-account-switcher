import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

type ProfileMeta = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type ProfilesJson = {
  active?: string;
  profiles: ProfileMeta[];
};

type Paths = {
  codexHome: string;
  switcherHome: string;
  codexAuthPath: string;
  profilesJsonPath: string;
  profilesDir: string;
  backupsDir: string;
};

let statusBar: vscode.StatusBarItem;
let webviewProvider: CodexProfilesWebviewProvider | undefined;

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
  return vscode.workspace.getConfiguration("codexProfileSwitcher");
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
    profilesJsonPath: path.join(switcherHome, "profiles.json"),
    profilesDir: path.join(switcherHome, "profiles"),
    backupsDir: path.join(switcherHome, "backups")
  };
}

function normalizeProfileId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function profileHomePath(profileId: string): string {
  return path.join(getPaths().profilesDir, profileId);
}

function profileAuthPath(profileId: string): string {
  return path.join(profileHomePath(profileId), "auth.json");
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
  await fs.mkdir(p.profilesDir, { recursive: true });
  await fs.mkdir(p.backupsDir, { recursive: true });

  if (!(await exists(p.profilesJsonPath))) {
    const initial: ProfilesJson = {
      profiles: []
    };

    await fs.writeFile(
      p.profilesJsonPath,
      JSON.stringify(initial, null, 2),
      "utf8"
    );
  }
}

async function readProfiles(): Promise<ProfilesJson> {
  await ensureStorage();

  const p = getPaths();
  const raw = await fs.readFile(p.profilesJsonPath, "utf8");

  try {
    const parsed = JSON.parse(raw) as ProfilesJson;

    if (!Array.isArray(parsed.profiles)) {
      return { profiles: [] };
    }

    return parsed;
  } catch {
    return { profiles: [] };
  }
}

async function writeProfiles(data: ProfilesJson): Promise<void> {
  await ensureStorage();

  const p = getPaths();

  await fs.writeFile(
    p.profilesJsonPath,
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

async function saveProfileMetadata(id: string, name: string): Promise<void> {
  const data = await readProfiles();
  const now = new Date().toISOString();

  const existing = data.profiles.find((profile) => profile.id === id);

  if (existing) {
    existing.name = name;
    existing.updatedAt = now;
  } else {
    data.profiles.push({
      id,
      name,
      createdAt: now,
      updatedAt: now
    });
  }

  data.active = id;

  await writeProfiles(data);
  await refreshUi();
}

async function setActiveProfile(id: string): Promise<void> {
  const data = await readProfiles();
  data.active = id;

  await writeProfiles(data);
  await refreshUi();
}

async function getActiveProfile(): Promise<ProfileMeta | undefined> {
  const data = await readProfiles();

  if (!data.active) {
    return undefined;
  }

  return data.profiles.find((profile) => profile.id === data.active);
}

async function updateStatusBar(): Promise<void> {
  if (!statusBar) return;

  const active = await getActiveProfile();

  if (active) {
    statusBar.text = ` Codex: ${active.name}`;
    statusBar.tooltip = `Active Codex profile: ${active.name}\nClick to switch profile.`;
  } else {
    statusBar.text = " Codex: No profile";
    statusBar.tooltip = "No Codex profile tracked. Click to open Codex Profile Switcher.";
  }

  statusBar.command = "codexProfiles.focusView";
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

async function addProfile(): Promise<void> {
  await ensureStorage();

  const name = await vscode.window.showInputBox({
    title: "Add Codex Profile",
    prompt: "Enter a name for this Codex profile.",
    placeHolder: "Personal, Work, Client X..."
  });

  if (!name) return;

  const id = normalizeProfileId(name);

  if (!id) {
    vscode.window.showErrorMessage("Invalid profile name.");
    return;
  }

  const profileHome = profileHomePath(id);
  const authPath = profileAuthPath(id);

  if (await exists(authPath)) {
    const overwrite = await vscode.window.showWarningMessage(
      `The profile "${name}" already has a saved auth.json. Do you want to login again and overwrite?`,
      "Overwrite",
      "Cancel"
    );

    if (overwrite !== "Overwrite") {
      return;
    }
  }

  await fs.mkdir(profileHome, { recursive: true });

  const terminal = vscode.window.createTerminal({
    name: `Codex Login: ${name}`,
    env: {
      CODEX_HOME: profileHome
    }
  });

  terminal.show();
  sendCodexLoginToTerminal(terminal);

  vscode.window.showInformationMessage(
    `Please login in the browser for profile "${name}". The extension will automatically detect auth.json.`
  );

  await webviewProvider?.setBusy(
    true,
    `Waiting for login for profile "${name}"...`
  );

  const detected = await waitForAuthJson(authPath, 180000);

  await webviewProvider?.setBusy(false);

  if (!detected) {
    vscode.window.showWarningMessage(
      `Did not detect auth.json for "${name}" yet. When login completes, try adding the profile again.`
    );
    await refreshUi();
    return;
  }

  await saveProfileMetadata(id, name);

  const autoUseNewProfile =
    getConfig().get<boolean>("autoUseNewProfile") ?? false;

  if (autoUseNewProfile) {
    await switchToProfile(id, name);
    return;
  }

  const action = await vscode.window.showInformationMessage(
    `Profile "${name}" added successfully.`,
    "Use now",
    "Close"
  );

  if (action === "Use now") {
    await switchToProfile(id, name);
  }
}

async function switchProfile(): Promise<void> {
  const data = await readProfiles();

  if (data.profiles.length === 0) {
    const action = await vscode.window.showInformationMessage(
      "No Codex profiles saved yet.",
      "Add profile"
    );

    if (action === "Add profile") {
      await addProfile();
    }

    return;
  }

  const items = data.profiles.map((profile) => {
    const isActive = profile.id === data.active;

    return {
      label: `${isActive ? "$(check) " : " "}${profile.name}`,
      description: isActive ? "Active" : profile.id,
      detail: profileAuthPath(profile.id),
      profile
    };
  });

  items.push({
    label: "$(add) Add new profile",
    description: "Run codex login in isolated CODEX_HOME",
    detail: "Add a new Codex profile",
    profile: {
      id: "__add__",
      name: "Add new profile",
      createdAt: "",
      updatedAt: ""
    }
  });

  const selected = await vscode.window.showQuickPick(items, {
    title: "Switch Codex Profile",
    placeHolder: "Choose the Codex profile to activate"
  });

  if (!selected) return;

  if (selected.profile.id === "__add__") {
    await addProfile();
    return;
  }

  await switchToProfile(selected.profile.id, selected.profile.name);
}

async function switchToProfile(id: string, name: string): Promise<void> {
  const p = getPaths();
  const source = profileAuthPath(id);
  const target = p.codexAuthPath;

  if (!(await exists(source))) {
    vscode.window.showErrorMessage(
      `auth.json not found for profile "${name}".`
    );
    return;
  }

  await webviewProvider?.setBusy(true, `Switching to "${name}"...`);

  try {
    await backupCurrentAuth();
    await secureCopy(source, target);
    await setActiveProfile(id);
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
  const active = await getActiveProfile();

  if (!active) {
    vscode.window.showInformationMessage("No active Codex profile registered.");
    return;
  }

  const authPath = profileAuthPath(active.id);

  vscode.window.showInformationMessage(
    `Active Codex profile: ${active.name}\n${authPath}`
  );
}

async function openStorage(): Promise<void> {
  await ensureStorage();

  const p = getPaths();
  const uri = vscode.Uri.file(p.switcherHome);

  await vscode.env.openExternal(uri);
}

async function removeProfile(): Promise<void> {
  const data = await readProfiles();

  if (data.profiles.length === 0) {
    vscode.window.showInformationMessage("No saved profiles to remove.");
    return;
  }

  const selected = await vscode.window.showQuickPick(
    data.profiles.map((profile) => ({
      label: profile.name,
      description: profile.id === data.active ? "Active" : profile.id,
      detail: profileAuthPath(profile.id),
      profile
    })),
    {
      title: "Remove Saved Codex Profile",
      placeHolder: "Choose a saved profile to remove"
    }
  );

  if (!selected) return;

  const confirm = await vscode.window.showWarningMessage(
    `Remove saved profile "${selected.profile.name}"? This deletes the local copy in .codex-switcher, but does not log out of the site.`,
    "Remove",
    "Cancel"
  );

  if (confirm !== "Remove") return;

  const profileHome = profileHomePath(selected.profile.id);

  await fs.rm(profileHome, {
    recursive: true,
    force: true
  });

  const nextProfiles = data.profiles.filter(
    (profile) => profile.id !== selected.profile.id
  );

  const nextData: ProfilesJson = {
    profiles: nextProfiles,
    active: data.active === selected.profile.id ? undefined : data.active
  };

  await writeProfiles(nextData);
  await refreshUi();

  vscode.window.showInformationMessage(
    `Profile "${selected.profile.name}" removed from switcher.`
  );
}

async function removeProfileById(id: string): Promise<void> {
  const data = await readProfiles();
  const profile = data.profiles.find((item) => item.id === id);

  if (!profile) {
    vscode.window.showErrorMessage("Profile not found.");
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove saved profile "${profile.name}"?`,
    "Remove",
    "Cancel"
  );

  if (confirm !== "Remove") return;

  await fs.rm(profileHomePath(id), {
    recursive: true,
    force: true
  });

  const nextProfiles = data.profiles.filter((item) => item.id !== id);

  await writeProfiles({
    profiles: nextProfiles,
    active: data.active === id ? undefined : data.active
  });

  await refreshUi();

  vscode.window.showInformationMessage(`Profile "${profile.name}" removed.`);
}

async function reloadWindow(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.reloadWindow");
}

async function focusView(): Promise<void> {
  await vscode.commands.executeCommand("codexProfilesView.focus");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class CodexProfilesWebviewProvider implements vscode.WebviewViewProvider {
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
            await addProfile();
            break;

          case "switch":
            if (typeof message.id === "string" && typeof message.name === "string") {
              await switchToProfile(message.id, message.name);
            }
            break;

          case "remove":
            if (typeof message.id === "string") {
              await removeProfileById(message.id);
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

    const data = await readProfiles();
    const p = getPaths();

    this.view.webview.html = this.getHtml(data, p);
  }

  private getHtml(data: ProfilesJson, p: Paths): string {
    const profiles = data.profiles;
    const active = profiles.find((item) => item.id === data.active);

    const profileRows =
      profiles.length === 0
        ? `
        <div class="empty">
          <div class="empty-title">No profiles yet</div>
          <div class="empty-text">Add a Codex profile to get started.</div>
        </div>
      `
        : profiles
          .map((profile) => {
            const isActive = profile.id === data.active;
            const safeId = escapeHtml(profile.id);
            const safeName = escapeHtml(profile.name);
            const safeAuthPath = escapeHtml(profileAuthPath(profile.id));

            return `
              <div class="profile-row ${isActive ? "active" : ""}">
                <div class="profile-main">
                  <div class="profile-title-row">
                    <span class="status-dot ${isActive ? "on" : ""}"></span>
                    <span class="profile-name">${safeName}</span>
                    ${isActive ? `<span class="active-pill">Active</span>` : ""}
                  </div>
                  <div class="profile-path">${safeAuthPath}</div>
                </div>

                <div class="profile-actions">
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

        .profile-list {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }

        .profile-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 8px;
          border: 1px solid transparent;
          border-radius: 7px;
          background: transparent;
        }

        .profile-row:hover {
          background: rgba(127, 127, 127, 0.06);
        }

        .profile-row.active {
          border-color: var(--border);
          background: rgba(127, 127, 127, 0.07);
        }

        .profile-main {
          min-width: 0;
          flex: 1;
        }

        .profile-title-row {
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

        .profile-name {
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

        .profile-path {
          margin-top: 3px;
          color: var(--muted);
          font-size: 10px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .profile-actions {
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
            <div class="brand-title">Codex Profiles</div>
            <div class="brand-subtitle">Switch local Codex sessions</div>
          </div>

          <button class="refresh-button" title="Refresh" data-action="refresh">↻</button>
        </div>

        <div class="active-card">
          <div class="section-label">Active profile</div>
          <div class="active-name">${active ? escapeHtml(active.name) : "None"}</div>
          ${this.busy
        ? `<div class="busy">${escapeHtml(this.busyMessage || "Working...")}</div>`
        : ""
      }
        </div>

        <div class="toolbar">
          <button class="primary-button" data-action="add">Add profile</button>

          <div class="ghost-row">
            <button class="ghost-button" data-action="reload">Reload</button>
            <button class="ghost-button" data-action="openStorage">Storage</button>
          </div>
        </div>

        <div class="section-title">Saved profiles</div>

        <div class="profile-list">
          ${profileRows}
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

  webviewProvider = new CodexProfilesWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codexProfilesView",
      webviewProvider
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("codexProfiles.add", addProfile),
    vscode.commands.registerCommand("codexProfiles.switch", switchProfile),
    vscode.commands.registerCommand("codexProfiles.showActive", showActive),
    vscode.commands.registerCommand("codexProfiles.openStorage", openStorage),
    vscode.commands.registerCommand("codexProfiles.reloadWindow", reloadWindow),
    vscode.commands.registerCommand("codexProfiles.remove", removeProfile),
    vscode.commands.registerCommand("codexProfiles.refreshView", async () => {
      await refreshUi();
    }),
    vscode.commands.registerCommand("codexProfiles.focusView", focusView)
  );

  ensureStorage()
    .then(refreshUi)
    .catch((error) => {
      vscode.window.showErrorMessage(
        `Codex Profile Switcher failed to initialize: ${String(error)}`
      );
    });
}

export function deactivate(): void { }