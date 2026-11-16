// Custom-command shims follow Lazygit's services/custom_commands/models.go and
// session_state_loader.go at 54cc6af. Missing metadata is deliberately omitted:
// a caller can hydrate this detached snapshot before displaying any prompts.
import {validateTemplate} from './templates.js';

const snapshotContexts = new WeakMap();
const copy = value => Array.isArray(value) ? value.map(copy) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v !== 'function').map(([k, v]) => [k, copy(v)])) : value;
const pick = (value, fields) => {
  if (!value) return null;
  const result = {};
  for (const [target, source] of Object.entries(fields)) {
    if (Object.hasOwn(value, target)) result[target] = copy(value[target]);
    else if (source && Object.hasOwn(value, source)) result[target] = copy(value[source]);
  }
  return result;
};
const selected = (rows, index) => rows[Math.max(0, Math.min(index ?? 0, rows.length - 1))] ?? null;
const filtered = (rows, term = '', pathOnly = false) => {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  return !words.length ? rows : rows.filter(row => words.every(word => (pathOnly ? row.path ?? ''
    : [row.name, row.path, row.hash, row.subject, row.who, row.url].join('\n')).toLowerCase().includes(word)));
};

function baseKey(view, panel) {
  if (panel === 'files') return view.fileView ?? 'files';
  if (panel === 'branches') return view.remoteContext ? `remote branches:${view.remoteContext.name}` : view.branchView ?? 'local';
  if (panel === 'commits') return view.commitView ?? 'commits';
  return panel;
}

// Use the view's pure list readers so its sort, search and pending rebase rows
// remain authoritative. Own overrides avoid changing even a frozen input view.
function baseRows(view, panel, key) {
  const proxy = Object.create(view), overrides = {panel, contexts:{...view.contexts, [panel]:[]}};
  if (panel === 'files') overrides.fileView = key;
  if (panel === 'branches') Object.assign(overrides, {branchView:key.startsWith('remote branches:') ? 'remotes' : key,
    remoteContext:key.startsWith('remote branches:') ? {name:key.slice(16)} : null});
  if (panel === 'commits') overrides.commitView = key;
  for (const [name, value] of Object.entries(overrides)) Object.defineProperty(proxy, name, {value, configurable:true});
  const method = {files:'fileItems', branches:'branchItems', commits:'commitItems', stash:'stashItems'}[panel];
  if (typeof proxy[method] === 'function') return proxy[method]() ?? [];
  if (key === 'files') return view.nodes ?? (view.files ?? []).map(file => ({file}));
  let rows = ({local:view.branches, remotes:view.remotes, tags:view.tags, commits:view.commits, reflog:view.reflog,
    stash:view.stashes, worktrees:view.worktrees, submodules:view.submodules})[key] ?? [];
  if (key.startsWith('remote branches:')) rows = (view.remoteBranches ?? []).filter(row => remoteParts(view, row).RemoteName === key.slice(16));
  return filtered(rows, view.filters?.[key] ?? '');
}

function baseSelection(view, panel, key) {
  const rows = baseRows(view, panel, key);
  const index = baseKey(view, panel) === key ? view.contexts?.[panel]?.[0]?.parentSelection ?? view.sel?.[panel] ?? 0 : view.viewSelections?.[key] ?? 0;
  return {rows, index, item:selected(rows, index), key};
}

function contextSelections(view) {
  const result = [];
  for (const [panel, stack] of Object.entries(view.contexts ?? {})) for (let at = 0; at < stack.length; at++) {
    const frame = stack[at], rows = frame.type === 'files' ? filtered(frame.items ?? [], view.filters?.[frame.key] ?? '', true) : frame.items ?? [];
    const index = stack[at + 1]?.parentSelection ?? view.sel?.[panel] ?? 0;
    result.push({frame, panel, rows, index, item:selected(rows, index), key:frame.key,
      sequence:Number(frame.key?.split(':').at(-1)) || 0});
  }
  return result.sort((a, b) => a.sequence - b.sequence);
}

