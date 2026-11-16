// Pure Lazygit configuration helpers. Source: jesseduffield/lazygit
// 54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451, app_config.go, user_config.go,
// keybinding.go, keynames.go, gui.go and vendored adrg/xdg.
// The caller supplies the target machine's environment, filesystem reads and
// canonical main-repository path. This module never reads files or runs commands.
import { parseDocument, isAlias, isMap, isSeq, isScalar } from './yaml.js';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const put = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, writable: true, configurable: true,
});

// Filled from the pinned UserConfig struct's YAML tags. Unknown fields retain
// their YAML core types; this is a sparse parser, not a full config validator or
// an implementation of every option/custom-command template.
const TYPES = {
  "UserConfig": {"gui": "GuiConfig","git": "GitConfig","worktree": "WorktreeConfig","update": "UpdateConfig","refresher": "RefresherConfig","confirmOnQuit": "bool","quitOnTopLevelReturn": "bool","os": "OSConfig","disableStartupPopups": "bool","customCommands": "[]CustomCommand","services": "map[string]string","notARepository": "string","promptToReturnFromSubprocess": "bool","keybinding": "KeybindingConfig"},
  "RefresherConfig": {"refreshInterval": "int","fetchInterval": "int","externalChangeCheckInterval": "int"},
  "GuiConfig": {"customIcons": "CustomIconsConfig","scrollHeight": "int","scrollPastBottom": "bool","scrollOffMargin": "int","scrollOffBehavior": "string","tabWidth": "int","mouseEvents": "bool","skipAmendWarning": "bool","skipDiscardChangeWarning": "bool","skipStashWarning": "bool","skipNoStagedFilesWarning": "bool","skipRewordInEditorWarning": "bool","skipSwitchWorktreeOnCheckoutWarning": "bool","sidePanelWidth": "float64","expandFocusedSidePanel": "bool","expandedSidePanelWeight": "int","shrinkSidePanelsToContent": "bool","sidePanels": "[]SidePanel","mainPanelSplitMode": "string","enlargedSideViewLocation": "string","wrapLinesInDiffView": "bool","useHunkModeInDiffView": "bool","language": "string","timeFormat": "string","shortTimeFormat": "string","colorScheme": "string","theme": "ThemeConfig","darkTheme": "ThemeConfig","lightTheme": "ThemeConfig","commitLength": "CommitLengthConfig","showListFooter": "bool","showFileTree": "bool","showRootItemInFileTree": "bool","fileTreeSortOrder": "string","fileTreeSortCaseSensitive": "bool","showNumstatInFilesView": "bool","showRandomTip": "bool","showCommandLog": "bool","showBottomLine": "bool","showPanelJumps": "bool","showIcons": "bool","nerdFontsVersion": "string","showFileIcons": "bool","commitGraphStyle": "string","commitAuthorShortLength": "int","commitAuthorLongLength": "int","commitHashLength": "int","showBranchCommitHash": "bool","showDivergenceFromBaseBranch": "string","commandLogSize": "int","splitDiff": "string","screenMode": "string","border": "string","animateExplosion": "bool","portraitMode": "string","portraitModeAutoMaxWidth": "int","portraitModeAutoMinHeight": "int","filterMode": "string","spinner": "SpinnerConfig","statusPanelView": "string","switchToFilesAfterStashPop": "bool","switchToFilesAfterStashApply": "bool","switchTabsWithPanelJumpKeys": "bool"},
  "ThemeConfig": {"activeBorderColor": "[]string","inactiveBorderColor": "[]string","searchingActiveBorderColor": "[]string","optionsTextColor": "[]string","selectedLineFgColor": "[]string","selectedLineBgColor": "[]string","inactiveViewSelectedLineBgColor": "[]string","cherryPickedCommitFgColor": "[]string","cherryPickedCommitBgColor": "[]string","markedBaseCommitFgColor": "[]string","markedBaseCommitBgColor": "[]string","unstagedChangesColor": "[]string","defaultFgColor": "[]string","authorColors": "map[string]string","branchColorPatterns": "ColorPatterns"},
  "CommitLengthConfig": {"show": "bool"},
  "SpinnerConfig": {"frames": "[]string","rate": "int"},
  "GitConfig": {"diffRenderers": "[]DiffRendererConfig","commit": "CommitConfig","merging": "MergingConfig","mainBranches": "[]string","skipHookPrefix": "string","autoFetch": "bool","autoRefresh": "bool","autoDetectExternalChanges": "bool","autoForwardBranches": "string","fetchAll": "bool","autoStageResolvedConflicts": "bool","branchLogCmd": "string","allBranchesLogCmds": "[]string","ignoreWhitespaceInDiffView": "bool","diffContextSize": "uint64","renameSimilarityThreshold": "int","overrideGpg": "bool","disableForcePushing": "bool","commitPrefix": "[]CommitPrefixConfig","commitPrefixes": "map[string][]CommitPrefixConfig","branchPrefix": "string","parseEmoji": "bool","log": "LogConfig","localBranchSortOrder": "string","remoteBranchSortOrder": "string","truncateCopiedCommitHashesTo": "int"},
  "DiffRendererConfig": {"type": "string","name": "string","colorArg": "string","command": "DiffRendererCommandType","args": "[]string"},
  "CommitConfig": {"signOff": "bool","autoWrapCommitMessage": "bool","autoWrapWidth": "int"},
  "MergingConfig": {"manualCommit": "bool","args": "string","squashMergeMessage": "string"},
  "LogConfig": {"order": "string","showGraph": "string","showWholeGraph": "bool"},
  "CommitPrefixConfig": {"pattern": "string","replace": "string"},
  "WorktreeConfig": {"defaultPath": "string"},
  "UpdateConfig": {"method": "string","days": "int64"},
  "OSConfig": {"edit": "string","editAtLine": "string","editAtLineAndWait": "string","editInTerminal": "*bool","openDirInEditor": "string","editPreset": "string","open": "string","openLink": "string","copyToClipboardCmd": "string","readFromClipboardCmd": "string","shellFunctionsFile": "string"},
  "CustomCommandAfterHook": {"checkForConflicts": "bool"},
  "CustomCommand": {"key": "Keybinding","commandMenu": "[]CustomCommand","context": "string","command": "string","prompts": "[]CustomCommandPrompt","loadingText": "string","description": "string","output": "string","outputTitle": "string","after": "*CustomCommandAfterHook"},
  "CustomCommandPrompt": {"type": "string","key": "string","title": "string","initialValue": "string","suggestions": "CustomCommandSuggestions","body": "string","options": "[]CustomCommandMenuOption","command": "string","filter": "string","valueFormat": "string","labelFormat": "string","condition": "string"},
  "CustomCommandSuggestions": {"preset": "string","command": "string"},
  "CustomCommandMenuOption": {"name": "string","description": "string","value": "string","key": "Keybinding"},
  "CustomIconsConfig": {"filenames": "map[string]IconProperties","extensions": "map[string]IconProperties"},
  "IconProperties": {"icon": "string","color": "string"},
  "KeybindingConfig": {"universal": "KeybindingUniversalConfig","status": "KeybindingStatusConfig","files": "KeybindingFilesConfig","branches": "KeybindingBranchesConfig","commits": "KeybindingCommitsConfig","amendAttribute": "KeybindingAmendAttributeConfig","stash": "KeybindingStashConfig","commitFiles": "KeybindingCommitFilesConfig","main": "KeybindingMainConfig","submodules": "KeybindingSubmodulesConfig","commitMessage": "KeybindingCommitMessageConfig"},
  "KeybindingUniversalConfig": {"quit": "Keybinding","quit-alt1": "Keybinding","suspendApp": "Keybinding","return": "Keybinding","quitWithoutChangingDirectory": "Keybinding","togglePanel": "Keybinding","prevItem": "Keybinding","nextItem": "Keybinding","prevItem-alt": "Keybinding","nextItem-alt": "Keybinding","prevPage": "Keybinding","nextPage": "Keybinding","scrollLeft": "Keybinding","scrollRight": "Keybinding","gotoTop": "Keybinding","gotoBottom": "Keybinding","gotoTop-alt": "Keybinding","gotoBottom-alt": "Keybinding","toggleRangeSelect": "Keybinding","rangeSelectDown": "Keybinding","rangeSelectUp": "Keybinding","prevBlock": "Keybinding","nextBlock": "Keybinding","prevBlock-alt": "Keybinding","nextBlock-alt": "Keybinding","nextBlock-alt2": "Keybinding","prevBlock-alt2": "Keybinding","jumpToBlock": "[]Keybinding","focusMainView": "Keybinding","jumpToFile": "Keybinding","nextMatch": "Keybinding","prevMatch": "Keybinding","startSearch": "Keybinding","moveWordLeft": "Keybinding","moveWordRight": "Keybinding","backspaceWord": "Keybinding","forwardDeleteWord": "Keybinding","optionMenu": "Keybinding","select": "Keybinding","goInto": "Keybinding","confirm": "Keybinding","confirmMenu": "Keybinding","confirmSuggestion": "Keybinding","confirmInEditor": "Keybinding","confirmInEditor-alt": "Keybinding","remove": "Keybinding","new": "Keybinding","newWorktree": "Keybinding","edit": "Keybinding","openFile": "Keybinding","scrollUpMain": "Keybinding","scrollDownMain": "Keybinding","scrollUpMain-alt1": "Keybinding","scrollDownMain-alt1": "Keybinding","scrollUpMain-alt2": "Keybinding","scrollDownMain-alt2": "Keybinding","executeShellCommand": "Keybinding","createRebaseOptionsMenu": "Keybinding","pushFiles": "Keybinding","pullFiles": "Keybinding","refresh": "Keybinding","createPatchOptionsMenu": "Keybinding","nextTab": "Keybinding","prevTab": "Keybinding","nextScreenMode": "Keybinding","prevScreenMode": "Keybinding","cycleDiffRenderers": "Keybinding","cycleDiffRenderersReverse": "Keybinding","undo": "Keybinding","redo": "Keybinding","filteringMenu": "Keybinding","diffingMenu": "Keybinding","diffingMenu-alt": "Keybinding","copyToClipboard": "Keybinding","openRecentRepos": "Keybinding","submitEditorText": "Keybinding","extrasMenu": "Keybinding","toggleWhitespaceInDiffView": "Keybinding","increaseContextInDiffView": "Keybinding","decreaseContextInDiffView": "Keybinding","increaseRenameSimilarityThreshold": "Keybinding","decreaseRenameSimilarityThreshold": "Keybinding","openDiffTool": "Keybinding","editConfig": "Keybinding"},
  "KeybindingStatusConfig": {"checkForUpdate": "Keybinding","recentRepos": "Keybinding","allBranchesLogGraph": "Keybinding","allBranchesLogGraphReverse": "Keybinding"},
  "KeybindingFilesConfig": {"commitChanges": "Keybinding","commitChangesWithoutHook": "Keybinding","amendLastCommit": "Keybinding","commitChangesWithEditor": "Keybinding","findBaseCommitForFixup": "Keybinding","confirmDiscard": "Keybinding","ignoreFile": "Keybinding","refreshFiles": "Keybinding","stashAllChanges": "Keybinding","viewStashOptions": "Keybinding","toggleStagedAll": "Keybinding","viewResetOptions": "Keybinding","fetch": "Keybinding","toggleTreeView": "Keybinding","openMergeOptions": "Keybinding","openStatusFilter": "Keybinding","copyFileInfoToClipboard": "Keybinding","collapseAll": "Keybinding","expandAll": "Keybinding"},
  "KeybindingBranchesConfig": {"createPullRequest": "Keybinding","viewPullRequestOptions": "Keybinding","openPullRequestInBrowser": "Keybinding","copyPullRequestURL": "Keybinding","checkoutBranchByName": "Keybinding","forceCheckoutBranch": "Keybinding","checkoutPreviousBranch": "Keybinding","rebaseBranch": "Keybinding","renameBranch": "Keybinding","mergeIntoCurrentBranch": "Keybinding","moveCommitsToNewBranch": "Keybinding","viewGitFlowOptions": "Keybinding","fastForward": "Keybinding","createTag": "Keybinding","pushTag": "Keybinding","setUpstream": "Keybinding","fetchRemote": "Keybinding","addForkRemote": "Keybinding","sortOrder": "Keybinding"},
  "KeybindingCommitsConfig": {"squashDown": "Keybinding","renameCommit": "Keybinding","renameCommitWithEditor": "Keybinding","viewResetOptions": "Keybinding","markCommitAsFixup": "Keybinding","setFixupMessage": "Keybinding","createFixupCommit": "Keybinding","squashAboveCommits": "Keybinding","moveDownCommit": "Keybinding","moveUpCommit": "Keybinding","amendToCommit": "Keybinding","resetCommitAuthor": "Keybinding","pickCommit": "Keybinding","revertCommit": "Keybinding","cherryPickCopy": "Keybinding","pasteCommits": "Keybinding","markCommitAsBaseForRebase": "Keybinding","tagCommit": "Keybinding","checkoutCommit": "Keybinding","resetCherryPick": "Keybinding","copyCommitAttributeToClipboard": "Keybinding","openLogMenu": "Keybinding","openInBrowser": "Keybinding","openPullRequestInBrowser": "Keybinding","viewBisectOptions": "Keybinding","startInteractiveRebase": "Keybinding","selectCommitsOfCurrentBranch": "Keybinding"},
  "KeybindingAmendAttributeConfig": {"resetAuthor": "Keybinding","setAuthor": "Keybinding","addCoAuthor": "Keybinding"},
  "KeybindingStashConfig": {"popStash": "Keybinding","renameStash": "Keybinding"},
  "KeybindingCommitFilesConfig": {"checkoutCommitFile": "Keybinding"},
  "KeybindingMainConfig": {"prevHunk": "Keybinding","nextHunk": "Keybinding","prevFile": "Keybinding","nextFile": "Keybinding","toggleSelectHunk": "Keybinding","pickBothHunks": "Keybinding","editSelectHunk": "Keybinding"},
  "KeybindingSubmodulesConfig": {"init": "Keybinding","update": "Keybinding","bulkMenu": "Keybinding"},
  "KeybindingCommitMessageConfig": {"commitMenu": "Keybinding"},
};

