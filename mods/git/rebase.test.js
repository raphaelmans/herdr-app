// Run with: node --test mods/git/rebase.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRebaseTodo, editRebaseTodo, dropRebaseTodo, moveRebaseTodo } from './rebase.js';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
const row = (doc, subject) => {
  const entry = doc.rows.find((entry) => entry.subject === subject);
  assert.ok(entry, `Missing pending row: ${subject}`);
  return entry;
};

test('todo parsing preserves source bytes and reverses only visible instructions', () => {
  const raw = `# header\r\n\r\nlabel onto\r\nreset [new root]\r\np ${a} first\r\nf -C ${b} # second\r\nx printf 'a  b # literal'\r\nu refs/heads/kept\r\nm -c ${c} left right # merged\r\nmerge left # new merge\r\nb\r\nnoop\r\n# final`;
  const doc = parseRebaseTodo(raw);
  assert.equal(doc.valid, true); assert.deepEqual(doc.errors, []);
  assert.equal(doc.lines.join(''), raw); assert.equal(doc.entries.map((entry) => entry.raw).join(''), raw);
  assert.deepEqual(doc.rows.map((entry) => entry.verb), ['merge', 'update-ref', 'exec', 'fixup', 'pick']);
  assert.equal(doc.rows[0].hash, c); assert.equal(doc.rows[0].flag, '-c');
  assert.deepEqual(doc.rows[0].labels, ['left', 'right']); assert.equal(doc.rows[0].subject, 'merged');
  assert.equal(doc.rows[1].ref, 'refs/heads/kept'); assert.equal(doc.rows[1].movable, true);
  assert.equal(doc.rows[2].command, "printf 'a  b # literal'"); assert.equal(doc.rows[2].movable, false);
  assert.equal(doc.rows[3].subject, 'second'); assert.deepEqual(doc.rows[3].flags, ['-C']);
  assert.equal(doc.entries[3].label, '[new root]'); assert.equal(doc.entries.at(-1).eol, '');
  assert.equal(doc.rows[0].editable, false);
});

test('custom comment characters, abbreviated hashes and whitespace survive edits', () => {
  const raw = `; header\n  p\t${a.slice(0, 8)}\t; subject  with spaces\n\n; footer\n`;
  const doc = parseRebaseTodo(raw, {commentChar:';'}), before = JSON.stringify(doc);
  assert.equal(doc.rows[0].subject, 'subject  with spaces');
  const fixed = editRebaseTodo(doc, doc.rows[0], 'fixup', '-C');
  assert.equal(fixed.raw, raw.replace('  p\t', '  fixup\t-C '));
  const picked = editRebaseTodo(fixed, fixed.rows[0], 'pick');
  assert.equal(picked.raw, raw.replace('  p\t', '  pick\t'));
  assert.equal(JSON.stringify(doc), before);
  assert.equal(picked.commentChar, ';');
  assert.deepEqual(picked.selection.map((entry) => entry.hash), [a.slice(0, 8)]);
});

test('malformed todo reports exact source lines and cannot be rewritten', () => {
  const raw = `pick\nfixup -C\nmerge -C ${a}\nexec\nupdate-ref\nlabel\nwat ${b}\n__proto__ ${c}\npick ${d}\0bad\n`;
  const doc = parseRebaseTodo(raw);
  assert.equal(doc.valid, false); assert.equal(doc.errors.length, 9);
  assert.match(doc.errors[0], /^Line 1:/); assert.match(doc.errors.at(-1), /^Line 9:/);
  assert.equal(doc.raw, raw);
  assert.throws(() => editRebaseTodo(doc, 0, 'edit'), /Line 1/);
  assert.throws(() => dropRebaseTodo(doc, 0), /Line 1/);
  assert.throws(() => moveRebaseTodo(doc, 0, -1), /Line 1/);
});

