// Source-backed expectations: Lazygit 54cc6af services/custom_commands/{models,
// session_state_loader,menu_generator}.go and commands/models/file.go.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {snapshotCommandData, menuFromOutput} from './command-data.js';
import {renderTemplate} from './templates.js';
import {parseStatus} from './status.js';

const render = (text, data, options) => renderTemplate(text, data, options);
function fixture(overrides = {}) {
  const files = parseStatus(' M changed.txt\0A  added.txt\0?? new.txt\0').files;
  return {
    panel:'commits', main:false, fileView:'files', branchView:'local', commitView:'commits',
    files, nodes:files.map(file => ({file})), sel:{files:0, branches:0, commits:0, stash:0},
    viewSelections:{}, contexts:{}, filters:{}, rangeAnchors:{},
    commits:[{hash:'ccc', subject:'new', who:'Ada', unpushed:true}, {hash:'bbb', subject:'middle'}, {hash:'aaa', subject:'old'}],
    reflog:[{hash:'ddd', subject:'checkout: moving from main to feature', when:'now'}],
    branches:[{name:'main', ref:'refs/heads/main', hash:'ccc', current:true, track:'ahead 2, behind 1'}, {name:'feature', hash:'bbb', current:false, track:''}],
    remotes:[{name:'origin', url:'https://example.invalid/r.git'}, {name:'other', url:'ssh://example.invalid/r.git'}],
    remoteBranches:[{name:'origin/main', ref:'refs/remotes/origin/main', hash:'ccc'}, {name:'origin/feature/topic', ref:'refs/remotes/origin/feature/topic', hash:'bbb'}],
    remoteContext:null, tags:[{name:'v1', hash:'ccc', subject:'Tag subject only'}],
    stashes:[{ref:'stash@{3}', hash:'stash-hash', subject:'WIP on main: ccc new', when:'one day ago'}],
    worktrees:[{path:'/repos/app', name:'/repos/app', branch:'main'}, {path:'/work/app', name:'/work/app', branch:'feature'}],
    submodules:[{name:'lib', path:'vendor/lib'}], hasHead:true, head:'ccc', branch:{name:'main', upstream:'origin/main', ahead:2, behind:1},
    ...overrides,
  };
}

test('snapshot carries all selected context shims and shares only captured commit aliases', () => {
  const view = fixture(), data = snapshotCommandData(view);
  assert.equal(data.SelectedCommit, data.SelectedLocalCommit);
  assert.deepEqual(data.SelectedCommitRange, {From:'ccc', To:'ccc'});
  assert.equal(data.SelectedCommit.AuthorName, 'Ada');
  assert.deepEqual(data.SelectedRemoteBranch, {Name:'main', RemoteName:'origin'});
  assert.deepEqual(data.SelectedRemote, {Name:'origin', Urls:['https://example.invalid/r.git'], Branches:[{Name:'main', RemoteName:'origin'}, {Name:'feature/topic', RemoteName:'origin'}]});
  assert.equal(data.SelectedLocalBranch.Pushables, '2');
  assert.equal(data.SelectedLocalBranch.Pullables, '1');
  assert.equal(data.CheckedOutBranch.Name, 'main');
  assert.equal(data.SelectedPath, 'changed.txt');
  assert.equal(data.SelectedStashEntry.Index, 3);
  assert.equal(data.SelectedStashEntry.Name, 'WIP on main: ccc new');
  assert.equal(data.SelectedWorktree.Name, 'repos/app');
  assert.deepEqual(data.SelectedSubmodule, {Name:'lib', Path:'vendor/lib'});
  data.SelectedCommit.Name = 'hydrated'; data.SelectedRemote.Urls.push('new'); data.Form.Branch = 'chosen'; data.PromptResponses.push('chosen');
  assert.equal(data.SelectedLocalCommit.Name, 'hydrated');
  assert.equal(view.commits[0].subject, 'new');
  assert.equal(view.remotes.length, 2);
  assert.deepEqual(snapshotCommandData(view).PromptResponses, []);
});