function childType(type, key) {
  type = (type || '').replace(/^\*/, '');
  if (type.startsWith('map[string]')) return type.slice(11);
  if (type === 'ColorPatterns') return 'string';
  return Object.hasOwn(TYPES, type) && Object.hasOwn(TYPES[type], key) ? TYPES[type][key] : undefined;
}

const nullableType = type => !type || type.startsWith('*') || type.startsWith('[]') ||
  type.startsWith('map[') || ['Keybinding', 'SidePanel'].includes(type);

export class ConfigParseError extends Error {
  constructor(diagnostics) {
    const first = diagnostics.find(item => item.severity === 'error') || diagnostics[0];
    super(`${first.source}${first.line ? `:${first.line}` : ''}: ${first.message}`);
    this.name = 'ConfigParseError';
    this.code = 'invalid-config';
    this.diagnostics = diagnostics;
  }
}

/** Parse one sparse layer. Fatal YAML/type errors carry source-aware diagnostics. */
export function parseConfigLayer(text, source = 'config.yml') {
  const diagnostics = [];
  if (typeof text !== 'string') throw new ConfigParseError([
    { severity: 'error', message: 'Configuration must be YAML text', source },
  ]);
  const lineAt = offset => text.slice(0, offset || 0).split('\n').length;
  const diagnostic = (message, node, severity = 'error') => ({
    severity, message, source, line: lineAt(node?.range?.[0]),
  });
  const fail = (message, node) => {
    throw new ConfigParseError([...diagnostics, diagnostic(message, node)]);
  };
  const doc = parseDocument(text, {
    version: '1.2', schema: 'core', merge: true, uniqueKeys: true, keepSourceTokens: true,
  });
  for (const [items, severity] of [[doc.warnings, 'warning'], [doc.errors, 'error']]) {
    for (const item of items) diagnostics.push({
      severity, source, message: item.message, line: item.linePos?.[0]?.line || lineAt(item.pos?.[0]),
    });
  }
  if (doc.errors.length) throw new ConfigParseError(diagnostics);
  // Have the YAML library check its alias-expansion budget before converting
  // typed fields. Do not mutate anchored nodes: one anchor may be decoded into
  // both a string and a bool, as with Go's typed yaml.v3 decoder.
  try { doc.toJS({ maxAliasCount: 100 }); }
  catch (error) { fail(error.message || String(error), doc.contents); }
  if (!doc.contents || (isScalar(doc.contents) && doc.contents.value === null)) return { config: {}, diagnostics };

  const active = new Set();
  let visits = 0;
  function read(node, type, path) {
    if (!node) return null;
    if (++visits > 100000 || active.size > 128) fail('Configuration expansion exceeds the supported limit', node);
    if (active.has(node)) fail('Cyclic YAML aliases are not supported in configuration', node);
    active.add(node);
    try {
      if (isAlias(node)) {
        const target = node.resolve(doc);
        if (!target) fail(`Unresolved YAML alias: ${node.source}`, node);
        return read(target, type, path);
      }
      type = (type || '').replace(/^\*/, '');
      if (isScalar(node) && node.value === null) return null;
      const label = path || 'configuration';
      const expect = wanted => fail(`${label}: expected ${wanted}`, node);
      if (type === 'Keybinding') {
        if (isSeq(node)) return node.items.map((item, index) => read(item, 'string', `${label}[${index}]`)).filter(value => value !== null);
        if (!isScalar(node)) expect('a key string or a sequence of key strings');
        return readScalar(node, 'string', expect);
      }
      if (type === 'SidePanel') type = '[]string';
      if (type.startsWith('[]')) {
        if (!isSeq(node)) expect('a sequence');
        const elementType = type.slice(2);
        // yaml.v3 skips null elements for non-nullable Go element types.
        return node.items.map((item, index) => read(item, elementType, `${label}[${index}]`))
          .filter(value => value !== null || nullableType(elementType));
      }
      const mapType = type.startsWith('map[string]') || Object.hasOwn(TYPES, type) || type === 'ColorPatterns';
      if (mapType && !isMap(node)) expect('a mapping');
      if (isMap(node)) {
        if (type && !mapType) expect(type);
        const result = {};
        // Merge entries precede explicit entries, independent of their position
        // in the document. In a sequence of merge maps, the first map wins.
        for (const pair of node.items) {
          if (isScalar(pair.key) && typeof pair.key.value === 'symbol') {
            const sources = isSeq(pair.value) ? pair.value.items : [pair.value];
            for (const item of sources) {
              const inherited = read(item, type, label);
              if (!record(inherited)) fail(`${label}: YAML merge requires a mapping or sequence of mappings`, item);
              for (const key of Object.keys(inherited)) if (!Object.hasOwn(result, key)) put(result, key, inherited[key]);
            }
          }
        }
        for (const pair of node.items) {
          if (isScalar(pair.key) && typeof pair.key.value === 'symbol') continue;
          if (!isScalar(pair.key) || pair.key.value === null) fail(`${label}: mapping keys must be scalar strings`, pair.key);
          const key = typeof pair.key.value === 'string' ? pair.key.value : pair.key.source;
          const valueType = childType(type, key);
          const value = read(pair.value, valueType, path ? `${path}.${key}` : key);
          if (value !== null || !type.startsWith('map[') || nullableType(valueType)) put(result, key, value);
        }
        return result;
      }
      if (isSeq(node)) {
        if (type) expect(type);
        return node.items.map((item, index) => read(item, undefined, `${label}[${index}]`));
      }
      if (!isScalar(node)) expect('a scalar, sequence or mapping');
      return readScalar(node, type, expect);
    } finally { active.delete(node); }
  }

  function readScalar(node, type, expect) {
    const value = node.value;
    if (!type) return value;
    // yaml.v3 decodes a typed string from the source spelling, including 001,
    // yes, n and true. Core YAML's parsed JS value alone loses that spelling.
    if (type === 'string' || type === 'DiffRendererCommandType') {
      return typeof value === 'string' ? value : node.source;
    }
    if (type === 'bool') {
      if (typeof value === 'boolean') return value;
      if (['y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON'].includes(value)) return true;
      if (['n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF'].includes(value)) return false;
      expect('a boolean (true/false, yes/no, y/n or on/off)');
    }
    if (['int', 'int64', 'uint64', 'float64'].includes(type)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) expect('a finite number');
      const number = type === 'float64' ? value : Math.trunc(value);
      if (type !== 'float64' && !Number.isSafeInteger(number)) expect('an integer representable without precision loss');
      if (type === 'uint64' && number < 0) expect('a non-negative integer');
      return number;
    }
    return value;
  }

  const config = read(doc.contents, 'UserConfig', '');
  if (!record(config)) fail('Configuration must be a mapping', doc.contents);
  return { config, diagnostics };
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!record(value)) return value;
  const copy = {};
  for (const key of Object.keys(value)) put(copy, key, clone(value[key]));
  return copy;
}

