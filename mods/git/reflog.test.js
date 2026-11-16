import {test} from 'node:test';
import assert from 'node:assert/strict';
import {findReflogAction} from './reflog.js';

const entry = (hash, subject) => ({hash, subject});
const action = (kind, from, to) => ({kind, from, to});
const commits = [entry('c', 'commit: C'), entry('b', 'commit: B'), entry('a', 'commit (initial): A')];
const undo = entry('ignored-undo-hash', '[lazygit undo]: updating HEAD');
const redo = entry('ignored-redo-hash', '[lazygit redo]: updating HEAD');

test('ordinary commit history undoes the newest action and cannot redo', () => {
  assert.deepEqual(findReflogAction(commits), action('commit', 'b', 'c'));
  assert.equal(findReflogAction(commits, {redo:true}), null);
  assert.equal(findReflogAction([], {redo:true}), null); assert.equal(findReflogAction([]), null);
});

test('the initial commit and truncated history preserve empty-from targets', () => {
  assert.deepEqual(findReflogAction([entry('a', 'commit (initial): A')]), action('commit', '', 'a'));
  assert.deepEqual(findReflogAction([entry('c', 'reset: moving to c')]), action('commit', '', 'c'));
  assert.deepEqual(findReflogAction([undo, entry('a', 'commit (initial): A')], {redo:true}), action('commit', '', 'a'));
});

test('undo markers skip exactly one recognized non-no-op user action each', () => {
  assert.deepEqual(findReflogAction([undo, ...commits]), action('commit', 'a', 'b'));
  assert.deepEqual(findReflogAction([undo, undo, ...commits]), action('commit', '', 'a'));
  assert.equal(findReflogAction([undo, undo, undo, ...commits]), null);
  assert.deepEqual(findReflogAction([undo, ...commits], {redo:true}), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([undo, undo, ...commits], {redo:true}), action('commit', 'a', 'b'));
});

test('redo markers cancel undo counts and ordinary new actions stop the redo search', () => {
  assert.deepEqual(findReflogAction([redo, undo, ...commits]), action('commit', 'b', 'c'));
  assert.equal(findReflogAction([redo, undo, ...commits], {redo:true}), null);
  assert.deepEqual(findReflogAction([redo, undo, undo, ...commits], {redo:true}), action('commit', 'b', 'c'));
  assert.equal(findReflogAction([entry('new', 'commit: New'), undo, ...commits], {redo:true}), null);
});

test('orphan redo markers retain the upstream negative-counter behavior', () => {
  assert.deepEqual(findReflogAction([redo, ...commits], {redo:true}), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([redo, redo, ...commits], {redo:true}), action('commit', 'b', 'c'));
  assert.equal(findReflogAction([redo, ...commits]), null);
});

test('checkout actions carry ref names, including Unicode whitespace that RE2 treats as non-ASCII', () => {
  assert.deepEqual(findReflogAction([entry('hash', 'checkout: moving from feature/one to feature/two')]), action('checkout', 'feature/one', 'feature/two'));
  assert.deepEqual(findReflogAction([undo, entry('hash', 'checkout: moving from old to new')], {redo:true}), action('checkout', 'old', 'new'));
  assert.deepEqual(findReflogAction([entry('hash', 'checkout: moving from 旧\u00a0支 to 新\u2003支 trailing words')]), action('checkout', '旧\u00a0支', '新\u2003支'));
  assert.deepEqual(findReflogAction([entry('hash', 'checkout: moving from old\vbranch to new\vbranch')]), action('checkout', 'old\vbranch', 'new\vbranch'));
});

test('commit, reset and pull use the immediate older physical entry as from', () => {
  for (const subject of ['commit (amend): changed', 'commit (merge): merged', 'reset: moving to HEAD~2', 'pull --rebase: Fast-forward', 'committer prefix', 'pulling prefix', 'reset: moving toward elsewhere']) {
    assert.deepEqual(findReflogAction([entry('new', subject), entry('physical', 'unrecognized entry'), ...commits]), action('commit', 'physical', 'new'));
  }
});

test('unrecognized actions never consume marker counts and prefixes stay case-sensitive', () => {
  const unknown = ['merge feature: Merge made by ort', 'cherry-pick: feature', 'revert: undo', 'branch: Created from main', 'rebase (pick): partial', 'Commit: uppercase', ' [lazygit undo]'].map((subject, index) => entry('unknown' + index, subject));
  assert.deepEqual(findReflogAction([...unknown, ...commits]), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([undo, ...unknown, ...commits]), action('commit', 'a', 'b'));
  assert.equal(findReflogAction(unknown), null);
});

test('finished and aborted rebases group through their start and skip every interior entry', () => {
  for (const suffix of ['(finish)', '(abort)', '-i (finish)', '-i (abort)']) {
    const rows = [entry('rebased', `rebase ${suffix}: returning to refs/heads/main`), redo, entry('mid', 'commit: during rebase'),
      entry('start', 'rebase -i (start): checkout base'), entry('original', 'commit: Original')];
    assert.deepEqual(findReflogAction(rows), action('rebase', 'original', 'rebased'));
    assert.deepEqual(findReflogAction([undo, ...rows], {redo:true}), action('rebase', 'original', 'rebased'));
  }
});

test('no-op commits/checkouts/aborted rebases do not consume an undo count', () => {
  assert.deepEqual(findReflogAction([entry('c', 'reset: moving to HEAD'), ...commits]), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([undo, entry('c', 'reset: moving to HEAD'), ...commits], {redo:true}), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([entry('same', 'checkout: moving from main to main'), ...commits]), action('commit', 'b', 'c'));
  assert.deepEqual(findReflogAction([entry('c', 'rebase (abort): returning to main'), entry('mid', 'rebase (start): checkout base'), ...commits]), action('commit', 'b', 'c'));
});

test('current rebase is selected distinctly, including empty-from and counter cases', () => {
  const rows = [entry('part', 'rebase (pick): picked'), entry('start', 'rebase (start): checkout base'), ...commits];
  assert.deepEqual(findReflogAction(rows), action('currentRebase', 'c', ''));
  assert.deepEqual(findReflogAction([entry('start', 'rebase -i (start)')]), action('currentRebase', '', ''));
  assert.deepEqual(findReflogAction([undo, ...rows], {redo:true}), action('currentRebase', 'c', ''));
  assert.deepEqual(findReflogAction([undo, ...rows]), action('commit', 'b', 'c'));
});

test('truncated or nested finish groups follow the upstream single pending-finish state', () => {
  assert.equal(findReflogAction([entry('end', 'rebase (finish)'), ...commits]), null);
  assert.deepEqual(findReflogAction([entry('end', 'rebase (finish)'), entry('start', 'rebase (start)')]), action('rebase', '', 'end'));
  assert.deepEqual(findReflogAction([entry('outer', 'rebase (finish)'), entry('inner', 'rebase (finish)'), entry('start', 'rebase (start)'), ...commits]), action('rebase', 'c', 'outer'));
  assert.deepEqual(findReflogAction([entry('', 'rebase (finish)'), ...commits]), action('commit', 'b', 'c'));
});

test('existing Lazygit marker prefixes interoperate without mutating input', () => {
  const rows = Object.freeze([Object.freeze(entry('ignored', '[lazygit undo]checkout: moving from new to old')), ...commits.map(row => Object.freeze({...row}))]);
  const before = JSON.stringify(rows), actual = findReflogAction(rows, {redo:true});
  assert.deepEqual(actual, action('commit', 'b', 'c')); assert.equal(JSON.stringify(rows), before);
  actual.from = 'changed'; assert.equal(rows[2].hash, 'b');
});
