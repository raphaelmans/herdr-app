import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync, spawnSync} from 'node:child_process';
import {snapshotCommandData, snapshotCommandContext} from './command-data.js';
import {hydrateCommandData} from './command-hydration.js';

const DATE = 1600000000;
async function fixture(fn, empty = false) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-command-data-'))), dir = join(temp, "repo ' $(echo literal) ü");
  mkdirSync(dir);
  const env = {...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_SYSTEM:'/dev/null', GIT_AUTHOR_NAME:'Raw User', GIT_AUTHOR_EMAIL:'raw@example.invalid',
    GIT_COMMITTER_NAME:'Raw User', GIT_COMMITTER_EMAIL:'raw@example.invalid', GIT_AUTHOR_DATE:'@1500000000 +0000', GIT_COMMITTER_DATE:`@${DATE} +0000`, GIT_EDITOR:'true'};
  const git = (args, extra = {}) => execFileSync('git', args, {cwd:dir, env:{...env, ...extra}, encoding:'utf8', stdio:'pipe'}).replace(/\n$/, '');
  const put = (path, text) => writeFileSync(join(dir, path), text);
  git(['init', '-q', '-b', 'main']); git(['config', 'commit.gpgsign', 'false']); git(['config', 'tag.gpgsign', 'false']);
  let base, head;
  if (!empty) {
    put('f', 'base\n'); git(['add', 'f']); git(['commit', '-qm', 'Base subject']); base = git(['rev-parse', 'HEAD']);
    git(['remote', 'add', 'origin', 'raw:repo']); git(['config', 'url.https://rewritten.invalid/.insteadOf', 'raw:']);
    git(['update-ref', 'refs/remotes/origin/main', base]); git(['config', 'branch.main.remote', 'origin']); git(['config', 'branch.main.merge', 'refs/heads/main']);
    git(['checkout', '-qb', 'feature']); put('f', 'feature\n'); git(['commit', '-qam', 'Feature subject']); head = git(['rev-parse', 'HEAD']);
    git(['config', 'branch.feature.remote', 'origin']); git(['config', 'branch.feature.merge', 'refs/heads/feature']); git(['update-ref', 'refs/remotes/origin/feature', base]);
  }
  const calls = [];
  const exec = async (command, args, context) => {
    calls.push({command, args, context}); assert.equal(context.cwd, dir); assert.equal(context.on, 'fixture-machine'); assert.equal(context.timeout, 15000);
    const result = spawnSync(command, args, {cwd:context.cwd, env, encoding:'utf8', maxBuffer:2 * 1024 * 1024});
    if (result.error) throw result.error;
    return {code:result.status, stdout:result.stdout, stderr:result.stderr};
  };
  const view = (extra = {}) => ({root:dir, panel:'commits', main:false, fileView:'files', branchView:'local', commitView:'commits',
    sel:{files:0, branches:0, commits:0, stash:0}, contexts:{}, filters:{}, rangeAnchors:{}, viewSelections:{},
    branchSort:'date', lazygitConfig:{git:{mainBranches:['main']}}, commits:head ? [{hash:head, subject:'Feature subject', who:'Raw User'}] : [],
    branches:head ? [{name:'feature', hash:head, current:true, track:'ahead 1'}, {name:'main', hash:base, current:false, track:''}] : [],
    reflog:[], nodes:[], remotes:[], remoteBranches:[], tags:[], stashes:[], submodules:[], worktrees:[],
    hasHead:Boolean(head), head, branch:{name:head ? 'feature' : 'main'}, ...extra});
  const hydrate = (data, extra = {}) => hydrateCommandData(data, {exec, context:{cwd:dir, on:'fixture-machine'}, current:()=>true, now:DATE + 3661, ...extra});
  try { await fn({temp, dir, git, put, env, base, head, exec, calls, view, hydrate}); }
  finally { rmSync(temp, {recursive:true, force:true}); }
}