function merge(base, next, type) {
  // yaml.v3 null leaves value types/structs untouched, and clears pointer,
  // sequence and map fields. Keep nulls in parsed layers until this step.
  if (next === null && !nullableType(type)) return clone(base);
  if (!record(next)) return clone(next);
  const result = record(base) ? clone(base) : {};
  for (const key of Object.keys(next)) put(result, key, merge(result[key], next[key], childType(type, key)));
  return result;
}

/** Later values override earlier ones; ordinary arrays replace, commands prepend.
 * A parsed result or a config object is accepted for each loaded layer.
 * An omitted customCommands key duplicates prior commands. This is the pinned
 * upstream append-after-Unmarshal behavior, including empty loaded documents.
 * Missing files must be omitted from `layers` by the caller.
 */
export function mergeConfigLayers(defaults, layers = []) {
  let result = clone(defaults || {});
  for (const entry of layers) {
    if (entry === null || entry === undefined) continue;
    const layer = Object.hasOwn(entry, 'config') && Object.hasOwn(entry, 'diagnostics') ? entry.config : entry;
    if (!record(layer)) throw new TypeError('Each configuration layer must be a mapping');
    const previous = Array.isArray(result.customCommands) ? result.customCommands : [];
    const commands = Object.hasOwn(layer, 'customCommands') ? layer.customCommands : previous;
    if (commands !== null && !Array.isArray(commands)) throw new TypeError('customCommands must be a sequence');
    result = merge(result, layer, 'UserConfig');
    if (Object.hasOwn(layer, 'customCommands') || Object.hasOwn(result, 'customCommands')) {
      put(result, 'customCommands', [...clone(commands || []), ...clone(previous)]);
    }
  }
  return result;
}

