// Expectations are from Lazygit 54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451:
// app_config.go, gui.go, keynames.go, custom_commands/client.go and adrg/xdg.
// Real YAML fixtures exercise the bundled parser; path probes are in memory so
// the host environment and the user's configuration never influence the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigLayer, ConfigParseError, mergeConfigLayers, resolveConfigPaths,
  normalizeKey, commandsForContext,
} from './config.js';

const parse = text => parseConfigLayer(text, '/fixture/config.yml').config;
const paths = entries => entries.map(entry => entry.path);

test('sparse YAML keeps typed strings and core unknown fields distinct', () => {
  const result = parseConfigLayer(`
keybinding:
  universal:
    nextItem: n
    prevItem: N
    jumpToBlock: [1, [2, '<f2>']]
    confirm: ['<enter>', '<disabled>', '']
gui:
  language: 001
  timeFormat: 2026-11-16
  mouseEvents: yes
  showFileTree: OFF
  sidePanelWidth: 0.27
  theme:
    activeBorderColor: [green, bold]
    authorColors: {001: 001, '*': '#abcdef'}
customCommands:
  - key: 1
    context: files
    description: no
    command: |
      printf '%s\\n' '{{.SelectedFile.Name}}'
      echo ready
    prompts:
      - type: input
        key: BranchName
        initialValue: 001
  - key: n
    command: echo n
    context: global
extraCoreValues: {yes: yes, no: no, decimal: 001, truth: true}
`, '/project/git.yml');
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.config.keybinding.universal, {
    nextItem: 'n', prevItem: 'N', jumpToBlock: ['1', ['2', '<f2>']], confirm: ['<enter>', '<disabled>', ''],
  });
  assert.deepEqual(result.config.gui, {
    language: '001', timeFormat: '2026-11-16', mouseEvents: true, showFileTree: false, sidePanelWidth: 0.27,
    theme: { activeBorderColor: ['green', 'bold'], authorColors: { '001': '001', '*': '#abcdef' } },
  });
  assert.equal(result.config.customCommands[0].key, '1');
  assert.equal(result.config.customCommands[0].description, 'no');
  assert.equal(result.config.customCommands[0].command, "printf '%s\\n' '{{.SelectedFile.Name}}'\necho ready\n");
  assert.equal(result.config.customCommands[0].prompts[0].key, 'BranchName');
  assert.equal(result.config.customCommands[0].prompts[0].initialValue, '001');
  assert.equal(result.config.customCommands[1].key, 'n');
  assert.deepEqual(result.config.extraCoreValues, { yes: 'yes', no: 'no', decimal: 1, truth: true });
});

test('typed scalar decoding follows yaml.v3 rather than a global YAML 1.1 schema', () => {
  for (const yes of ['y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON', 'true', 'True', 'TRUE']) {
    assert.equal(parse(`gui: {mouseEvents: ${yes}}`).gui.mouseEvents, true, yes);
  }
  for (const no of ['n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF', 'false', 'False', 'FALSE']) {
    assert.equal(parse(`gui: {mouseEvents: ${no}}`).gui.mouseEvents, false, no);
  }
  assert.equal(parse('gui: {mouseEvents: "yes"}').gui.mouseEvents, true);
  assert.equal(parse('gui: {mouseEvents: "OFF"}').gui.mouseEvents, false);
  assert.equal(parse('gui: {language: true}').gui.language, 'true');
  assert.equal(parse('gui: {scrollHeight: 3.75}').gui.scrollHeight, 3);
  assert.throws(() => parse('gui: {mouseEvents: "true"}'), ConfigParseError);
  assert.throws(() => parse('gui: {mouseEvents: yEs}'), ConfigParseError);
  assert.throws(() => parse('gui: {scrollHeight: "3"}'), ConfigParseError);
});

