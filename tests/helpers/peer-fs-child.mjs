import fs from 'node:fs';
import path from 'node:path';

/**
 * A deliberately tiny filesystem peer for hostile safety fixtures.
 *
 * This process is launched without the test run's `NODE_OPTIONS`, so none of the wrapped `fs`
 * bindings or child-ledger instrumentation can witness these mutations. The parent supplies one
 * JSON array of closed, structured operations; this file never accepts source text or invokes a
 * shell.
 */

const MAX_OPERATIONS = 128;
const MAX_WRITE_BYTES = 1024 * 1024;

function fail(message) {
  throw new TypeError(`invalid peer filesystem operation: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, permitted) {
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) fail(`unexpected field ${JSON.stringify(key)}`);
  }
}

function absolutePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    fail(`${field} must be a non-empty absolute path`);
  }
  return value;
}

function nonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function optionalMode(value) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 0o777) {
    fail('mode must be an integer between 0 and 0777');
  }
  return value;
}

function optionalBoolean(value, field) {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') fail(`${field} must be boolean`);
  return value;
}

function execute(operation) {
  if (!plainObject(operation) || typeof operation.kind !== 'string') {
    fail('each operation must be an object with a kind');
  }

  switch (operation.kind) {
    case 'mkdir': {
      exactKeys(operation, new Set(['kind', 'path', 'recursive', 'mode']));
      const target = absolutePath(operation.path, 'path');
      const mode = optionalMode(operation.mode);
      fs.mkdirSync(target, {
        recursive: optionalBoolean(operation.recursive, 'recursive'),
        mode,
      });
      // `mkdir -m` applies the requested mode independently of umask; preserve that fixture
      // contract so a deliberate 0777 boundary remains shared-writable in the peer process.
      if (mode !== undefined) fs.chmodSync(target, mode);
      return;
    }
    case 'write': {
      exactKeys(operation, new Set(['kind', 'path', 'data', 'mode']));
      if (typeof operation.data !== 'string') fail('data must be a string');
      if (Buffer.byteLength(operation.data, 'utf8') > MAX_WRITE_BYTES) {
        fail(`data exceeds ${MAX_WRITE_BYTES} bytes`);
      }
      fs.writeFileSync(absolutePath(operation.path, 'path'), operation.data, {
        mode: optionalMode(operation.mode),
      });
      return;
    }
    case 'unlink': {
      exactKeys(operation, new Set(['kind', 'path', 'missingOk']));
      const target = absolutePath(operation.path, 'path');
      const missingOk = optionalBoolean(operation.missingOk, 'missingOk');
      try {
        fs.unlinkSync(target);
      } catch (error) {
        if (missingOk && error !== null && typeof error === 'object' && error.code === 'ENOENT') {
          return;
        }
        throw error;
      }
      return;
    }
    case 'rmdir':
      exactKeys(operation, new Set(['kind', 'path']));
      fs.rmdirSync(absolutePath(operation.path, 'path'));
      return;
    case 'rename':
      exactKeys(operation, new Set(['kind', 'from', 'to']));
      fs.renameSync(absolutePath(operation.from, 'from'), absolutePath(operation.to, 'to'));
      return;
    case 'chmod': {
      exactKeys(operation, new Set(['kind', 'path', 'mode']));
      const mode = optionalMode(operation.mode);
      if (mode === undefined) fail('mode is required');
      fs.chmodSync(absolutePath(operation.path, 'path'), mode);
      return;
    }
    case 'symlink': {
      exactKeys(operation, new Set(['kind', 'target', 'path', 'type']));
      if (
        operation.type !== undefined &&
        operation.type !== 'file' &&
        operation.type !== 'dir' &&
        operation.type !== 'junction'
      ) {
        fail('type must be file, dir, or junction');
      }
      fs.symlinkSync(
        nonEmptyString(operation.target, 'target'),
        absolutePath(operation.path, 'path'),
        operation.type,
      );
      return;
    }
    default:
      fail(`unsupported kind ${JSON.stringify(operation.kind)}`);
  }
}

if (process.argv.length !== 3) fail('expected exactly one JSON argv payload');

let operations;
try {
  operations = JSON.parse(process.argv[2]);
} catch {
  fail('payload is not valid JSON');
}
if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_OPERATIONS) {
  fail(`payload must contain between 1 and ${MAX_OPERATIONS} operations`);
}
for (const operation of operations) execute(operation);
