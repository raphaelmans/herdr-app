// Run with: node --experimental-vm-modules --test mods/git/*.test.js
// The host is mocked; every Git command runs in a disposable real repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import vm from 'node:vm';

const source = dirname(fileURLToPath(import.meta.url));
const elements = [];
function element() {
  const record = {_children:[],events:{}};
  const proxy = new Proxy(record, {get(obj,key) {
    if (key in obj) return obj[key];
    if (key === 'then') return undefined;
    return (...args) => {
      if (key === 'when') { if (args[0]) args[1](proxy); }
      else if (key === 'child') obj._children.push(args[0]);
      else if (key === 'children') obj._children.push(...args[0]);
      else if (key === 'id') obj._id = args[0];
      else if (String(key).startsWith('on_')) obj.events[key] = args.at(-1);
      return proxy;
    };
  }}); elements.push(proxy); return proxy;
}
function input() {
  let value = ''; const handlers = {};
  return {value:()=>value, set_value(v){value=v;}, focus(){handlers.focus?.({},cxCurrent);}, on(k,f){handlers[k]=f;}, release(){}};
}
let cxCurrent;
async function harness(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'herdr-workflows-')));
  const git = (args,input) => execFileSync('git',args,{cwd:dir,input,encoding:'utf8',stdio:'pipe'});
  const put = (path,text) => fs.writeFileSync(join(dir,path),text);
  git(['init','-q','-b','main']); git(['config','user.name','Test']); git(['config','user.email','test@example.invalid']);git(['config','commit.gpgsign','false']);
  const tasks=[]; let hostChecking=true;
  const cx = {notify(){}, stop_propagation(){}, bind_keys(){}, write_to_clipboard(){}, focus_handle:()=>({focus(){if (app) app.typing=false;}}),
    timer:{every(){},after(_ms,cb){if(!hostChecking)queueMicrotask(()=>cb(cx));return 1;}},spawn(f){const task=Promise.resolve().then(()=>f(cx));tasks.push(task);return task;}};
  cxCurrent=cx; let app;
  const host={
    exec:async(command,args,opts={})=>{
      assert.ok(opts.cwd?.startsWith(dir),`Git escaped fixture: ${opts.cwd}`);
      const r=spawnSync(command,args,{cwd:opts.cwd,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}});
      if(r.error)throw r.error; return {code:r.status,stdout:r.stdout,stderr:r.stderr};
    },
    checking:()=>hostChecking, props:()=>({folder:dir}), spaces:()=>[],panes:()=>[],focused:()=>null,
    theme:()=>new Proxy({},{get:()=> '#556677'}), settings:()=>({font_family:'monospace'}), shared:()=>null,setShared(){},
    run(){}, appHome:()=>dir,closeOverlay(){},openOverlay(){return 'test';},hc(){throw new Error('Unexpected terminal launch in test');},
    readTextFile:async(path)=>{assert.ok(path.startsWith(dir));return fs.existsSync(path)?fs.readFileSync(path,'utf8'):null;},
    writeTextFile:async(path,text,expected)=>{assert.ok(path.startsWith(dir));assert.equal(fs.readFileSync(path,'utf8'),expected);fs.writeFileSync(path,text);},
    watchFolder:()=>{throw new Error('No native watcher in test');},
  };
  const inputFactory={new:input}, scroll={new:()=>({scroll_to_item(){}})};
  const kit={View:class {},div:element,svg:element,image:element,PathBuilder:{new:element}};
  const base={h_flex:element,v_flex:element,InputState:inputFactory,Input:{new:element},TextareaState:inputFactory,Textarea:{new:element},ScrollHandle:scroll,VirtualListScrollHandle:scroll,Scrollbar:{vertical:element},TextView:{markdown:element},v_virtual_list:element};
  const context=vm.createContext({console,localStorage:{getItem:()=>null,setItem(){}},setTimeout});
  const modules=new Map();
  async function load(path) {
    if(modules.has(path))return modules.get(path);
    const exports=path==='herdr'?host:path==='gpui-kit'?kit:path==='gpui-base'?base:path==='fs/promises'?{mkdir:async()=>{},exists:async()=>true,writeFile:async()=>{}}:null;
    const mod=exports?new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v);},{context,identifier:path}):new vm.SourceTextModule(fs.readFileSync(path,'utf8'),{context,identifier:path});
    modules.set(path,mod);
    await mod.link((name,parent)=>load(name.startsWith('.')?resolve(dirname(parent.identifier),name):name));return mod;
  }
  async function flush(){let rounds=0;while(tasks.length){if(++rounds>100)throw new Error('Refresh loop');await Promise.all(tasks.splice(0));}}
  async function refresh(){app.refresh(cx,true);await flush();assert.equal(app.error,null);}
  async function key(key,modifiers={}){app.keys({key,key_char:key.length===1?key:undefined,modifiers},cx);await flush();}
  try {
    const mod=await load(join(source,'main.js'));await mod.evaluate(); app=new mod.namespace.default(); app.init({folder:dir},cx);hostChecking=false;
    await fn({dir,git,put,app,cx,flush,refresh,key});
  } finally {app?.close();fs.rmSync(dir,{recursive:true,force:true});}
}