test('anchors are decoded separately for each typed use; merge order is YAML order', () => {
  const config = parse(`
flag: &flag yes
first: &first {mouseEvents: *flag, showFileTree: true, language: 001}
second: &second {mouseEvents: no, showFileTree: false, scrollHeight: 7}
gui:
  language: override
  <<: [*first, *second]
  showFileTree: false
customCommands:
  - {key: *flag, context: global, command: echo yes}
quoted: {'<<': literal}
`);
  assert.equal(config.flag, 'yes');
  assert.equal(config.first.mouseEvents, 'yes');
  assert.deepEqual(config.gui, { mouseEvents: true, showFileTree: false, language: 'override', scrollHeight: 7 });
  assert.equal(config.customCommands[0].key, 'yes');
  assert.deepEqual(config.quoted, { '<<': 'literal' });
});

test('duplicate keys, bad types and syntax report the correct source and line', () => {
  for (const [text, line, message] of [
    ['gui:\n  mouseEvents: true\n  mouseEvents: false\n', 3, /unique/i],
    ['gui:\n  mouseEvents: maybe\n', 2, /boolean/],
    ['customCommands:\n  - key: {nested: no}\n', 2, /key string/],
    ['git:\n  mainBranches: master\n', 2, /sequence/],
    ['gui:\n  sidePanels: [files]\n', 2, /sequence/],
    ['services:\n  git.example: [gitlab]\n', 2, /string/],
  ]) {
    assert.throws(() => parseConfigLayer(text, '/remote/config.yml'), error => {
      assert.equal(error.code, 'invalid-config');
      const d = error.diagnostics.find(item => item.severity === 'error');
      assert.equal(d.source, '/remote/config.yml');
      assert.equal(d.line, line);
      assert.match(d.message, message);
      return true;
    });
  }
  assert.throws(() => parse('gui: [\n'), ConfigParseError);
  assert.throws(() => parse('[gui, git]'), ConfigParseError);
  assert.throws(() => parse('gui: {}\n---\ngui: {}'), ConfigParseError);
  assert.throws(() => parse('gui: {scrollHeight: 9007199254740993}'), /precision loss/);
  assert.throws(() => parse('git: {diffContextSize: -1}'), /non-negative/);
});

test('aliases are bounded and cycles cannot enter the loaded config', () => {
  assert.throws(() => parse('cycle: &cycle {again: *cycle}'), /Cyclic/);
  assert.throws(() => parse('missing: *absent'), /Unresolved alias/);
  const base = 'a: &a [one, two, three, four, five, six, seven, eight, nine, ten]\n';
  const b = `b: &b [${Array(10).fill('*a').join(',')}]\n`;
  const c = `c: &c [${Array(10).fill('*b').join(',')}]\n`;
  assert.throws(() => parse(base + b + c), /alias count|expansion/i);
  assert.throws(() => parse('gui: {<<: [one, two]}'), /merge/i);
});

test('configuration keys do not change JavaScript object prototypes', () => {
  const layer = parse(`services: {__proto__: github:example.com, constructor: gitlab:example.org}
__proto__: {rootField: value}
constructor: unknown root option
extra: {__proto__: {polluted: yes}}
`);
  const result = mergeConfigLayers({}, [layer]);
  assert.equal(Object.getPrototypeOf(result.services), Object.prototype);
  assert.equal(Object.hasOwn(result.services, '__proto__'), true);
  assert.equal(result.services.__proto__, 'github:example.com');
  assert.deepEqual(result.extra.__proto__, { polluted: 'yes' });
  assert.deepEqual(result.__proto__, { rootField: 'value' });
  assert.equal(result.constructor, 'unknown root option');
  assert.equal({}.polluted, undefined);
});

test('ordinary fields merge sparsely, arrays replace, inputs remain unchanged', () => {
  const defaults = {
    gui: { mouseEvents: true, theme: { activeBorderColor: ['blue', 'bold'], authorColors: { a: 'red' } } },
    git: { mainBranches: ['main', 'master'] }, services: { old: 'github:old' },
  };
  const snapshot = structuredClone(defaults);
  const layers = [parse('gui: {mouseEvents: no, theme: {authorColors: {b: blue}}}\ngit: {mainBranches: [trunk]}'),
    parse('gui: {theme: {activeBorderColor: [green], authorColors: {a: yellow}}}\nservices: {new: gitlab:new}')];
  const result = mergeConfigLayers(defaults, layers);
  assert.deepEqual(result, {
    gui: { mouseEvents: false, theme: { activeBorderColor: ['green'], authorColors: { a: 'yellow', b: 'blue' } } },
    git: { mainBranches: ['trunk'] }, services: { old: 'github:old', new: 'gitlab:new' },
  });
  assert.deepEqual(defaults, snapshot);
  result.git.mainBranches.push('mutation');
  result.gui.theme.authorColors.b = 'mutation';
  assert.deepEqual(layers[0].git.mainBranches, ['trunk']);
  assert.equal(layers[0].gui.theme.authorColors.b, 'blue');
});