// Target-platform filepath operations; no host Node/process dependencies.
function pathTools(windows) {
  const sep = windows ? '\\' : '/';
  const slashes = value => windows ? String(value).replace(/\//g, '\\') : String(value);
  const absolute = value => windows ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/.test(value) : value.startsWith('/');
  function clean(value) {
    let rest = slashes(value), root = '';
    if (windows) {
      const unc = rest.match(/^\\\\[^\\]+\\[^\\]+/);
      const drive = rest.match(/^[A-Za-z]:/);
      if (unc) { root = unc[0]; rest = rest.slice(root.length); }
      else if (drive) {
        root = drive[0]; rest = rest.slice(2);
        if (rest.startsWith(sep)) { root += sep; rest = rest.slice(1); }
      } else if (rest.startsWith(sep)) { root = sep; rest = rest.slice(1); }
    } else if (rest.startsWith(sep)) { root = sep; rest = rest.slice(1); }
    const rooted = root.endsWith(sep) || root.startsWith(sep + sep);
    const parts = [];
    for (const part of rest.split(sep)) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (part !== '..' || !rooted) parts.push(part);
    }
    const between = root && !root.endsWith(sep) && root.startsWith(sep + sep) && parts.length ? sep : '';
    return root + between + parts.join(sep) || '.';
  }
  const join = (...parts) => clean(parts.filter(part => part !== '').join(sep));
  function dirname(value) {
    const current = clean(value);
    const parent = join(current, '..');
    return parent;
  }
  return { sep, absolute, clean, join, dirname };
}