function commitShim(commit, kind) {
  if (!commit || (!(commit.Hash ?? commit.hash) && !commit.todo) || (commit.Hash ?? commit.hash) === '*') return null;
  const result = pick(commit, {Hash:'hash', Name:'subject', Status:'status', Action:null,
    Tags:'tags', ExtraInfo:'extraInfo', AuthorName:kind === 'reflog' ? null : 'who', AuthorEmail:'authorEmail',
    UnixTimestamp:kind === 'reflog' ? 'committerTimestamp' : 'authorTimestamp', Divergence:'divergence', Parents:'parents'});
  result.Hash ??= ''; result.Sha = result.Hash;
  if (kind === 'reflog') {
    // ReflogCommitLoader intentionally uses %gs as Name and %ct as time.
    // Its model does not load commit authors, decorations, or divergence.
    Object.assign(result, {Status:8, AuthorName:'', AuthorEmail:'', Tags:[], ExtraInfo:'', Divergence:0});
  }
  if (commit.todo) { result.Status = 4; result.Action = commit.todo.action; }
  if (result.Action === undefined && !commit.todo) result.Action = '';
  if (result.Tags === undefined && Array.isArray(commit.refs)) result.Tags = commit.refs.filter(ref => ref.kind === 'tag').map(ref => ref.name);
  return result;
}

function fileShim(node) {
  const file = node?.dir ? null : node?.file ?? node;
  if (!file) return null;
  const result = pick(file, {Name:'path', PreviousName:'previousPath', HasStagedChanges:'staged', HasUnstagedChanges:'unstaged',
    Tracked:null, Added:null, Deleted:null, HasMergeConflicts:'conflict', HasInlineMergeConflicts:'inlineConflict',
    DisplayString:'displayString', ShortStatus:null, IsWorktree:'isWorktree'});
  result.PreviousName ??= '';
  if (!file.directory) result.IsWorktree ??= false;
  if (typeof file.x === 'string' && typeof file.y === 'string') {
    const code = file.x + file.y, tracked = !['??', 'A ', 'AM'].includes(code);
    Object.assign(result, {ShortStatus:code, HasStagedChanges:![' ', 'U', '?'].includes(file.x), HasUnstagedChanges:file.y !== ' ',
      Tracked:tracked, Added:file.y === 'A' || !tracked, Deleted:file.y === 'D' || file.x === 'D',
      HasMergeConflicts:['UU', 'AA', 'DD', 'AU', 'UA', 'UD', 'DU'].includes(code), HasInlineMergeConflicts:['UU', 'AA'].includes(code)});
    result.DisplayString ??= `${code} ${file.path}${file.directory ? '/' : ''}`;
  }
  return result;
}

function branchShim(branch) {
  if (!branch) return null;
  const result = pick(branch, {Name:'name', DisplayName:'displayName', Recency:'recency', AheadForPull:'aheadForPull', BehindForPull:'behindForPull',
    AheadForPush:'aheadForPush', BehindForPush:'behindForPush', UpstreamGone:'upstreamGone', Head:'current', DetachedHead:'detached',
    UpstreamRemote:'upstreamRemote', UpstreamBranch:'upstreamBranch', Subject:'subject', CommitHash:'hash'});
  result.Head ??= false; result.DetachedHead ??= false;
  if (result.DetachedHead) { result.Name = branch.hash ?? result.Name; result.CommitHash = ''; }
  else result.DisplayName ??= '';
  if (typeof branch.track === 'string') {
    result.UpstreamGone ??= branch.track.includes('gone');
    // Empty track text cannot distinguish an up-to-date upstream from no
    // upstream. Those counts need %(upstream), not a fabricated zero.
    if (branch.track) {
      result.AheadForPull ??= result.UpstreamGone ? '?' : /ahead (\d+)/.exec(branch.track)?.[1] ?? '0';
      result.BehindForPull ??= result.UpstreamGone ? '?' : /behind (\d+)/.exec(branch.track)?.[1] ?? '0';
    }
  }
  if (result.AheadForPull !== undefined) result.Pushables = String(result.AheadForPull);
  if (result.BehindForPull !== undefined) result.Pullables = String(result.BehindForPull);
  return result;
}