test('normal and reflog metadata use their different source names, timestamps and author fields', () => fixture(async ({dir, git, put, base, head, view, hydrate}) => {
  put('.mailmap', 'Canonical Person <canonical@example.invalid> Raw User <raw@example.invalid>\n');
  git(['tag', '-a', 'v1', '-m', 'First physical line\nSecond physical line\n\nBody', head]);
  const data = snapshotCommandData(view({reflog:[{hash:base, subject:'checkout: moving from main to feature'}], tags:[{name:'v1', subject:'First physical line Second physical line'}]}));
  const before = git(['status', '--porcelain=v1', '-z']);
  assert.equal(await hydrate(data), data);
  assert.equal(data.SelectedCommit.AuthorName, 'Canonical Person'); assert.equal(data.SelectedCommit.AuthorEmail, 'raw@example.invalid');
  assert.equal(data.SelectedCommit.UnixTimestamp, 1500000000); assert.deepEqual(data.SelectedCommit.Parents, [base]);
  assert.deepEqual(data.SelectedCommit.Tags, ['v1']); assert.match(data.SelectedCommit.ExtraInfo, /tag: v1/);
  assert.equal(data.SelectedCommit.Status, 1); assert.equal(data.SelectedCommit.Divergence, 0);
  assert.equal(data.SelectedReflogCommit.Name, 'checkout: moving from main to feature'); assert.equal(data.SelectedReflogCommit.UnixTimestamp, DATE);
  assert.equal(data.SelectedReflogCommit.AuthorName, ''); assert.equal(data.SelectedReflogCommit.AuthorEmail, ''); assert.deepEqual(data.SelectedReflogCommit.Tags, []);
  assert.equal(data.SelectedTag.Message, 'First physical line'); assert.equal(data.SelectedCommit, data.SelectedLocalCommit);
  assert.equal(git(['status', '--porcelain=v1', '-z']), before); assert.equal(git(['rev-parse', 'HEAD']), head);
}));

test('status classification verifies upstream and main-branch reachability and preserves known states', () => fixture(async ({git, base, head, view, hydrate}) => {
  git(['update-ref', 'refs/remotes/origin/feature', head]);
  const pushed = snapshotCommandData(view()); await hydrate(pushed); assert.equal(pushed.SelectedCommit.Status, 2);
  const merged = snapshotCommandData(view({commits:[{hash:base, subject:'Base subject'}]})); await hydrate(merged); assert.equal(merged.SelectedCommit.Status, 3);
  const known = snapshotCommandData(view({commits:[{hash:head, subject:'Feature subject', status:7}]})); await hydrate(known); assert.equal(known.SelectedCommit.Status, 7);
  const unknown = snapshotCommandData(view({lazygitConfig:{}})); await hydrate(unknown); assert.equal(Object.hasOwn(unknown.SelectedCommit, 'Status'), false);
  git(['config', '--unset', 'branch.feature.remote']); git(['config', '--unset', 'branch.feature.merge']);
  const noUpstream = snapshotCommandData(view()); await hydrate(noUpstream); assert.equal(noUpstream.SelectedCommit.Status, 2);
}));

test('branch shims hydrate triangular pull/push counts, raw remote URLs and submodule URL', () => fixture(async ({git, put, head, view, hydrate}) => {
  git(['remote', 'add', 'fork', 'ssh://fork.invalid/repo']); git(['update-ref', 'refs/remotes/fork/feature', head]);
  git(['config', 'remote.pushDefault', 'fork']); git(['config', 'push.default', 'current']);
  git(['config', '--add', 'remote.origin.url', 'ssh://second.invalid/repo']); git(['config', '--add', 'remote.origin.pushurl', 'ssh://push.invalid/one']); git(['config', '--add', 'remote.origin.pushurl', 'ssh://push.invalid/two']);
  put('.gitmodules', '[submodule "lib ü"]\n path = vendor/lib\n url = ../library.git\n');
  const data = snapshotCommandData(view({remotes:[{name:'origin', url:'https://rewritten.invalid/repo'}], submodules:[{name:'lib ü', path:'vendor/lib'}]}));
  await hydrate(data);
  assert.deepEqual(data.SelectedRemote.Urls, ['raw:repo', 'ssh://second.invalid/repo']); assert.deepEqual(data.SelectedRemote.PushUrls, ['ssh://push.invalid/one', 'ssh://push.invalid/two']);
  const branch = data.CheckedOutBranch; assert.equal(branch.UpstreamRemote, 'origin'); assert.equal(branch.UpstreamBranch, 'feature');
  assert.equal(branch.AheadForPull, '1'); assert.equal(branch.BehindForPull, '0'); assert.equal(branch.AheadForPush, '0'); assert.equal(branch.BehindForPush, '0');
  assert.equal(branch.Pushables, '1'); assert.equal(branch.Pullables, '0'); assert.equal(branch.Recency, '  *'); assert.equal(branch.Subject, 'Feature subject');
  assert.equal(data.SelectedSubmodule.Url, '../library.git');
  const noPush = snapshotCommandData(view({remotes:[{name:'fork', url:'ssh://fork.invalid/repo'}]})); await hydrate(noPush); assert.deepEqual(noPush.SelectedRemote.PushUrls, []);
}));