test('later custom commands prepend; omission retains the upstream duplicate quirk', () => {
  const defaults = { customCommands: [{ key: 'a', context: 'files', command: 'echo default' }] };
  const global = parseConfigLayer('customCommands: [{key: b, context: global, command: echo global}]', 'global.yml');
  const repo = parseConfigLayer('customCommands: [{key: c, context: commits, command: echo repo}]', 'repo.yml');
  assert.deepEqual(mergeConfigLayers(defaults, [global, repo]).customCommands.map(item => item.key), ['c', 'b', 'a']);
  assert.deepEqual(mergeConfigLayers(defaults, [parse('gui: {mouseEvents: true}')]).customCommands.map(item => item.key), ['a', 'a']);
  assert.deepEqual(mergeConfigLayers(defaults, [parse('# empty loaded document')]).customCommands.map(item => item.key), ['a', 'a']);
  assert.deepEqual(mergeConfigLayers(defaults, [parse('null')]).customCommands.map(item => item.key), ['a', 'a']);
  assert.deepEqual(mergeConfigLayers(defaults, [parse('customCommands: []')]).customCommands.map(item => item.key), ['a']);
  assert.deepEqual(mergeConfigLayers(defaults, [parse('customCommands: null')]).customCommands.map(item => item.key), ['a']);
  assert.deepEqual(mergeConfigLayers(defaults, [null, undefined]).customCommands.map(item => item.key), ['a']);
  assert.deepEqual(defaults.customCommands.map(item => item.key), ['a']);
});

test('typed YAML null preserves value types and clears maps, lists and pointers', () => {
  const defaults = { gui: { mouseEvents: true, theme: { activeBorderColor: ['blue'] } }, services: { a: 'b' }, os: { editInTerminal: true } };
  const result = mergeConfigLayers(defaults, [parse('gui: {mouseEvents: null, theme: {activeBorderColor: null}}\nservices: null\nos: {editInTerminal: null}')]);
  assert.deepEqual(result, { gui: { mouseEvents: true, theme: { activeBorderColor: null } }, services: null, os: { editInTerminal: null } });
  assert.deepEqual(mergeConfigLayers(defaults, [parse('gui: null')]).gui, defaults.gui);
  assert.deepEqual(parse('gui: {theme: {activeBorderColor: [null, green]}}\ncustomCommands: [null]\nservices: {a: null, b: gitlab:b}'), {
    gui: { theme: { activeBorderColor: ['green'] } }, customCommands: [], services: { b: 'gitlab:b' },
  });
});

function memoryExists(existing = []) {
  const calls = [];
  const exists = async path => { calls.push(path); return existing.includes(path); };
  return { calls, exists };
}

test('legacy global name wins across XDG directories before modern config name', async () => {
  const fs = memoryExists(['/home/p/.config/lazygit/config.yml', '/org/xdg/jesseduffield/lazygit/config.yml']);
  const result = await resolveConfigPaths({
    platform: 'linux', env: { HOME: '/home/p', XDG_CONFIG_DIRS: '/etc/xdg:/org/xdg' },
  }, fs.exists);
  assert.deepEqual(result, [{ path: '/org/xdg/jesseduffield/lazygit/config.yml', required: false, kind: 'global' }]);
  assert.deepEqual(fs.calls, ['/home/p/.config/jesseduffield/lazygit/config.yml', '/etc/xdg/jesseduffield/lazygit/config.yml', '/org/xdg/jesseduffield/lazygit/config.yml']);
});

