#!/usr/bin/env node

/**
 * Repository lint and formatting checks.
 *
 * These rules are the ones that actually bite this project:
 *
 * - Anything written to stdout by the server corrupts the stdio MCP framing,
 *   so `console.log`/`process.stdout.write` are banned outside scripts.
 *   Diagnostics belong on `ctx.logger` or stderr.
 * - A committed secret, a stray `.only(` in a test, or an unfinished marker
 *   should fail the build rather than reach a review.
 * - Consistent formatting (LF, no tabs, no trailing whitespace, final
 *   newline) keeps diffs readable.
 *
 * Type checking runs separately via `pnpm typecheck`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const roots = ['src', 'scripts', 'tests'];
const skipDirectories = new Set(['node_modules', '.next', 'out', 'dist', '.git', '.data']);
const sourceExtensions = ['.ts', '.tsx', '.mjs', '.js'];

const secretPatterns = [
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'eBay production token', pattern: /v\^1\.1#i\^1#[A-Za-z0-9+/=]{40,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Postgres URL with a password', pattern: /postgres(?:ql)?:\/\/[^\s:@/]+:(?!pw@host|password@host)[^\s:@/]{3,}@/ },
  { name: 'generic API secret assignment', pattern: /\b(?:api[_-]?key|client[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i },
];

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (skipDirectories.has(entry.name)) continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(full)));
    } else if (sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(full);
    }
  }
  return files;
}

function checkFile(path, contents) {
  const problems = [];
  const relativePath = relative(projectRoot, path);
  const isScript = relativePath.startsWith('scripts/') || relativePath.startsWith('tests/');
  // This file necessarily contains the literals it searches for.
  const isSelf = relativePath === 'scripts/lint.mjs';
  const lines = contents.split('\n');

  if (contents.includes('\r')) {
    problems.push(`${relativePath}: contains CRLF line endings`);
  }
  if (contents.length > 0 && !contents.endsWith('\n')) {
    problems.push(`${relativePath}: does not end with a newline`);
  }

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (line.includes('\t')) {
      problems.push(`${relativePath}:${lineNumber}: contains a tab character`);
    }
    if (/[ ]+$/.test(line)) {
      problems.push(`${relativePath}:${lineNumber}: has trailing whitespace`);
    }
    if (!isScript && /(?:^|[^.\w])console\.log\s*\(/.test(line)) {
      problems.push(`${relativePath}:${lineNumber}: console.log writes to stdout and corrupts stdio MCP framing`);
    }
    if (!isScript && /process\.stdout\.write\s*\(/.test(line)) {
      problems.push(`${relativePath}:${lineNumber}: process.stdout.write corrupts stdio MCP framing`);
    }
    if (!isSelf && /\b(?:TODO|FIXME|XXX)\b/.test(line)) {
      problems.push(`${relativePath}:${lineNumber}: unfinished work marker`);
    }
    if (/\b(?:test|describe|it)\.only\s*\(/.test(line)) {
      problems.push(`${relativePath}:${lineNumber}: a focused test would hide the rest of the suite`);
    }
    for (const { name, pattern } of isSelf ? [] : secretPatterns) {
      if (pattern.test(line)) {
        problems.push(`${relativePath}:${lineNumber}: looks like a committed secret (${name})`);
      }
    }
  });

  return problems;
}

async function main() {
  const files = (await Promise.all(roots.map((root) => collectFiles(join(projectRoot, root))))).flat();
  const problems = [];

  for (const file of files) {
    problems.push(...checkFile(file, await readFile(file, 'utf8')));
  }

  if (problems.length > 0) {
    console.error(`Lint failed with ${problems.length} problem(s):`);
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }

  console.log(JSON.stringify({ status: 'ok', filesChecked: files.length }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
