// Run with: node --test mods/git/status.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { parseStatus, filterFiles, filePaths, operationFromState, operationCommands, OPERATION_STATE_SCRIPT } from './status.js';

function repo(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-git-status-'))), dir = join(root, 'repo');
  mkdirSync(dir);
  // Do not inherit user Git configuration, indexes, worktrees or commit identity.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: join(root, 'global.config'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', LC_ALL: 'C',
  };
  const run = (args, input, cwd = dir) => spawnSync('git', args, {cwd, input, encoding:'utf8', env});
  const git = (args, input, cwd = dir) => {
    const result = run(args, input, cwd);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.error ?? result.stderr}`);
    return result.stdout;
  };
  const fail = (args, input) => {
    const result = run(args, input);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `git ${args.join(' ')} unexpectedly succeeded`);
    return result;
  };
  const put = (path, text) => { const full = join(dir, path); mkdirSync(dirname(full), {recursive:true}); writeFileSync(full, text); };
  const metadata = (name, text) => {
    const path = resolve(dir, git(['rev-parse', '--git-path', name]).trim());
    mkdirSync(dirname(path), {recursive:true}); writeFileSync(path, text); return path;
  };
  const status = (...args) => parseStatus(git(['status', '--porcelain=v1', '-z', '-b', '--find-renames=50%', ...args]));
  const state = (cwd = dir) => execFileSync('sh', ['-c', OPERATION_STATE_SCRIPT], {cwd, env, encoding:'utf8'});
  const commit = (message) => { git(['add', '--all']); git(['commit', '-qm', message]); return git(['rev-parse', 'HEAD']).trim(); };
  try {
    git(['init', '--template=', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Status Test']); git(['config', 'user.email', 'status@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.autocrlf', 'false']);
    return fn({root, dir, git, fail, put, metadata, status, state, commit});
  } finally { rmSync(root, {recursive:true, force:true}); }
}

const paths = (files) => files.map((file) => file.path).sort();

test('Git ignore sources hide untracked paths but never hide a tracked ignored file', () => repo(({root, git, put, metadata, status, commit}) => {
  put('tracked.log', 'base\n'); commit('tracked before ignored');
  put('.gitignore', '*.log\nignored directory/\n'); commit('ignore rules');
  metadata('info/exclude', '*.info\n');
  const globalIgnore = join(root, 'global ignore'); writeFileSync(globalIgnore, '*.global\n');
  git(['config', '--global', 'core.excludesFile', globalIgnore]);
  put('tracked.log', 'changed\n'); put('local.log', 'ignored'); put('local.info', 'ignored');
  put('local.global', 'ignored'); put('ignored directory/nested.txt', 'ignored'); put('visible ü.txt', 'visible');
  const {files} = status('--untracked-files=all');
  assert.deepEqual(paths(files), ['tracked.log', 'visible ü.txt']);
  assert.deepEqual(paths(filterFiles(files, 'tracked')), ['tracked.log']);
  assert.deepEqual(paths(filterFiles(files, 'untracked')), ['visible ü.txt']);
  assert.equal(files.find((file) => file.path === 'tracked.log').unstaged, true);
  // Defensive parsing also excludes !! records when the caller asks Git for them.
  assert.deepEqual(paths(status('--ignored', '--untracked-files=all').files), paths(files));
}));

for (const setting of ['no', 'normal', 'all']) {
  test(`status.showUntrackedFiles=${setting} is respected and an explicit untracked query overrides it`, () => repo(({git, put, status, commit}) => {
    put('tracked', 'base'); commit('base'); put('tracked', 'changed');
    put('new directory/a ü.txt', 'a'); put('new directory/nested/b.txt', 'b');
    git(['config', 'status.showUntrackedFiles', setting]);
    const files = status().files;
    const expected = setting === 'no' ? [] : setting === 'normal' ? ['new directory'] : ['new directory/a ü.txt', 'new directory/nested/b.txt'];
    assert.deepEqual(paths(filterFiles(files, 'untracked')), expected);
    assert.deepEqual(paths(filterFiles(files, 'tracked')), ['tracked']);
    if (setting === 'normal') assert.equal(files.find((file) => file.path === 'new directory').directory, true);
    const override = filterFiles(status('--untracked-files=all').files, 'untracked');
    assert.deepEqual(paths(override), ['new directory/a ü.txt', 'new directory/nested/b.txt']);
    assert.ok(override.every((file) => !file.directory));
  }));
}

test('NUL status preserves both rename paths, special characters, and the following record', () => repo(({git, put, status, commit}) => {
  const old = "?? old '\t\n$() ü.txt", renamed = "new '\t\n`literal` ü.txt";
  put(old, 'one\ntwo\nthree\nfour\n'); put('other', 'base'); commit('base');
  git(['mv', '--', old, renamed]); put(renamed, 'one\ntwo\nthree\nfour\nfive\n'); put('other', 'changed');
  const {files} = status();
  assert.equal(files.length, 2);
  const file = files.find((item) => item.path === renamed);
  assert.equal(file.previousPath, old); assert.equal(file.x, 'R'); assert.equal(file.y, 'M');
  assert.equal(file.staged, true); assert.equal(file.unstaged, true);
  assert.deepEqual(paths(filterFiles(files, 'staged', 'old ü')), [renamed]);
  assert.deepEqual(paths(filterFiles(files, 'unstaged', 'new ü')), [renamed]);
  assert.deepEqual(filePaths([file, file]), [renamed, old]);
  // Both paths are needed for an actual rename unstage; they are passed as argv.
  git(['restore', '--staged', '--', ...filePaths([file])]);
  assert.equal(git(['diff', '--cached']), '');
  assert.ok(status('--untracked-files=all').files.some((item) => item.path === renamed && item.fresh));
}));

test('conflicted filtering retains resolved staged paths while other conflicts remain', () => repo(({git, fail, put, status, commit}) => {
  put('one', 'base\n'); put('two', 'base\n'); put('unrelated', 'base\n'); commit('base');
  git(['switch', '-qc', 'other']); put('one', 'theirs\n'); put('two', 'theirs\n'); commit('theirs');
  git(['switch', '-q', 'main']); put('one', 'ours\n'); put('two', 'ours\n'); commit('ours');
  fail(['merge', '--no-edit', 'other']);
  const initial = status().files, remembered = new Set(initial.filter((file) => file.conflict).map((file) => file.path));
  assert.deepEqual([...remembered].sort(), ['one', 'two']);
  assert.ok(initial.every((file) => file.inlineConflict && !file.staged));
  put('one', 'resolved\n'); git(['add', '--', 'one']); put('unrelated', 'later edit\n');
  const current = status().files;
  assert.deepEqual(paths(filterFiles(current, 'conflicted', '', remembered)), ['one', 'two']);
  assert.deepEqual(paths(filterFiles(current, 'conflicted')), ['two']);
  assert.deepEqual(paths(filterFiles(current, 'conflicted', 'one', remembered)), ['one']);
  assert.deepEqual(paths(filterFiles(current, 'conflicted', 'ONE', remembered)), []); // uppercase makes the search case-sensitive
  assert.equal(current.find((file) => file.path === 'one').conflict, false);
  assert.equal(current.find((file) => file.path === 'one').staged, true);
  git(['merge', '--abort']);
}));

test('operation precedence selects the inner operation and maps only supported commands', () => {
  const markers = ['REVERT_HEAD', 'CHERRY_PICK_HEAD', 'MERGE_HEAD', 'SQUASH_MSG', 'rebase-apply/applying', 'rebase-merge'];
  const operations = ['revert', 'cherry-pick', 'merge', 'squash-merge', 'am', 'rebase'];
  for (let i = 0; i < markers.length; i++) assert.equal(operationFromState(markers.slice(i).reverse().join('\n')), operations[i]);
  assert.equal(operationFromState('rebase-apply\n'), 'rebase');
  assert.equal(operationFromState('rebase-apply\nrebase-apply/applying\n'), 'am');
  assert.equal(operationFromState('rebase-merge\nCHERRY_PICK_HEAD\nrebase:pick\n'), 'rebase');
  assert.equal(operationFromState('rebase-merge\nCHERRY_PICK_HEAD\nrebase:pick\nsequence:pick\n'), 'cherry-pick');
  assert.equal(operationFromState('BISECT_LOG\n'), null);
  assert.equal(operationFromState(''), null);
  assert.deepEqual(operationCommands('squash-merge'), {label:'squash merge', continue:['commit', '--no-edit'], abort:['reset', '--merge'], skip:null});
  assert.deepEqual(operationCommands('am'), {label:'apply patches', continue:['am', '--continue'], abort:['am', '--abort'], skip:['am', '--skip']});
  assert.equal(operationCommands('merge').skip, null);
  for (const op of ['rebase', 'cherry-pick', 'revert']) assert.deepEqual(operationCommands(op).skip, [op, '--skip']);
  assert.equal(operationCommands('unknown'), null); assert.equal(operationCommands(null), null);
});

test('a real git am conflict is applying patches and its Continue command completes it', () => repo(({git, fail, put, state, commit}) => {
  put('f', 'base\n'); commit('base'); git(['switch', '-qc', 'patch']); put('f', 'patch\n'); commit('patch');
  const patch = git(['format-patch', '-1', '--stdout']);
  git(['switch', '-q', 'main']); put('f', 'main\n'); commit('main');
  fail(['am'], patch);
  assert.equal(operationFromState(state()), 'am');
  put('f', 'resolved\n'); git(['add', '--', 'f']); git(operationCommands('am').continue);
  assert.equal(operationFromState(state()), null); assert.equal(git(['show', 'HEAD:f']), 'resolved\n');
}));

test('squash Continue commits staged changes without MERGE_HEAD and clears operation state', () => repo(({git, put, state, commit}) => {
  put('f', 'base\n'); const base = commit('base'); git(['switch', '-qc', 'other']); put('added', 'other\n'); commit('other');
  git(['switch', '-q', 'main']); git(['merge', '--squash', 'other']);
  const snapshot = state(); assert.match(snapshot, /SQUASH_MSG/); assert.doesNotMatch(snapshot, /MERGE_HEAD/);
  assert.equal(operationFromState(snapshot), 'squash-merge'); git(operationCommands('squash-merge').continue);
  assert.equal(git(['rev-parse', 'HEAD^']).trim(), base); assert.equal(git(['rev-list', '--count', `${base}..HEAD`]).trim(), '1');
  assert.equal(operationFromState(state()), null); assert.equal(git(['status', '--porcelain']), '');
}));

test('squash Abort clears its changes and preserves unrelated unstaged edits', () => repo(({dir, git, put, state, commit}) => {
  put('keep', 'base\n'); const base = commit('base'); git(['switch', '-qc', 'other']); put('added', 'other\n'); commit('other');
  git(['switch', '-q', 'main']); put('keep', 'keep this edit\n'); git(['merge', '--squash', 'other']);
  assert.equal(operationFromState(state()), 'squash-merge'); git(operationCommands('squash-merge').abort);
  assert.equal(operationFromState(state()), null); assert.equal(git(['rev-parse', 'HEAD']).trim(), base);
  assert.equal(readFileSync(join(dir, 'keep'), 'utf8'), 'keep this edit\n'); assert.equal(existsSync(join(dir, 'added')), false);
}));

test('a stopped multi-commit cherry-pick is detected from the sequencer without CHERRY_PICK_HEAD', () => repo(({git, fail, put, state, commit}) => {
  put('base', 'base'); commit('base'); git(['switch', '-qc', 'other']);
  put('collision', 'committed'); const first = commit('first'); put('second', 'second'); const second = commit('second');
  git(['switch', '-q', 'main']); put('collision', 'untracked user file'); fail(['cherry-pick', first, second]);
  const snapshot = state(); assert.doesNotMatch(snapshot, /CHERRY_PICK_HEAD/); assert.match(snapshot, /sequence:pick/);
  assert.equal(operationFromState(snapshot), 'cherry-pick'); git(operationCommands('cherry-pick').abort);
  assert.equal(operationFromState(state()), null);
}));

test('a stopped multi-commit revert is detected from the sequencer without REVERT_HEAD', () => repo(({git, fail, put, state, commit}) => {
  put('collision', 'original'); commit('base'); git(['rm', '--', 'collision']); const first = commit('remove');
  put('second', 'second'); const second = commit('second'); put('collision', 'untracked user file');
  fail(['revert', first, second]);
  const snapshot = state(); assert.doesNotMatch(snapshot, /REVERT_HEAD/); assert.match(snapshot, /sequence:revert/);
  assert.equal(operationFromState(snapshot), 'revert'); git(operationCommands('revert').abort);
  assert.equal(operationFromState(state()), null);
}));

test('a cherry-pick nested inside a paused rebase takes precedence until it is aborted', () => repo(({git, fail, put, state, commit}) => {
  put('f', 'base\n'); commit('base'); git(['switch', '-qc', 'other']); put('f', 'other\n'); const other = commit('other');
  git(['switch', '-q', 'main']); put('f', 'main\n'); commit('main'); fail(['rebase', '--exec', 'false', 'HEAD~1']);
  assert.equal(operationFromState(state()), 'rebase'); fail(['cherry-pick', other]);
  assert.equal(operationFromState(state()), 'cherry-pick'); git(operationCommands('cherry-pick').abort);
  assert.equal(operationFromState(state()), 'rebase'); git(operationCommands('rebase').abort);
  assert.equal(operationFromState(state()), null);
}));

test('a rebase-owned CHERRY_PICK_HEAD remains a rebase, including the stopped-sha and done forms', () => repo(({git, fail, put, metadata, state, commit}) => {
  put('f', 'base\n'); commit('base'); git(['switch', '-qc', 'other']); put('f', 'other\n'); commit('other');
  git(['switch', '-q', 'main']); put('f', 'main\n'); const ours = commit('main'); fail(['rebase', 'other']);
  assert.equal(operationFromState(state()), 'rebase');
  // Git versions differ in whether this marker survives a failed rebase pick.
  const cherry = metadata('CHERRY_PICK_HEAD', `${ours}\n`);
  assert.match(state(), /rebase:pick/); assert.equal(operationFromState(state()), 'rebase');
  rmSync(resolve(dirname(cherry), 'rebase-merge/stopped-sha'));
  assert.match(state(), /rebase:pick/); assert.equal(operationFromState(state()), 'rebase');
  git(operationCommands('rebase').abort); assert.equal(operationFromState(state()), null);
}));

test('operation state follows the linked worktree git path instead of its .git file', () => repo(({root, dir, git, put, state, commit}) => {
  put('f', 'base\n'); commit('base'); git(['switch', '-qc', 'other']); put('added', 'other'); commit('other');
  git(['switch', '-q', 'main']); const linked = join(root, 'linked worktree'); git(['worktree', 'add', '-qb', 'linked', linked]);
  git(['merge', '--squash', 'other'], undefined, linked);
  assert.equal(operationFromState(state(linked)), 'squash-merge'); assert.equal(operationFromState(state(dir)), null);
  git(operationCommands('squash-merge').abort, undefined, linked);
  assert.equal(operationFromState(state(linked)), null);
}));

test('the bounded sequencer read returns only its operation, not subjects or later commands', () => repo(({metadata, state}) => {
  metadata('sequencer/todo', `pick ${'a'.repeat(40)} ${'subject '.repeat(50000)}\nrevert ${'b'.repeat(40)} later\n`);
  assert.equal(state(), 'sequence:pick\n');
  metadata('sequencer/todo', `${'# comment\n'.repeat(1000)}pick ${'a'.repeat(40)} beyond limit\n`);
  assert.equal(state(), '');
}));