test('action changes preserve every unselected byte and clear obsolete fixup flags', () => {
  const raw = `# prefix\npick ${a} first\n  f  -c\t${b}\tsecond # keep this\nexec printf 'unchanged'\n# suffix\n`;
  const doc = parseRebaseTodo(raw);
  const changed = editRebaseTodo(doc, row(doc, 'second # keep this'), 'drop');
  assert.equal(changed.raw, raw.replace(`  f  -c\t${b}`, `  drop  ${b}`));
  assert.equal(changed.requiresEditTodo, false);
  assert.equal(changed.rows.find((entry) => entry.hash === b).flag, '');
  const same = editRebaseTodo(doc, row(doc, 'first'), 'pick');
  assert.equal(same.raw, raw);
  assert.throws(() => editRebaseTodo(doc, row(doc, 'first'), 'reword'), /external editor/);
  assert.throws(() => editRebaseTodo(doc, row(doc, 'first'), 'fixup', '-c'), /Only fixup/);
  assert.throws(() => editRebaseTodo(doc, row(doc, 'first'), 'edit', '-C'), /Only fixup/);
  assert.throws(() => editRebaseTodo(doc, row(doc, "printf 'unchanged'"), 'drop'), /exec/);
  assert.throws(() => editRebaseTodo(doc, row(doc, 'first'), '__proto__'), /Unsupported/);
});

test('a pending reword can be converted to pick, but pending reword is not newly assigned', () => {
  const doc = parseRebaseTodo(`reword ${a} original\npick ${b} next\n`);
  assert.equal(editRebaseTodo(doc, row(doc, 'original'), 'pick').rows.at(-1).verb, 'pick');
  const moved = moveRebaseTodo(doc, row(doc, 'original'), -1);
  assert.equal(moved.rows[0].verb, 'reword');
  assert.throws(() => editRebaseTodo(doc, row(doc, 'next'), 'r'), /external editor/);
});

test('moves follow visible list direction and leave hidden comment lines in place', () => {
  const raw = `pick ${a} first\n# between\n\npick ${b} second\nexec echo after-second\npick ${c} third\n`;
  const doc = parseRebaseTodo(raw), before = JSON.stringify(doc);
  const moved = moveRebaseTodo(doc, row(doc, 'second'), -1);
  assert.equal(moved.raw, `pick ${a} first\n# between\n\nexec echo after-second\npick ${b} second\npick ${c} third\n`);
  assert.equal(moved.selection[0].subject, 'second');
  const back = moveRebaseTodo(moved, moved.selection, 1);
  assert.equal(back.raw, raw); assert.equal(JSON.stringify(doc), before);
});

test('moving a range keeps its order, skips hidden rows, and is atomic at list boundaries', () => {
  const raw = `pick ${a} first\n# stays\npick ${b} second\npick ${c} third\npick ${d} fourth\n`;
  const doc = parseRebaseTodo(raw), selected = [row(doc, 'third'), row(doc, 'second')];
  const moved = moveRebaseTodo(doc, selected, -1);
  assert.deepEqual(moved.rows.map((entry) => entry.subject), ['third', 'second', 'fourth', 'first']);
  assert.deepEqual(moved.selection.map((entry) => entry.subject), ['third', 'second']);
  assert.ok(moved.raw.includes(`# stays\npick ${d}`));
  assert.throws(() => moveRebaseTodo(doc, selected, -2), /cannot move any further/);
  assert.throws(() => moveRebaseTodo(doc, [row(doc, 'first'), row(doc, 'third')], -1), /contiguous/);
  assert.throws(() => moveRebaseTodo(doc, selected, 0.5), /integer/);
  assert.equal(doc.raw, raw);
});

test('moving terminal lines preserves CRLF and the missing final newline', () => {
  const doc = parseRebaseTodo(`pick ${a} first\r\npick ${b} second`);
  const moved = moveRebaseTodo(doc, row(doc, 'second'), 1);
  assert.equal(moved.raw, `pick ${b} second\r\npick ${a} first`);
  assert.equal(moveRebaseTodo(moved, moved.selection, -1).raw, doc.raw);
  assert.equal(moveRebaseTodo(doc, row(doc, 'first'), 0).raw, doc.raw);
});

test('line identities distinguish duplicate hashes and stale row snapshots are rejected', () => {
  const doc = parseRebaseTodo(`pick ${a} first copy\npick ${a} second copy\n`);
  const changed = editRebaseTodo(doc, row(doc, 'second copy'), 'edit');
  assert.deepEqual(changed.rows.map((entry) => entry.verb), ['edit', 'pick']);
  assert.throws(() => editRebaseTodo(changed, row(doc, 'second copy'), 'drop'), /changed; refresh/);
  assert.throws(() => editRebaseTodo(doc, [], 'edit'), /Select/);
  assert.throws(() => editRebaseTodo(doc, -1, 'edit'), /Select/);
  assert.throws(() => editRebaseTodo(doc, a, 'edit'), /Select/);
});

