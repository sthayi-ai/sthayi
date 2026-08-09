import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { runBootstrap } from './bootstrap.js';
import {
  SUPPORTED_NODE_MAJORS,
  cliFailureMessage,
  isNativeAddonCompatibilityError,
  nodeRuntimeSupport,
  unsupportedNodeMessage,
} from './runtime-guard.js';

describe('Node.js runtime policy', () => {
  it('is exactly the Node major set declared by the published package manifest', () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: { node?: string } };
    const policyRange = SUPPORTED_NODE_MAJORS.map((major) => `${major}.x`).join(' || ');

    expect(SUPPORTED_NODE_MAJORS).toEqual([22, 24]);
    expect(manifest.engines?.node).toBe(policyRange);
  });

  it.each(['22.0.0', '22.99.1', 'v24.0.0', '24.12.3'])(
    'accepts supported LTS runtime %s',
    (version) => {
      expect(nodeRuntimeSupport(version).supported).toBe(true);
      expect(unsupportedNodeMessage(version)).toBeUndefined();
    },
  );

  it.each(['20.19.0', '23.11.1', '25.8.1', '26.0.0'])(
    'refuses unsupported runtime %s',
    (version) => {
      expect(nodeRuntimeSupport(version).supported).toBe(false);
      expect(unsupportedNodeMessage(version)).toContain('supports Node.js 22 or 24 LTS');
    },
  );

  it('refuses Node 25 before importing the native-dependent CLI implementation', async () => {
    const loadCli = vi.fn(async () => ({ main: vi.fn(async () => undefined) }));
    const writeError = vi.fn();
    const setExitCode = vi.fn();

    await runBootstrap({
      argv: ['node', 'sthayi', 'serve'],
      nodeVersion: '25.8.1',
      loadCli,
      writeError,
      setExitCode,
    });

    expect(loadCli).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledOnce();
    expect(writeError.mock.calls[0]?.[0]).toContain('Node.js v25.8.1 is not supported');
    expect(writeError.mock.calls[0]?.[0]).toContain('then reinstall Sthayi');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it.each(['22.22.0', '24.13.0'])(
    'loads and runs the CLI under supported Node %s',
    async (nodeVersion) => {
      const main = vi.fn(async () => undefined);
      const loadCli = vi.fn(async () => ({ main }));
      const writeError = vi.fn();
      const setExitCode = vi.fn();
      const argv = ['node', 'sthayi', '--version'];

      await runBootstrap({ argv, nodeVersion, loadCli, writeError, setExitCode });

      expect(loadCli).toHaveBeenCalledOnce();
      expect(main).toHaveBeenCalledWith(argv);
      expect(writeError).not.toHaveBeenCalled();
      expect(setExitCode).not.toHaveBeenCalled();
    },
  );
});

describe('native-addon compatibility diagnosis', () => {
  const abiError = new Error(
    "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.",
  );

  it('classifies a nested NODE_MODULE_VERSION failure and replaces its raw loader text', () => {
    const wrapped = new Error('opening the store failed', { cause: abiError });
    expect(isNativeAddonCompatibilityError(wrapped)).toBe(true);

    const message = cliFailureMessage(wrapped, { nodeVersion: '24.13.0', platform: 'darwin' });
    expect(message).toContain('native SQLite module is incompatible');
    expect(message).toContain('Node.js v24.13.0');
    expect(message).toContain('npm uninstall -g --prefix "$HOME/.local" sthayi');
    expect(message).toContain(
      'npm install -g --prefix "$HOME/.local" --engine-strict sthayi@latest',
    );
    expect(message).not.toContain('NODE_MODULE_VERSION 127');
  });

  it('renders the documented user-space repair command on Windows', () => {
    const message = cliFailureMessage(abiError, { nodeVersion: '24.13.0', platform: 'win32' });
    expect(message).toContain('PowerShell:');
    expect(message).toContain(
      'npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" --engine-strict sthayi@latest',
    );
    expect(message).toContain('Command Prompt:');
    expect(message).toContain(
      'npm install -g --prefix "%LOCALAPPDATA%\\sthayi" --engine-strict sthayi@latest',
    );
  });

  it('does not relabel an ordinary product error as install damage', () => {
    const ordinary = new Error('journal verification failed');
    expect(isNativeAddonCompatibilityError(ordinary)).toBe(false);
    expect(cliFailureMessage(ordinary)).toBe('journal verification failed');
  });

  it('turns a supported-runtime ABI rejection at the bootstrap into a concise repair message', async () => {
    const writeError = vi.fn();
    const setExitCode = vi.fn();
    await runBootstrap({
      nodeVersion: '24.13.0',
      platform: 'linux',
      loadCli: async () => ({
        main: async () => {
          throw abiError;
        },
      }),
      writeError,
      setExitCode,
    });

    expect(writeError.mock.calls[0]?.[0]).toContain('native SQLite module is incompatible');
    expect(writeError.mock.calls[0]?.[0]).not.toContain('NODE_MODULE_VERSION');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});
