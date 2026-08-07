import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * SAFETY: the MCP Registry publication is a second immutable release, not a README claim.
 *
 * npm proves ownership by reading `mcpName` from the published package. The Registry then stores
 * each `name@version` permanently. A missing `serve` argument installs a healthy CLI but launches
 * its help command instead of its stdio MCP server; a version/name drift cannot be repaired in
 * place. This test therefore binds the checked-in manifest to the npm package and makes the
 * protected OIDC workflow's retry and verification properties executable.
 *
 * Nothing here contacts npm, GitHub or the Registry. The release job performs those live checks;
 * this layer fails ordinary CI when the declarations or the only Registry write path drift.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagePath = path.join(repoRoot, 'packages', 'cli', 'package.json');
const manifestPath = path.join(repoRoot, 'packages', 'cli', 'server.json');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'release.yml');

interface CliPackage {
  name?: unknown;
  version?: unknown;
  mcpName?: unknown;
}

const readJson = <T>(at: string): T => JSON.parse(fs.readFileSync(at, 'utf8')) as T;
const cliPackage = (): CliPackage => readJson<CliPackage>(packagePath);
const serverManifest = (): Record<string, unknown> =>
  readJson<Record<string, unknown>>(manifestPath);
const workflow = (): string => fs.readFileSync(workflowPath, 'utf8');

const MCP_NAME = 'io.github.sthayi-ai/sthayi';
const PUBLISHER_VERSION = '1.8.1';
const PUBLISHER_SHA256 = 'a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc';

function manifestProblems(pkg: CliPackage, manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };

  check(pkg.name === 'sthayi', 'npm package name is not sthayi');
  check(pkg.mcpName === MCP_NAME, 'package.json mcpName does not own the chosen namespace');
  check(
    typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/.test(pkg.version),
    'package version is not plain semver',
  );

  const expected = {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: MCP_NAME,
    title: 'Sthayi',
    description: 'Local-first AI memory over MCP. No account; you own the store.',
    websiteUrl: 'https://sthayi.ai',
    repository: {
      url: 'https://github.com/sthayi-ai/sthayi',
      source: 'github',
      id: '1326112733',
      subfolder: 'packages/cli',
    },
    version: pkg.version,
    packages: [
      {
        registryType: 'npm',
        identifier: 'sthayi',
        version: pkg.version,
        transport: { type: 'stdio' },
        packageArguments: [{ type: 'positional', value: 'serve' }],
      },
    ],
  };
  check(
    isDeepStrictEqual(manifest, expected),
    'server.json is not the exact keyless npm/stdio `sthayi serve` manifest',
  );
  check(
    typeof manifest.description === 'string' && manifest.description.length <= 100,
    'Registry description exceeds the schema maximum',
  );
  return problems;
}

