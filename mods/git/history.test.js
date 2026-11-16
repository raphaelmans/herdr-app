// These fixtures exercise real Git history in disposable repositories.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { graphHistoryQuery, graphHistoryPage } from './history.js';

const FORMAT = '%H%x1f%P%x1f%s';

function repository(run) {
  const cwd = mkdtempSync(join(tmpdir(), 'herdr-graph-history-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  const git = (args, options = {}) => execFileSync('git', args, {
    cwd, env: { ...env, ...options.env }, input: options.input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
  try {
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Graph fixture']);
    git(['config', 'user.email', 'graph@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    const tree = git(['mktree'], { input: '' });
    const commit = (subject, day, parents = []) => {
      const date = `2025-01-${String(day).padStart(2, '0')}T12:00:00+00:00`;
      return git(['commit-tree', tree, ...parents.flatMap((hash) => ['-p', hash])], {
        input: subject, env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
      });
    };
    const query = (options) => graphHistoryQuery({ format: FORMAT, ...options });
    const read = (request) => {
      const text = git(request.args);
      const commits = text ? text.split('\n').map((line) => {
        const [hash, parentText, subject] = line.split('\x1f');
        return { hash, parents: parentText ? parentText.split(' ') : [], subject };
      }) : [];
      return graphHistoryPage(commits, request.limit);
    };
    return run({ cwd, git, commit, query, read });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('Git orders the complete walk before selecting a page despite skewed commit dates', () => repository(({ git, commit, query, read }) => {
  const parent = commit('parent dated after children', 10);
  const main = commit('main child', 9, [parent]);
  const side = commit('side child', 8, [parent]);
  git(['update-ref', 'refs/heads/main', main]);
  git(['update-ref', 'refs/heads/side', side]);

  // Establish the old failure: sorting these two results cannot recover side.
  const oldPage = git(['log', '-n', '2', '--format=%H', '--branches', 'HEAD', '--']).split('\n');
  assert.deepEqual(oldPage, [main, parent]);
  const page = read(query({ limit: 2 }));
  assert.deepEqual(page.commits.map((item) => item.hash), [main, side]);
  assert.equal(page.hasMore, true);
  const complete = read(query({ limit: 3 }));
  assert.deepEqual(complete.commits.map((item) => item.hash), [main, side, parent]);
  assert.equal(complete.hasMore, false);
}));

test('all-branches history includes a stash-only base after its branch is deleted', () => repository(({ cwd, git, query, read }) => {
  const file = join(cwd, 'file.txt');
  writeFileSync(file, 'base\n');
  git(['add', 'file.txt']);
  git(['commit', '-qm', 'base']);
  git(['checkout', '-qb', 'discarded-topic']);
  writeFileSync(file, 'topic\n');
  git(['commit', '-qam', 'topic']);
  const base = git(['rev-parse', 'HEAD']);
  writeFileSync(file, 'saved work\n');
  git(['stash', 'push', '-qm', 'saved topic work']);
  git(['checkout', '-q', 'main']);
  git(['branch', '-D', 'discarded-topic']);
  assert.equal(git(['rev-parse', 'stash@{0}^1']), base);

  const withoutStash = query({ limit: 10 });
  assert.ok(!read(withoutStash).commits.some((item) => item.hash === base));
  const withStash = query({ limit: 10, stashBases: [base, base] });
  assert.ok(read(withStash).commits.some((item) => item.hash === base));
  assert.equal(withStash.args.filter((arg) => arg === base).length, 1);
  assert.notEqual(withStash.key, withoutStash.key, 'stash reachability changes invalidate the graph query cache');

  const filtered = query({ refs: ['refs/heads/main'], limit: 10, stashBases: [base] });
  assert.ok(!read(filtered).commits.some((item) => item.hash === base), 'a filtered branch must not acquire unrelated stash history');
}));

test('extending history retains the existing prefix and removes the sentinel at the final page', () => repository(({ git, commit, query, read }) => {
  const hashes = [];
  for (let day = 1; day <= 7; day++) hashes.push(commit(`commit ${day}`, day, hashes.length ? [hashes.at(-1)] : []));
  git(['update-ref', 'refs/heads/main', hashes.at(-1)]);
  const firstQuery = query({ limit: 2 }), nextQuery = query({ limit: 4 });
  const first = read(firstQuery), next = read(nextQuery), final = read(query({ limit: 7 }));
  assert.notEqual(firstQuery.key, nextQuery.key, 'a larger page must not reuse a smaller cached query');
  assert.equal(first.commits.length, 2);
  assert.equal(first.hasMore, true);
  assert.equal(next.commits.length, 4);
  assert.equal(next.hasMore, true);
  assert.deepEqual(next.commits.slice(0, 2), first.commits);
  assert.deepEqual(final.commits.map((item) => item.hash), hashes.toReversed());
  assert.equal(final.hasMore, false);
  assert.equal(read(query({ limit: 8 })).hasMore, false);
}));

test('truncated command output does not claim the history is exhausted', () => {
  const page = graphHistoryPage([{ hash: 'first' }], 300, { truncated: true });
  assert.equal(page.commits.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
});