test('merge and break boundaries cannot be crossed or converted into ordinary commit actions', () => {
  for (const instruction of ['label boundary', 'reset boundary', 'break', `merge -C ${c} boundary # merged`]) {
    const doc = parseRebaseTodo(`pick ${a} first\n${instruction}\npick ${b} second\n`);
    assert.equal(doc.valid, true);
    assert.throws(() => moveRebaseTodo(doc, row(doc, 'first'), -1), /Moving across/);
    assert.throws(() => moveRebaseTodo(doc, row(doc, 'second'), 1), /Moving across/);
  }
  const doc = parseRebaseTodo(`pick ${a} first\nmerge -C ${c} boundary # merged\n`);
  assert.throws(() => editRebaseTodo(doc, row(doc, 'merged'), 'pick'), /merge/);
  assert.throws(() => dropRebaseTodo(doc, row(doc, 'merged')), /merge/);
  assert.throws(() => moveRebaseTodo(doc, row(doc, 'merged'), 1), /merge/);
});

test('drop removes update-ref rows, marks ordinary commits as drop, and requests Git reconciliation', () => {
  const raw = `# keep\npick ${a} first\nupdate-ref refs/heads/saved\n# retain\npick ${b} second\n`;
  const doc = parseRebaseTodo(raw);
  const changed = dropRebaseTodo(doc, [row(doc, 'refs/heads/saved'), row(doc, 'second')]);
  assert.equal(changed.raw, `# keep\npick ${a} first\n# retain\ndrop ${b} second\n`);
  assert.equal(changed.requiresEditTodo, true);
  assert.deepEqual(changed.selection.map((entry) => entry.subject), ['second']);
  assert.equal(editRebaseTodo(changed, changed.selection, 'pick').requiresEditTodo, true);
  assert.equal(moveRebaseTodo(doc, row(doc, 'first'), -1).requiresEditTodo, true);
  assert.equal(moveRebaseTodo(doc, row(doc, 'refs/heads/saved'), -1).requiresEditTodo, true);
  assert.equal(dropRebaseTodo(parseRebaseTodo('update-ref refs/heads/only'), 0).raw, '');
});