test('unknown metadata is absent rather than copied from similar-looking display fields', () => {
  const data = snapshotCommandData(fixture());
  for (const key of ['UnixTimestamp', 'Parents', 'AuthorEmail', 'Status', 'ExtraInfo']) assert.equal(Object.hasOwn(data.SelectedCommit, key), false, key);
  assert.equal(data.SelectedReflogCommit.Name, 'checkout: moving from main to feature');
  assert.equal(data.SelectedReflogCommit.Status, 8);
  assert.equal(data.SelectedReflogCommit.AuthorName, '');
  assert.equal(data.SelectedReflogCommit.AuthorEmail, '');
  assert.deepEqual(data.SelectedReflogCommit.Tags, []);
  assert.equal(Object.hasOwn(data.SelectedTag, 'Message'), false);
  assert.equal(Object.hasOwn(data.SelectedRemote, 'PushUrls'), false);
  assert.equal(Object.hasOwn(data.SelectedSubmodule, 'Url'), false);
  assert.equal(Object.hasOwn(data.SelectedWorktree, 'IsMain'), false);
  assert.equal(Object.hasOwn(data.SelectedWorktree, 'IsCurrent'), false);
  assert.equal(Object.hasOwn(data.SelectedLocalBranch, 'Recency'), false);
  assert.equal(Object.hasOwn(data.SelectedLocalBranch, 'UpstreamRemote'), false);
});

test('staged additions use upstream Tracked/Added semantics, not numstat additions/deletions', () => {
  for (const [code, tracked, added, deleted] of [['??',false,true,false], ['A ',false,true,false], ['AM',false,true,false], ['MM',true,false,false], [' D',true,false,true], ['AA',true,true,false]]) {
    const file = parseStatus(`${code} dir/special \" ü.txt\0`).files[0]; file.add = 12; file.del = 4;
    const data = snapshotCommandData(fixture({nodes:[{file}]}));
    assert.equal(data.SelectedFile.Tracked, tracked, code); assert.equal(data.SelectedFile.Added, added, code); assert.equal(data.SelectedFile.Deleted, deleted, code);
    assert.equal(data.SelectedFile.DisplayString, `${code} dir/special \" ü.txt`);
  }
  const renamed = parseStatus('R  new name\0old\nname\0').files[0];
  const data = snapshotCommandData(fixture({nodes:[{file:renamed}]}));
  assert.equal(data.SelectedFile.PreviousName, 'old\nname');
  assert.equal(data.SelectedFile.ShortStatus, 'R ');
});

test('directory selection preserves SelectedPath with a nil SelectedFile', () => {
  const data = snapshotCommandData(fixture({nodes:[{dir:true, path:'src/components', files:[]}]}));
  assert.equal(data.SelectedFile, null); assert.equal(data.SelectedPath, 'src/components');
});

test('inactive tabs use saved indexes, filters and the native pure list readers', () => {
  const view = fixture({panel:'files', fileView:'worktrees', commitView:'reflog', branchView:'tags',
    viewSelections:{files:1, commits:2, local:1, submodules:0}, sel:{files:1, branches:0, commits:0, stash:0}});
  let calls = 0;
  view.branchItems = function () { calls++; assert.notEqual(this, view); assert.equal(this.contexts.branches.length, 0); return this.branchView === 'local' ? [...this.branches].reverse() : this.branchView === 'tags' ? this.tags : this.remoteContext ? this.remoteBranches : this.remotes; };
  const before = JSON.stringify(view), data = snapshotCommandData(view);
  assert.equal(JSON.stringify(view), before); assert.ok(calls >= 3);
  assert.equal(data.SelectedFile.Name, 'added.txt'); assert.equal(data.SelectedCommit.Hash, 'aaa');
  assert.equal(data.SelectedReflogCommit.Hash, 'ddd'); assert.equal(data.SelectedLocalBranch.Name, 'main');
  assert.equal(data.SelectedWorktree.Path, '/work/app');
});

