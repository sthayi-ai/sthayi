/** Node.js majors supported by Sthayi v0.1.0. Keep this deliberately explicit: odd-numbered
 * releases are short-lived, and the CLI includes a native SQLite addon whose binaries follow the
 * Node.js LTS lines. */
export const SUPPORTED_NODE_MAJORS = [22, 24] as const;
export const RECOMMENDED_NODE_MAJOR = 24;

export interface NodeRuntimeSupport {
  supported: boolean;
  major?: number;
}

/** Pure policy predicate so unsupported releases can be tested without running the suite on them. */
export function nodeRuntimeSupport(version: string): NodeRuntimeSupport {
  const match = /^(?:v)?(\d+)(?:\.|$)/.exec(version.trim());
  if (match === null) {
    return { supported: false };
  }
  const major = Number(match[1]);
  return {
    supported: SUPPORTED_NODE_MAJORS.some((supported) => supported === major),
    major,
  };
}

/** Actionable refusal used before the native-dependent CLI implementation is imported. */
export function unsupportedNodeMessage(version: string): string | undefined {
  const support = nodeRuntimeSupport(version);
  if (support.supported) {
    return undefined;
  }
  const detected =
    support.major === undefined ? JSON.stringify(version) : `v${version.replace(/^v/, '')}`;
  return [
    `sthayi: Node.js ${detected} is not supported by Sthayi v0.1.0.`,
    'Sthayi v0.1.0 supports Node.js 22 or 24 LTS; Node.js 24 LTS is recommended.',
    'Install Node.js 24 LTS from https://nodejs.org/en/download, then reinstall Sthayi under that Node.js version.',
  ].join('\n');
}

/** Throwing form for programmatic/dev entry points which call main() without the packaged
 * bootstrap. The shipped executable performs this same check before importing the implementation. */
export function assertSupportedNodeRuntime(version: string = process.versions.node): void {
  const message = unsupportedNodeMessage(version);
  if (message !== undefined) {
    throw new Error(message);
  }
}

function objectField(value: unknown, key: string): unknown {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

/** Walk Error.cause without trusting it to be acyclic or even Error-shaped. Native loader errors
 * are sometimes wrapped by a command or storage layer before reaching the executable boundary. */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current) && chain.length < 12) {
    chain.push(current);
    seen.add(current);
    current = objectField(current, 'cause');
  }
  return chain;
}

function errorText(error: unknown): string {
  const message = objectField(error, 'message');
  return typeof message === 'string' ? message : String(error);
}

/** Detect the native-addon compatibility failures caused by reusing an install after changing
 * Node.js ABI (or architecture). Do not classify arbitrary SQLite/runtime errors as install damage. */
export function isNativeAddonCompatibilityError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const text = errorText(item);
    return (
      /NODE_MODULE_VERSION\s+\d+/i.test(text) ||
      /compiled against a different Node(?:\.js)? version/i.test(text) ||
      /module did not self-register/i.test(text) ||
      /wrong ELF class|invalid ELF header|incompatible architecture|not a valid Win32 application/i.test(
        text,
      )
    );
  });
}

function reinstallCommands(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? [
        'PowerShell:',
        'npm uninstall -g --prefix "$env:LOCALAPPDATA\\sthayi" sthayi',
        'npm install -g --prefix "$env:LOCALAPPDATA\\sthayi" sthayi',
        'Command Prompt:',
        'npm uninstall -g --prefix "%LOCALAPPDATA%\\sthayi" sthayi',
        'npm install -g --prefix "%LOCALAPPDATA%\\sthayi" sthayi',
      ]
    : [
        'npm uninstall -g --prefix "$HOME/.local" sthayi',
        'npm install -g --prefix "$HOME/.local" sthayi',
      ];
}

export function nativeAddonCompatibilitySummary(
  nodeVersion: string = process.versions.node,
): string {
  return [
    `the native SQLite module is incompatible with the active Node.js v${nodeVersion.replace(/^v/, '')} runtime.`,
    'This usually happens when Sthayi was installed under a different Node.js version.',
  ].join('\n');
}

export function nativeAddonReinstallGuidance(platform: NodeJS.Platform = process.platform): string {
  return [
    'Select Node.js 22 or 24 LTS (24 recommended), then reinstall Sthayi with:',
    ...reinstallCommands(platform),
  ].join('\n');
}

/** Convert only native compatibility failures. Ordinary errors retain their original message. */
export function cliFailureMessage(
  error: unknown,
  options: { nodeVersion?: string; platform?: NodeJS.Platform } = {},
): string {
  if (!isNativeAddonCompatibilityError(error)) {
    return error instanceof Error ? error.message : String(error);
  }
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  return [
    `sthayi: ${nativeAddonCompatibilitySummary(nodeVersion)}`,
    nativeAddonReinstallGuidance(platform),
  ].join('\n');
}