test('diff keys stage a single line, switch sides, and unstage it',()=>harness(async({git,put,app,refresh,key})=>{
  put('f','a\nb\nc\nd\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\nc\nD\n');await refresh();
  app.tree=false;app.layoutFiles();await key('enter');assert.ok(app.patch);assert.equal(app.main,true);
  await key('a');app.cursor=app.patch.changes.find(n=>app.patch.lines[n]==='+B');await key('space');
  assert.equal(app.note,null);assert.equal(git(['show',':f']),'a\nb\nB\nc\nd\n');
  await key('tab');assert.equal(app.shownSide,'staged');app.cursor=app.patch.changes[0];await key('space');
  assert.equal(git(['show',':f']),'a\nb\nc\nd\n');
}));

test('fresh untracked file selection never adds other files',()=>harness(async({git,put,app,refresh,key})=>{
  put('a file ü.txt','first\nsecond\nthird\n');put('other','leave me');await refresh();app.tree=false;app.layoutFiles();
  await key('enter');await key('a');app.cursor=app.patch.changes[1];await key('space');
  assert.equal(app.note,null);assert.equal(git(['show',':a file ü.txt']),'second\n');assert.equal(git(['ls-files','-z']),'a file ü.txt\0');
}));

test('branch views include refs, worktrees and reflog and render menus',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','feature']);git(['tag','v1']);git(['remote','add','origin','https://example.invalid/repo.git']);
  await refresh();assert.equal(app.tags[0].name,'v1');assert.equal(app.worktrees.length,1);assert.equal(app.remotes[0].name,'origin');assert.ok(app.reflog.length);
  await key('3');await key(']');assert.equal(app.branchView,'remotes');assert.equal(app.item().name,'origin');
  app.render(cx);await key('m');assert.ok(app.menu.items.some(x=>x.label==='Add remote…'));app.render(cx);await key('escape');
  await key('4');await key(']');assert.equal(app.commitView,'reflog');await key('m');app.render(cx);
}));

test('commit with no staged changes preserves the draft without staging everything',()=>harness(async({git,put,app,cx,refresh})=>{
  put('f','one');await refresh();app.ask2('commit','Commit summary',cx);app.message='keep draft';app.submit(cx);
  assert.equal(git(['ls-files']), '');assert.equal(app.prompt.kind,'commit');assert.equal(app.message,'keep draft');
  app.cancelPrompt(cx);app.ask2('commit','Commit summary',cx);assert.equal(app.message,'keep draft');
}));

test('native rebase plan applies reword and drop and can undo and redo',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const name of ['a','b','c']){put(name,name);git(['add','.']);git(['commit','-qm',name]);}
  await refresh();const before=git(['rev-parse','HEAD']).trim();const cm=app.commits[1];
  app.startRebase(cm,cx,{action:'reword',message:'renamed safely'});await flush();assert.ok(app.plan,app.note);app.render(cx);
  app.plan.entries[1].action='drop';app.applyPlan(cx);const pending=app.pending;app.pending=null;pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['log','-1','--format=%s']).trim(),'renamed safely');assert.equal(git(['ls-files']).trim(),'a\nb');
  app.undo(false,cx);app.pending.then(cx);await flush();assert.equal(git(['rev-parse','HEAD']).trim(),before);
  app.undo(true,cx);app.pending.then(cx);await flush();assert.equal(git(['log','-1','--format=%s']).trim(),'renamed safely');
}));