function windowsPathList(value) {
  // filepath.SplitList permits quoted semicolons and removes the quotes.
  const entries = []; let entry = '', quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (char === ';' && !quoted) { entries.push(entry); entry = ''; }
    else entry += char;
  }
  entries.push(entry);
  return entries;
}

/** Ordered layers, including optional missing paths for future reloads.
 * Returns {path, required, kind}[]; exists is an async/sync target-machine probe.
 * repoPath must be Lazygit's canonical main-repository path (not a linked
 * worktree checkout), and commonGitDir must be its shared git directory.
 * Windows KnownFolder locations must be supplied in the target's env; there is
 * no registry/host fallback here. The upstream environment fallbacks are used.
 * Neither this helper nor the parser creates Lazygit's default config file.
 */
export async function resolveConfigPaths({ platform = 'linux', env = {}, repoPath = '', commonGitDir = '' } = {}, exists = () => false) {
  const windows = platform === 'windows' || platform === 'win32';
  const p = pathTools(windows);
  const envKeys = Object.keys(env);
  const get = key => String(env[windows ? (envKeys.find(item => item.toLowerCase() === key.toLowerCase()) || key) : key] ?? '');
  const home = windows ? get('USERPROFILE') : get('HOME') || '/';
  const expand = value => {
    if (!value || !home) return value;
    if (windows) return value.startsWith('%USERPROFILE%') ? p.join(home, value.slice(13)) : value;
    if (value.startsWith('~')) return p.join(home, value.slice(1));
    if (value.startsWith('$HOME')) return p.join(home, value.slice(5));
    return value;
  };
  const uniqueAbsolute = values => [...new Set(values.map(expand).filter(value => value && p.absolute(value)))];
  const firstAbsolute = values => uniqueAbsolute(values)[0] || '';
  let defaultHome, defaultDirs;
  if (windows) {
    const driveSource = get('SystemDrive') || get('SystemRoot') || get('windir') || home || 'C:';
    const drive = driveSource.match(/^[A-Za-z]:/)?.[0] || 'C:';
    defaultHome = get('LOCALAPPDATA') || (home ? p.join(home, 'AppData', 'Local') : '');
    defaultDirs = [get('ProgramData') || get('ALLUSERSPROFILE') || p.join(`${drive}\\`, 'ProgramData'),
      get('APPDATA') || (home ? p.join(home, 'AppData', 'Roaming') : '')];
  } else if (platform === 'darwin') {
    defaultHome = p.join(home, 'Library', 'Application Support');
    defaultDirs = [p.join(home, 'Library', 'Preferences'), '/Library/Application Support', '/Library/Preferences', p.join(home, '.config')];
  } else {
    defaultHome = p.join(home, '.config');
    defaultDirs = ['/etc/xdg'];
  }
  const configHome = firstAbsolute([get('XDG_CONFIG_HOME'), defaultHome]);
  const configuredDirs = uniqueAbsolute(windows ? windowsPathList(get('XDG_CONFIG_DIRS')) : get('XDG_CONFIG_DIRS').split(':'));
  const configDirs = configuredDirs.length ? configuredDirs : uniqueAbsolute(defaultDirs);
  const paths = [];
  if (get('LG_CONFIG_FILE')) {
    // Upstream strings.Split deliberately preserves whitespace/relative/empty
    // entries; do not reinterpret them relative to the main repository path.
    for (const path of get('LG_CONFIG_FILE').split(',')) paths.push({ path, required: true, kind: 'global' });
  } else {
    let globalPath;
    if (get('CONFIG_DIR')) globalPath = p.join(get('CONFIG_DIR'), 'config.yml');
    else {
      for (const name of ['jesseduffield/lazygit/config.yml', 'lazygit/config.yml']) {
        for (const directory of [configHome, ...configDirs]) {
          if (!directory) continue;
          const candidate = p.join(directory, name);
          if (await exists(candidate)) { globalPath = candidate; break; }
        }
        if (globalPath) break;
      }
      globalPath ||= p.join(configHome, 'lazygit', 'config.yml');
    }
    paths.push({ path: globalPath, required: false, kind: 'global' });
  }
  if (repoPath) {
    if (!p.absolute(repoPath)) throw new TypeError('repoPath must be an absolute target-machine path');
    let previous = p.clean(repoPath);
    let directory = p.dirname(previous);
    const ancestors = [];
    while (directory !== previous) {
      ancestors.unshift({ path: p.join(directory, '.lazygit.yml'), required: false, kind: 'ancestor' });
      previous = directory;
      directory = p.dirname(directory);
    }
    paths.push(...ancestors);
  }
  if (commonGitDir) paths.push({ path: p.join(commonGitDir, 'lazygit.yml'), required: false, kind: 'gitdir' });
  return paths;
}

