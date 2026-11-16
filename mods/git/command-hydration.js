import {snapshotCommandContext} from './command-data.js';

// Values are argv arguments, never shell source. Selected metadata is capped
// before reaching JavaScript. All repository operations are reads.
const READ = ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'log.showSignature=false', '--no-pager'];
const CAPTURE = String.raw`limit=$1; shift
umask 077
tmp=$TMPDIR; [ -n "$tmp" ] || tmp=/tmp
d=$(mktemp -d "$tmp/herdr-git-data.XXXXXX") || exit 1
trap 'rm -rf -- "$d"' 0
"$@" > "$d/out" 2> "$d/err"; code=$?
if [ "$(wc -c < "$d/out")" -gt "$limit" ]; then
  printf '%s\n' 'Custom-command metadata exceeds the read limit' >&2; exit 125
fi
cat "$d/out"; head -c 4096 "$d/err" >&2; exit "$code"`;
const PATH_INFO = String.raw`if [ ! -e "$1" ]; then
  p=$1
  while [ ! -e "$p" ]; do parent=$(dirname "$p"); if [ "$parent" = "$p" ] || [ -z "$parent" ]; then p=/; break; fi; p=$parent; done
  if [ -d "$p" ] && [ ! -x "$p" ]; then printf '%s\n' 'Cannot inspect worktree path permissions' >&2; exit 13; fi
  printf 'missing\000'; exit 0
fi
printf 'present\000'; git --no-optional-locks -C "$1" rev-parse --absolute-git-dir`;
const WORKTREE_BRANCH = String.raw`for name in rebase-merge/head-name rebase-apply/head-name BISECT_START; do
  if [ -f "$1/$name" ]; then printf '%s\000' "$name"; head -c 8193 "$1/$name"; exit; fi
done`;
const stripNewline = value => value.endsWith('\n') ? value.slice(0, -1) : value;
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
const copy = (value, memo = new Map()) => {
  if (!value || typeof value !== 'object') return value;
  if (memo.has(value)) return memo.get(value);
  const out = Array.isArray(value) ? [] : {}; memo.set(value, out);
  for (const [key, item] of Object.entries(value)) out[key] = copy(item, memo);
  return out;
};
const age = (timestamp, now) => {
  const periods = [[1, 's'], [60, 'm'], [3600, 'h'], [86400, 'd'], [604800, 'w'], [2628000, 'M'], [31536000, 'y']];
  const seconds = now - timestamp;
  for (let n = 1; n < periods.length; n++) if (seconds < periods[n][0]) return `${Math.trunc(seconds / periods[n - 1][0])}${periods[n - 1][1]}`;
  return `${Math.trunc(seconds / periods.at(-1)[0])}${periods.at(-1)[1]}`;
};
const number = (value, label) => {
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid ${label} in Git metadata`);
  return Number(value);
};
const validHash = value => /^[0-9a-fA-F]{4,64}$/.test(value);
const fields = (value, count, label) => {
  const parts = value.split('\0');
  if (parts.length < count + 1) throw new Error(`Incomplete ${label} in Git metadata`);
  return parts.slice(0, count);
};

/** Return the same detached data on success, null when cancelled. All metadata
 * changes are staged until reads succeed and current() is still true. `now`
 * accepts an optional Unix-seconds clock for deterministic tests. */
export async function hydrateCommandData(data, {exec, context, current = () => true, now = () => Math.floor(Date.now() / 1000), branchSort} = {}) {
  if (typeof exec !== 'function' || !context?.cwd) throw new TypeError('Metadata hydration needs exec and a captured repository context');
  if (!current()) return null;
  const draft = copy(data), captured = snapshotCommandContext(data), repo = {cwd:context.cwd, on:context.on, timeout:15000};
  const timestamp = typeof now === 'function' ? now() : now, cancelled = {}, requests = new Map();
  const active = () => { if (!current()) throw cancelled; };
  const run = (program, args, allowed = [0], cwd = repo.cwd, limit = 262144) => {
    active(); const key = JSON.stringify([program, args, cwd, limit]);
    if (!requests.has(key)) requests.set(key, (async () => {
      const result = await exec('sh', ['-c', CAPTURE, 'sh', String(limit), program, ...args], {...repo, cwd});
      active(); return result;
    })());
    return requests.get(key).then(result => {
      active();
      if (!allowed.includes(result.code)) throw new Error(`Cannot read custom-command metadata: ${trim(result.stderr || result.stdout) || `command exited ${result.code}`}`);
      return result;
    });
  };
  const git = (args, allowed, cwd, limit) => run('git', [...READ, ...args], allowed, cwd, limit);
  const config = async key => {
    const result = await git(['config', '--local', '-z', '--get-all', key], [0, 1]);
    return result.code ? [] : result.stdout.split('\0').slice(0, -1);
  };
  const resolve = async ref => {
    if (!ref) return null;
    const result = await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], [0, 1]);
    return result.code ? null : stripNewline(result.stdout);
  };
  const ancestor = async (hash, ref) => (await git(['merge-base', '--is-ancestor', hash, ref], [0, 1])).code === 0;
  let mainRefs;
  const readMainRefs = () => mainRefs ??= (async () => {
    if (!Array.isArray(captured.mainBranches)) return null;
    return (await Promise.all(captured.mainBranches.map(async name =>
      await resolve(`${name}@{u}`) ?? await resolve(`refs/remotes/origin/${name}`) ?? await resolve(`refs/heads/${name}`)))).filter(Boolean);
  })();
  const commitStatus = async (commit, source) => {
    if (commit.Status !== undefined || !source?.valid || !validHash(commit.Hash)) return;
    const bases = await readMainRefs(); if (bases === null) return;
    const ref = await resolve(source.ref); if (!ref) return;
    const reachable = await ancestor(commit.Hash, ref);
    const merged = bases.length ? (await Promise.all(bases.map(base => ancestor(commit.Hash, base)))).some(Boolean) || !reachable : false;
    if (merged) { commit.Status = 3; return; }
    const upstream = await resolve(source.pushedRef ? `${source.pushedRef}@{u}` : null);
    // Upstream getReachableHashes returns an empty set for a missing upstream.
    commit.Status = upstream && reachable && !await ancestor(commit.Hash, upstream) ? 1 : 2;
  };
  const readCommit = async (commit, reflog, source) => {
    if (!commit) return;
    if (!commit.Hash) {
      if ([4, 5, 6].includes(commit.Status)) Object.assign(commit, {AuthorName:'', AuthorEmail:'', UnixTimestamp:0, Parents:[], Tags:[], ExtraInfo:'', Divergence:0});
      return;
    }
    if (!validHash(commit.Hash)) throw new Error('The selected commit does not have a valid Git object ID');
    const raw = (await git(['show', '-s', '--no-show-signature', '--no-notes', '--decorate=short',
      '--format=%H%x00%s%x00%aN%x00%ae%x00%at%x00%ct%x00%P%x00%D%x00', commit.Hash, '--'])).stdout;
    const [hash, name, author, email, authorTime, commitTime, parentText, decorations] = fields(raw, 8, 'commit'), oldHash = commit.Hash;
    Object.assign(commit, {Hash:hash, Sha:hash, Parents:parentText ? parentText.split(' ') : [], UnixTimestamp:number(reflog ? commitTime : authorTime, 'commit timestamp')});
    if (!reflog) {
      const extra = trim(decorations);
      Object.assign(commit, {Name:name, AuthorName:author, AuthorEmail:email, Tags:extra.split(',').map(trim).filter(value => value.startsWith('tag: ')).map(value => value.slice(5)), ExtraInfo:extra ? `(${extra})` : ''});
      if (captured.hasDivergence === false) commit.Divergence ??= 0;
      await commitStatus(commit, source);
    }
    if (draft.SelectedCommitRange) for (const key of ['From', 'To']) if (draft.SelectedCommitRange[key] === oldHash) draft.SelectedCommitRange[key] = hash;
  };
  const sort = branchSort ?? captured.branchSort;
  const branchRecency = async name => {
    if (!Array.isArray(captured.reflog)) return undefined;
    // Use the same already-loaded reflog snapshot as BranchLoader. No later
    // checkout or arbitrary history cap can change an invocation's recency.
    const equal = new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'iu');
    for (const row of captured.reflog) {
      const match = /checkout: moving from (\S+) to (\S+)/.exec(row.subject ?? '');
      if (!match || !match.slice(1).some(value => equal.test(value))) continue;
      if (Number.isSafeInteger(row.committerTimestamp)) return age(row.committerTimestamp, timestamp);
      if (!validHash(row.hash)) return undefined;
      return age(number(stripNewline((await git(['show', '-s', '--format=%ct', row.hash, '--'])).stdout), 'reflog timestamp'), timestamp);
    }
    return '';
  };
  const tracking = (upstream, track) => !upstream || track === '[gone]' ? ['?', '?'] : [/ahead (\d+)/.exec(track)?.[1] ?? '0', /behind (\d+)/.exec(track)?.[1] ?? '0'];
  const readBranch = async branch => {
    if (!branch?.Name) return;
    if (branch.DetachedHead) {
      if (validHash(branch.Name)) branch.Subject ??= stripNewline((await git(['show', '-s', '--format=%s', branch.Name, '--'])).stdout);
      const result = await git(['branch', '--points-at=HEAD', '--format=%(HEAD)%00%(objectname)%00%(refname)%00%(contents:subject)%00']);
      const records = result.stdout.split('\0');
      for (let at = 0; at + 3 < records.length; at += 4) if (records[at].replace(/^\n/, '') === '*' && records[at + 1] === branch.Name) branch.DisplayName ??= records[at + 2];
      Object.assign(branch, {Recency:branch.Head ? '  *' : branch.Recency ?? '', CommitHash:''});
      for (const key of ['AheadForPull', 'BehindForPull', 'AheadForPush', 'BehindForPush', 'UpstreamRemote', 'UpstreamBranch']) branch[key] ??= '';
      branch.UpstreamGone ??= false; branch.Pushables = branch.AheadForPull; branch.Pullables = branch.BehindForPull;
      return;
    }
    const ref = `refs/heads/${branch.Name}`;
    const [raw, remote, merge] = await Promise.all([
      git(['for-each-ref', '--count=1', '--format=%(refname)%00%(upstream)%00%(upstream:track)%00%(push:track)%00%(subject)%00%(objectname)%00%(committerdate:unix)%00', ref]),
      config(`branch.${branch.Name}.remote`), config(`branch.${branch.Name}.merge`),
    ]);
    branch.UpstreamRemote ??= remote.at(-1) ?? ''; branch.UpstreamBranch ??= (merge.at(-1) ?? '').replace(/^refs\/heads\//, '');
    if (!raw.stdout) {
      if (branch.Head && !branch.CommitHash) {
        branch.DisplayName = branch.Name; branch.Subject ??= ''; branch.Recency = '  *'; branch.CommitHash = '';
        for (const key of ['AheadForPull', 'BehindForPull', 'AheadForPush', 'BehindForPush']) branch[key] ??= '';
        branch.UpstreamGone ??= false;
      }
    } else {
      const [actualRef, upstream, pull, push, subject, hash, time] = fields(raw.stdout, 7, 'branch');
      if (actualRef !== ref) return;
      const [ahead, behind] = tracking(upstream, pull), [pushAhead, pushBehind] = tracking(upstream, push);
      Object.assign(branch, {AheadForPull:ahead, BehindForPull:behind, AheadForPush:pushAhead, BehindForPush:pushBehind, UpstreamGone:pull === '[gone]'});
      branch.CommitHash ??= hash;
      // Never silently follow a ref that moved since the invocation snapshot.
      branch.Subject ??= branch.CommitHash === hash ? subject : stripNewline((await git(['show', '-s', '--format=%s', branch.CommitHash, '--'])).stdout);
      if (branch.Head) branch.Recency = '  *';
      else if (sort === 'date' || sort === 'alphabetical') branch.Recency ??= age(number(time, 'branch timestamp'), timestamp);
      else if (sort === 'recency') { const recency = await branchRecency(branch.Name); if (recency !== undefined) branch.Recency ??= recency; }
    }
    if (branch.AheadForPull !== undefined) branch.Pushables = branch.AheadForPull;
    if (branch.BehindForPull !== undefined) branch.Pullables = branch.BehindForPull;
  };
  const readRemote = async remote => {
    if (!remote?.Name) return;
    const [urls, pushUrls] = await Promise.all([config(`remote.${remote.Name}.url`), config(`remote.${remote.Name}.pushurl`)]);
    // These are raw local values, without get-url's rewrites or push fallback.
    remote.Urls = urls.map(trim); remote.PushUrls = pushUrls.map(trim);
  };
  const readSubmodule = async module => {
    if (!module?.Name || module.Url !== undefined) return;
    const result = await git(['config', '-z', '--file', '.gitmodules', '--get', `submodule.${module.Name}.url`], [0, 1]);
    module.Url = result.code ? '' : result.stdout.slice(0, -1);
  };
  const readTag = async tag => {
    if (!tag?.Name || tag.Message !== undefined) return;
    const raw = (await git(['tag', '--list', '-n1', '--', tag.Name])).stdout;
    const line = raw.split('\n').find(line => line.startsWith(tag.Name) && (line.length === tag.Name.length || /\s/.test(line[tag.Name.length])));
    if (line !== undefined) tag.Message = line.slice(tag.Name.length).replace(/^\s+/, '');
  };
  const readStash = async stash => {
    if (!stash || stash.Recency !== undefined) return;
    const ref = captured.stashHash ?? (Number.isSafeInteger(stash.Index) && stash.Index >= 0 ? `stash@{${stash.Index}}` : null);
    if (!ref) return;
    const raw = (await git(['show', '-s', '--format=%ct%x00%s%x00', ref, '--'])).stdout;
    const [time, subject] = fields(raw, 2, 'stash');
    if (!captured.stashHash && subject !== stash.Name) throw new Error('The selected stash changed before its metadata was read');
    stash.Recency = age(number(time, 'stash timestamp'), timestamp);
  };
  const readWorktree = async worktree => {
    if (!worktree?.Path) return;
    const [probe, currentDir, commonDir, topLevel] = await Promise.all([
      // A registered worktree can still exist after its .git file disappears.
      // Upstream keeps it with an empty GitDir and derives flags from its path.
      run('sh', ['-c', PATH_INFO, 'sh', worktree.Path], [0, 128]),
      git(['rev-parse', '--path-format=absolute', '--git-dir']), git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(['rev-parse', '--show-toplevel'], [0, 128]),
    ]);
    const cut = probe.stdout.indexOf('\0'), exists = probe.stdout.slice(0, cut) === 'present', gitDir = exists ? stripNewline(probe.stdout.slice(cut + 1)) : '';
    const currentGitDir = stripNewline(currentDir.stdout), commonGitDir = stripNewline(commonDir.stdout), root = topLevel.code ? '' : stripNewline(topLevel.stdout);
    Object.assign(worktree, {GitDir:gitDir, IsPathMissing:!exists,
      IsCurrent:gitDir ? gitDir === currentGitDir : worktree.Path === root,
      IsMain:gitDir ? gitDir === commonGitDir : worktree.Path === (currentGitDir === commonGitDir ? root : commonGitDir.slice(0, commonGitDir.lastIndexOf('/')))});
    if (!worktree.Branch && gitDir) {
      const branchResult = await run('sh', ['-c', WORKTREE_BRANCH, 'sh', gitDir], [0, 1], repo.cwd, 8192);
      const branch = branchResult.code ? '' : branchResult.stdout;
      if (branch) {
        const split = branch.indexOf('\0'), kind = branch.slice(0, split), value = branch.slice(split + 1);
        // Upstream rebasedBranch preserves head-name bytes; bisect trims them.
        worktree.Branch = kind === 'BISECT_START' ? trim(value) : value.replace(/^refs\/heads\//, '');
      }
    }
  };
  const readFileWorktree = async file => {
    if (!file || file.IsWorktree !== undefined || !file.Name) return;
    const raw = (await git(['worktree', 'list', '--porcelain', '-z'])).stdout;
    const root = captured.root ?? stripNewline((await git(['rev-parse', '--show-toplevel'])).stdout);
    file.IsWorktree = raw.split('\0').some(part => part === 'worktree ' + root.replace(/\/$/, '') + '/' + file.Name);
  };
  try {
    const commitEntries = new Map();
    for (const name of ['SelectedLocalCommit', 'SelectedSubCommit', 'SelectedReflogCommit', 'SelectedCommit']) {
      const commit = draft[name];
      if (commit && !commitEntries.has(commit)) commitEntries.set(commit, {reflog:commit === draft.SelectedReflogCommit, source:captured.commitSources?.[name]});
    }
    const tasks = [
      ...[...commitEntries].map(([commit, info]) => () => readCommit(commit, info.reflog, info.source)),
      ...[...new Set([draft.SelectedLocalBranch, draft.CheckedOutBranch].filter(Boolean))].map(branch => () => readBranch(branch)),
      () => readRemote(draft.SelectedRemote), () => readSubmodule(draft.SelectedSubmodule), () => readTag(draft.SelectedTag),
      () => readStash(draft.SelectedStashEntry), () => readWorktree(draft.SelectedWorktree), () => readFileWorktree(draft.SelectedFile),
    ];
    const results = await Promise.allSettled(tasks.map(task => task()));
    if (!current() || results.some(result => result.status === 'rejected' && result.reason === cancelled)) return null;
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
    // Prompt answers are not metadata and may have changed during an await.
    const applied = new Set();
    for (const [key, value] of Object.entries(draft)) {
      if (key === 'Form' || key === 'PromptResponses' || !value || typeof value !== 'object' || applied.has(data[key])) continue;
      if (data[key] && typeof data[key] === 'object') { Object.assign(data[key], value); applied.add(data[key]); }
    }
    return data;
  } catch (error) {
    if (error === cancelled || !current()) return null;
    throw error;
  }
}