test('main repository ancestors load root to nearest, with common gitdir last', async () => {
  const result = await resolveConfigPaths({
    platform: 'linux', env: { HOME: '/home/p' }, repoPath: '/work/team/project', commonGitDir: '/work/team/project/.git',
  });
  assert.deepEqual(paths(result), [
    '/home/p/.config/lazygit/config.yml', '/.lazygit.yml', '/work/.lazygit.yml', '/work/team/.lazygit.yml', '/work/team/project/.git/lazygit.yml',
  ]);
  assert.equal(result.every(entry => !entry.required), true);
  assert.equal(paths(result).includes('/work/team/project/.lazygit.yml'), false);
  assert.deepEqual(result.map(entry => entry.kind), ['global', 'ancestor', 'ancestor', 'ancestor', 'gitdir']);
});

test('linked worktrees use supplied main repository and shared gitdir; submodules keep own ancestors', async () => {
  const worktree = await resolveConfigPaths({ platform: 'linux', env: { HOME: '/h' },
    repoPath: '/main/project', commonGitDir: '/main/project/.git' });
  assert.deepEqual(paths(worktree).slice(1), ['/.lazygit.yml', '/main/.lazygit.yml', '/main/project/.git/lazygit.yml']);
  const submodule = await resolveConfigPaths({ platform: 'linux', env: { HOME: '/h' },
    repoPath: '/main/project/libs/lib', commonGitDir: '/main/project/.git/modules/libs/lib' });
  assert.deepEqual(paths(submodule).slice(1), ['/.lazygit.yml', '/main/.lazygit.yml', '/main/project/.lazygit.yml', '/main/project/libs/.lazygit.yml', '/main/project/.git/modules/libs/lib/lazygit.yml']);
});

test('LG_CONFIG_FILE replaces globals but preserves required comma entries and repo layers', async () => {
  const fs = memoryExists();
  const result = await resolveConfigPaths({ platform: 'linux', env: {
    HOME: '/h', LG_CONFIG_FILE: '/one.yml, relative.yml,,/one.yml', CONFIG_DIR: '/ignored',
  }, repoPath: '/repo', commonGitDir: '/repo/.git' }, fs.exists);
  assert.deepEqual(result.slice(0, 4), ['/one.yml', ' relative.yml', '', '/one.yml'].map(path => ({ path, required: true, kind: 'global' })));
  assert.deepEqual(paths(result).slice(4), ['/.lazygit.yml', '/repo/.git/lazygit.yml']);
  assert.deepEqual(fs.calls, []);
});

test('CONFIG_DIR selects a single file without tilde expansion or XDG probing', async () => {
  const fs = memoryExists();
  const result = await resolveConfigPaths({ platform: 'darwin', env: { HOME: '/Users/p', CONFIG_DIR: '~/private/../git' } }, fs.exists);
  assert.deepEqual(paths(result), ['~/git/config.yml']);
  assert.deepEqual(fs.calls, []);
});

test('Darwin XDG fallbacks and expansion follow the target rather than this host', async () => {
  const fs = memoryExists(['/Library/Preferences/jesseduffield/lazygit/config.yml']);
  assert.deepEqual(paths(await resolveConfigPaths({ platform: 'darwin', env: { HOME: '/Users/p' } }, fs.exists)), ['/Library/Preferences/jesseduffield/lazygit/config.yml']);
  assert.deepEqual(fs.calls, ['/Users/p/Library/Application Support/jesseduffield/lazygit/config.yml', '/Users/p/Library/Preferences/jesseduffield/lazygit/config.yml', '/Library/Application Support/jesseduffield/lazygit/config.yml', '/Library/Preferences/jesseduffield/lazygit/config.yml']);
  const expanded = memoryExists(['/Users/p/second/lazygit/config.yml']);
  const result = await resolveConfigPaths({ platform: 'darwin', env: {
    HOME: '/Users/p', XDG_CONFIG_HOME: '$HOME/first', XDG_CONFIG_DIRS: 'relative:~/second:~/second:/third',
  } }, expanded.exists);
  assert.equal(result[0].path, '/Users/p/second/lazygit/config.yml');
  assert.deepEqual(expanded.calls.slice(0, 3), ['/Users/p/first/jesseduffield/lazygit/config.yml', '/Users/p/second/jesseduffield/lazygit/config.yml', '/third/jesseduffield/lazygit/config.yml']);
});

