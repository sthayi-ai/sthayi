import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { cliFailureMessage, unsupportedNodeMessage } from './runtime-guard.js';

interface CliImplementation {
  main(argv: readonly string[]): Promise<void>;
}

export interface BootstrapOptions {
  argv?: readonly string[];
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  loadCli?: () => Promise<CliImplementation>;
  writeError?: (message: string) => void;
  setExitCode?: (code: number) => void;
}

/**
 * The packaged executable boundary. The runtime policy is evaluated before loadCli() is called,
 * which means an unsupported Node release cannot evaluate better-sqlite3 or any other
 * native-dependent CLI module merely by asking for `--help` or starting the MCP server.
 */
export async function runBootstrap(options: BootstrapOptions = {}): Promise<void> {
  const argv = options.argv ?? process.argv;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const loadCli = options.loadCli ?? (() => import('./index.js'));
  const writeError =
    options.writeError ?? ((message: string) => process.stderr.write(`${message}\n`));
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });

  const refusal = unsupportedNodeMessage(nodeVersion);
  if (refusal !== undefined) {
    writeError(refusal);
    setExitCode(1);
    return;
  }

  try {
    const cli = await loadCli();
    await cli.main(argv);
  } catch (error) {
    writeError(cliFailureMessage(error, { nodeVersion, platform }));
    setExitCode(1);
  }
}

/** Symlink-aware direct-invocation check: npm's bin shim points at dist/index.js. */
function invokedDirectly(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }
  let invokedReal = invokedPath;
  try {
    invokedReal = fs.realpathSync(invokedPath);
  } catch {
    // Preserve the literal path; it cannot equal a different resolvable entry by accident.
  }
  return import.meta.url === pathToFileURL(invokedReal).href;
}

if (invokedDirectly()) {
  void runBootstrap();
}