test('nested branch commits and commit files retain each parent selection and range', () => {
  const parent = {hash:'sub2', subject:'second'}, sub = {type:'commits', key:'branches:commits:1', parentSelection:1,
    items:[{hash:'sub3', subject:'third'}, parent, {hash:'sub1', subject:'first'}]};
  const files = {type:'files', key:'branches:files:2', parentSelection:1, parentCommit:{...parent}, parentCommitContext:'subCommits', items:[{path:'src/a', status:'M'}, {path:'src/b', status:'A'}]};
  const view = fixture({panel:'branches', contexts:{branches:[sub, files]}, sel:{files:0, branches:1, commits:2, stash:0}, rangeAnchors:{[sub.key]:2}});
  const data = snapshotCommandData(view);
  assert.equal(data.SelectedLocalBranch.Name, 'feature'); assert.equal(data.SelectedLocalCommit.Hash, 'aaa');
  assert.equal(data.SelectedSubCommit, data.SelectedCommit); assert.equal(data.SelectedCommit.Hash, 'sub2');
  assert.deepEqual(data.SelectedCommitRange, {From:'sub1', To:'sub2'});
  assert.deepEqual(data.SelectedCommitFile, {Name:'src/b', ChangeStatus:'A'});
  assert.equal(data.SelectedPath, 'src/b'); assert.equal(data.SelectedFile.Name, 'changed.txt');
  sub.items[1].hash = 'changed-live'; files.items[1].path = 'changed-live';
  assert.equal(data.SelectedCommit.Hash, 'sub2'); assert.equal(data.SelectedCommitFile.Name, 'src/b');
});

test('parent reflog commit wins after live history changes, and main keeps upstream SelectedPath semantics', () => {
  const frame = {type:'files', key:'commits:files:1', parentSelection:0, parentCommit:{hash:'saved', subject:'reflog action'}, parentCommitContext:'reflogCommits', items:[{path:'historical.txt', status:'D'}]};
  const view = fixture({panel:'commits', commitView:'reflog', contexts:{commits:[frame]}}), data = snapshotCommandData(view);
  assert.equal(data.SelectedCommit, data.SelectedReflogCommit); assert.equal(data.SelectedCommit.Hash, 'saved');
  assert.equal(data.SelectedCommit.Name, 'reflog action');
  assert.deepEqual(data.SelectedCommitRange, {From:'saved', To:'saved'});
  assert.equal(data.SelectedPath, 'historical.txt');
  assert.equal(snapshotCommandData({...view, main:true}).SelectedPath, 'changed.txt');
  assert.equal(snapshotCommandData({...view, main:true}).SelectedCommitFilePath, 'historical.txt');
});

test('remote drilldown keeps its remote and separates remote name from branch path', () => {
  const view = fixture({panel:'branches', branchView:'remotes', remoteContext:{name:'origin'}, sel:{files:0, branches:1, commits:0, stash:0}});
  const data = snapshotCommandData(view);
  assert.deepEqual(data.SelectedRemoteBranch, {Name:'feature/topic', RemoteName:'origin'});
  assert.equal(data.SelectedRemote.Name, 'origin');
});

test('commit ranges follow visible order in either selection direction', () => {
  for (const [index, anchor] of [[0,2],[2,0]]) {
    const view = fixture({sel:{files:0, branches:0, commits:index, stash:0}, rangeAnchors:{commits:anchor}});
    assert.deepEqual(snapshotCommandData(view).SelectedCommitRange, {From:'aaa', To:'ccc'});
  }
});

test('graph commands use a real focused commit and never the synthetic uncommitted hash', () => {
  const view = fixture({panel:'status', main:true, cursor:0, graph:{rows:[{commit:{hash:'graph-hash', subject:'graph subject', parents:['base'], refs:[{kind:'tag', name:'v2'}], time:123}}]}});
  let data = snapshotCommandData(view);
  assert.equal(data.SelectedCommit.Hash, 'graph-hash'); assert.deepEqual(data.SelectedCommit.Tags, ['v2']);
  assert.deepEqual(data.SelectedCommit.Parents, ['base']); assert.equal(Object.hasOwn(data.SelectedCommit, 'UnixTimestamp'), false);
  view.graph.rows[0].commit.parents.push('mutated'); assert.deepEqual(data.SelectedCommit.Parents, ['base']);
  view.graph.rows[0].commit.hash = '*'; data = snapshotCommandData(view);
  assert.equal(data.SelectedCommit, null); assert.equal(data.SelectedCommitRange, null);
});