/** Top-level job text, stopped at the next two-space job key. */
function jobBlock(name: string, text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z][\w-]*:\s*$/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function workflowProblems(text: string): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, problem: string): void => {
    if (!ok) problems.push(problem);
  };
  const registry = jobBlock('mcp-registry', text);
  const npmPublish = jobBlock('publish', text);
  const executableRegistry = registry
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  check(registry !== '', 'mcp-registry job is missing');
  check(/needs:\s*\[preflight, publish\]/.test(registry), 'Registry job does not wait for npm');
  check(registry.includes('timeout-minutes: 10'), 'Registry job has no overall bound');
  check(registry.includes('name: mcp-production'), 'Registry job is not protected separately');
  check(
    registry.includes('group: mcp-production-publish') &&
      registry.includes('cancel-in-progress: false'),
    'Registry writes are not serialized without cancellation',
  );
  check(registry.includes('contents: read'), 'Registry job lacks minimal checkout permission');
  check(registry.includes('id-token: write'), 'Registry job cannot obtain GitHub OIDC identity');
  check(
    !registry.includes('packages: write'),
    'Registry job has unrelated package-write permission',
  );
  check(
    registry.includes('persist-credentials: false'),
    'checkout leaves a repository credential available to the publisher job',
  );
  check(
    !registry.includes('registry-url:'),
    'read-only npm metadata lookup unnecessarily configures an auth-token registry',
  );
  check(
    registry.includes(`MCP_PUBLISHER_VERSION: ${PUBLISHER_VERSION}`) &&
      registry.includes(`MCP_PUBLISHER_SHA256: ${PUBLISHER_SHA256}`),
    'mcp-publisher release asset is not version- and checksum-pinned',
  );
  check(
    registry.indexOf('sha256sum --check --strict') < registry.indexOf('tar -xzf "$ARCHIVE"'),
    'publisher archive is extracted before its checksum is verified',
  );
  check(
    registry.includes('npm view "sthayi@${VERSION}" mcpName'),
    'public npm mcpName is not proved before Registry publication',
  );
  check(
    registry.includes('io.github.sthayi-ai%2Fsthayi/versions/${VERSION}'),
    'Registry lookup is not the exact URL-encoded name/version endpoint',
  );
  check(
    registry.includes('if ! HTTP_CODE="$(curl') &&
      registry.includes('--connect-timeout 10 --max-time 30'),
    'Registry HTTP failures are not caught and time-bounded',
  );
  check(
    registry.includes('if [ "$HTTP_CODE" = 404 ]') &&
      registry.includes('if [ "$HTTP_CODE" != 200 ]'),
    'exact lookup does not distinguish absence from transient API failure',
  );
  check(
    registry.includes("'.server == $expected[0]'") &&
      registry.includes('--slurpfile expected packages/cli/server.json'),
    'post-publication check does not compare the complete immutable record',
  );
  check(
    registry.indexOf('if fetch_exact_record; then') <
      registry.indexOf('mcp-publisher login github-oidc'),
    'job writes before checking for an already-published immutable version',
  );
  check(
    registry.includes('if [ "$PREEXISTING" = false ]'),
    'reruns cannot skip an already-correct Registry publication',
  );
  check(
    registry.includes('timeout 120s mcp-publisher login github-oidc') &&
      registry.includes('timeout 120s mcp-publisher publish packages/cli/server.json'),
    'OIDC login or publication is not time-bounded and manifest-specific',
  );
  check(!/\bnpm publish\b/.test(executableRegistry), 'Registry retry can re-enter npm publish');
  check(!npmPublish.includes('mcp-publisher'), 'npm publish job also writes the MCP Registry');
  return problems;
}

describe('safety: MCP Registry manifest is one exact package identity', () => {
  it('binds npm ownership, package version and `sthayi serve` to the checked-in manifest', () => {
    expect(manifestProblems(cliPackage(), serverManifest())).toEqual([]);
  });

  it.each([
    [
      'changed mcpName',
      (pkg: CliPackage, _manifest: Record<string, unknown>) => {
        pkg.mcpName = 'io.github.someone-else/sthayi';
      },
    ],
    [
      'drifted Registry version',
      (_pkg: CliPackage, manifest: Record<string, unknown>) => {
        manifest.version = '99.0.0';
      },
    ],
    [
      'missing serve argument',
      (_pkg: CliPackage, manifest: Record<string, unknown>) => {
        const packages = manifest.packages as Record<string, unknown>[];
        (packages[0] as Record<string, unknown>).packageArguments = undefined;
      },
    ],
    [
      'wrong repository identity',
      (_pkg: CliPackage, manifest: Record<string, unknown>) => {
        (manifest.repository as Record<string, unknown>).id = '0';
      },
    ],
  ])('refuses a %s', (_name, mutate) => {
    const pkg = structuredClone(cliPackage());
    const manifest = structuredClone(serverManifest());
    mutate(pkg, manifest);
    expect(manifestProblems(pkg, manifest)).not.toEqual([]);
  });
});

describe('safety: Registry publication is protected, pinned, complete and retry-safe', () => {
  it('the live release workflow satisfies the Registry contract', () => {
    expect(workflowProblems(workflow())).toEqual([]);
  });

  it.each([
    [
      'does not wait for npm',
      (text: string) => text.replace('needs: [preflight, publish]', 'needs: preflight'),
    ],
    [
      'loses OIDC write permission',
      (text: string) =>
        text.replace(
          'id-token: write # short-lived GitHub OIDC identity for the io.github.sthayi-ai namespace',
          'id-token: read # short-lived GitHub OIDC identity for the io.github.sthayi-ai namespace',
        ),
    ],
    [
      'checks only name and version',
      (text: string) => text.replace("'.server == $expected[0]'", "'.server.name == $name'"),
    ],
    [
      'cannot catch curl failure',
      (text: string) => text.replace('if ! HTTP_CODE="$(curl', 'HTTP_CODE="$(curl'),
    ],
    [
      'always republishes on retry',
      (text: string) => text.replace('if [ "$PREEXISTING" = false ]; then', 'if true; then'),
    ],
  ])('turns red when the workflow %s', (_name, mutate) => {
    expect(workflowProblems(mutate(workflow()))).not.toEqual([]);
  });
});