test('missing upstream differs from zero and branch date/checkout recency match upstream age', () => fixture(async ({git, base, head, view, hydrate}) => {
  const data = snapshotCommandData(view({sel:{files:0, branches:1, commits:0, stash:0}})); await hydrate(data);
  assert.equal(data.SelectedLocalBranch.Recency, '1h'); assert.equal(data.SelectedLocalBranch.AheadForPull, '0');
  git(['update-ref', '-d', 'refs/remotes/origin/feature']);
  const gone = snapshotCommandData(view()); await hydrate(gone); assert.equal(gone.CheckedOutBranch.UpstreamGone, true); assert.equal(gone.CheckedOutBranch.AheadForPull, '?');
  git(['config', '--unset', 'branch.feature.remote']); git(['config', '--unset', 'branch.feature.merge']);
  const missing = snapshotCommandData(view()); await hydrate(missing); assert.equal(missing.CheckedOutBranch.UpstreamGone, false); assert.equal(missing.CheckedOutBranch.AheadForPull, '?');
  const recency = snapshotCommandData(view({branchSort:'recency', reflog:[{hash:head, subject:'checkout: moving from main to feature'}], sel:{files:0, branches:1, commits:0, stash:0}})); await hydrate(recency); assert.equal(recency.SelectedLocalBranch.Recency, '1h');
}));

test('stashes hydrate by captured hash after indices shift and private snapshot context is detached', () => fixture(async ({git, put, view, hydrate}) => {
  put('f', 'stash one\n'); git(['stash', 'push', '-qm', 'saved']); const hash = git(['rev-parse', 'stash@{0}']), subject = git(['show', '-s', '--format=%s', hash]);
  const live = view({stashes:[{ref:'stash@{0}', hash, subject}]}), data = snapshotCommandData(live);
  put('f', 'stash two\n'); git(['stash', 'push', '-qm', 'second'], {GIT_COMMITTER_DATE:`@${DATE + 3600} +0000`});
  live.stashes[0].hash = 'mutated'; live.lazygitConfig.git.mainBranches.push('mutated');
  const context = snapshotCommandContext(data); assert.equal(context.stashHash, hash); assert.deepEqual(context.mainBranches, ['main']);
  context.mainBranches.push('also-mutated'); assert.deepEqual(snapshotCommandContext(data).mainBranches, ['main']);
  assert.equal(Object.hasOwn(data, 'stashHash'), false);
  await hydrate(data); assert.equal(data.SelectedStashEntry.Name, subject); assert.equal(data.SelectedStashEntry.Recency, '1h');
}));

test('linked and missing worktrees use actual Git dirs, preserve special paths and mark worktree files', () => fixture(async ({dir, git, view, hydrate}) => {
  const linked = join(dir, "linked ' ü\n"); git(['worktree', 'add', '-q', '-b', 'linked', linked]);
  const live = view({worktrees:[{path:dir, branch:'feature'}, {path:linked, branch:'linked'}], fileView:'worktrees', sel:{files:1, branches:0, commits:0, stash:0}, nodes:[{file:{path:"linked ' ü\n", directory:true, x:'?', y:'?'}}]});
  const data = snapshotCommandData(live); await hydrate(data);
  assert.equal(data.SelectedWorktree.Path, linked); assert.equal(data.SelectedWorktree.IsMain, false); assert.equal(data.SelectedWorktree.IsCurrent, false); assert.equal(data.SelectedWorktree.IsPathMissing, false);
  assert.equal(data.SelectedWorktree.GitDir, git(['-C', linked, 'rev-parse', '--absolute-git-dir'])); assert.equal(data.SelectedFile.IsWorktree, true);
  const main = snapshotCommandData(view({worktrees:[{path:dir, branch:'feature'}]})); await hydrate(main); assert.equal(main.SelectedWorktree.IsMain, true); assert.equal(main.SelectedWorktree.IsCurrent, true);
  rmSync(linked, {recursive:true, force:true});
  const missing = snapshotCommandData(live); await hydrate(missing); assert.equal(missing.SelectedWorktree.IsPathMissing, true); assert.equal(missing.SelectedWorktree.GitDir, '');
}));

test('pending rebase rows retain their actions, resolve abbreviated hashes and leave exec rows executable as metadata only', () => fixture(async ({head, base, view, hydrate, calls}) => {
  const data = snapshotCommandData(view({commits:[{hash:head.slice(0,7), subject:'todo subject', todo:{action:'fixup'}}], operation:'rebase'}));
  await hydrate(data); assert.equal(data.SelectedCommit.Hash, head); assert.equal(data.SelectedCommit.Action, 'fixup'); assert.equal(data.SelectedCommit.Status, 4); assert.equal(data.SelectedCommit.Name, 'Feature subject');
  assert.deepEqual(data.SelectedCommitRange, {From:head, To:head});
  const execRow = snapshotCommandData(view({commits:[{hash:'', subject:'touch SHOULD_NOT_RUN', todo:{action:'exec'}}], branches:[], branch:null, hasHead:false, head:null, operation:'rebase'}));
  calls.length = 0; await hydrate(execRow); assert.equal(execRow.SelectedCommit.Name, 'touch SHOULD_NOT_RUN'); assert.equal(execRow.SelectedCommit.Hash, ''); assert.equal(execRow.SelectedCommit.UnixTimestamp, 0); assert.equal(calls.length, 0);
}));