test('empty contexts and detached HEAD do not invent a selected object', () => {
  const view = fixture({commits:[], reflog:[], branches:[], remotes:[], remoteBranches:[], stashes:[], worktrees:[], submodules:[], nodes:[], tags:[], head:'detached'});
  const data = snapshotCommandData(view);
  assert.equal(data.SelectedCommit, null); assert.equal(data.SelectedFile, null); assert.equal(data.SelectedPath, '');
  assert.deepEqual(data.CheckedOutBranch, {Name:'detached', CommitHash:'', Head:true, DetachedHead:true});
  assert.equal(data.SelectedRemoteBranch, null);
});

test('official menu example exposes named captures, numbered captures and group_0', async () => {
  assert.deepEqual(await menuFromOutput('upstream/pr-1\nupstream/pr-2\n', {filter:'(?P<remote>[a-z_]+)/(?P<branch>.*)', valueFormat:'{{.branch}}', labelFormat:'Remote: {{.remote}} / {{.group_0}}'}, render), [
    {value:'pr-1', label:'Remote: upstream / upstream/pr-1'}, {value:'pr-2', label:'Remote: upstream / upstream/pr-2'},
  ]);
  assert.deepEqual(await menuFromOutput('upstream/pr-1', {filter:'([a-z_]+)/(.*)', valueFormat:'{{.group_2}}'}, render), [{value:'pr-1', label:'pr-1'}]);
});

test('plain output skips exactly empty lines and preserves whitespace and CR', async () => {
  assert.deepEqual(await menuFromOutput('\n first \n\n \nsecond\r\n', {}), [{value:' first ', label:' first '}, {value:' ', label:' '}, {value:'second\r', label:'second\r'}]);
});

test('unmatched lines still produce rows and default missing-map fields render <no value>', async () => {
  assert.deepEqual(await menuFromOutput('origin/main\nnot-a-branch\n ', {filter:'(?P<remote>[^/]+)/(?P<branch>.+)', valueFormat:'{{.branch}}', labelFormat:'{{if .remote}}{{.remote}}{{else}}unknown{{end}}'}, render), [
    {value:'main', label:'origin'}, {value:'<no value>', label:'unknown'}, {value:'<no value>', label:'unknown'},
  ]);
  assert.deepEqual(await menuFromOutput('x', {filter:'x'}, render), [{value:'', label:''}]);
  assert.deepEqual(await menuFromOutput('x', {valueFormat:'{{.group_0}}/{{.missing}}'}, render), [{value:'/<no value>', label:'/<no value>'}]);
});

test('the first regex match wins and optional or duplicate named groups use Go capture rules', async () => {
  assert.deepEqual(await menuFromOutput('a1 a2\nb\nc', {filter:'(?P<letter>[ab])(?P<number>[0-9])?', valueFormat:'{{.group_0}}/{{.letter}}/{{.number}}'}, render), [
    {value:'a1/a/1', label:'a1/a/1'}, {value:'b/b/', label:'b/b/'}, {value:'<no value>/<no value>/<no value>', label:'<no value>/<no value>/<no value>'},
  ]);
  assert.deepEqual(await menuFromOutput('a', {filter:'(?P<same>a)(?P<same>b)?', valueFormat:'{{.same}}'}, render), [{value:'', label:''}]);
  assert.deepEqual(await menuFromOutput('ab', {filter:'(?P<group_2>a)(b)', valueFormat:'{{.group_2}}'}, render), [{value:'b', label:'b'}]);
});

