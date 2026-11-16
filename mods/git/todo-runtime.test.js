import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, appendFileSync, readdirSync, mkdtempSync, mkdirSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as rebase from './rebase.js';
import { LAZYGIT_DEFAULTS, loadLazygitConfig } from './configuration.js';

const source = dirname(fileURLToPath(import.meta.url));
// Runtime module imports are injected so the actual class methods and shell
// scripts run without a Herdr window. Git and sh below are real subprocesses.
const body = name => readFileSync(join(source, name), 'utf8').replace(/^import .*;\n/gm, '')
  .replaceAll('export class ', 'class ').replaceAll('export const ', 'const ');
function runtime(execute) {
  return new Function('exec', 'GitContexts', ...Object.keys(rebase),
    body('todo.js') + '\nreturn GitTodo;')(execute, class {}, ...Object.values(rebase));
}

function fixture(run, { updateRefs = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-todo-runtime-'));
  const git = (args, environment = {}) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir, env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(r.status, 0, r.stderr || r.error?.message); return r.stdout;
  };
  const calls = [];
  let intercept = null, environment = {};
  const execute = async (command, args, context) => {
    calls.push({ command, args, context: { ...context } });
    const intercepted = await intercept?.(command, args, context);
    if (intercepted) return intercepted;
    const r = spawnSync(command, args, { cwd: context.cwd, env: { ...process.env, ...environment },
      encoding: 'utf8', timeout: context.timeout || 30000, maxBuffer: 4 * 1024 * 1024 });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  return (async () => {
    try {
      git(['init', '-q']); git(['config', 'user.name', 'Todo Fixture']); git(['config', 'user.email', 'todo@example.invalid']);
      for (const name of ['base', 'one', 'two']) {
        writeFileSync(join(dir, name), name); git(['add', name]); git(['commit', '-qm', name]);
      }
      if (updateRefs) git(['branch', 'saved']);
      const editor = join(dir, 'pause.sh');
      writeFileSync(editor, '#!/bin/sh\nsed "1s/^pick /edit /" "$1" > "$1.fixture"\nmv "$1.fixture" "$1"\n');
      chmodSync(editor, 0o700);
      git(['rebase', '-i', ...(updateRefs ? ['--update-refs'] : []), 'HEAD~2'], { GIT_SEQUENCE_EDITOR: editor, GIT_EDITOR: 'true' });
      const path = git(['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge/git-rebase-todo']).replace(/\n$/, '');
      const context = { cwd: dir, on: 'captured-test-target', timeout: 30000 };
      const GitTodo = runtime(execute), app = new GitTodo();
      let task;
      Object.assign(app, { root: dir, on: context.on, operation: 'rebase', rangeAnchors: { commits: 3 },
        viewKey: () => 'commits', selectedItems: () => [{ todo: app.pendingRebase.doc.rows[0] }],
        perform: (_label, work) => { task = work(() => {}, { ...context }); },
        say: message => { throw new Error(message); },
      });
      const load = async () => { app.pendingRebase = await app.readPendingRebase(context); };
      await load();
      const change = () => { app.editPendingRebase('drop', {}); return task; };
      const stages = () => readdirSync(dirname(path)).filter(name => name.startsWith('.herdr-git-todo.'));
      await run({ dir, git, path, context, app, calls, load, change, stages,
        intercept: fn => { intercept = fn; }, environment: value => { environment = value; } });
    } finally {
      spawnSync('git', ['rebase', '--abort'], { cwd: dir, stdio: 'ignore' });
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('todo writes use staged files and remove their private directory on success', () => fixture(async ({ app, path, change, stages, calls }) => {
  const before = readFileSync(path, 'utf8');
  const expected = rebase.dropRebaseTodo(app.pendingRebase.doc, app.pendingRebase.doc.rows[0]);
  await change();
  assert.notEqual(expected.raw, before);
  assert.equal(readFileSync(path, 'utf8'), expected.raw);
  assert.equal(existsSync(path + '.lock'), false);
  assert.deepEqual(stages(), []);
  assert.equal(app.rangeAnchors.commits, null);
  assert.equal(app.pendingRebaseSelection.action, 'drop');
  const commit = calls.find(call => call.args[1]?.includes('lock=$path.lock'));
  assert.equal(commit.args.length, 6); // expected path, private directory, update-refs flag
  assert.equal(commit.args.some(arg => arg === before || arg === expected.raw), false);
}));

test('near-512 KiB todo crosses exec in bounded code-point-safe chunks', () => fixture(async ({ app, path, load, change, calls, stages }) => {
  const hash = app.pendingRebase.doc.rows.find(row => row.hash).hash;
  // Put the high surrogate exactly where a naive 4-Ki-unit slice would end.
  const comment = '#' + 'x'.repeat(4094) + '😀\n';
  const line = `pick ${hash} ${'pending subject '.repeat(8)}\n`;
  const count = Math.floor((523000 - Buffer.byteLength(comment)) / Buffer.byteLength(line));
  const raw = comment + line.repeat(count);
  assert.ok(Buffer.byteLength(raw) > 520000 && Buffer.byteLength(raw) <= 524288);
  writeFileSync(path, raw); await load();
  const expected = rebase.dropRebaseTodo(app.pendingRebase.doc, app.pendingRebase.doc.rows[0]);
  await change();
  assert.equal(readFileSync(path, 'utf8'), expected.raw);
  const appends = calls.filter(call => call.args[1]?.includes('>> "$1/before"'));
  assert.ok(appends.length > 20);
  const before = [], after = [];
  for (const call of appends) {
    for (const payload of call.args.slice(4)) {
      assert.ok(payload.length <= 4096);
      assert.equal(/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(payload), false);
    }
    before.push(call.args[4]); after.push(call.args[5]);
  }
  assert.equal(before.join(''), raw); assert.equal(after.join(''), expected.raw);
  assert.deepEqual(stages(), []);
}));

test('stale todo bytes refuse replacement and clean only the owned lock/stage', () => fixture(async ({ path, change, stages }) => {
  appendFileSync(path, '\n# another editor changed the file\n');
  const newer = readFileSync(path, 'utf8');
  await assert.rejects(change(), /todo changed/);
  assert.equal(readFileSync(path, 'utf8'), newer);
  assert.equal(existsSync(path + '.lock'), false);
  assert.deepEqual(stages(), []);
}));

test('an existing Git lock is preserved when the edit is refused', () => fixture(async ({ path, change, stages }) => {
  const original = readFileSync(path, 'utf8');
  writeFileSync(path + '.lock', 'another Git process owns this');
  await assert.rejects(change(), /locked by another process/);
  assert.equal(readFileSync(path + '.lock', 'utf8'), 'another Git process owns this');
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.deepEqual(stages(), []);
}));

test('cleanup cannot delete a successor lock acquired immediately after rename', () => fixture(async ({ dir, path, change, environment, stages }) => {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'mv'), '#!/bin/sh\n/bin/mv "$@" || exit $?\nfor final; do :; done\n(set -C; printf "successor owns this" > "$final.lock")\n');
  chmodSync(join(bin, 'mv'), 0o700);
  environment({ PATH: bin + ':' + process.env.PATH });
  await change();
  assert.equal(readFileSync(path + '.lock', 'utf8'), 'successor owns this');
  assert.deepEqual(stages(), []);
}));

test('failure cleanup preserves a successor lock even when rename already committed', () => fixture(async ({ dir, path, change, environment, stages }) => {
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'mv'), '#!/bin/sh\n/bin/mv "$@" || exit $?\nfor final; do :; done\n(set -C; printf "successor after failure" > "$final.lock")\nexit 7\n');
  chmodSync(join(bin, 'mv'), 0o700);
  environment({ PATH: bin + ':' + process.env.PATH });
  await assert.rejects(change(), /Git exited 7/);
  assert.equal(readFileSync(path + '.lock', 'utf8'), 'successor after failure');
  assert.deepEqual(stages(), []);
}));

test('dropping update-ref releases the lock before Git reconciles pending branch updates', () => fixture(async ({ app, git, path, change, stages }) => {
  const saved = git(['rev-parse', 'saved']);
  git(['commit', '--amend', '-qm', 'one rewritten']);
  const selected = app.pendingRebase.doc.rows.find(row => row.action === 'update-ref');
  assert.ok(selected);
  const expected = rebase.dropRebaseTodo(app.pendingRebase.doc, selected);
  assert.equal(expected.requiresEditTodo, true);
  app.selectedItems = () => [{ todo: selected }];
  const bookkeeping = git(['rev-parse', '--path-format=absolute', '--git-path', 'rebase-merge/update-refs']).trim();
  assert.ok(readFileSync(bookkeeping, 'utf8').includes('refs/heads/saved'));
  await change();
  if (existsSync(bookkeeping)) assert.ok(!readFileSync(bookkeeping, 'utf8').includes('refs/heads/saved'));
  assert.equal(existsSync(path + '.lock'), false);
  assert.deepEqual(stages(), []);
  git(['rebase', '--continue'], { GIT_EDITOR: 'true' });
  assert.equal(git(['rev-parse', 'saved']), saved);
  assert.notEqual(git(['rev-parse', 'HEAD']), saved);
}, { updateRefs: true }));

test('failed chunk transport leaves the original todo untouched and cleans its stage', () => fixture(async ({ path, change, intercept, stages }) => {
  const original = readFileSync(path, 'utf8');
  intercept((_command, args) => args[1]?.includes('>> "$1/before"') ? { code: 1, stdout: '', stderr: 'simulated transport failure' } : null);
  await assert.rejects(change(), /simulated transport failure/);
  assert.equal(readFileSync(path, 'utf8'), original);
  assert.equal(existsSync(path + '.lock'), false);
  assert.deepEqual(stages(), []);
}));

test('staging, commit and cleanup keep the captured target when the view changes', () => fixture(async ({ app, path, context, calls, change, intercept, stages }) => {
  const expected = rebase.dropRebaseTodo(app.pendingRebase.doc, app.pendingRebase.doc.rows[0]);
  intercept((_command, args) => {
    if (args[1]?.includes('>> "$1/before"')) { app.root = '/different-repository'; app.on = 'different-target'; }
  });
  await change();
  assert.equal(readFileSync(path, 'utf8'), expected.raw);
  assert.ok(calls.every(call => call.context.cwd === context.cwd && call.context.on === context.on));
  assert.equal(app.rangeAnchors.commits, 3); // do not mutate the new view's selection
  assert.equal(app.pendingRebaseSelection, undefined);
  assert.deepEqual(stages(), []);
}));

test('todo read still rejects files above 512 KiB', () => fixture(async ({ path, load }) => {
  writeFileSync(path, '#'.repeat(524289));
  await assert.rejects(load(), /exceeds 512 KiB/);
}));

function configurationRuntime() {
  return new Function('exec', 'div', 'v_flex', 'GitTodo', 'LAZYGIT_DEFAULTS', 'loadLazygitConfig',
    body('configuration-runtime.js') + '\nreturn GitConfiguration;')(() => {}, () => {}, () => {}, class {}, LAZYGIT_DEFAULTS, loadLazygitConfig);
}

test('nonpositive refresh intervals disable each corresponding background job', async () => {
  const GitConfiguration = configurationRuntime();
  for (const [name, flag] of [['fetchInterval', 'autoFetch'], ['refreshInterval', 'autoRefresh'], ['externalChangeCheckInterval', 'autoDetectExternalChanges']]) {
    for (const value of [0, -1, -100]) {
      const app = new GitConfiguration(); app.initConfiguration();
      app.root = '/fixture'; app.remotes = [{ name: 'origin' }];
      app.lazygitConfig.git = { autoFetch: false, autoRefresh: false, autoDetectExternalChanges: false, [flag]: true };
      app.lazygitConfig.refresher[name] = value;
      app.lastFetch = app.lastRefresh = app.lastExternalCheck = 0;
      const called = [];
      app.fetch = () => called.push('fetch'); app.refresh = () => called.push('refresh'); app.mark = async () => called.push('mark');
      app.tickRefresh({ spawn: work => { called.push('spawn'); work({}); } });
      assert.deepEqual(called, [], `${name}: ${value}`);
    }
  }
});

test('positive intervals above one day are honored and omitted intervals use defaults', () => {
  const GitConfiguration = configurationRuntime();
  const app = new GitConfiguration(); app.initConfiguration(); app.root = '/fixture'; app.remotes = [{ name: 'origin' }];
  app.lazygitConfig.git = { autoFetch: true, autoRefresh: false, autoDetectExternalChanges: false };
  app.lazygitConfig.refresher.fetchInterval = 172800;
  app.lastFetch = Date.now() - 86400000;
  let fetches = 0; app.fetch = () => fetches++;
  app.tickRefresh({}); assert.equal(fetches, 0);
  delete app.lazygitConfig.refresher.fetchInterval;
  app.tickRefresh({}); assert.equal(fetches, 1);
});