test('real paused rebase supplies the selected worktree branch from head-name', () => fixture(async ({dir, git, put, view, hydrate}) => {
  put('f', 'another\n'); git(['commit', '-qam', 'Another subject']);
  git(['rebase', '-i', 'HEAD~2'], {GIT_SEQUENCE_EDITOR:"sed -i.bak '1s/^pick/edit/'"});
  const head = git(['rev-parse', 'HEAD']), raw = readFileSync(join(dir, '.git', 'rebase-merge', 'head-name'), 'utf8');
  const data = snapshotCommandData(view({head, commits:[{hash:head, subject:'Feature subject'}], operation:'rebase', worktrees:[{path:dir, branch:''}]}));
  await hydrate(data); assert.equal(data.SelectedWorktree.Branch, raw.replace(/^refs\/heads\//, '')); assert.equal(data.SelectedWorktree.IsCurrent, true);
  git(['rebase', '--abort']);
}));

test('unborn and detached branches retain their distinct upstream model fields', async () => {
  await fixture(async ({view, hydrate}) => {
    const data = snapshotCommandData(view()); await hydrate(data); assert.equal(data.CheckedOutBranch.Name, 'main'); assert.equal(data.CheckedOutBranch.DisplayName, 'main'); assert.equal(data.CheckedOutBranch.CommitHash, ''); assert.equal(data.CheckedOutBranch.AheadForPull, '');
  }, true);
  await fixture(async ({git, head, view, hydrate}) => {
    git(['checkout', '--detach', '-q', head]);
    const data = snapshotCommandData(view({branches:[], branch:{name:'HEAD'}})); await hydrate(data);
    assert.equal(data.CheckedOutBranch.Name, head); assert.equal(data.CheckedOutBranch.CommitHash, ''); assert.equal(data.CheckedOutBranch.DetachedHead, true); assert.match(data.CheckedOutBranch.DisplayName, /HEAD detached/); assert.equal(data.CheckedOutBranch.Subject, 'Feature subject');
  });
});

test('absent optional metadata does not block an unrelated file command', () => fixture(async ({dir, temp, git, view, hydrate}) => {
  const unavailable = join(temp, 'folder without git'); mkdirSync(unavailable);
  const data = snapshotCommandData(view({nodes:[{file:{path:'f', x:' ', y:'M'}}],
    submodules:[{name:'removed', path:'vendor/removed'}], tags:[{name:'deleted-tag'}], worktrees:[{path:unavailable, branch:''}]}));
  await hydrate(data);
  assert.equal(data.SelectedFile.Name, 'f'); assert.equal(data.SelectedSubmodule.Url, '');
  assert.equal(Object.hasOwn(data.SelectedTag, 'Message'), false);
  assert.equal(data.SelectedWorktree.IsPathMissing, false); assert.equal(data.SelectedWorktree.GitDir, ''); assert.equal(data.SelectedWorktree.IsCurrent, false);
}));

test('cancelled or failed reads never partially mutate the snapshot or prompt answers', () => fixture(async ({exec, view, hydrate, calls}) => {
  const data = snapshotCommandData(view()), before = JSON.stringify(data); let current = true;
  const cancelled = await hydrate(data, {current:()=>current, exec:async (...args) => { const result = await exec(...args); current = false; return result; }});
  assert.equal(cancelled, null); assert.equal(JSON.stringify(data), before);
  current = true; calls.length = 0;
  assert.equal(await hydrate(data, {current:()=>false}), null); assert.equal(calls.length, 0);
  await assert.rejects(hydrate(data, {exec:async (command, args, context) => args.includes('for-each-ref') ? {code:2, stdout:'', stderr:'fixture failed'} : exec(command,args,context)}), /fixture failed/);
  assert.equal(JSON.stringify(data), before);
  await hydrate(data, {exec:async (...args) => { data.Form.answer = 'kept'; data.PromptResponses.push('kept'); return exec(...args); }});
  assert.equal(data.Form.answer, 'kept'); assert.ok(data.PromptResponses.length > 0);
}));

test('oversized metadata fails before fields are exposed', () => fixture(async ({put, git, head, view, hydrate}) => {
  put('huge-message', 'x'.repeat(270000)); git(['commit', '--allow-empty', '-q', '-F', 'huge-message']); const huge = git(['rev-parse', 'HEAD']);
  const data = snapshotCommandData(view({commits:[{hash:huge}], branches:[], branch:null, hasHead:false, head:null})), before = JSON.stringify(data);
  await assert.rejects(hydrate(data), /read limit/); assert.equal(JSON.stringify(data), before);
}));