test('conflict resolution changes one conflict and detects merge state',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);
  try{git(['merge','other']);}catch{}await refresh();assert.equal(app.operation,'merge');app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();assert.equal(app.conflicts.conflicts.length,1);
  app.render(cx);app.resolveHunk('both',cx);await flush();assert.equal(app.note,null);assert.equal(fs.readFileSync(join(app.root,'f'),'utf8'),'ours\ntheirs\n');
  assert.ok(git(['status','--porcelain']).startsWith('UU')); // explicit staging marks it resolved
  app.operationMenu(cx);assert.ok(app.menu.items.some(x=>x.label==='Abort…'));app.render(cx);
}));

test('stale diff cannot change the index',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\n');await refresh();app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();
  put('f','a\nnewer\n');app.applySelection(false,cx);await flush();assert.match(app.note,/changed since/);assert.equal(git(['diff','--cached']),'');
}));

test('worktree creation and repository navigation stay in the selected repository',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);await refresh();
  const path=join(dir,'second checkout');app.perform('Create worktree', [['worktree','add','-b','second','--',path]],cx);await flush();assert.equal(app.note,null);assert.equal(app.worktrees.length,2);
  app.switchRepository(path,cx);await flush();assert.equal(app.root,path);assert.equal(app.branch.name,'second');assert.equal(app.repoStack.length,1);
  app.location=app.repoStack.pop();app.resetRepository(cx);await flush();assert.equal(app.root,dir);
  app.perform('Remove worktree',[['worktree','remove','--',path]],cx);await flush();assert.equal(app.note,null);assert.equal(app.worktrees.length,1);
}));

test('renaming a stash keeps its contents and stale stash references cannot be dropped',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);put('f','first');git(['stash','push','-m','first']);await refresh();
  let st=app.stashes[0];const tree=git(['rev-parse',`${st.hash}^{tree}`]);app.stashAction('rename',st,cx,'new name');await flush();assert.equal(app.note,null);assert.equal(app.stashes.length,1);assert.equal(app.stashes[0].subject,'new name');assert.equal(git(['rev-parse',`${app.stashes[0].hash}^{tree}`]),tree);
  st=app.stashes[0];put('f','second');git(['stash','push','-m','second']);app.stashAction('drop',st,cx);await flush();assert.match(app.note,/stash list changed/);assert.equal(app.stashes.length,2);
}));

test('amending an old commit replays descendants and includes only staged changes',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const name of ['a','b','c']){put(name,name);git(['add','.']);git(['commit','-qm',name]);}
  put('b','changed b');git(['add','b']);await refresh();app.amendCommit(app.commits[1],cx);await flush();assert.equal(app.note,null);
  assert.equal(git(['rev-list','--count','HEAD']).trim(),'3');assert.equal(git(['show','HEAD:b']),'changed b');assert.equal(git(['show','HEAD^:b']),'changed b');assert.equal(git(['status','--porcelain']),'');
}));

test('copied commits cherry-pick in ancestry order despite marking order and backdated timestamps',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','feature']);put('f','base\none\n');git(['commit','-qam','one']);put('f','base\none\ntwo\n');git(['commit','-qam','two']);await refresh();
  execFileSync('git',['commit','--amend','--no-edit'],{cwd:dir,env:{...process.env,GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},stdio:'pipe'});await refresh();
  const copied=[app.commits[0],app.commits[1]];git(['switch','-q','main']);await refresh();for(const cm of copied)app.copied.set(cm.hash,cm);
  const action=app.commitActions(app.commits[0],cx).filter(Boolean).find(a=>a[1]==='V');action[2](cx);app.pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'base\none\ntwo\n');assert.equal(app.copied.size,0);
}));

test('local bare remote supports tag push and remote branch tracking',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  const remote=join(dir,'upstream.git');execFileSync('git',['init','--bare','-q',remote]);put('f','base');git(['add','f']);git(['commit','-qm','base']);git(['remote','add','origin',remote]);git(['push','-qu','origin','main']);git(['tag','v1']);await refresh();
  assert.ok(app.remoteBranches.some(r=>r.name==='origin/main'));
  app.perform('Push tag',[['push','origin','refs/tags/v1']],cx,{network:true});await flush();assert.equal(app.note,null);
  assert.ok(git(['ls-remote','--tags','origin']).includes('refs/tags/v1'));
  app.perform('Track remote branch',[['switch','--track','-c','tracked','refs/remotes/origin/main']],cx);await flush();assert.equal(app.note,null);assert.equal(app.branch.upstream,'origin/main');
}));