test('relative XDG variables fall back and empty HOME is independent of host', async () => {
  const fs = memoryExists();
  assert.deepEqual(paths(await resolveConfigPaths({ platform: 'linux', env: { HOME: '/h', XDG_CONFIG_HOME: 'relative', XDG_CONFIG_DIRS: 'one:two' } }, fs.exists)), ['/h/.config/lazygit/config.yml']);
  assert.deepEqual(fs.calls, ['/h/.config/jesseduffield/lazygit/config.yml', '/etc/xdg/jesseduffield/lazygit/config.yml', '/h/.config/lazygit/config.yml', '/etc/xdg/lazygit/config.yml']);
  assert.equal((await resolveConfigPaths({ platform: 'linux', env: {} }))[0].path, '/.config/lazygit/config.yml');
});

test('Windows target paths use environment fallbacks, drive roots and semicolon XDG lists', async () => {
  const fs = memoryExists(['D:\\Shared\\jesseduffield\\lazygit\\config.yml']);
  const result = await resolveConfigPaths({ platform: 'windows', env: {
    userprofile: 'C:\\Users\\P', localappdata: 'C:\\Users\\P\\AppData\\Local',
    ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\P\\AppData\\Roaming',
    XDG_CONFIG_HOME: '%USERPROFILE%\\Config', XDG_CONFIG_DIRS: 'relative;D:\\Shared;D:\\Shared;"E:\\Semi;Colon"',
  }, repoPath: 'C:\\work\\repo', commonGitDir: 'C:/work/repo/.git' }, fs.exists);
  assert.deepEqual(paths(result), ['D:\\Shared\\jesseduffield\\lazygit\\config.yml', 'C:\\.lazygit.yml', 'C:\\work\\.lazygit.yml', 'C:\\work\\repo\\.git\\lazygit.yml']);
  assert.deepEqual(fs.calls, ['C:\\Users\\P\\Config\\jesseduffield\\lazygit\\config.yml', 'D:\\Shared\\jesseduffield\\lazygit\\config.yml']);
  const quoteFs = memoryExists(['E:\\Semi;Colon\\lazygit\\config.yml']);
  assert.equal((await resolveConfigPaths({ platform: 'windows', env: { USERPROFILE: 'C:\\Users\\P', XDG_CONFIG_DIRS: '"E:\\Semi;Colon"' } }, quoteFs.exists))[0].path, 'E:\\Semi;Colon\\lazygit\\config.yml');
  assert.equal((await resolveConfigPaths({ platform: 'windows', env: { USERPROFILE: 'C:\\Users\\P' } }))[0].path, 'C:\\Users\\P\\AppData\\Local\\lazygit\\config.yml');
});

test('Windows UNC ancestors stop at the share root and never load repo-root config', async () => {
  const result = await resolveConfigPaths({ platform: 'windows', env: { LG_CONFIG_FILE: 'chosen.yml' },
    repoPath: '\\\\server\\share\\team\\repo', commonGitDir: '\\\\server\\share\\team\\repo\\.git' });
  assert.deepEqual(paths(result), ['chosen.yml', '\\\\server\\share\\.lazygit.yml', '\\\\server\\share\\team\\.lazygit.yml', '\\\\server\\share\\team\\repo\\.git\\lazygit.yml']);
  await assert.rejects(() => resolveConfigPaths({ platform: 'windows', repoPath: 'C:relative' }), /absolute/);
});

test('root repository ancestor planning terminates without loading repo-root config', async () => {
  assert.deepEqual(paths(await resolveConfigPaths({ platform: 'linux', env: { LG_CONFIG_FILE: '/chosen' }, repoPath: '/', commonGitDir: '/.git' })), ['/chosen', '/.git/lazygit.yml']);
  await assert.rejects(() => resolveConfigPaths({ repoPath: 'relative/repo' }), /absolute/);
});