test('missing map index returns the string zero and all menu formats parse before output is read', async () => {
  assert.deepEqual(await menuFromOutput('x', {filter:'no-match', valueFormat:'{{index . "missing"}}/{{.missing}}'}, render), [{value:'/<no value>', label:'/<no value>'}]);
  for (const valueFormat of ['{{if true}}', '{{quote "x"}}', '{{if false}}{{runCommand "x"}}{{end}}', '{{red "x"}}']) {
    await assert.rejects(menuFromOutput('', {valueFormat}, render), /template|Unclosed|function/i);
  }
  await assert.rejects(menuFromOutput('', {labelFormat:'{{if true}}'}, render), /Missing end/);
  assert.deepEqual(await menuFromOutput('', {labelFormat:'{{red .group_0}}'}, render), []);
});

test('menu formatting snapshots options and captures across awaited render callbacks', async () => {
  const prompt = {filter:'(?P<name>.+)', valueFormat:'{{.name}}', labelFormat:'Name: {{.name}}'}, seen = [];
  const items = await menuFromOutput('one\ntwo', prompt, async (text, data, options) => {
    seen.push(options.kind); const value = await render(text, data, options);
    prompt.labelFormat = 'changed'; data.name = 'mutated'; return value;
  });
  assert.deepEqual(items, [{value:'one', label:'Name: one'}, {value:'two', label:'Name: two'}]);
  assert.deepEqual(seen, ['value','label','value','label']);
});

test('regex rune, dot, end anchor and ASCII whitespace behavior match RE2 per line', async () => {
  const check = async (text, filter) => (await menuFromOutput(text, {filter, valueFormat:'{{.group_0}}'}, render))[0].value;
  assert.equal(await check('😀x', '^.'), '😀');
  assert.equal(await check('x\ry', 'x.y'), 'x\ry');
  assert.equal(await check('x\u2028y', 'x.y'), 'x\u2028y');
  assert.equal(await check('x\r', 'x$'), '<no value>');
  assert.equal(await check('x\u00a0y', 'x\\sy'), '<no value>');
  assert.equal(await check('x y', 'x\\sy'), 'x y');
  assert.equal(await check('HELLO', '(?i)hello'), 'HELLO');
  assert.equal(await check('x.y', '\\Qx.y\\E'), 'x.y');
  assert.equal(await check('😀', '\\x{1f600}'), '😀');
});

test('Go TrimSpace includes U+0085 and preserves U+FEFF', async () => {
  assert.deepEqual(await menuFromOutput('x', {filter:'x', valueFormat:'\u0085 value \u0085'}, render), [{value:'value', label:'value'}]);
  assert.deepEqual(await menuFromOutput('x', {filter:'x', valueFormat:'\ufeffvalue\ufeff'}, render), [{value:'\ufeffvalue\ufeff', label:'\ufeffvalue\ufeff'}]);
});

test('incompatible regex syntax fails explicitly, including on empty output', async () => {
  for (const filter of ['(?=a)', '(?<=a)', '(a)\\1', '(?i:a)', '[[:alpha:]]', '\\p{L}', '(a+)+', '(a|aa)+', 'a{1001}', '\\u0061']) {
    await assert.rejects(menuFromOutput('', {filter, valueFormat:'{{.group_0}}'}, render), /Unsupported menu filter/);
  }
  await assert.rejects(menuFromOutput('a', {filter:'('}, render), /unclosed group/);
  await assert.rejects(menuFromOutput('a', {filter:'['}, render), /unclosed character class/);
});

test('missingKey default preserves Go nil errors and strict custom-command defaults', async () => {
  assert.equal(await renderTemplate('{{.absent.deep}}/{{if .absent}}yes{{else}}no{{end}}', {}, {missingKey:'default'}), '<no value>/no');
  assert.equal(await renderTemplate('{{.absent}}', new Map(), {missingKey:'default'}), '<no value>');
  await assert.rejects(renderTemplate('{{.absent}}', {}), /Missing field/);
  await assert.rejects(renderTemplate('{{.nil.deep}}', {nil:null}, {missingKey:'default'}), /from nil/);
  await assert.rejects(renderTemplate('ok', {}, {missingKey:'invalid'}), /missingKey/);
});