const KEY_NAMES = {
  insert: 'insert', delete: 'delete', home: 'home', end: 'end', pgup: 'pageup', pgdown: 'pagedown',
  up: 'up', down: 'down', left: 'left', right: 'right', tab: 'tab', backtab: 'tab',
  enter: 'enter', esc: 'escape', backspace: 'backspace',
  'mouse wheel up': 'mouse-wheel-up', 'mouse wheel down': 'mouse-wheel-down',
};
const MODIFIERS = { c: 'ctrl', ctrl: 'ctrl', a: 'alt', alt: 'alt', s: 'shift', shift: 'shift', m: 'meta', meta: 'meta' };

/** Upstream scalar/alternate binding syntax -> canonical native event keys. */
export function normalizeKey(value, platform = 'linux') {
  if (value === undefined || value === null) return [];
  const labels = Array.isArray(value) ? value : [value];
  return labels.filter(label => label !== '' && label !== '<disabled>').map(original => {
    const invalid = () => {
      const error = new TypeError(`Unrecognized Lazygit key: ${String(original)}`);
      error.code = 'invalid-key'; throw error;
    };
    if (typeof original !== 'string') invalid();
    let label = original;
    if (label.startsWith('<') && label.endsWith('>')) label = label.slice(1, -1);
    const modifiers = new Set();
    let literalSign = false;
    for (;;) {
      if (label === '-' || label === '+') { literalSign = true; break; }
      const at = label.search(/[-+]/);
      if (at < 0) break;
      const labelPart = label.slice(0, at);
      const mod = Object.hasOwn(MODIFIERS, labelPart) ? MODIFIERS[labelPart] : undefined;
      if (!mod || modifiers.has(mod)) invalid();
      modifiers.add(mod); label = label.slice(at + 1);
    }
    let key;
    if (literalSign) key = label;
    else if (label === 'space') key = 'space';
    else if (label === 'minus' || label === 'plus') {
      if (modifiers.size === 1 && modifiers.has('shift')) invalid();
      key = label === 'minus' ? '-' : '+';
    } else if (Object.hasOwn(KEY_NAMES, label) || /^f(?:[1-9]|1[0-2])$/.test(label)) {
      key = KEY_NAMES[label] || label;
      if (label === 'backtab') modifiers.add('shift');
    } else {
      if ([...label].length !== 1 || (modifiers.size === 1 && modifiers.has('shift')) ||
          (modifiers.size && /^[A-Z]$/.test(label))) invalid();
      key = label === ' ' ? 'space' : label;
    }
    return [...['ctrl', 'alt', 'shift', 'meta'].filter(mod => modifiers.has(mod)).map(mod =>
      mod === 'meta' ? platform === 'darwin' ? 'cmd' : 'super' : mod), key].join('-');
  });
}

/** Groups are global; menu leaves without context inherit the active context.
 * Returns filtered copies and never expands templates or executes commands.
 */
export function commandsForContext(configOrCommands, context) {
  const commands = Array.isArray(configOrCommands) ? configOrCommands : configOrCommands?.customCommands || [];
  function filter(items, inMenu) {
    const result = [];
    for (const command of items) {
      if (Array.isArray(command.commandMenu) && command.commandMenu.length) {
        result.push({ ...clone(command), commandMenu: filter(command.commandMenu, true) });
      } else {
        const contexts = String(command.context || '').split(',').map(item => item.trim());
        if (command.context === 'global' || contexts.includes(context) || (inMenu && !command.context)) result.push(clone(command));
      }
    }
    return result;
  }
  return filter(commands, false);
}