function repo(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-git-rebase-'))), dir = join(root, 'repo');
  mkdirSync(dir);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    GIT_CONFIG_GLOBAL: join(root, 'global.config'), GIT_CONFIG_NOSYSTEM:'1',
    GIT_TERMINAL_PROMPT:'0', GIT_EDITOR:'true', GIT_SEQUENCE_EDITOR:'true', LC_ALL:'C',
  };
  const git = (args, options = {}) => {
    const result = spawnSync('git', args, {cwd:dir, encoding:'utf8', ...options, env:{...env, ...options.env}});
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.error ?? result.stderr}`);
    return result.stdout;
  };
  const put = (path, text) => { const full = join(dir, path); mkdirSync(dirname(full), {recursive:true}); writeFileSync(full, text); };
  const commit = (name) => { put(name, `${name}\n`); git(['add', '--all']); git(['commit', '-qm', name]); return git(['rev-parse', 'HEAD']).trim(); };
  const metadata = (name) => resolve(dir, git(['rev-parse', '--git-path', name]).trim());
  const todo = () => parseRebaseTodo(readFileSync(metadata('rebase-merge/git-rebase-todo'), 'utf8'));
  const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
  let scriptId = 0;
  const editor = (body) => {
    const path = join(root, `editor ${scriptId++}.sh`);
    writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`);
    return {GIT_SEQUENCE_EDITOR:`sh ${quote(path)}`};
  };
  const pauseAtFirst = (base, extra = []) => git(['rebase', '-i', ...extra, base], {
    env:editor('sed \'1s/^pick /edit /\' "$1" > "$1.new"\nmv "$1.new" "$1"'),
  });
  const writeTodo = (doc, throughGit = false) => {
    if (!throughGit) { writeFileSync(metadata('rebase-merge/git-rebase-todo'), doc.raw); return; }
    const path = join(root, 'replacement todo'); writeFileSync(path, doc.raw);
    git(['rebase', '--edit-todo'], {env:editor(`cat ${quote(path)} > "$1"`)});
  };
  try {
    git(['init', '--template=', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Rebase Test']); git(['config', 'user.email', 'rebase@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']); git(['config', 'core.autocrlf', 'false']);
    return fn({root, dir, git, put, commit, metadata, todo, editor, pauseAtFirst, writeTodo});
  } finally { rmSync(root, {recursive:true, force:true}); }
}

test('real paused Git rebase accepts a first remaining fixup, moved commit, and drop', () => repo(({git, commit, todo, pauseAtFirst, writeTodo, metadata}) => {
  const base = commit('base'); commit('one'); commit('two'); commit('three'); commit('four');
  pauseAtFirst(base);
  let doc = todo();
  assert.deepEqual(doc.rows.map((entry) => entry.subject), ['four', 'three', 'two']);
  doc = moveRebaseTodo(doc, row(doc, 'four'), 1);
  doc = dropRebaseTodo(doc, row(doc, 'three'));
  doc = editRebaseTodo(doc, row(doc, 'two'), 'fixup');
  assert.equal(doc.entries.find((entry) => entry.visible).verb, 'fixup');
  writeTodo(doc); git(['rebase', '--continue']);
  assert.equal(existsSync(metadata('rebase-merge')), false);
  assert.deepEqual(git(['log', '--reverse', '--format=%s']).trim().split('\n'), ['base', 'one', 'four']);
  assert.deepEqual(git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n'), ['base', 'four', 'one', 'two']);
}));

test('real update-ref removal through edit-todo keeps the old branch target', () => repo(({git, commit, todo, pauseAtFirst, writeTodo, metadata}) => {
  const base = commit('base'); commit('one'); const oldTwo = commit('two'); git(['branch', 'saved']); commit('three');
  pauseAtFirst(base, ['--update-refs']);
  git(['commit', '--amend', '-qm', 'one rewritten']);
  const doc = todo(), ref = row(doc, 'refs/heads/saved');
  const changed = dropRebaseTodo(doc, ref);
  assert.equal(changed.requiresEditTodo, true);
  writeTodo(changed, changed.requiresEditTodo);
  const bookkeeping = metadata('rebase-merge/update-refs');
  if (existsSync(bookkeeping)) assert.ok(!readFileSync(bookkeeping, 'utf8').includes('refs/heads/saved'));
  git(['rebase', '--continue']);
  assert.equal(git(['rev-parse', 'saved']).trim(), oldTwo);
  assert.notEqual(git(['rev-parse', 'HEAD~1']).trim(), oldTwo);
  assert.equal(git(['show', 'HEAD:two']), 'two\n');
}));

test('real merge-preserving todo retains labels/resets/merge while dropping a later ordinary commit', () => repo(({git, commit, todo, editor, writeTodo}) => {
  const base = commit('base');
  git(['switch', '-qc', 'side']); commit('side');
  git(['switch', '-q', 'main']); commit('main'); git(['merge', '--no-ff', '-qm', 'merged side', 'side']);
  commit('post');
  git(['rebase', '-i', '--rebase-merges', base], {env:editor('printf "break\\n" > "$1.new"\ncat "$1" >> "$1.new"\nmv "$1.new" "$1"')});
  const doc = todo();
  assert.equal(doc.valid, true);
  const metadata = doc.entries.filter((entry) => ['label', 'reset', 'merge'].includes(entry.verb)).map((entry) => entry.raw);
  assert.ok(metadata.length >= 3); assert.ok(doc.rows.some((entry) => entry.verb === 'merge'));
  const changed = dropRebaseTodo(doc, row(doc, 'post'));
  assert.deepEqual(changed.entries.filter((entry) => ['label', 'reset', 'merge'].includes(entry.verb)).map((entry) => entry.raw), metadata);
  writeTodo(changed); git(['rebase', '--continue']);
  assert.equal(git(['rev-list', '--count', '--merges', `${base}..HEAD`]).trim(), '1');
  assert.equal(git(['show', 'HEAD:side']), 'side\n'); assert.equal(git(['show', 'HEAD:main']), 'main\n');
  assert.ok(!git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').includes('post'));
}));