test('large diff disables partial actions without parsing an incomplete patch',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f',('long line '.repeat(20)+'\n').repeat(5000));await refresh();app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();
  assert.equal(app.patch,null);assert.equal(app.patchTruncated,true);app.applySelection(false,cx);assert.match(app.note,/too large/);assert.equal(git(['diff','--cached']),'');
}));

for(const split of [false,true])test(`custom patch ${split?'splits into a new commit':'removes changes from an old commit'}`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\nc\nd\ne\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\nc\nD\ne\n');git(['commit','-qam','two changes']);put('later','later');git(['add','.']);git(['commit','-qm','later']);await refresh();
  const cm=app.commits[1];app.panel='commits';app.openChangedFiles(cm,cx);await flush();assert.equal(app.detail.items.length,1);app.openDetailFile(0,cx);await flush();assert.ok(app.historyPatch?.patch);
  app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);assert.equal(app.customPatch.parts.size,1);
  app.rewritePatch(split?'split change':null,cx);app.pending.then(cx);await flush();assert.equal(app.note,null);
  assert.equal(git(['rev-list','--count','HEAD']).trim(),split?'4':'3');
  assert.equal(git(['show','HEAD:f']),split?'a\nB\nc\nD\ne\n':'a\nb\nc\nD\ne\n');
  if(split)assert.equal(git(['show','HEAD~2:f']),'a\nb\nc\nD\ne\n');
  assert.equal(git(['status','--porcelain']),'');
}));

test('stash file view includes tracked and untracked file patches',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('tracked','base\n');git(['add','.']);git(['commit','-qm','base']);put('tracked','changed\n');put('untracked','fresh\n');git(['stash','push','-u','-m','both']);await refresh();
  app.panel='stash';app.openChangedFiles(app.stashes[0],cx,true);await flush();assert.equal(app.detail.items.length,2);
  for(let i=0;i<app.detail.items.length;i++){app.openDetailFile(i,cx);await flush();assert.ok(app.historyPatch?.patch?.hunks.length,JSON.stringify(app.rows));}
}));

test('rebase cannot apply after HEAD changes during plan review',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const name of ['a','b']){put(name,name);git(['add','.']);git(['commit','-qm',name]);}await refresh();app.startRebase(app.commits[0],cx);await flush();
  put('c','c');git(['add','.']);git(['commit','-qm','newer']);const newer=git(['rev-parse','HEAD']);app.applyPlan(cx);app.pending.then(cx);await flush();
  assert.match(app.note,/HEAD changed/);assert.equal(git(['rev-parse','HEAD']),newer);
}));

test('history pages keep older commits reachable without growing the loaded list',()=>harness(async({git,app,cx,refresh,flush})=>{
  let stream='blob\nmark :1\ndata 1\nx\n';
  for(let i=0;i<305;i++){const message=`commit ${i}`;stream+=`commit refs/heads/main\ncommitter Test <test@example.invalid> ${1700000000+i} +0000\ndata ${message.length}\n${message}\nM 100644 :1 f\n\n`;}
  git(['fast-import','--quiet'],stream);git(['reset','--hard']);await refresh();assert.equal(app.commits.length,300);assert.equal(app.moreCommits,true);
  app.pageCommits(1,cx);await flush();assert.equal(app.commits.length,5);assert.equal(app.moreCommits,false);assert.equal(app.commits[4].subject,'commit 0');
  app.pageCommits(-1,cx);await flush();assert.equal(app.commits[0].subject,'commit 304');
}));

test('custom patch can split a root commit',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\nc\n');git(['add','.']);execFileSync('git',['commit','-qm','root'],{cwd:dir,env:{...process.env,GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},stdio:'pipe'});await refresh();
  app.panel='commits';app.openChangedFiles(app.commits[0],cx);await flush();app.openDetailFile(0,cx);await flush();
  app.lineMode=true;app.cursor=app.historyPatch.patch.changes[1];app.addCustomPatch(cx);app.rewritePatch('split root',cx);app.pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'a\nb\nc\n');assert.equal(git(['show','HEAD^:f']),'a\nc\n');
}));
