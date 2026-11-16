import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePatch, selectedPatch, parseConflicts, resolveConflict, rebaseTodo } from './patch.js';

function repo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-git-test-'));
  const git = (args, input) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const put = (path, text) => writeFileSync(join(dir, path), text);
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.autocrlf', 'false']);
  try { fn({ dir, git, put }); } finally { rmSync(dir, { recursive: true, force: true }); }
}

for (const path of ['file.txt', "a b ' $() ü.txt", '-option.txt']) {
  test(`stage and unstage individual replacements: ${path}`, () => repo(({git, put}) => {
    put(path, 'a\nb\nc\nd\ne\n'); git(['add', '--', path]); git(['commit', '-qm', 'base']);
    put(path, 'a\nB\nc\nD\ne\n');
    let p = parsePatch(git(['diff', '--no-color', '--', path]));
    let rows = p.changes.filter((n) => ['-b', '+B'].includes(p.lines[n]));
    git(['apply', '--cached', '--whitespace=nowarn', '-'], selectedPatch(p, path, rows));
    assert.equal(git(['show', `:${path}`]), 'a\nB\nc\nd\ne\n');
    p = parsePatch(git(['diff', '--cached', '--', path]));
    git(['apply', '--cached', '-R', '-'], selectedPatch(p, path, p.changes, true));
    assert.equal(git(['show', `:${path}`]), 'a\nb\nc\nd\ne\n');
  }));
}

test('partial unstage keeps unselected staged lines', () => repo(({git, put}) => {
  put('f', 'a\nb\nc\nd\ne\n'); git(['add', '.']); git(['commit', '-qm', 'base']);
  put('f', 'a\nB\nc\nD\ne\n'); git(['add', '.']);
  const p = parsePatch(git(['diff', '--cached']));
  const rows = p.changes.filter((n) => ['-b', '+B'].includes(p.lines[n]));
  git(['apply', '--cached', '-R', '-'], selectedPatch(p, 'f', rows, true));
  assert.equal(git(['show', ':f']), 'a\nb\nc\nD\ne\n');
}));

test('new file partial stage and partial unstage, then remove from index', () => repo(({git, put}) => {
  put('f', 'a\nb\nc\n'); git(['add', '-N', '--', 'f']);
  let p = parsePatch(git(['diff', '--', 'f']));
  git(['apply', '--cached', '-'], selectedPatch(p, 'f', [p.changes[0], p.changes[2]]));
  assert.equal(git(['show', ':f']), 'a\nc\n');
  p = parsePatch(git(['diff', '--cached']));
  git(['apply', '--cached', '-R', '-'], selectedPatch(p, 'f', [p.changes[0]], true));
  assert.equal(git(['show', ':f']), 'c\n');
  p = parsePatch(git(['diff', '--cached']));
  git(['apply', '--cached', '-R', '-'], selectedPatch(p, 'f', p.changes, true));
  assert.equal(git(['ls-files']), '');
}));

test('partial deletion retains remaining lines', () => repo(({dir,git,put}) => {
  put('f', 'a\nb\nc\n'); git(['add', '.']); git(['commit', '-qm', 'base']); rmSync(join(dir,'f'));
  const p = parsePatch(git(['diff']));
  git(['apply', '--cached', '-'], selectedPatch(p, 'f', [p.changes[1]]));
  assert.equal(git(['show', ':f']), 'a\nc\n');
}));

test('multiple hunks and lines without a trailing newline', () => repo(({git,put}) => {
  const base = Array.from({length: 50}, (_, i) => `line ${i}`);
  put('f', base.join('\n')); git(['add', '.']); git(['commit', '-qm', 'base']);
  const changed = [...base]; changed[2] = 'early'; changed[40] = 'later'; changed[49] = 'end';
  put('f', changed.join('\n'));
  const p = parsePatch(git(['diff']));
  const rows = p.changes.filter((n) => ['-line 40', '+later', '-line 49', '+end'].includes(p.lines[n]));
  git(['apply', '--cached', '-'], selectedPatch(p, 'f', rows));
  base[40] = 'later'; base[49] = 'end'; assert.equal(git(['show', ':f']), base.join('\n'));
}));

test('discard only selected worktree lines and reject stale patches', () => repo(({dir,git,put}) => {
  put('f', 'a\nb\nc\nd\n'); git(['add', '.']); git(['commit', '-qm', 'base']); put('f', 'a\nB\nc\nD\n');
  const p = parsePatch(git(['diff'])), rows = p.changes.filter((n) => ['-b', '+B'].includes(p.lines[n]));
  const patch = selectedPatch(p, 'f', rows, true);
  git(['apply', '-R', '-'], patch); assert.equal(readFileSync(join(dir,'f'),'utf8'), 'a\nb\nc\nD\n');
  assert.throws(() => git(['apply', '-R', '--check', '-'], patch));
}));

test('diff3 conflict selection keeps unrelated contents and other conflicts', () => {
  const text = 'before\n<<<<<<< HEAD\nours\n||||||| base\nold\n=======\ntheirs\n>>>>>>> branch\nafter\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n';
  const p = parseConflicts(text); assert.equal(p.conflicts.length, 2);
  const next = resolveConflict(p, 0, 'both');
  assert.ok(next.startsWith('before\nours\ntheirs\nafter\n')); assert.equal(parseConflicts(next).conflicts.length, 1);
});

test('interactive rebase reorders, fixes up, drops and safely rewords commits', () => repo(({dir,git,put}) => {
  put('a', 'a'); git(['add', '.']); git(['commit', '-qm', 'base']); const base = git(['rev-parse','HEAD']).trim();
  const commits = [];
  for (const name of ['one','two','three']) { put(name,name); git(['add','.']); git(['commit','-qm',name]); commits.push({hash:git(['rev-parse','HEAD']).trim(),subject:name,action:'pick'}); }
  const message = "renamed ' $(touch never) `touch nope`";
  const todo = rebaseTodo([{...commits[1],action:'reword',message}, {...commits[0],action:'fixup'}, {...commits[2],action:'drop'}]);
  execFileSync('git', ['rebase', '-i', base], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: {
    ...process.env, HERDR_GIT_TODO: todo, GIT_SEQUENCE_EDITOR: 'sh -c \'printf "%s" "$HERDR_GIT_TODO" > "$1"\' sh', GIT_EDITOR: 'true',
  }});
  assert.equal(git(['log','-1','--format=%s']).trim(), message);
  assert.equal(git(['rev-list','--count',`${base}..HEAD`]).trim(), '1');
  assert.equal(git(['ls-files']).trim(), 'a\none\ntwo');
}));