function remoteParts(view, branch) {
  if (!branch) return null;
  if (Object.hasOwn(branch, 'RemoteName')) return {Name:branch.Name, RemoteName:branch.RemoteName};
  const name = branch.ref?.replace(/^refs\/remotes\//, '') ?? branch.name ?? '';
  const remote = branch.remoteName ?? (view.remotes ?? []).map(row => row.name).sort((a, b) => b.length - a.length).find(remote => name.startsWith(remote + '/')) ?? name.split('/')[0];
  return {Name:name.startsWith(remote + '/') ? name.slice(remote.length + 1) : name, RemoteName:remote};
}

function remoteShim(view, remote) {
  if (!remote) return null;
  const result = pick(remote, {Name:'name', Urls:'urls', PushUrls:'pushUrls', Branches:null});
  if (!result.Urls) {
    const urls = (view.remotes ?? []).filter(row => row.name === result.Name && typeof row.url === 'string').map(row => row.url);
    if (urls.length) result.Urls = [...new Set(urls)];
  }
  result.Branches ??= (view.remoteBranches ?? []).map(row => remoteParts(view, row)).filter(row => row.RemoteName === result.Name);
  return result;
}

function worktreeShim(view, worktree) {
  if (!worktree) return null;
  const result = pick(worktree, {IsMain:'isMain', IsCurrent:'isCurrent', Path:'path', IsPathMissing:'isPathMissing', GitDir:'gitDir', Branch:'branch', Name:null});
  // Upstream names worktrees by their shortest unambiguous path suffix.
  if (!Object.hasOwn(result, 'Name')) {
    const paths = (view.worktrees ?? [worktree]).map(row => (row.path ?? '').replace(/^\/+|\/+$/g, '').split('/'));
    const parts = (result.Path ?? '').replace(/^\/+|\/+$/g, '').split('/');
    let depth = 1;
    while (depth < parts.length && paths.some(other => other.join('/') !== parts.join('/') && other.slice(-depth).join('/') === parts.slice(-depth).join('/'))) depth++;
    result.Name = parts.slice(-depth).join('/');
  }
  result.Branch ??= ''; // detached worktrees have no porcelain branch field.
  return result;
}

function commitRange(selection, view) {
  if (!selection) return null;
  const anchor = view.rangeAnchors?.[selection.key], index = Math.max(0, Math.min(selection.index, selection.rows.length - 1));
  const rows = (anchor == null ? [selection.item] : selection.rows.slice(Math.max(0, Math.min(anchor, index)), Math.max(anchor, index) + 1))
    .filter(row => row && ((row.Hash ?? row.hash) || row.todo) && (row.Hash ?? row.hash) !== '*');
  return rows.length ? {From:rows.at(-1).Hash ?? rows.at(-1).hash ?? '', To:rows[0].Hash ?? rows[0].hash ?? ''} : null;
}

/** Detached mutable plain SessionState. Aliases intentionally share a captured
 * commit shim so hydration updates SelectedCommit and its deprecated alias.
 * No returned object or array references the live view. Prompt answers belong
 * to this invocation, never to the view or a prior command session. */
export function snapshotCommandData(view) {
  const files = baseSelection(view, 'files', 'files'), local = baseSelection(view, 'commits', 'commits');
  const reflog = baseSelection(view, 'commits', 'reflog'), frames = contextSelections(view);
  const active = frames.filter(entry => entry.panel === view.panel), top = active.at(-1);
  const last = (rows, type) => [...rows].reverse().find(entry => entry.frame.type === type);
  const sub = last(active, 'commits') ?? last(frames, 'commits');
  const commitFiles = last(active, 'files') ?? last(frames, 'files');
  const selections = {local, reflog, sub};
  const commits = {local:commitShim(local.item, 'local'), reflog:commitShim(reflog.item, 'reflog'), sub:commitShim(sub?.item, 'sub')};
  let kind = view.panel === 'commits' && view.commitView === 'reflog' ? 'reflog' : 'local';
  if (active.some(entry => entry.frame.type === 'commits')) kind = 'sub';
  if (top?.frame.type === 'files' && top.frame.parentCommit) {
    const parentKind = {commits:'local', localCommits:'local', reflog:'reflog', reflogCommits:'reflog', subCommits:'sub', main:'local'}[top.frame.parentCommitContext];
    if (parentKind) { kind = parentKind; commits[kind] = commitShim(top.frame.parentCommit, kind); }
  }
  let range = commitRange(selections[kind], view);
  if (top?.frame.type === 'files' && top.frame.parentCommit && commits[kind] && view.rangeAnchors?.[selections[kind]?.key] == null) {
    range = {From:commits[kind].Hash, To:commits[kind].Hash};
  }
  // The native graph has no upstream context. A real focused graph commit is
  // its command target; its synthetic uncommitted row is never a Git hash.
  const graphCommit = view.main ? view.graph?.rows?.[view.cursor]?.commit : null;
  if (graphCommit) {
    kind = 'local'; commits.local = commitShim(graphCommit, kind);
    range = commits.local ? {From:commits.local.Hash, To:commits.local.Hash} : null;
  } else if (top?.frame.parentCommit && commits[kind] && !range) range = {From:commits[kind].Hash, To:commits[kind].Hash};
  const localBranch = baseSelection(view, 'branches', 'local').item;
  const remote = view.remoteContext ? (view.remotes ?? []).find(row => row.name === view.remoteContext.name) : baseSelection(view, 'branches', 'remotes').item;
  const remoteBranch = remote ? baseSelection(view, 'branches', `remote branches:${remote.name}`).item : null;
  const stash = baseSelection(view, 'stash', 'stash').item;
  const checkedOut = (view.branches ?? []).find(row => row.current) ?? (view.hasHead && view.head ? {name:view.head, hash:view.head, current:true, detached:true}
    : view.branch?.name && view.branch.name !== '?' ? {name:view.branch.name, current:true} : null);
  const commitFile = commitFiles?.item?.dir ? null : commitFiles?.item?.file ?? commitFiles?.item;
  const commitPath = commitFiles?.item?.path ?? commitFile?.path ?? '';
  const filePath = files.item?.path ?? files.item?.file?.path ?? '';
  const stashShim = pick(stash, {Index:'index', Recency:'recency', Name:'subject'});
  if (stashShim && stashShim.Index === undefined) { const match = /^stash@\{(\d+)\}$/.exec(stash.ref ?? ''); if (match) stashShim.Index = Number(match[1]); }
  const data = {
    SelectedLocalCommit:commits.local, SelectedReflogCommit:commits.reflog, SelectedSubCommit:commits.sub,
    SelectedCommit:commits[kind], SelectedCommitRange:range, SelectedFile:fileShim(files.item),
    SelectedSubmodule:pick(baseSelection(view, 'files', 'submodules').item, {Name:'name', Path:'path', Url:'url'}),
    SelectedPath:top?.frame.type === 'files' && !view.main ? commitPath : filePath,
    SelectedLocalBranch:branchShim(localBranch), SelectedRemoteBranch:remoteParts(view, remoteBranch), SelectedRemote:remoteShim(view, remote),
    SelectedTag:pick(baseSelection(view, 'branches', 'tags').item, {Name:'name', Message:'message'}), SelectedStashEntry:stashShim,
    SelectedCommitFile:pick(commitFile, {Name:'path', ChangeStatus:'status'}), SelectedCommitFilePath:commitPath,
    SelectedWorktree:worktreeShim(view, baseSelection(view, 'files', 'worktrees').item), CheckedOutBranch:branchShim(checkedOut),
    PromptResponses:[], Form:{},
  };
  const shortRef = ref => ref?.replace(/^refs\/(?:heads|remotes|tags)\//, '');
  const localRef = view.head || (checkedOut?.detached ? checkedOut.hash : checkedOut?.name ? `refs/heads/${checkedOut.name}` : null);
  const localSource = {ref:localRef, pushedRef:checkedOut?.detached ? checkedOut.hash : checkedOut?.name,
    valid:!view.operation && Boolean(localRef)};
  const subSource = {ref:sub?.frame.ref, pushedRef:shortRef(sub?.frame.ref), valid:Boolean(sub?.frame.ref)};
  snapshotContexts.set(data, copy({branchSort:view.branchSort, mainBranches:view.lazygitConfig?.git?.mainBranches,
    stashHash:stash?.hash, root:view.root, worktrees:view.worktrees ?? [],
    reflog:Array.isArray(view.reflog) ? view.reflog.map(row => ({hash:row.hash, subject:row.subject, committerTimestamp:row.committerTimestamp})) : null,
    commitSources:{SelectedLocalCommit:localSource, SelectedSubCommit:subSource,
      SelectedCommit:kind === 'local' ? localSource : kind === 'sub' ? subSource : null},
    // This native log implementation does not request a left/right log.
    hasDivergence:false,
  }));
  return data;
}

// Internal hydration context stays outside the public Go-compatible template
// object. A copy prevents an async caller from changing later hydration reads.
export function snapshotCommandContext(data) { return copy(snapshotContexts.get(data) ?? {}); }

// RE2's supported syntax is wider than the safe native subset below. Reject
// unsupported constructs explicitly: never reinterpret a Perl-only expression
// as a different filter, and never execute user code while compiling it.
function menuRegex(pattern) {
  if (pattern.length > 4096) throw new Error('Menu filter exceeds 4096 characters');
  const fail = (message, at) => { throw new Error(`Unsupported menu filter at column ${at + 1}: ${message}`); };
  let at = 0, insensitive = false, dotAll = false, output = '', captures = 0;
  const names = [], groups = [{repeat:false, alternative:false}], atoms = [];
  while (pattern.startsWith('(?', at)) {
    const flags = /^\(\?([ims]+)(?:-([ims]+))?\)/.exec(pattern.slice(at));
    if (!flags) break;
    if (flags[1].includes('i')) insensitive = true;
    if (flags[1].includes('s')) dotAll = true;
    if (flags[2]?.includes('i')) insensitive = false;
    if (flags[2]?.includes('s')) dotAll = false;
    // Each subject is one LF-delimited line; m has no further effect.
    at += flags[0].length;
  }
  const literal = char => /[\\^$.*+?()[\]{}|/]/.test(char) ? '\\' + char : char;
  const escape = inClass => {
    const start = at++, char = pattern[at++];
    if (char === undefined) fail('trailing backslash', start);
    if (char === 'Q' && !inClass) {
      const end = pattern.indexOf('\\E', at), text = pattern.slice(at, end < 0 ? pattern.length : end);
      at = end < 0 ? pattern.length : end + 2; return [...text].map(literal).join('');
    }
    if (/[0-9]/.test(char)) fail('backreferences and octal escapes are unavailable', start);
    if (char === 'p' || char === 'P') fail('Unicode property classes are unavailable; use a literal character class', start);
    if (char === 's') return inClass ? '\\t\\n\\f\\r ' : '[\\t\\n\\f\\r ]';
    if (char === 'S') { if (inClass) fail('\\S inside a character class is unavailable', start); return '[^\\t\\n\\f\\r ]'; }
    if (char === 'A' && !inClass) return '^';
    if (char === 'z' && !inClass) return '(?![\\s\\S])';
    if (char === 'b' || char === 'B') {
      if (inClass || insensitive) fail('word boundaries with this class or case-insensitive flag are unavailable', start);
      return '\\' + char;
    }
    if (char === 'x') {
      const match = /^(?:\{([0-9a-fA-F]+)\}|([0-9a-fA-F]{2}))/.exec(pattern.slice(at));
      if (!match) fail('invalid hexadecimal escape', start);
      at += match[0].length;
      const value = parseInt(match[1] ?? match[2], 16);
      if (value > 0x10ffff || value >= 0xd800 && value <= 0xdfff) fail('invalid Unicode scalar', start);
      return `\\u{${value.toString(16)}}`;
    }
    if (char === 'a') return '\\x07';
    if ('dDwWfnrtv'.includes(char)) return '\\' + char;
    if (/[A-Za-z]/.test(char)) fail(`escape \\${char} is not supported by RE2`, start);
    return `\\u{${char.codePointAt(0).toString(16)}}`;
  };
  while (at < pattern.length) {
    const char = pattern[at], start = at;
    if (char === '\\') { output += escape(false); atoms.push({}); continue; }
    if (char === '[') {
      at++; let content = '', first = true, closed = false;
      if (pattern[at] === '^') { content += '^'; at++; }
      while (at < pattern.length) {
        if (pattern.startsWith('[:', at)) fail('POSIX character classes are unavailable; use an explicit range', at);
        if (pattern[at] === ']' && !first) { at++; closed = true; break; }
        if (pattern[at] === '\\') content += escape(true);
        else if (pattern[at] === ']' && first) { content += '\\]'; at++; }
        else content += pattern[at++];
        first = false;
      }
      if (!closed) fail('unclosed character class', start);
      output += '[' + content + ']'; atoms.push({}); continue;
    }
    if (char === '(') {
      let opener = '(';
      if (pattern.startsWith('(?:', at)) { opener = '(?:'; at += 3; }
      else if (pattern.startsWith('(?P<', at) || pattern.startsWith('(?<', at) && !['=', '!'].includes(pattern[at + 3])) {
        const offset = pattern.startsWith('(?P<', at) ? 4 : 3, end = pattern.indexOf('>', at + offset);
        const name = end < 0 ? '' : pattern.slice(at + offset, end);
        if (!/^[A-Za-z0-9_]+$/.test(name)) fail('invalid RE2 capture name', at);
        names.push({index:++captures, name}); at = end + 1;
      } else if (pattern.startsWith('(?', at)) fail('lookarounds, scoped flags and special groups are unavailable', at);
      else { captures++; at++; }
      output += opener; groups.push({repeat:false, alternative:false, atomStart:atoms.length}); continue;
    }
    if (char === ')') {
      if (groups.length === 1) fail('unmatched closing parenthesis', at);
      const group = groups.pop(); atoms.splice(group.atomStart); atoms.push(group);
      groups.at(-1).repeat ||= group.repeat; groups.at(-1).alternative ||= group.alternative;
      output += char; at++; continue;
    }
    if (char === '|') { groups.at(-1).alternative = true; output += char; at++; atoms.push({}); continue; }
    let quantifier = '*+?'.includes(char) ? char : char === '{' ? /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(at))?.[0] : null;
    if (quantifier) {
      const prior = atoms.at(-1);
      if (!prior || prior.quantified) fail('invalid repeated quantifier', at);
      if (prior.repeat || prior.alternative) fail('a repeated group containing repetition or alternatives needs a simpler filter', at);
      if (quantifier.startsWith('{')) {
        const bounds = quantifier.slice(1, -1).split(',').filter(Boolean).map(Number);
        if (bounds.some(n => n > 1000)) fail('RE2 repetition bounds must not exceed 1000', at);
      }
      output += quantifier; at += quantifier.length;
      if (pattern[at] === '?') { output += '?'; at++; }
      prior.quantified = true; groups.at(-1).repeat = true; continue;
    }
    if (char === '.') output += dotAll ? '[\\s\\S]' : '[^\\n]';
    else if (char === '$') output += '(?![\\s\\S])';
    else if (char === '{' || char === '}') output += '\\' + char;
    else output += char;
    atoms.push({}); at++;
  }
  if (groups.length !== 1) fail('unclosed group', pattern.length);
  let regex;
  try { regex = new RegExp(output, 'u' + (insensitive ? 'i' : '')); }
  catch (error) { throw new Error(`Invalid menu filter: ${error.message}`); }
  return {regex, captures, names};
}

const trimSpace = text => String(text).replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, '');
const menuColors = Object.fromEntries(['default', 'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'bold', 'underline'].map(name => [name, text => text]));

/** prompt.filter is already resolved against the command SessionState;
 * valueFormat/labelFormat remain raw capture-map templates. render receives
 * (format, captures, {kind, missingKey:'default', mapZeroValue:'', allowCommands:false}). Only labels admit color
 * helpers upstream; neither format admits quote or runCommand. */
export async function menuFromOutput(text, prompt = {}, render) {
  const filter = String(prompt.filter ?? ''), valueFormat = String(prompt.valueFormat ?? ''), labelFormat = String(prompt.labelFormat ?? '');
  const lines = String(text).split('\n').filter(line => line !== '');
  if (!filter && !valueFormat && !labelFormat) return lines.map(line => ({value:line, label:line}));
  const {regex, captures, names} = menuRegex(filter);
  if (typeof render !== 'function') throw new TypeError('Formatted menu output requires a template renderer');
  validateTemplate(valueFormat, {allowCommands:false});
  if (labelFormat) validateTemplate(labelFormat, {colors:menuColors, allowCommands:false});
  const result = [];
  for (const line of lines) {
    if (line.length > 16384) throw new Error('Formatted menu line exceeds the native filter limit of 16384 characters');
    const match = regex.exec(line), data = {};
    if (match) {
      for (let index = 0; index <= captures; index++) {
        const descriptor = {value:match[index] ?? '', enumerable:true, writable:true, configurable:true};
        Object.defineProperty(data, `group_${index}`, descriptor);
        const named = names.find(entry => entry.index === index);
        if (named) Object.defineProperty(data, named.name, descriptor);
      }
    }
    const options = {missingKey:'default', mapZeroValue:'', allowCommands:false};
    const value = trimSpace(await render(valueFormat, {...data}, {...options, kind:'value'}));
    const label = labelFormat ? trimSpace(await render(labelFormat, {...data}, {...options, kind:'label'})) : value;
    result.push({value, label});
  }
  return result;
}