test('upstream key syntax normalizes case, aliases, modifiers and alternates', () => {
  assert.deepEqual(normalizeKey(['n', 'N', '1', '<disabled>', '', '<c-s-a>', '<a+shift+c>', '<s-m-c-a-enter>'], 'darwin'), ['n', 'N', '1', 'ctrl-shift-a', 'alt-shift-c', 'ctrl-alt-shift-cmd-enter']);
  assert.deepEqual(normalizeKey(['<esc>', 'enter', '<space>', ' ', '<backtab>', '<shift-tab>', '<ctrl-pgup>', '<s-up>', '<f12>']), ['escape', 'enter', 'space', 'space', 'shift-tab', 'shift-tab', 'ctrl-pageup', 'shift-up', 'f12']);
  assert.deepEqual(normalizeKey(['<meta+enter>', '<m-a>'], 'darwin'), ['cmd-enter', 'cmd-a']);
  assert.deepEqual(normalizeKey('<meta+enter>', 'linux'), ['super-enter']);
  assert.deepEqual(normalizeKey('<meta+enter>', 'windows'), ['super-enter']);
  assert.deepEqual(normalizeKey(['<c-minus>', '<c-->', '<c-+>', '<c++>', '+', '-', '<shift-space>']), ['ctrl--', 'ctrl--', 'ctrl-+', 'ctrl-+', '+', '-', 'shift-space']);
  assert.deepEqual(normalizeKey(['é', '🙂', '<c-é>', '<mouse wheel up>']), ['é', '🙂', 'ctrl-é', 'mouse-wheel-up']);
  for (const value of [null, undefined, '', '<disabled>', []]) assert.deepEqual(normalizeKey(value), []);
});

test('invalid keys fail explicitly instead of silently changing case or modifiers', () => {
  for (const value of ['<shift+a>', '<ctrl+A>', '<a-C>', '<c-c-a>', '<ctrl+ctrl+a>', '<s-minus>', '<s-plus>', '<c+>', '<f13>', 'pageup', 'n ', 'disabled', '<cmd-enter>', '<toString-a>', '<constructor-a>', '<__proto__-a>', 1, ['n', ['x']]]) {
    assert.throws(() => normalizeKey(value), error => error.code === 'invalid-key', String(value));
  }
  // Source explicitly permits these lenient literal sign forms before the
  // ordinary bare-rune shift validation.
  assert.deepEqual(normalizeKey(['<s-->', '<s++>']), ['shift--', 'shift-+']);
});

test('command menus stay global, leaf contexts filter and templates remain literal', () => {
  const config = parse(`customCommands:
  - {key: g, context: global, command: 'echo {{.SelectedFile.Name}}'}
  - {key: f, context: 'files, commits', command: echo files}
  - {key: r, context: remoteBranches, command: echo remote}
  - {key: x, command: echo missing-top-level-context}
  - key: m
    description: Menu
    commandMenu:
      - {key: a, command: echo inherited}
      - {key: b, context: stash, command: echo stash}
      - {key: c, context: global, command: echo global-child}
      - key: d
        description: Nested
        commandMenu:
          - {key: e, context: remoteBranches, command: echo nested-remote}
`);
  const before = structuredClone(config);
  const files = commandsForContext(config, 'files');
  assert.deepEqual(files.map(command => command.key), ['g', 'f', 'm']);
  assert.equal(files[0].command, 'echo {{.SelectedFile.Name}}');
  assert.deepEqual(files[2].commandMenu.map(command => command.key), ['a', 'c', 'd']);
  assert.deepEqual(files[2].commandMenu[2].commandMenu, []);
  const remote = commandsForContext(config.customCommands, 'remoteBranches');
  assert.deepEqual(remote.map(command => command.key), ['g', 'r', 'm']);
  assert.equal(remote[2].commandMenu[2].commandMenu[0].key, 'e');
  files[2].commandMenu[0].command = 'changed';
  assert.deepEqual(config, before);
  assert.deepEqual(commandsForContext({}, 'files'), []);
});
