import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClientAdapter } from './adapter.js';
import { JsonMcpAdapter } from './json-adapter.js';
import { launcherCommand } from './launcher.js';
import { TomlMcpAdapter } from './toml-adapter.js';

export type { ClientAdapter, WireResult } from './adapter.js';
export { JsonMcpAdapter } from './json-adapter.js';
export { TomlMcpAdapter } from './toml-adapter.js';
export { writeLauncher, launcherCommand } from './launcher.js';

const exists = (p: string): boolean => fs.existsSync(p);

function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function zedConfigDir(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Zed');
  }
  // macOS and Linux both use XDG-style ~/.config/zed (per official docs).
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, 'zed') : path.join(home, '.config', 'zed');
}

function vscodeUserDir(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Code', 'User');
  }
  return path.join(home, '.config', 'Code', 'User');
}

/**
 * The built-in client adapters, wired to the real per-machine config locations (every adapter's
 * config format is verified against the client's official docs and captured fixtures).
 * Absent clients simply report detected:false and are excluded from
 * wiring; the interface is public so the community adds the next one.
 */
export function defaultAdapters(): ClientAdapter[] {
  const home = os.homedir();
  return [
    new JsonMcpAdapter({
      id: 'claude-desktop',
      label: 'Claude Desktop',
      resolveConfigPath: claudeDesktopConfigPath,
      detect: () => exists(path.dirname(claudeDesktopConfigPath())),
      launcherCommand,
    }),
    new JsonMcpAdapter({
      id: 'claude-code',
      label: 'Claude Code',
      resolveConfigPath: () => path.join(home, '.claude.json'),
      detect: () => exists(path.join(home, '.claude.json')),
      launcherCommand,
    }),
    new JsonMcpAdapter({
      id: 'cursor',
      label: 'Cursor',
      resolveConfigPath: () => path.join(home, '.cursor', 'mcp.json'),
      detect: () => exists(path.join(home, '.cursor')),
      launcherCommand,
    }),
    new JsonMcpAdapter({
      id: 'gemini-cli',
      label: 'Gemini CLI',
      resolveConfigPath: () => path.join(home, '.gemini', 'settings.json'),
      detect: () => exists(path.join(home, '.gemini')),
      launcherCommand,
    }),
    new TomlMcpAdapter({
      id: 'codex',
      label: 'Codex CLI',
      resolveConfigPath: () => path.join(home, '.codex', 'config.toml'),
      detect: () => exists(path.join(home, '.codex')),
      launcherCommand,
    }),
    // VS Code's user-level MCP config is the per-profile mcp.json (GA since 1.102) — NOT
    // settings.json (legacy, auto-migrated). Top-level key is "servers" and stdio entries
    // carry an explicit type. The file is created lazily, so detection is on the User dir.
    new JsonMcpAdapter({
      id: 'vscode',
      label: 'VS Code (Copilot MCP)',
      resolveConfigPath: () => path.join(vscodeUserDir(), 'mcp.json'),
      detect: () => exists(vscodeUserDir()),
      launcherCommand,
      containerKey: 'servers',
      entryValue: (command) => ({ type: 'stdio', command, args: [] }),
    }),
    new JsonMcpAdapter({
      id: 'windsurf',
      label: 'Windsurf',
      resolveConfigPath: () => path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      detect: () => exists(path.join(home, '.codeium', 'windsurf')),
      launcherCommand,
    }),
    // Cline stores MCP config in VS Code's globalStorage for extension saoudrizwan.claude-dev;
    // entries carry disabled/autoApprove (verified against the extension source, July 2026).
    new JsonMcpAdapter({
      id: 'cline',
      label: 'Cline',
      resolveConfigPath: () =>
        path.join(
          vscodeUserDir(),
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
      detect: () => exists(path.join(vscodeUserDir(), 'globalStorage', 'saoudrizwan.claude-dev')),
      launcherCommand,
      entryValue: (command) => ({ command, args: [], disabled: false, autoApprove: [] }),
    }),
    // LM Studio follows Cursor's mcp.json notation and hot-reloads on save (official docs).
    new JsonMcpAdapter({
      id: 'lmstudio',
      label: 'LM Studio',
      resolveConfigPath: () => path.join(home, '.lmstudio', 'mcp.json'),
      detect: () => exists(path.join(home, '.lmstudio')),
      launcherCommand,
    }),
    // Warp's global MCP file auto-spawns servers; note the dotted filename (.mcp.json).
    new JsonMcpAdapter({
      id: 'warp',
      label: 'Warp',
      resolveConfigPath: () => path.join(home, '.warp', '.mcp.json'),
      detect: () => exists(path.join(home, '.warp')),
      launcherCommand,
    }),
    // JetBrains Junie (IDE plugin + CLI share this file); AI Assistant users can alternatively
    // one-click "Import from Claude" after wiring claude-desktop.
    new JsonMcpAdapter({
      id: 'junie',
      label: 'JetBrains Junie',
      resolveConfigPath: () => path.join(home, '.junie', 'mcp', 'mcp.json'),
      detect: () => exists(path.join(home, '.junie')),
      launcherCommand,
    }),
    // Zed: MCP entries live in the MAIN settings.json (JSONC with comments — the surgical
    // jsonc edits preserve them) under "context_servers"; current schema has no "source" key.
    new JsonMcpAdapter({
      id: 'zed',
      label: 'Zed',
      resolveConfigPath: () => path.join(zedConfigDir(), 'settings.json'),
      detect: () => exists(zedConfigDir()),
      launcherCommand,
      containerKey: 'context_servers',
    }),
    // Roo Code (Cline fork; publisher id retained from the pre-rebrand name).
    new JsonMcpAdapter({
      id: 'roo-code',
      label: 'Roo Code',
      resolveConfigPath: () =>
        path.join(
          vscodeUserDir(),
          'globalStorage',
          'rooveterinaryinc.roo-cline',
          'settings',
          'mcp_settings.json',
        ),
      detect: () =>
        exists(path.join(vscodeUserDir(), 'globalStorage', 'rooveterinaryinc.roo-cline')),
      launcherCommand,
      entryValue: (command) => ({ command, args: [], disabled: false, alwaysAllow: [] }),
    }),
    // Visual Studio 2022/2026 (Windows-only): %USERPROFILE%\.mcp.json, "servers" container,
    // explicit stdio type. launcherCommand() already yields the .cmd launcher on Windows.
    new JsonMcpAdapter({
      id: 'visual-studio',
      label: 'Visual Studio',
      resolveConfigPath: () => path.join(home, '.mcp.json'),
      detect: () =>
        process.platform === 'win32' &&
        exists(
          path.join(
            process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'),
            'Microsoft',
            'VisualStudio',
          ),
        ),
      launcherCommand,
      containerKey: 'servers',
      entryValue: (command) => ({ type: 'stdio', command, args: [] }),
    }),
  ];
}
