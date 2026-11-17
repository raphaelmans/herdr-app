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
      else if (String(key).startsWith('on_')) {obj.events[key] = args.at(-1);if(['on_mouse_down','on_mouse_up'].includes(key))obj.events[`${key}:${args[0]}`]=args.at(-1);}
      return proxy;
    };
  }}); elements.push(proxy); return proxy;
}
function input() {
  let value = ''; const handlers = {};
  return {handlers,value:()=>value, set_value(v){value=v;}, focus(){handlers.focus?.({},cxCurrent);}, on(k,f){handlers[k]=f;}, release(){}};
}
let cxCurrent;
async function harness(fn) {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'herdr-workflows-')));
  const git = (args,input) => execFileSync('git',args,{cwd:dir,input,encoding:'utf8',stdio:'pipe'});
  const put = (path,text) => fs.writeFileSync(join(dir,path),text);
  git(['init','-q','-b','main']); git(['config','user.name','Test']); git(['config','user.email','test@example.invalid']);git(['config','commit.gpgsign','false']);
  const clipboard=[],tasks=[],overlays=[],notifications=[];let overlaySequence=0,hostEnvironment={}; let hostChecking=true, held=null, failing=null,core=null,afterExec=null;
  // hold() stops every host command until its result is called: a wait can be looked at.
  const hold=()=>{let open;held=new Promise(r=>{open=r;});return ()=>{held=null;open();};};
  const tick=()=>new Promise(r=>setImmediate(r));
  const cx = {notify(){}, stop_propagation(){}, bind_keys(){}, write_to_clipboard(value){clipboard.push(value);}, focus_handle:()=>({focus(){if (app) app.typing=false;}}),
    new(Class,props){const view=new Class();view.init?.(props,cx);return {view,release(){this.released=true;}};},
    timer:{every(){},after(_ms,cb){if(!hostChecking)queueMicrotask(()=>cb(cx));return 1;}},spawn(f){const task=Promise.resolve().then(()=>f(cx));tasks.push(task);return task;}};
  cxCurrent=cx; let app;
  const host={
    exec:async(command,args,opts={})=>{
      if(held)await held;
      if(failing?.(command,args))throw new Error('host went away');
      assert.ok(opts.cwd?.startsWith(dir),`Git escaped fixture: ${opts.cwd}`);
      const r=spawnSync(command,args,{cwd:opts.cwd,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,...hostEnvironment,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',CONFIG_DIR:join(dir,'.git','fixture-config'),LG_CONFIG_FILE:''}});
      if(r.error)throw r.error; const result={code:r.status,stdout:r.stdout,stderr:r.stderr};await afterExec?.(command,args,opts,result);return result;
    },
    checking:()=>hostChecking, props:()=>({folder:dir}), spaces:()=>[],panes:()=>[],focused:()=>null,
    theme:()=>new Proxy({},{get:()=> '#556677'}), settings:()=>({font_family:'monospace'}), shared:()=>null,setShared(){},
    run(){}, appHome:()=>dir,closeOverlay(id){overlays.push({closed:id});},openOverlay(spec){overlays.push(spec);return ++overlaySequence===1?'test':`test-${overlaySequence}`;},notify(n){notifications.push(n);return 'notice';},hc(args){if(core)return core(args);throw new Error('Unexpected terminal launch in test');},
    readTextFile:async(path)=>{assert.ok(path.startsWith(dir));return fs.existsSync(path)?fs.readFileSync(path,'utf8'):null;},
    writeTextFile:async(path,text,expected)=>{assert.ok(path.startsWith(dir));assert.equal(fs.readFileSync(path,'utf8'),expected);fs.writeFileSync(path,text);},
    watchFolder:()=>{throw new Error('No native watcher in test');},
  };
  const inputFactory={new:input}, scroll={new:()=>({scroll_to_item(){}})};
  const kit={View:class {},div:element,svg:element,image:element,PathBuilder:{new:element,stroke:element}};
  const base={h_flex:element,v_flex:element,h_resizable:element,resizable_panel:element,Button:{new:element},InputState:inputFactory,Input:{new:element},TextareaState:inputFactory,Textarea:{new:element},ScrollHandle:scroll,VirtualListScrollHandle:scroll,Scrollbar:{vertical:element},TextView:{markdown:element},v_virtual_list:(...args)=>{const e=element();e.virtualArgs=args;return e;}};
  const storage=new Map();
  const context=vm.createContext({console,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},window:{paint_path:element},setTimeout});
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
    await fn({dir,git,put,app,cx,flush,refresh,key,hold,tick,clipboard,overlays,notifications,failOn:(f)=>{failing=f;},setCore:f=>{core=f;},setEnvironment:value=>{hostEnvironment=value;},afterExec:f=>{afterExec=f;}});
  } finally {app?.close();fs.rmSync(dir,{recursive:true,force:true});}
}

async function confirmRecovery(app,cx,flush,redo=false) {
  app.undo(redo,cx);await flush();assert.ok(app.pending,app.note??'Recovery confirmation missing');
  const pending=app.pending;app.pending=null;pending.then(cx);await flush();
}

function promptField(app) {
  const before=elements.length;app.modal(app.colors());
  const field=elements.slice(before).find(e=>typeof e._id==='string'&&e._id.startsWith('git-prompt-field:'));
  assert.ok(field,'The prompt must have a mounted input frame');return field;
}
function mountPrompt(app,cx) {
  const field=promptField(app);field.events.on_size_change({width:484,height:34},cx);return field;
}

test('prompt layout gives the field focus once and Escape retains its draft',()=>harness(async({app,cx,key})=>{
  app.promptValue('Branch name','topic',()=>{},cx);
  let focuses=0;const focus=app.input.focus;app.input.focus=()=>{focuses++;focus();};
  assert.equal(Boolean(app.typing),false);const field=mountPrompt(app,cx);assert.equal(focuses,1);assert.equal(app.typing,true);
  app.input.set_value('topic draft');app.input.handlers.change({},cx);
  await key('escape');assert.equal(app.typing,false);assert.equal(app.message,'topic draft');assert.ok(app.prompt);
  field.events.on_size_change({width:400,height:34},cx);assert.equal(focuses,1);assert.equal(app.typing,false);
  await key('escape');assert.equal(app.prompt,null);
}));

for(const action of ['escape','description','input'])test(`prompt layout respects an earlier ${action} focus action`,()=>harness(async({app,cx})=>{
  app.ask2('commit','Commit',cx);const field=promptField(app);
  let focuses=0;const focus=app.input.focus;app.input.focus=()=>{focuses++;focus();};
  if(action==='escape'){app.typing=true;app.keys({key:'escape',modifiers:{}},cx);assert.equal(app.typing,false);}
  if(action==='description')app.bodyInput.focus();
  if(action==='input')app.input.focus();
  const before=focuses;field.events.on_size_change({width:484,height:34},cx);
  assert.equal(focuses,before);assert.ok(app.prompt);
  if(action==='escape')assert.equal(app.typing,false);
}));

for(const action of ['cancel','submit','replace','close'])test(`delayed prompt layout cannot take focus after ${action}`,()=>harness(async({app,cx})=>{
  app.promptValue('First','first',()=>{},cx);const old=promptField(app);
  let focuses=0;const focus=app.input.focus;app.input.focus=()=>{focuses++;focus();};
  if(action==='cancel')app.cancelPrompt(cx);
  if(action==='submit')app.submit(cx);
  if(action==='replace')app.promptValue('Second','second',()=>{},cx);
  if(action==='close')app.close();
  old.events.on_size_change({width:484,height:34},cx);assert.equal(focuses,0);
  if(action==='replace'){const next=mountPrompt(app,cx);assert.notEqual(next._id,old._id);assert.equal(focuses,1);assert.equal(app.message,'second');}
}));

test('restoring a commit draft focuses its new input mount and ignores the earlier mount',()=>harness(async({app,cx})=>{
  app.commitDraft='Saved summary';app.ask2('commit','Commit',cx);const first=mountPrompt(app,cx),original=app.prompt;
  app.commitBody='Saved body';app.bodyInput.set_value(app.commitBody);app.commitCoAuthor(cx);mountPrompt(app,cx);
  app.cancelPrompt(cx);assert.equal(app.prompt,original);assert.equal(app.message,'Saved summary');assert.equal(app.commitBody,'Saved body');
  let focuses=0;const focus=app.input.focus;app.input.focus=()=>{focuses++;focus();};
  first.events.on_size_change({width:484,height:34},cx);assert.equal(focuses,0);
  const restored=mountPrompt(app,cx);assert.notEqual(restored._id,first._id);assert.equal(focuses,1);assert.equal(app.typing,true);
}));

function externalFixture({dir,git,put,setEnvironment},os={}) {
  put('f','one\ntwo\nthree\n');git(['add','f']);git(['commit','-qm','base']);put('f','one\nTWO\nthree\n');
  setEnvironment({SHELL:'/bin/bash',TMPDIR:join(dir,'.git')});
  put('.git/editor.sh','printf "%s\\0" "$@" > .git/editor-args\n');
  const settings={edit:'sh .git/editor.sh edit {{filename}}',editAtLine:'sh .git/editor.sh line {{line}} {{filename}}',editAtLineAndWait:'sh .git/editor.sh wait {{line}} {{filename}}',openDirInEditor:'sh .git/editor.sh directory {{dir}}',open:'sh .git/editor.sh open {{filename}}',editInTerminal:false,...os};
  put('.git/lazygit.yml',JSON.stringify({git:{autoFetch:false},promptToReturnFromSubprocess:false,os:settings}));
  return ()=>fs.readFileSync(join(dir,'.git/editor-args'),'utf8').split('\0').slice(0,-1);
}
async function focusEditorFile(app,cx,flush,path='f') {
  app.panel='files';app.fileView='files';app.main=false;app.tree=false;app.layoutFiles();app.sel.files=app.list().findIndex(it=>it.file?.path===path);app.reload(cx);await flush();
}
async function focusEditorHunk(app,cx,flush,side='unstaged') {
  await focusEditorFile(app,cx,flush);app.diffSide=side;app.focusDiff(cx);await flush();app.lineMode=true;app.cursor=app.patch.lines.indexOf('-two');assert.ok(app.cursor>=0);
}

test('external editor and opener preserve literal filenames and keep the Git dialog open',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key}=h,read=externalFixture(h);
  const path="odd ' café $HOME `id` $(id) {{line}}.txt";put(path,'new file\n');await refresh();await focusEditorFile(app,cx,flush,path);
  await key('e');assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(dir,path)]);assert.ok(!app.closed);assert.equal(app.busy,null);
  await key('o');assert.equal(app.note,null);assert.deepEqual(read(),['open',join(dir,path)]);assert.equal(git(['show',':f']),'one\ntwo\nthree\n');
}));
test('external editor supports file ranges and refuses opening multiple files',()=>harness(async h=>{
  const {dir,put,app,cx,refresh,flush,key}=h,read=externalFixture(h);put('second','new\n');await refresh();await focusEditorFile(app,cx,flush);
  app.rangeAnchors[app.viewKey()]=0;app.sel.files=1;await key('e');assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(dir,'f'),join(dir,'second')]);
  await key('o');assert.match(app.note,/Select one file/);
}));
test('external editor uses remapped keys, nullable terminal override and captured remote machine',()=>harness(async h=>{
  const {dir,app,cx,refresh,flush,key,setCore}=h,read=externalFixture(h,{editInTerminal:true});app.location={...app.location,on:'fixture-machine'};await refresh();await focusEditorFile(app,cx,flush);
  app.lazygitConfig.keybinding={universal:{edit:'<ctrl+i>'}};const calls=realGitTerminal(dir,setCore);
  await key('e');assert.equal(calls.length,0);await key('i',{control:true});assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(dir,'f')]);
  const launch=calls.find(args=>args[0]==='run');assert.equal(launch[launch.indexOf('--on')+1],'fixture-machine');assert.ok(calls.some(args=>args[0]==='rm'&&args[1]==='fixture-machine/t-merge'));
}));
test('external editor preparation is visible and a closed dialog never launches it',()=>harness(async h=>{
  const {app,cx,refresh,flush,hold,tick}=h;externalFixture(h);await refresh();await focusEditorFile(app,cx,flush);const release=hold();app.editSelectedFiles(cx);await tick();assert.equal(app.busy,'Preparing editor');assert.equal(app.opening,app.busy);app.render(cx);app.close();release();await flush();assert.equal(app.busy,null);assert.equal(app.gitTask,undefined);
}));
test('external staged and historical line edits map into current worktree contents',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key}=h,read=externalFixture(h);git(['add','f']);git(['commit','-qm','modified']);const changed=git(['rev-parse','HEAD']).trim();
  put('f','inserted\nagain\none\nTWO\nthree\n');await refresh();app.panel='commits';app.openChangedFiles({hash:changed,subject:'modified'},cx);await flush();app.openDetailFile(0,cx);await flush();app.cursor=app.rawDiffLines.indexOf('+TWO');await key('e');assert.equal(app.note,null);assert.deepEqual(read(),['line','4',join(dir,'f')]);
  app.popContext(cx);await flush();put('f','one\nOTHER\nthree\n');git(['add','f']);put('f','inserted\none\nOTHER\nthree\n');await refresh();await focusEditorFile(app,cx,flush);app.diffSide='staged';app.focusDiff(cx);await flush();app.cursor=app.rawDiffLines.indexOf('+OTHER');await key('e');assert.equal(app.note,null);assert.deepEqual(read(),['line','3',join(dir,'f')]);
}));
test('external historical editing follows the branch worktree and refuses missing files',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key}=h,read=externalFixture(h);git(['checkout','--','f']);const branchPath=join(dir,'linked');git(['worktree','add','-qb','topic',branchPath]);put('.git/info/exclude','linked/\n');await refresh();app.panel='branches';app.sel.branches=app.branches.findIndex(it=>it.name==='topic');app.openSubCommits(app.item(),cx);await flush();app.openChangedFiles(app.item(),cx);await flush();await key('e');assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(branchPath,'f')]);
  fs.unlinkSync(join(branchPath,'f'));await key('e');assert.match(app.note,/does not exist in the worktree/);assert.equal(fs.existsSync(join(branchPath,'f')),false);
  app.contexts.branches=[];app.syncContext();app.panel='files';app.fileView='worktrees';app.sel.files=app.list().findIndex(it=>it.path===branchPath);await key('o');assert.equal(app.note,null);assert.deepEqual(read(),['directory',branchPath]);
}));
test('external shell functions are sourced with aliases and quoted filenames',()=>harness(async h=>{
  const {dir,put,app,cx,refresh,flush,key}=h,functions=join(dir,".git/functions ' café.sh");
  externalFixture(h,{edit:'fixture_edit {{filename}}',shellFunctionsFile:functions});fs.writeFileSync(functions,"alias fixture_edit='sh .git/editor.sh function'\n");await refresh();await focusEditorFile(app,cx,flush);await key('e');assert.equal(app.note,null);assert.deepEqual(fs.readFileSync(join(dir,'.git/editor-args'),'utf8').split('\0').slice(0,-1),['function',join(dir,'f')]);
}));
test('external diff tool compares unstaged, staged, ref, reverse and commit contents',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);put('.git/diff.sh','cat "$1" > .git/diff-left\ncat "$2" > .git/diff-right\n');git(['config','diff.tool','fixture']);git(['config','difftool.fixture.cmd','sh .git/diff.sh "$LOCAL" "$REMOTE"']);git(['config','difftool.trustExitCode','true']);const calls=realGitTerminal(dir,setCore);
  await refresh();await focusEditorFile(app,cx,flush);await key('t',{control:true});assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'.git/diff-left'),'utf8'),'one\ntwo\nthree\n');assert.equal(fs.readFileSync(join(dir,'.git/diff-right'),'utf8'),'one\nTWO\nthree\n');
  git(['add','f']);await refresh();await key('t',{control:true});assert.equal(app.note,null);assert.ok(calls.filter(a=>a[0]==='run').at(-1).includes('--cached'));
  put('f','one\nWORK\nthree\n');await refresh();await key('t',{control:true});assert.equal(app.note,null);assert.equal(calls.filter(a=>a[0]==='run').at(-1).includes('--cached'),false);assert.equal(fs.readFileSync(join(dir,'.git/diff-left'),'utf8'),'one\nTWO\nthree\n');
  app.compareBase='HEAD';app.compareReverse=true;await key('t',{control:true});assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'.git/diff-left'),'utf8'),'one\nWORK\nthree\n');assert.equal(fs.readFileSync(join(dir,'.git/diff-right'),'utf8'),'one\ntwo\nthree\n');
  app.compareBase=null;app.compareReverse=false;git(['commit','-qm','staged']);await refresh();app.panel='commits';app.openChangedFiles(app.commits[0],cx);await flush();await key('t',{control:true});assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'.git/diff-right'),'utf8'),'one\nTWO\nthree\n');
}));
test('external diff tool uses parent-to-commit, empty-tree roots, directory and reverse refs',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);git(['add','f']);git(['commit','-qm','second']);await refresh();const calls=[];
  setCore(async args=>{calls.push(Array.from(args));return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'diff-fixture',state:'finished',exit_code:0}:args[0]==='read'?{text:''}:{})};});
  app.panel='commits';app.main=false;await key('t',{control:true});const launch=()=>calls.filter(a=>a[0]==='run').at(-1);assert.deepEqual(launch().slice(-7),['difftool','--no-prompt','--dir-diff',app.commits[1].hash,app.commits[0].hash,'--','.']);
  assert.ok(launch().includes(app.commits[1].hash));app.sel.commits=1;await key('t',{control:true});assert.ok(launch().includes('4b825dc642cb6eb9a060e54bf8d69288fbee4904'));
  app.panel='branches';app.compareBase='HEAD~1';app.compareReverse=true;await key('t',{control:true});assert.deepEqual(launch().slice(-5),['HEAD~1','refs/heads/main','-R','--','.']);
}));
test('external merge tool resolves all conflicts and leaves merge continuation available',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);git(['checkout','--','f']);put('second','base\n');git(['add','second']);git(['commit','-qm','second']);git(['switch','-qc','topic']);put('f','topic\n');put('second','topic\n');git(['commit','-qam','topic']);git(['switch','-q','main']);put('f','main\n');put('second','main\n');git(['commit','-qam','main']);try{git(['merge','--no-edit','topic']);}catch{}
  put('.git/merge.sh','cp "$1" "$2"\nprintf "%s\\n" "$2" >> .git/merge-files\n');git(['config','merge.tool','fixture']);git(['config','mergetool.fixture.cmd','sh .git/merge.sh "$REMOTE" "$MERGED"']);git(['config','mergetool.fixture.trustExitCode','true']);git(['config','mergetool.prompt','false']);git(['config','mergetool.keepBackup','false']);realGitTerminal(dir,setCore);await refresh();await focusEditorFile(app,cx,flush);await key('M');await key('m');assert.equal(app.note,null);assert.equal(git(['ls-files','-u']),'');assert.equal(app.operation,'merge');assert.equal(git(['show',':f']),'topic\n');assert.equal(git(['show',':second']),'topic\n');assert.equal(fs.readFileSync(join(dir,'.git/merge-files'),'utf8').trim().split('\n').length,2);
}));
for(const staged of [false,true])test(`external hunk editor applies authored content to the ${staged?'staged':'unstaged'} side without changing working bytes`,()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h,read=externalFixture(h);if(staged)git(['add','f']);
  put('.git/editor.sh',`printf '%s\\0' "$@" > .git/editor-args\nsed '${staged?'s/^-two$/-EDITED/':'s/^+TWO$/+EDITED/'}; s|a/f|a/other|; s|b/f|b/other|' "$3" > "$3.next" && mv "$3.next" "$3"\n`);realGitTerminal(dir,setCore);await refresh();await focusEditorHunk(app,cx,flush,staged?'staged':'unstaged');
  const refreshStates=[],original=app.refresh.bind(app);app.refresh=(...args)=>{refreshStates.push(git(['show',':f']));return original(...args);};
  await key('E');assert.equal(app.note,null);assert.equal(git(['show',':f']),'one\nEDITED\nthree\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'one\nTWO\nthree\n');assert.equal(fs.existsSync(join(dir,'other')),false);assert.equal(read()[0],'wait');assert.equal(read()[1],'5');assert.ok(refreshStates.every(text=>text==='one\nEDITED\nthree\n'));assert.equal(app.busy,null);assert.ok(fs.existsSync(app.lastEditedPatch.path));
}));
for(const [kind,body,error]of [['exit','exit 7','exited 7'],['missing','rm "$3"','missing'],['malformed',`printf '@@ broken\\n-old\\n+new\\n' > "$3"`,'Invalid edited hunk'],['empty',': > "$3"','No valid patches']])test(`external hunk editor retains recoverable state after ${kind}`,()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);put('.git/editor.sh',body+'\n');realGitTerminal(dir,setCore);await refresh();await focusEditorHunk(app,cx,flush);await key('E');assert.match(app.note,new RegExp(error,'i'));assert.match(app.note,/Patch files kept/);assert.equal(git(['show',':f']),'one\ntwo\nthree\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'one\nTWO\nthree\n');assert.equal(app.busy,null);if(kind!=='missing')assert.ok(fs.existsSync(app.lastEditedPatch.path));
}));
test('external hunk editor honors remapping and refuses a stale identity',()=>harness(async h=>{
  const {dir,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);const calls=realGitTerminal(dir,setCore);await refresh();await focusEditorHunk(app,cx,flush);app.lazygitConfig.keybinding={main:{editSelectHunk:'<ctrl+h>'}};await key('E');assert.equal(calls.length,0);put('f','one\ntwo\nthree\n');await key('h',{control:true});assert.match(app.note,/no longer present/);assert.equal(calls.length,0);
}));
test('external hunk editor never applies after closing and retains the patch with a notification',()=>harness(async h=>{
  const {dir,git,app,cx,refresh,flush,key,setCore,notifications}=h;externalFixture(h);await refresh();await focusEditorHunk(app,cx,flush);
  setCore(async args=>{if(args[0]==='run'){app.close();return {code:0,stderr:'',stdout:JSON.stringify({address:'hunk-closed',state:'finished',exit_code:0})};}return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='read'?{text:''}:{})};});
  await key('E');assert.equal(git(['show',':f']),'one\ntwo\nthree\n');assert.ok(fs.existsSync(app.lastEditedPatch.path));assert.ok(notifications.some(n=>n.title==='Edited hunk kept'&&n.body.includes('not applied')));assert.equal(app.busy,null);
}));
test('external hunk editor rejects an incompatible concurrent index change',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);realGitTerminal(dir,setCore);await refresh();await focusEditorHunk(app,cx,flush);
  const terminal=app.gitTerminal.bind(app);app.gitTerminal=async(...args)=>{const result=await terminal(...args);put('f','CONCURRENT\n');git(['add','f']);put('f','one\nTWO\nthree\n');return result;};
  await key('E');assert.match(app.note,/patch does not apply/);assert.equal(git(['show',':f']),'CONCURRENT\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'one\nTWO\nthree\n');assert.ok(fs.existsSync(app.lastEditedPatch.path));
}));
test('external hunk editor keeps input blocked through its final refresh',()=>harness(async h=>{
  const {dir,git,app,cx,refresh,flush,hold,tick,setCore}=h;externalFixture(h);realGitTerminal(dir,setCore);await refresh();await focusEditorHunk(app,cx,flush);
  const original=app.refresh.bind(app);let release;app.refresh=(...args)=>{if(!app.externalJob&&!release)release=hold();return original(...args);};
  try{
    app.editHunk(cx);for(let i=0;i<20&&!release;i++)await tick();assert.ok(release);assert.equal(app.busy,'Refreshing repository');assert.equal(git(['show',':f']),'one\nTWO\nthree\n');
    app.keys({key:'d',key_char:'d',modifiers:{}},cx);assert.ok(!app.pending);assert.equal(app.busy,'Refreshing repository');
  }finally{app.refresh=original;release?.();await flush();}
  assert.equal(app.busy,null);assert.equal(app.settling,null);
}));
for(const kind of ['new','deleted','quoted'])test(`external hunk editor safely applies ${kind} paths`,()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);let path='f';
  if(kind==='new'){git(['checkout','--','f']);path='new';put(path,'new\n');}
  if(kind==='deleted')fs.unlinkSync(join(dir,'f'));
  if(kind==='quoted'){git(['checkout','--','f']);path="quote ' café\tline\nname";put(path,'one\ntwo\nthree\n');git(['add','--',path]);git(['commit','-qm','quoted']);put(path,'one\nTWO\nthree\n');}
  realGitTerminal(dir,setCore);await refresh();await focusEditorFile(app,cx,flush,path);app.focusDiff(cx);await flush();app.lineMode=true;app.cursor=app.patch.changes[0];await key('E');assert.equal(app.note,null);assert.equal(git(['show',':'+path]),kind==='new'?'new\n':kind==='deleted'?'':'one\nTWO\nthree\n');
  if(kind==='deleted')assert.equal(fs.existsSync(join(dir,path)),false);
}));
test('external commit editor uses Git configuration and refreshes the new commit',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,key,setCore}=h;externalFixture(h);git(['add','f']);put('.git/commit-editor.sh','printf "Written by commit editor\\n" > "$1"\n');git(['config','core.editor','sh .git/commit-editor.sh']);realGitTerminal(dir,setCore);await refresh();await focusEditorFile(app,cx,flush);await key('C');assert.equal(app.note,null);assert.equal(git(['log','-1','--format=%s']).trim(),'Written by commit editor');assert.equal(app.files.length,0);assert.equal(app.busy,null);
}));
for(const modifier of ['alt','shift'])test(`diff ${modifier}-click edits the clicked line without moving the existing selection`,()=>harness(async h=>{
  const {dir,app,cx,refresh,flush}=h,read=externalFixture(h);await refresh();await focusEditorFile(app,cx,flush);app.cursor=1;app.main=false;
  const before=elements.length;app.mainView(app.colors());const drawn=elements.slice(before),list=drawn.find(e=>e.events.on_item_click),container=drawn.find(e=>e._id==='git-diff-x');assert.ok(list&&container);
  const timer=cx.timer.after;let expire;cx.timer.after=(ms,fn)=>ms===200?(expire=fn,1):timer(ms,fn);
  const line=app.rawDiffLines.indexOf('+TWO');container.events.on_mouse_down({modifiers:{[modifier]:true}},cx);list.events.on_item_click(String(line),cx);assert.equal(app.cursor,1);assert.equal(app.main,false);assert.equal(app.editedLine.index,line);await flush();
  assert.equal(app.note,null);assert.deepEqual(read(),['line','2',join(dir,'f')]);expire(cx);assert.equal(app.editedLine,null);cx.timer.after=timer;
}));
test('diff modified clicks ignore metadata and busy work, while ordinary clicks keep selection behavior',()=>harness(async h=>{
  const {dir,app,cx,refresh,flush}=h,read=externalFixture(h);await refresh();await focusEditorFile(app,cx,flush);
  app.setLines(['commit deadbeef',...app.rawDiffLines]);app.clickDiff(0,{alt:true},cx);await flush();assert.equal(fs.existsSync(join(dir,'.git/editor-args')),false);
  app.busy='Another operation';app.clickDiff(1,{shift:true},cx);assert.equal(fs.existsSync(join(dir,'.git/editor-args')),false);app.busy=null;
  app.clickDiff(1,{shift:true},cx);await flush();assert.deepEqual(read(),['edit',join(dir,'f')]);
  app.clickDiff(3,{},cx);assert.equal(app.main,true);assert.equal(app.cursor,3);
}));
test('configuration editor opens the one existing file from Status and reloads its changes',()=>harness(async h=>{
  const {dir,put,app,refresh,key}=h,read=externalFixture(h);
  put('.git/editor.sh','printf "%s\\0" "$@" > .git/editor-args\nprintf "git:\\n  autoFetch: false\\n  diffContextSize: 9\\n" > "$2"\n');
  await refresh();app.panel='status';app.main=false;await key('e');
  assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(dir,'.git/lazygit.yml')]);assert.equal(app.diffContext,9);assert.equal(app.busy,null);assert.ok(!app.menu);
}));
test('configuration editor offers only existing files in layer order and honors remapping',()=>harness(async h=>{
  const {dir,put,app,cx,refresh,flush,key}=h,read=externalFixture(h);fs.mkdirSync(join(dir,'.git/fixture-config'));put('.git/fixture-config/config.yml','gui: {showFileTree: false}\n');
  await refresh();app.lazygitConfig.keybinding={universal:{editConfig:'<ctrl+i>'}};
  await key('c',{alt:true,shift:true});assert.ok(!app.menu);await key('i',{control:true});
  assert.equal(app.menu.title,'Select configuration file');assert.deepEqual(Array.from(app.menu.items,it=>it.label),[join(dir,'.git/fixture-config/config.yml'),join(dir,'.git/lazygit.yml')]);
  await key('enter');assert.equal(app.note,null);assert.deepEqual(read(),['edit',join(dir,'.git/fixture-config/config.yml')]);
  app.configOpen=true;app.main=true;await key('e');assert.ok(app.menu);await key('escape');assert.equal(app.menu,null);assert.equal(app.configOpen,true);
  app.editConfiguration(cx);await flush();app.repoKey='different-repository';await key('enter');assert.match(app.note,/repository changed/);
}));
test('configuration editor reports missing files without creating defaults and drops a closed request',()=>harness(async h=>{
  const {dir,app,cx,refresh,flush,key,hold,tick}=h;externalFixture(h);fs.unlinkSync(join(dir,'.git/lazygit.yml'));await refresh();
  await key('c',{alt:true,shift:true});assert.match(app.note,/No configuration file found/);assert.equal(app.busy,null);assert.equal(fs.existsSync(join(dir,'.git/fixture-config/config.yml')),false);
  app.render(cx);const release=hold();app.editConfiguration(cx);await tick();assert.equal(app.busy,'Preparing configuration editor');assert.equal(app.opening,app.busy);app.close();release();await flush();assert.ok(!app.menu);assert.ok(!app.gitTask);assert.equal(app.busy,null);
}));
test('configured link launcher preserves literal URLs, shell functions and target-machine routing',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,afterExec}=h;
  externalFixture(h,{openLink:'record_link {{link}}',shellFunctionsFile:join(dir,".git/functions ' café.sh")});
  put(".git/functions ' café.sh",'record_link() { printf "%s\\0" "$@" > .git/link-args; }\n');git(['remote','add','origin','git@github.com:owner/project.git']);app.location={...app.location,on:'fixture-machine'};await refresh();
  const contexts=[];afterExec((_command,args,context)=>{if(args.some(arg=>arg.includes('record_link')))contexts.push(context);});
  const read=()=>fs.readFileSync(join(dir,'.git/link-args'),'utf8').split('\0').slice(0,-1);
  const url="https://example.invalid/path?q='café'&literal=$HOME`id`$(id){{link}}";app.openLink(url,cx);await flush();assert.equal(app.note,null);assert.deepEqual(read(),[url]);
  app.openCommitWeb({hash:'abc123'},cx);await flush();assert.deepEqual(read(),['https://github.com/owner/project/commit/abc123']);
  app.createPullRequest({name:"topic/café 'quote'"},cx,'main');await flush();assert.equal(app.note,null);assert.deepEqual(read(),['https://github.com/owner/project/compare/main...topic%2Fcaf%C3%A9+%27quote%27?expand=1']);
  assert.ok(contexts.length>=3);assert.ok(contexts.every(context=>context.cwd===dir&&context.on==='fixture-machine'));assert.equal(app.busy,null);assert.equal(app.gitTask,undefined);
  app.md=[{kind:'md',text:'[fixture](https://example.invalid)'}];const first=elements.length;app.mainView(app.colors());const preview=elements.slice(first).find(element=>element.events.on_link_click);assert.ok(preview);
  preview.events.on_link_click('https://example.invalid/from-markdown',cx);await flush();assert.deepEqual(read(),['https://example.invalid/from-markdown']);
}));
test('configured link preparation and execution are visible and launcher failures clear waiting',()=>harness(async h=>{
  const {dir,put,app,cx,refresh,flush,hold,tick,afterExec}=h;externalFixture(h,{openLink:'sh .git/link.sh {{link}}'});put('.git/link.sh','printf "launcher failed" >&2; exit 9\n');await refresh();
  const release=hold();app.openLink('https://example.invalid',cx);await tick();assert.equal(app.busy,'Preparing open link');assert.equal(app.opening,app.busy);app.render(cx);
  afterExec((_command,args)=>{if(args.includes('.git/link.sh')||args.some(arg=>arg.includes('sh .git/link.sh')))assert.equal(app.busy,'Opening browser');});release();await flush();
  assert.match(app.note,/exited 9: launcher failed/);assert.equal(app.busy,null);assert.equal(app.opening,null);assert.equal(fs.existsSync(join(dir,'.git/link-args')),false);
}));
test('pull request browser and copy use the captured lookup and discard late results',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,flush,setEnvironment,afterExec,clipboard}=h;externalFixture(h,{openLink:'sh .git/editor.sh link {{link}}'});
  fs.mkdirSync(join(dir,'.git/bin'));put('.git/bin/gh','#!/bin/sh\nprintf "%s\\0" "$@" > .git/gh-args\nprintf "https://github.com/owner/project/pull/17\\n"\n');fs.chmodSync(join(dir,'.git/bin/gh'),0o700);
  setEnvironment({SHELL:'/bin/bash',TMPDIR:join(dir,'.git'),PATH:join(dir,'.git/bin')+':'+process.env.PATH});git(['remote','add','origin','git@github.com:owner/project.git']);await refresh();
  app.openPullRequest({name:'topic'},cx);await flush();assert.equal(app.note,null);assert.deepEqual(fs.readFileSync(join(dir,'.git/editor-args'),'utf8').split('\0').slice(0,-1),['link','https://github.com/owner/project/pull/17']);
  app.openPullRequest({hash:'abc123'},cx,true,true);await flush();assert.equal(clipboard.at(-1),'https://github.com/owner/project/pull/17');assert.ok(fs.readFileSync(join(dir,'.git/gh-args'),'utf8').includes('repos/owner/project/commits/abc123/pulls'));
  fs.unlinkSync(join(dir,'.git/editor-args'));afterExec(command=>{if(command==='gh')app.close();});app.openPullRequest({name:'topic'},cx);await flush();assert.equal(fs.existsSync(join(dir,'.git/editor-args')),false);assert.equal(app.busy,null);
}));
for(const cleanupFails of [false,true])test(`external terminal returns keyboard focus after ${cleanupFails?'failed':'successful'} cleanup`,()=>harness(async h=>{
  const {dir,app,cx,refresh,flush,key,setCore,notifications}=h;externalFixture(h,{editInTerminal:true});
  const calls=realGitTerminal(dir,handler=>setCore(async args=>{const result=await handler(args);return cleanupFails&&args[0]==='rm'?{code:1,stdout:'',stderr:'cleanup unavailable'}:result;}));await refresh();await focusEditorFile(app,cx,flush);
  let returned=false;const focus=app.handle.focus.bind(app.handle);app.handle.focus=()=>{assert.ok(calls.some(args=>args[0]==='rm'));returned=true;focus();};
  await key('e');assert.equal(app.note,null);assert.ok(returned);assert.equal(app.busy,null);app.handle.focus=focus;
  if(cleanupFails){assert.equal(app.gitTask.terminal,'t-merge');assert.ok(notifications.some(n=>n.body.includes('cleanup unavailable')));}
}));

function mergeFixture(git,put,{diverged=false,conflict=false}={}) {
  put('f','base\n');put('unrelated','base\n');git(['add','.']);git(['commit','-qm','base']);
  git(['switch','-qc','topic']);put('f','topic\n');git(['commit','-qam','topic']);git(['switch','-q','main']);
  if(conflict){put('f','main\n');git(['commit','-qam','main']);}
  else if(diverged){put('main-only','main\n');git(['add','main-only']);git(['commit','-qm','main']);}
}
async function openMerge(app,cx,flush,name='topic') {
  app.panel='branches';app.main=false;app.branchView='local';app.rangeAnchors.local=null;
  app.sel.branches=app.branchItems().findIndex(it=>it.name===name);app.mergeMenu(app.item(),cx);await flush();assert.ok(app.menu,app.note);
}
async function chooseMerge(app,cx,flush,key) {
  app.pickMenu(app.menu.items.findIndex(it=>it.key===key),cx);assert.ok(app.pending,app.note);
  const pending=app.pending;app.pending=null;pending.then(cx);await flush();
}

test('merge menu changes with topology, prevents self merge and limits selection to one branch',()=>harness(async({git,put,app,cx,refresh,flush,key})=>{
  mergeFixture(git,put,{diverged:true});await refresh();await openMerge(app,cx,flush);
  assert.equal(app.menu.title,'Merge topic into main');assert.equal(app.menu.items[0].label,'Regular merge (with merge commit)');assert.ok(app.menu.items[1].disabled);
  await key('f');assert.ok(app.menu);assert.match(app.note,/Cannot fast-forward/);await key('escape');
  git(['config','merge.ff','only']);await openMerge(app,cx,flush);assert.equal(app.menu.items[0].key,'m');assert.ok(app.menu.items[0].disabled);assert.equal(app.menu.items[1].key,'n');assert.equal(app.menu.items[1].disabled,null);await key('escape');
  app.mergeMenu(app.branches.find(it=>it.name==='main'),cx);await flush();assert.match(app.note,/into itself/);assert.equal(app.menu,null);
  app.rangeAnchors.local=0;app.sel.branches=1;await key('M');assert.match(app.note,/Select one branch/);assert.equal(app.menu,null);
}));

for(const [name,args,ff,diverged,key,parents]of [
  ['default FF','',null,false,'m',1],
  ['explicit merge commit','',null,false,'n',2],
  ['Git no-FF override','', 'false',false,'f',1],
  ['args override','--no-ff','true',false,'m',2],
  ['ff-only divergence override','--ff-only','only',true,'n',2],
])test(`merge real Git: ${name}`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put,{diverged});if(ff)git(['config','merge.ff',ff]);put('.git/lazygit.yml',`git:\n  autoFetch: false\n  merging:\n    args: '${args}'\n`);await refresh();await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,key);
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'topic\n');assert.equal(git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length-1,parents);assert.equal(app.operation,null);assert.equal(git(['status','--porcelain']),'');
}));

test('merge reads show loading, discard a closed result and clear a failed wait',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick,failOn})=>{
  mergeFixture(git,put);await refresh();const topic=app.branches.find(it=>it.name==='topic');
  const release=hold();app.mergeMenu(topic,cx);await tick();assert.equal(app.busy,'Reading merge options');assert.equal(app.opening,app.busy);app.render(cx);app.close();release();await flush();
  assert.equal(app.busy,null);assert.equal(app.opening,null);assert.ok(app.menu==null);app.closed=false;
  failOn(()=>true);app.mergeMenu(topic,cx);await flush();assert.match(app.note,/host went away/);assert.equal(app.busy,null);assert.ok(app.menu==null);
}));

test('merge --no-commit leaves a real merge available for continuation',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put,{diverged:true});put('.git/lazygit.yml','git:\n  autoFetch: false\n  merging:\n    args: --no-commit\n');await refresh();const before=git(['rev-parse','HEAD']);await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,'m');
  assert.equal(app.note,null);assert.equal(app.operation,'merge');assert.equal(git(['rev-parse','HEAD']),before);app.continueOperation('merge',cx);await flush();assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length,3);
}));

test('merge from nested remote branches keeps its remote name in the squash message',()=>harness(async({dir,git,put,app,cx,refresh,flush,key})=>{
  mergeFixture(git,put);git(['remote','add','origin','https://example.invalid/repo']);git(['update-ref','refs/remotes/origin/topic','topic']);await refresh();await key('3');await key(']');await key('enter');
  assert.equal(app.remoteContext.name,'origin');await key('M');assert.equal(app.menu.title,'Merge origin/topic into main');await chooseMerge(app,cx,flush,'s');
  assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'.git','SQUASH_MSG'),'utf8'),'Squash merge origin/topic into main\n');assert.equal(app.remoteContext.name,'origin');assert.equal(app.branchView,'remotes');
}));

for(const change of ['HEAD','ref','settings'])test(`merge rejects a stale ${change} before executing`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put);await refresh();await openMerge(app,cx,flush);
  if(change==='HEAD'){put('unrelated','new HEAD\n');git(['commit','-qam','new HEAD']);}
  else if(change==='ref')git(['update-ref','refs/heads/topic','HEAD']);
  else git(['config','merge.ff','false']);
  const head=git(['rev-parse','HEAD']);await chooseMerge(app,cx,flush,'m');assert.match(app.note,/changed; review merge/);assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['show','HEAD:f']),'base\n');
}));

test('squash rechecks staged files after the menu opens',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put);await refresh();await openMerge(app,cx,flush);put('unrelated','keep staged\n');git(['add','unrelated']);await chooseMerge(app,cx,flush,'S');
  assert.match(app.note,/existing staged changes/);assert.equal(git(['show',':unrelated']),'keep staged\n');assert.equal(git(['show',':f']),'base\n');assert.equal(app.operation,null);
}));

test('squash overrides no-FF and writes the configured message without committing',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put,{diverged:true});git(['config','merge.ff','false']);put('.git/lazygit.yml','git:\n  autoFetch: false\n  merging:\n    args: --no-ff\n    squashMergeMessage: |\n      {{.selectedRef}} into {{currentBranch}}\n      body {{selectedRef}} / {{.currentBranch}} {{unknown}}\n');await refresh();const head=git(['rev-parse','HEAD']);await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,'s');
  assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['show',':f']),'topic\n');assert.equal(app.operation,'squash-merge');assert.equal(app.startedOperation,null);
  const message=fs.readFileSync(join(app.root,'.git','SQUASH_MSG'),'utf8');assert.equal(message,'topic into main\nbody topic / main {{unknown}}\n\n');
}));

test('early squash failure never fabricates a squash operation',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put);put('.git/lazygit.yml','git:\n  autoFetch: false\n  merging:\n    args: --not-a-merge-option\n');await refresh();await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,'s');
  assert.ok(app.note);assert.equal(fs.existsSync(join(dir,'.git','SQUASH_MSG')),false);assert.equal(app.operation,null);assert.equal(git(['status','--porcelain']),'');
}));

for(const commit of [false,true])test(`conflicted squash ${commit?'offers':'does not offer'} automatic continuation`,()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put,{conflict:true});await refresh();await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,commit?'S':'s');
  assert.equal(app.operation,'squash-merge');assert.ok(app.files.some(it=>it.conflict));assert.equal(fs.readFileSync(join(dir,'.git','SQUASH_MSG'),'utf8'),'Squash merge topic into main\n');
  put('f','resolved\n');git(['add','f']);await refresh();assert.equal(Boolean(app.pending),commit);if(commit)assert.equal(app.pending.operation,'squash-merge');
  app.pending=null;app.continueOperation('squash-merge',cx);await flush();assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(git(['log','-1','--format=%s']).trim(),'Squash merge topic into main');
}));

test('squash message uses HEAD while detached and a rebase branch when available',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put);git(['switch','--detach']);await refresh();await openMerge(app,cx,flush);assert.equal(app.menu.title,'Merge topic into HEAD');await chooseMerge(app,cx,flush,'s');
  assert.equal(fs.readFileSync(join(dir,'.git','SQUASH_MSG'),'utf8'),'Squash merge topic into HEAD\n');git(['reset','--hard']);
  fs.mkdirSync(join(dir,'.git','rebase-merge'));put('.git/rebase-merge/head-name','refs/heads/rebasing-topic\n');
  assert.equal(await app.mergeBranchName({branch:''},{cwd:dir}),'rebasing-topic');
}));

test('squash message is written in the linked worktree Git directory',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put);const worktree=join(dir,'linked');git(['worktree','add','-qb','linked-branch',worktree,'main']);await refresh();app.switchRepository(worktree,cx);await flush();await openMerge(app,cx,flush);await chooseMerge(app,cx,flush,'s');
  assert.equal(app.note,null);assert.equal(app.operation,'squash-merge');const path=git(['-C',worktree,'rev-parse','--path-format=absolute','--git-path','SQUASH_MSG']).trim();assert.equal(fs.readFileSync(path,'utf8'),'Squash merge topic into linked-branch\n');assert.equal(fs.existsSync(join(dir,'.git','SQUASH_MSG')),false);
}));

function recordingMergeEditor(git,put) {
  put('.git/record-editor', '#!/bin/sh\nprintf "%s\\n" "Edited in fixture editor" > "$1"\nprintf used > .git/editor-used\n');
  git(['config','core.editor','sh .git/record-editor']);
}
function realGitTerminal(dir,setCore) {
  const calls=[];let output='';setCore(async args=>{
    calls.push(Array.from(args));let result={};
    if(args[0]==='run'){
      const at=args.indexOf('--'),r=spawnSync(args[at+1],args.slice(at+2),{cwd:dir,input:'\n',encoding:'utf8',env:{...process.env,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_EDITOR:undefined,VISUAL:undefined,EDITOR:undefined}});
      assert.ifError(r.error);output=r.stdout+r.stderr;result={address:'t-merge',state:'finished',exit_code:r.status};
    }else if(args[0]==='read')result={text:output};
    return {code:0,stderr:'',stdout:JSON.stringify(result)};
  });return calls;
}

for(const squash of [false,true])for(const manual of [false,true])test(`${squash?'squash':'merge'} continuation ${manual?'uses':'skips'} the configured editor`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setCore})=>{
  mergeFixture(git,put,{conflict:true});recordingMergeEditor(git,put);put('.git/lazygit.yml',`git:\n  autoFetch: false\n  merging:\n    manualCommit: ${manual}\n`);
  try{git(['merge',...(squash?['--squash']:[]),'--no-edit','topic']);}catch{}put('f','resolved\n');git(['add','f']);await refresh();const calls=realGitTerminal(dir,setCore);app.operationMenu(cx);app.pickMenu(0,cx);await flush();
  assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(fs.existsSync(join(dir,'.git','editor-used')),manual);assert.equal(calls.some(args=>args[0]==='run'),manual);
  if(manual){assert.equal(git(['log','-1','--format=%s']).trim(),'Edited in fixture editor');assert.deepEqual(calls[0].slice(squash?-2:-3),squash?['git','commit']:['git','merge','--continue']);assert.ok(calls.some(args=>args[0]==='rm'));}
  assert.equal(git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length-1,squash?1:2);
}));

for(const squash of [false,true])test(`immediate ${squash?'squash commit':'regular merge'} skips the editor with manualCommit enabled`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setCore})=>{
  mergeFixture(git,put,{diverged:true});recordingMergeEditor(git,put);put('.git/lazygit.yml','git:\n  autoFetch: false\n  merging:\n    manualCommit: true\n');await refresh();await openMerge(app,cx,flush);const calls=realGitTerminal(dir,setCore);await chooseMerge(app,cx,flush,squash?'S':'m');
  assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(calls.length,0);assert.equal(fs.existsSync(join(dir,'.git','editor-used')),false);assert.equal(git(['show','HEAD:f']),'topic\n');
  if(squash)assert.equal(git(['log','-1','--format=%s']).trim(),'Squash merge topic into main');
}));

test('continuation rejects an operation that ended while its menu was open',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  mergeFixture(git,put,{conflict:true});try{git(['merge','--no-edit','topic']);}catch{}await refresh();app.operationMenu(cx);git(['merge','--abort']);app.pickMenu(0,cx);await flush();assert.match(app.note,/Git operation changed/);assert.equal(app.operation,null);
}));

for(const squash of [false,true])test(`${squash?'squash':'merge'} abort stays noninteractive with manualCommit enabled`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setCore})=>{
  mergeFixture(git,put,{conflict:true});recordingMergeEditor(git,put);put('.git/lazygit.yml','git:\n  autoFetch: false\n  merging:\n    manualCommit: true\n');try{git(['merge',...(squash?['--squash']:[]),'--no-edit','topic']);}catch{}await refresh();const calls=realGitTerminal(dir,setCore);
  app.operationMenu(cx);app.pickMenu(app.menu.items.findIndex(it=>it.key==='a'),cx);app.pending.then(cx);await flush();assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(calls.length,0);assert.equal(fs.existsSync(join(dir,'.git','editor-used')),false);assert.equal(git(['status','--porcelain']),'');
}));

function fixtureFlow(dir,setEnvironment,{available=true}={}) {
  const bin=join(dir,'.git','flow-bin');fs.mkdirSync(bin,{recursive:true});
  fs.writeFileSync(join(bin,'git-flow'),`#!/bin/sh\nif [ "$1" = version ]; then echo fixture-git-flow; exit ${available?0:127}; fi\nexit 99\n`,{mode:0o755});
  setEnvironment({PATH:bin+':'+process.env.PATH});
}
async function openFlow(app,cx,flush,branch) {
  app.panel='branches';app.main=false;app.branchView='local';app.sel.branches=app.branchItems().findIndex(it=>it.name===branch);
  app.gitFlowMenu(app.item(),cx);await flush();assert.equal(app.menu?.title,'Git-flow',app.note);
}

test('Git-flow local branch menu supports all start types and next prefixes',()=>harness(async({git,put,app,cx,refresh,flush,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.branch.feature.prefix','feature']);await refresh();app.panel='branches';app.main=false;
  await key('i');assert.equal(app.menu?.title,'Git-flow',app.note);assert.deepEqual(Array.from(app.menu.items,it=>it.label),["Finish branch 'main'…",'Start feature…','Start hotfix…','Start bugfix…','Start release…']);
  await key('h');assert.equal(app.prompt.title,'New hotfix name');app.cancelPrompt(cx);assert.equal(app.prompt,null);assert.equal(git(['branch','--show-current']).trim(),'main');
}));

test('Git-flow start actions remain available on detached HEAD',()=>harness(async({git,put,app,cx,refresh,flush,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);git(['switch','--detach']);await refresh();app.panel='branches';app.main=false;
  app.sel.branches=app.branchItems().findIndex(it=>it.detached);assert.ok(app.item()?.detached);
  await key('i');assert.equal(app.menu?.title,'Git-flow',app.note);await key('f');assert.equal(app.prompt?.title,'New feature name');app.cancelPrompt(cx);
  app.gitFlowMenu(app.item(),cx);await flush();app.pickMenu(0,cx);assert.match(app.note,/does not seem to be a Git-flow branch/);assert.equal(app.pending,null);
}));

test('Git-flow configured shortcut replaces and disables the native default only in local branches',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);put('.git/lazygit.yml','git:\n  autoFetch: false\nkeybinding:\n  branches:\n    viewGitFlowOptions: I\n');await refresh();app.panel='branches';app.main=false;
  await key('i');assert.ok(app.menu==null);await key('I');assert.equal(app.menu?.title,'Git-flow',app.note);await key('escape');
  put('.git/lazygit.yml','git:\n  autoFetch: false\nkeybinding:\n  branches:\n    viewGitFlowOptions: "<disabled>"\n');await refresh();await key('i');assert.equal(app.menu,null);await key('I');assert.equal(app.menu,null);
}));

test('Git-flow finish is disabled for a branch range and rejects non-flow branches',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','feature/one']);git(['config','gitflow.prefix.feature','feature/']);await refresh();
  app.panel='branches';app.rangeAnchors.local=0;app.sel.branches=1;app.gitFlowMenu(app.item(),cx);await flush();assert.equal(app.menu.items[0].disabled,'Select one branch to finish');app.pickMenu(0,cx);assert.equal(app.pending,null);
  app.rangeAnchors.local=null;await openFlow(app,cx,flush,'main');app.pickMenu(0,cx);assert.match(app.note,/does not seem to be a Git-flow branch/);assert.equal(app.pending,null);
}));

test('Git-flow reads show waiting state and a closed or failed read cannot leave a menu',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick,failOn})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);await refresh();app.panel='branches';
  const release=hold();app.gitFlowMenu(app.item(),cx);await tick();assert.equal(app.busy,'Reading Git-flow configuration');assert.equal(app.opening,app.busy);app.render(cx);app.close();release();await flush();
  assert.equal(app.busy,null);assert.equal(app.opening,null);assert.ok(app.menu==null);app.closed=false;
  failOn(()=>true);app.gitFlowMenu(app.item(),cx);await flush();assert.match(app.note,/host went away/);assert.equal(app.busy,null);assert.ok(app.menu==null);
}));

test('Git-flow reports absent configuration and an unavailable executable without starting a terminal',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);await refresh();app.panel='branches';app.gitFlowMenu(app.item(),cx);await flush();assert.match(app.note,/enable it in this repository/);assert.ok(app.menu==null);
  git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment,{available:false});await openFlow(app,cx,flush,'main');let started=false;setCore(()=>{started=true;throw new Error('must not start');});
  app.pickMenu(1,cx);app.message='new-feature';app.submit(cx);await flush();assert.match(app.note,/not available on this repository/);assert.equal(started,false);assert.equal(app.busy,null);
}));

test('Git-flow start sends literal argv to an interactive terminal, refreshes and removes the finished terminal',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,overlays,notifications})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  const calls=[];setCore(async args=>{calls.push(Array.from(args));return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Created feature'}:{})};});
  app.pickMenu(1,cx);app.message='nested/$(literal);name';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(app.info,'Started feature nested/$(literal);name');
  assert.deepEqual(calls[0].slice(-5),['git','flow','feature','start','nested/$(literal);name']);assert.equal(calls[0][calls[0].indexOf('--cwd')+1],dir);
  assert.ok(overlays.some(it=>it.layout?.content?.terminal==='t-flow'));assert.ok(overlays.some(it=>it.closed==='test'));assert.ok(calls.some(args=>args[0]==='rm'&&args[1]==='t-flow'));
  assert.equal(app.gitTask,null);assert.equal(app.busy,null);assert.equal(notifications.length,0);assert.equal(app.commandLog.at(-1).output,'Created feature');
}));

test('Git-flow finish captures the selected branch and uses the configured prefix type',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','topic/nested/one']);git(['config','gitflow.prefix.feature','topic/']);git(['config','gitflow.branch.bugfix.prefix','topic/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'topic/nested/one');
  const calls=[];setCore(async args=>{calls.push(Array.from(args));return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'finished',exit_code:0}:args[0]==='read'?{text:'Finished'}:{})};});
  app.pickMenu(0,cx);assert.match(app.pending.body??app.pending.text??JSON.stringify(app.pending),/topic\/nested\/one/);app.sel.branches=0;
  const pending=app.pending;app.pending=null;pending.then(cx);await flush();assert.equal(app.note,null);assert.deepEqual(calls[0].slice(-5),['git','flow','feature','finish','nested/one']);
}));

test('Git-flow refuses a changed selected branch or prefix mapping before finish',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','topic/one']);git(['config','gitflow.prefix.feature','topic/']);fixtureFlow(dir,setEnvironment);await refresh();
  let started=false;setCore(()=>{started=true;throw new Error('must not start');});await openFlow(app,cx,flush,'topic/one');app.pickMenu(0,cx);let pending=app.pending;app.pending=null;
  git(['config','--unset','gitflow.prefix.feature']);git(['config','gitflow.prefix.hotfix','topic/']);pending.then(cx);await flush();assert.match(app.note,/prefixes changed/);
  await openFlow(app,cx,flush,'topic/one');app.pickMenu(0,cx);pending=app.pending;app.pending=null;git(['commit','--allow-empty','-qm','other']);git(['branch','-f','topic/one','HEAD']);pending.then(cx);await flush();
  assert.match(app.note,/selected branch changed/);assert.equal(started,false);assert.equal(app.busy,null);
}));

for(const change of ['branch','prefix'])test(`Git-flow finish detects a ${change} changed during executable probing`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,afterExec})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','feature/one']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'feature/one');
  let moved=false,started=false;afterExec((command,args)=>{if(!moved&&command==='sh'&&args.includes('flow')&&args.includes('version')){
    moved=true;if(change==='branch'){git(['commit','--allow-empty','-qm','other']);git(['branch','-f','feature/one','HEAD']);}
    else{git(['config','--unset','gitflow.prefix.feature']);git(['config','gitflow.prefix.hotfix','feature/']);}
  }});setCore(()=>{started=true;throw new Error('must not start');});
  app.pickMenu(0,cx);const pending=app.pending;app.pending=null;pending.then(cx);await flush();assert.equal(moved,true);assert.equal(started,false);assert.match(app.note,change==='branch'?/selected branch changed/:/prefixes changed/);assert.equal(app.busy,null);
}));

test('Git-flow failure preserves command output, clears waiting and cleans up a finished terminal',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  const calls=[];setCore(async args=>{calls.push(args[0]);return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'finished',exit_code:1}:args[0]==='read'?{text:'A Git-flow hook failed'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();assert.match(app.note,/A Git-flow hook failed/);assert.ok(calls.includes('rm'));assert.equal(app.gitTask,null);assert.equal(app.busy,null);
}));

test('Git-flow preserves a live terminal and offers recovery if observation fails',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,notifications})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  const calls=[];setCore(async args=>{calls.push(args[0]);if(args[0]==='wait')throw new Error('connection lost');return {code:0,stderr:'',stdout:JSON.stringify({address:'t-flow',state:'live'})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();assert.match(app.note,/connection lost/);assert.equal(app.busy,null);assert.equal(app.gitTask.terminal,'t-flow');assert.equal(calls.includes('rm'),false);assert.equal(calls.includes('kill'),false);
  assert.equal(notifications[0].action.args.terminal,'t-flow');app.moreMenu(cx);assert.ok(app.menu.items.some(it=>it.label==='Open Git-flow terminal'));
}));

test('Git-flow keeps completed terminals when output cannot be read and retries before removal',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,notifications})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  let readable=false;const calls=[];setCore(async args=>{calls.push(args[0]);if(args[0]==='read'&&!readable)return {code:1,stdout:'',stderr:'cannot read terminal output'};return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'||args[0]==='get'?{address:'t-flow',state:'finished',exit_code:0}:args[0]==='read'?{text:'Created feature'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();assert.match(app.note,/cannot read terminal output/);assert.ok(app.gitTask.finished);assert.equal(app.gitTask.captured,false);assert.equal(calls.includes('rm'),false);assert.match(notifications[0].body,/Could not read/);
  app.moreMenu(cx);assert.ok(app.menu.items.some(it=>it.label==='Open Git-flow terminal'));
  await openFlow(app,cx,flush,'main');app.pickMenu(1,cx);app.message='two';app.submit(cx);await flush();assert.equal(calls.filter(it=>it==='run').length,1);assert.equal(calls.includes('rm'),false);
  readable=true;await openFlow(app,cx,flush,'main');app.pickMenu(1,cx);app.message='two';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(app.gitTask,null);assert.equal(app.commandLog.filter(it=>it.output==='Created feature').length,2);assert.equal(calls.filter(it=>it==='rm').length,2);
}));

for(const code of [0,1])test(`Git-flow cleanup failure preserves exit ${code} and retains access to the terminal`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,notifications})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  setCore(async args=>args[0]==='rm'?{code:1,stdout:'',stderr:'cleanup unavailable'}:{code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'finished',exit_code:code}:args[0]==='read'?{text:code?'Hook failed':'Created feature'}:{})});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();if(code)assert.match(app.note,/Hook failed/);else{assert.equal(app.note,null);assert.equal(app.info,'Started feature one');}
  assert.equal(app.commandLog.at(-1).code,code);assert.equal(app.gitTask.terminal,'t-flow');assert.match(notifications[0].body,/cleanup unavailable/);assert.equal(notifications[0].action.args.terminal,'t-flow');assert.equal(app.busy,null);
}));

test('Git-flow terminal allocation after the parent closes is exposed without opening a stale overlay',()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,notifications,overlays})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  const calls=[];setCore(async args=>{calls.push(args[0]);if(args[0]==='run')app.close();return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Done'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();assert.equal(overlays.some(it=>it.layout),false);assert.match(notifications[0].body,/dialog closed/);assert.equal(calls.includes('rm'),false);assert.ok(app.gitTask.retained);assert.equal(app.busy,null);
}));

test('Git-flow remote terminal addresses remain anchored to the captured machine',()=>harness(async({dir,app,cx,setCore,overlays})=>{
  app.root=dir;app.on='lab';app.repoKey='lab:'+dir;const calls=[];setCore(async args=>{calls.push(Array.from(args));return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Done'}:{})};});
  const result=await app.gitTerminal({context:{cwd:dir,on:'lab'},repoKey:app.repoKey},['git','flow','feature','start','one'],'Starting feature',cx);assert.equal(result.code,0);
  assert.equal(calls[0][calls[0].indexOf('--on')+1],'lab');assert.ok(calls.filter(args=>args[0]!=='run').every(args=>args[1]==='lab/t-flow'));assert.ok(overlays.some(it=>it.layout?.content?.terminal==='lab/t-flow'));
}));

test('Git-flow remains reachable while busy and closing its parent offers the live terminal',()=>harness(async({dir,git,put,app,cx,refresh,flush,tick,setEnvironment,setCore,notifications,overlays})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  let release,notified=false;cx.notify=()=>{if(app.gitTask?.terminal&&!app.gitTask.finished)notified=true;};const wait=new Promise(resolve=>{release=resolve;});setCore(async args=>{if(args[0]==='wait')await wait;return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Done'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await tick();assert.equal(app.gitTask?.terminal,'t-flow');assert.equal(app.busy,'Starting feature');
  assert.equal(notified,true);app.render(cx);const button=elements.findLast(element=>element._id==='git-terminal');assert.ok(button);const count=overlays.length;button.events.on_click({},cx);assert.equal(overlays.length,count+2);assert.deepEqual(overlays.at(-2),{closed:'test'});assert.equal(overlays.at(-1).layout.content.terminal,'t-flow');
  app.close();assert.equal(notifications.length,1);assert.equal(notifications[0].action.args.terminal,'t-flow');release();await flush();assert.ok(app.gitTask.retained);assert.equal(app.busy,null);
}));

test('Git-flow completion closes the reopened terminal overlay',()=>harness(async({dir,git,put,app,cx,refresh,flush,tick,setEnvironment,setCore,overlays})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');
  let release;const wait=new Promise(resolve=>{release=resolve;});setCore(async args=>{if(args[0]==='wait')await wait;return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Done'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await tick();assert.equal(app.gitTask.overlay,'test');app.openGitTerminal();assert.equal(app.gitTask.overlay,'test-2');release();await flush();assert.ok(overlays.some(it=>it.closed==='test-2'));assert.equal(app.gitTask,null);assert.equal(app.busy,null);
}));

for(const change of ['close','repository'])test(`Git-flow retains completed output after ${change} during execution`,()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore,notifications})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['config','gitflow.prefix.feature','feature/']);fixtureFlow(dir,setEnvironment);await refresh();await openFlow(app,cx,flush,'main');app.lazygitConfig.promptToReturnFromSubprocess=false;
  const calls=[];setCore(async args=>{calls.push(args[0]);if(args[0]==='get'){if(change==='close')app.close();else app.repoKey='a different repository';}return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-flow',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:'Created feature/one'}:{})};});
  app.pickMenu(1,cx);app.message='one';app.submit(cx);await flush();assert.equal(app.gitTask.terminal,'t-flow');assert.equal(app.gitTask.retained,true);assert.equal(calls.includes('rm'),false);assert.equal(app.commandLog.at(-1).output,'Created feature/one');assert.equal(notifications.at(-1).action.args.terminal,'t-flow');
}));

const referenceGitFlow=process.env.HERDR_GIT_FLOW_TEST_BIN;
for(const [type,key]of [['feature','f'],['hotfix','h'],['bugfix','b'],['release','r']])test(`native Git-flow runs real ${type} start${type==='feature'?' and finish':''}`,{skip:!referenceGitFlow},()=>harness(async({dir,git,put,app,cx,refresh,flush,setEnvironment,setCore})=>{
  const env={...process.env,PATH:dirname(referenceGitFlow)+':'+process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',GIT_EDITOR:'true',GIT_TERMINAL_PROMPT:'0'};
  const realGit=args=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe',env});setEnvironment({PATH:env.PATH});
  put('base','base');git(['add','.']);git(['commit','-qm','base']);const mainHead=git(['rev-parse','HEAD']).trim();fs.mkdirSync(join(dir,'.git','flow-hooks'));git(['config','core.hooksPath',join(dir,'.git','flow-hooks')]);
  realGit(['flow','init','--defaults','--preset=classic','--local']);git(['switch','develop']);git(['commit','--allow-empty','-qm','develop base']);const developHead=git(['rev-parse','HEAD']).trim();git(['switch','main']);await refresh();
  let output='',exitCode;setCore(async args=>{
    if(args[0]==='run'){
      const argv=args.slice(args.indexOf('--')+1);const result=spawnSync(argv[0],argv.slice(1),{cwd:dir,encoding:'utf8',input:'\n',env});assert.ifError(result.error);output=result.stdout+result.stderr;exitCode=result.status;
      return {code:0,stderr:'',stdout:JSON.stringify({address:'t-flow-real',state:'finished',exit_code:exitCode})};
    }
    return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='read'?{text:output}:{})};
  });
  await openFlow(app,cx,flush,'main');app.pickMenu(app.menu.items.findIndex(it=>it.hint===key),cx);app.message='audit/nested-name';app.submit(cx);await flush();assert.equal(app.note,null,output);assert.equal(exitCode,0,output);
  assert.equal(git(['branch','--show-current']).trim(),type+'/audit/nested-name');assert.equal(git(['rev-parse','HEAD']).trim(),type==='hotfix'?mainHead:developHead);assert.equal(app.branch.name,type+'/audit/nested-name');
  if(type==='feature'){
    put('feature.txt','delivered');git(['add','.']);git(['commit','-qm','feature work']);await refresh();await openFlow(app,cx,flush,'feature/audit/nested-name');app.pickMenu(0,cx);const pending=app.pending;app.pending=null;pending.then(cx);await flush();
    assert.equal(app.note,null,output);assert.equal(git(['branch','--show-current']).trim(),'develop');assert.equal(git(['branch','--list','feature/audit/nested-name']),'');assert.equal(git(['show','develop:feature.txt']),'delivered');assert.equal(app.branch.name,'develop');
  }
}));

test('reflog recovery undoes a pre-existing commit softly and redoes it with local edits preserved',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('other','one\n');git(['add','.']);git(['commit','-qm','base']);const before=git(['rev-parse','HEAD']).trim();
  put('new-file','committed\n');git(['add','.']);git(['commit','-qm','second']);const after=git(['rev-parse','HEAD']).trim();
  put('other','local change\n');await refresh();
  await confirmRecovery(app,cx,flush);assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),before);
  assert.equal(git(['diff','--cached','--name-only']).trim(),'new-file');assert.equal(git(['show',':new-file']),'committed\n');
  assert.match(git(['reflog','-1','--format=%gs']),/^\[lazygit undo\]/);
  // No in-memory stack is involved: the freshly read reflog is authoritative.
  app.reflog=[];await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);
  assert.equal(git(['rev-parse','HEAD']).trim(),after);assert.equal(git(['diff','--cached','--name-only']),'');
  assert.equal(git(['diff','--name-only']).trim(),'other');assert.match(git(['diff']),/local change/);assert.equal(git(['stash','list']),'');
  assert.match(git(['reflog','-1','--format=%gs']),/^\[lazygit redo\]/);assert.equal(app.busy,null);assert.equal(app.opening,null);
}));

test('reflog recovery traverses multiple undos and redos without dialog memory',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  const hashes=[];for(const name of ['one','two','three']){put(name,name);git(['add','.']);git(['commit','-qm',name]);hashes.push(git(['rev-parse','HEAD']).trim());}
  await refresh();await confirmRecovery(app,cx,flush);assert.equal(git(['rev-parse','HEAD']).trim(),hashes[1]);
  app.reflog=[];await confirmRecovery(app,cx,flush);assert.equal(git(['rev-parse','HEAD']).trim(),hashes[0]);
  await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),hashes[1]);
  app.reflog=[];await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),hashes[2]);
  app.undo(true,cx);await flush();assert.equal(app.pending,null);assert.match(app.note,/No redoable action/);
}));

test('reflog checkout recovery preserves compatible local edits and focuses local branches',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('same','base');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','feature']);
  put('feature','feature');git(['add','.']);git(['commit','-qm','feature']);git(['switch','-q','main']);git(['switch','-q','feature']);
  put('same','local');await refresh();await confirmRecovery(app,cx,flush);
  assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'main');assert.equal(app.panel,'branches');assert.equal(app.branchView,'local');assert.equal(app.item('branches').name,'main');
  assert.equal(git(['diff','--name-only']).trim(),'same');assert.equal(git(['stash','list']),'');
  await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'feature');
}));

test('reflog checkout recovery offers auto-stash and reapplies independent changes',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  const base='a\nb\nc\nd\ne\nf\ng\nh\n';put('f',base);git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','feature']);
  put('f',base.replace('b\n','B\n'));git(['commit','-qam','feature']);git(['switch','-q','main']);git(['switch','-q','feature']);
  put('f',base.replace('b\n','B\n').replace('g\n','G\n'));await refresh();await confirmRecovery(app,cx,flush);
  assert.equal(git(['branch','--show-current']).trim(),'feature');assert.equal(app.pending.title,'Auto-stash');assert.equal(app.busy,null);
  const pending=app.pending;app.pending=null;pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'main');assert.match(git(['diff']),/\+G/);assert.equal(git(['stash','list']),'');
}));

test('reflog checkout recovery keeps a conflicting auto-stash and existing stashes',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');put('saved','base\n');git(['add','.']);git(['commit','-qm','base']);put('saved','saved\n');git(['stash','push','-qm','keep me']);const existing=git(['rev-parse','refs/stash']).trim();
  git(['switch','-qc','feature']);put('f','feature\n');git(['commit','-qam','feature']);git(['switch','-q','main']);git(['switch','-q','feature']);put('f','local\n');await refresh();
  await confirmRecovery(app,cx,flush);assert.equal(app.pending.title,'Auto-stash');const pending=app.pending;app.pending=null;pending.then(cx);await flush();
  assert.match(app.note,/Recovery stash .* was kept/);assert.equal(git(['branch','--show-current']).trim(),'main');assert.ok(git(['ls-files','-u']).length);
  assert.equal(git(['stash','list','--format=%H']).trim().split('\n').length,2);assert.equal(git(['rev-parse','stash@{1}']).trim(),existing);
  assert.equal(git(['show','stash@{0}:f']),'local\n');assert.equal(app.busy,null);
}));

test('reflog recovery refuses a changed HEAD, branch or reflog after confirmation',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const name of ['one','two']){put(name,name);git(['add','.']);git(['commit','-qm',name]);}await refresh();
  for(const change of [()=>git(['commit','--allow-empty','-qm','concurrent']),()=>git(['switch','-qc','same-head']),()=>git(['reset','--soft','HEAD'])]){
    app.undo(false,cx);await flush();assert.ok(app.pending,app.note);const pending=app.pending;app.pending=null;change();
    const head=git(['rev-parse','HEAD']).trim(),branch=git(['branch','--show-current']);pending.then(cx);await flush();
    assert.match(app.note,/HEAD, branch or reflog changed/);assert.equal(git(['rev-parse','HEAD']).trim(),head);assert.equal(git(['branch','--show-current']),branch);
    // Restore an actionable newest entry for the next case.
    git(['commit','--allow-empty','-qm','next action']);await refresh();
  }
}));

test('reflog recovery refuses a checkout target moved after confirmation',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','feature']);put('f','feature');git(['commit','-qam','feature']);
  git(['switch','-q','main']);git(['switch','-q','feature']);await refresh();app.undo(false,cx);await flush();assert.ok(app.pending,app.note);
  const pending=app.pending;app.pending=null;const head=git(['rev-parse','HEAD']).trim();git(['update-ref','refs/heads/main',head]);pending.then(cx);await flush();
  assert.match(app.note,/recovery target changed/);assert.equal(git(['branch','--show-current']).trim(),'feature');
}));

test('reflog recovery refuses an operation begun after confirmation',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','one');git(['add','.']);git(['commit','-qm','one']);put('f','two');git(['commit','-qam','two']);await refresh();
  app.undo(false,cx);await flush();const pending=app.pending;app.pending=null;const head=git(['rev-parse','HEAD']).trim();put('.git/MERGE_HEAD',head+'\n');pending.then(cx);await flush();
  assert.match(app.note,/Finish or abort the merge/);assert.equal(git(['rev-parse','HEAD']).trim(),head);
}));

for(const ignored of [false,true])test(`reflog hard recovery protects ${ignored?'ignored':'untracked'} files in the destination`,()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('base','base');git(['add','.']);git(['commit','-qm','base']);const before=git(['rev-parse','HEAD']).trim();put('new-file','committed');git(['add','.']);git(['commit','-qm','second']);await refresh();
  await confirmRecovery(app,cx,flush);git(['reset','--','new-file']);put('new-file','personal');if(ignored)put('.git/info/exclude','new-file\n');
  await confirmRecovery(app,cx,flush,true);assert.ok(app.note);assert.equal(git(['rev-parse','HEAD']).trim(),before);assert.equal(fs.readFileSync(join(dir,'new-file'),'utf8'),'personal');assert.equal(git(['stash','list']),'');
}));

test('reflog recovery retains the auto-stash if its reset cannot run',()=>harness(async({git,put,app,cx,refresh,flush,failOn})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['commit','--allow-empty','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);
  put('f','local');app.undo(true,cx);await flush();assert.ok(app.pending,app.note);const before=git(['rev-parse','HEAD']).trim();
  failOn((command,args)=>command==='env'&&args.includes('--hard'));const pending=app.pending;app.pending=null;pending.then(cx);await flush();
  assert.match(app.note,/Recovery stash .* was kept/);assert.equal(git(['rev-parse','HEAD']).trim(),before);assert.equal(git(['show','refs/stash:f']),'local');assert.equal(app.busy,null);
}));

test('reflog recovery never drops a different stash created during reset',()=>harness(async({git,put,app,cx,refresh,flush,afterExec})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);put('f','saved');git(['stash','push','-qm','old']);const other=git(['rev-parse','refs/stash']).trim();
  put('f','foreign');const foreign=git(['stash','create','concurrent']).trim();put('f','base');
  git(['commit','--allow-empty','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);put('f','local');
  afterExec((command,args,resultOptions,result)=>{if(command==='env'&&args.includes('--hard')&&result.code===0)git(['stash','store','-m','concurrent',foreign]);});
  await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);
  assert.equal(git(['rev-parse','refs/stash']).trim(),foreign);assert.equal(git(['rev-parse','stash@{1}']).trim(),other);assert.match(git(['diff']),/\+local/);assert.equal(git(['stash','list','--format=%H']).trim().split('\n').length,2);
  assert.equal(git(['show','refs/stash:f']),'foreign');
  assert.equal(git(['for-each-ref','--format=%(refname)','refs/herdr/recovery/']),'');
}));

for(const directory of [false,true])test(`reflog recovery preserves an untracked ${directory?'file replacing a directory':'directory replacing a file'}`,()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  if(directory)fs.mkdirSync(join(dir,'p'));put(directory?'p/child':'p','base');git(['add','.']);git(['commit','-qm','base']);git(['commit','--allow-empty','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);
  const before=git(['rev-parse','HEAD']).trim();fs.rmSync(join(dir,'p'),{recursive:true});if(!directory)fs.mkdirSync(join(dir,'p'));put(directory?'p':'p/local','personal');
  await confirmRecovery(app,cx,flush,true);assert.match(app.note,/overwrite untracked or ignored files/);assert.equal(git(['rev-parse','HEAD']).trim(),before);
  assert.equal(fs.readFileSync(join(dir,directory?'p':'p/local'),'utf8'),'personal');
}));

for(const path of ['literal\nfile',':(glob)*','ignored/sub/file'])test(`reflog recovery protects ignored destination ${JSON.stringify(path)}`,()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('base','base');git(['add','.']);git(['commit','-qm','base']);const before=git(['rev-parse','HEAD']).trim();fs.mkdirSync(dirname(join(dir,path)),{recursive:true});put(path,'committed');git(['add','.']);git(['commit','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);
  git(['reset']);put(path,'personal');put('.git/info/exclude','*\n');await confirmRecovery(app,cx,flush,true);
  assert.match(app.note,/overwrite untracked or ignored files/);assert.equal(git(['rev-parse','HEAD']).trim(),before);assert.equal(fs.readFileSync(join(dir,path),'utf8'),'personal');
}));

test('reflog recovery keeps its private snapshot if publishing a failed recovery stash also fails',()=>harness(async({git,put,app,cx,refresh,flush,failOn})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['commit','--allow-empty','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);put('f','local');
  failOn((command,args)=>command==='env'&&(args.includes('--hard')||args.includes('store')));await confirmRecovery(app,cx,flush,true);
  assert.match(app.note,/Recovery snapshot refs\/herdr\/recovery\/.* was kept/);const ref=git(['for-each-ref','--format=%(refname)','refs/herdr/recovery/']).trim();
  assert.ok(ref);assert.equal(git(['show',ref+':f']),'local');assert.equal(app.busy,null);
}));

test('reflog recovery refuses edits made after its stash snapshot and retains both versions',()=>harness(async({dir,git,put,app,cx,refresh,flush,afterExec})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['commit','--allow-empty','-qm','second']);await refresh();await confirmRecovery(app,cx,flush);put('f','snapshot');const before=git(['rev-parse','HEAD']).trim();
  afterExec((command,args)=>{if(command==='env'&&args.includes('update-ref')&&!args.includes('-d')&&args.some(arg=>arg.startsWith('refs/herdr/recovery/')))put('f','newer edit');});
  await confirmRecovery(app,cx,flush,true);assert.match(app.note,/Working files or the index changed/);assert.equal(git(['rev-parse','HEAD']).trim(),before);
  assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'newer edit');assert.equal(git(['show','refs/stash:f']),'snapshot');
}));

test('reflog recovery refuses an incomplete bounded reflog read',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['commit','--allow-empty','-qm','second']);await refresh();const before=git(['rev-parse','HEAD']).trim();const bounded=app.boundedGit.bind(app);
  app.boundedGit=async(args,...rest)=>args[0]==='reflog'?{code:0,stdout:'',stderr:'',truncated:true}:bounded(args,...rest);
  app.undo(false,cx);await flush();assert.equal(app.pending,null);assert.match(app.note,/reflog exceeds the recovery read limit/);assert.equal(git(['rev-parse','HEAD']).trim(),before);assert.equal(app.busy,null);
}));

test('reflog recovery preserves local submodule contents when the destination replaces its gitlink',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  const source=join(dir,'.git','module-source');fs.mkdirSync(source);const moduleGit=args=>execFileSync('git',args,{cwd:source,encoding:'utf8',stdio:'pipe'});
  moduleGit(['init','-q','-b','main']);moduleGit(['config','user.name','Test']);moduleGit(['config','user.email','test@example.invalid']);moduleGit(['config','commit.gpgsign','false']);
  fs.writeFileSync(join(source,'tracked'),'base');moduleGit(['add','.']);moduleGit(['commit','-qm','module base']);
  git(['-c','protocol.file.allow=always','submodule','add','-q',source,'module']);git(['commit','-qm','with module']);const before=git(['rev-parse','HEAD']).trim();
  git(['rm','-qf','module']);put('module','replacement');git(['add','.']);git(['commit','-qm','replace module']);
  execFileSync('env',['GIT_REFLOG_ACTION=[lazygit undo]','git','reset','--hard',before],{cwd:dir,stdio:'pipe'});
  git(['-c','protocol.file.allow=always','submodule','update','--init']);put('module/tracked','local tracked edit');put('module/local','local data');await refresh();
  await confirmRecovery(app,cx,flush,true);assert.match(app.note,/overwrite untracked or ignored files/);assert.equal(git(['rev-parse','HEAD']).trim(),before);
  assert.equal(fs.readFileSync(join(dir,'module/tracked'),'utf8'),'local tracked edit');assert.equal(fs.readFileSync(join(dir,'module/local'),'utf8'),'local data');
  assert.match(git(['ls-files','--stage','module']),/^160000 /);assert.equal(git(['for-each-ref','--format=%(refname)','refs/herdr/recovery/']),'');
}));

test('reflog preparation shows a wait, drops a closed read and clears a failed read',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick,failOn})=>{
  put('f','one');git(['add','.']);git(['commit','-qm','one']);git(['commit','--allow-empty','-qm','two']);await refresh();
  const release=hold();app.undo(false,cx);await tick();assert.equal(app.busy,'Reading reflog');assert.equal(app.opening,'Reading reflog');app.render(cx);app.close();release();await flush();
  assert.equal(app.pending,null);assert.equal(app.busy,null);assert.equal(app.opening,null);
  app.closed=false;failOn(()=>true);app.undo(false,cx);await flush();assert.equal(app.pending,null);assert.equal(app.busy,null);assert.equal(app.opening,null);assert.match(app.note,/host went away/);
}));

test('reflog recovery explains unavailable initial commits and absent redo history',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','one');git(['add','.']);git(['commit','-qm','one']);await refresh();const head=git(['rev-parse','HEAD']).trim();
  app.undo(false,cx);await flush();assert.equal(app.pending,null);assert.match(app.note,/initial commit cannot be undone/);
  app.undo(true,cx);await flush();assert.equal(app.pending,null);assert.match(app.note,/No redoable action/);assert.equal(git(['rev-parse','HEAD']).trim(),head);
}));

test('reflog recovery checks out detached targets without interpreting them as paths',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);const before=git(['rev-parse','HEAD']).trim();git(['commit','--allow-empty','-qm','second']);
  git(['switch','--detach',before]);git(['switch','main']);await refresh();await confirmRecovery(app,cx,flush);
  assert.equal(app.note,null);assert.equal(git(['branch','--show-current']),'');assert.equal(git(['rev-parse','HEAD']).trim(),before);
  await confirmRecovery(app,cx,flush,true);assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'main');
}));

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

test('pane tabs follow Lazygit groups and keep each view selection',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['branch','feature']);git(['tag','v1']);git(['remote','add','origin','https://example.invalid/repo.git']);
  git(['config','--file','.gitmodules','submodule.library.path','vendor/library']);
  await refresh();assert.equal(app.tags[0].name,'v1');assert.equal(app.worktrees.length,1);assert.equal(app.remotes[0].name,'origin');assert.ok(app.reflog.length);
  await key('3');await key(']');assert.equal(app.branchView,'remotes');assert.equal(app.item().name,'origin');
  app.render(cx);await key('m');assert.ok(app.menu.items.some(x=>x.label==='Add remote…'));app.render(cx);await key('escape');
  await key(']');assert.equal(app.branchView,'tags');assert.equal(app.item().name,'v1');
  await key(']');assert.equal(app.branchView,'local');
  await key('2');await key(']');assert.equal(app.fileView,'worktrees');assert.equal(app.item().path,app.root);assert.equal(app.source().title,'Worktree');
  await key('a');assert.equal(git(['diff','--cached']),''); // file shortcuts must not stage changes here
  await key('m');assert.ok(app.menu.items.some(x=>x.label==='New worktree…'));await key('escape');
  await key(']');assert.equal(app.fileView,'submodules');assert.equal(app.item().path,'vendor/library');assert.equal(app.source().title,'Submodule');
  await key('m');assert.ok(app.menu.items.some(x=>x.label==='Initialize'));await key('escape');
  await key(']');assert.equal(app.fileView,'files');
  await key('4');await key(']');assert.equal(app.commitView,'reflog');await key('m');app.render(cx);
}));

test('remote branches stay under their selected remote through filtering, history and back navigation',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);
  for(const name of ['origin','origin-backup','team/origin']){
    git(['remote','add',name,'https://example.invalid/repo.git']);
    git(['update-ref',`refs/remotes/${name}/feature/topic`,'HEAD']);
  }
  git(['update-ref','refs/remotes/origin/main','HEAD']);
  await refresh();await key('3');await key(']');await key('j');
  const parent=app.item().name;assert.equal(parent,'origin-backup');
  await key('enter');assert.equal(app.branchView,'remotes');assert.equal(app.remoteContext.name,parent);assert.equal(app.branchItems().length,1);
  assert.equal(app.remoteBranchParts(app.item()).branch,'feature/topic');
  app.filters[app.viewKey()]='main';app.reload(cx);await flush();assert.equal(app.branchItems().length,0);
  app.filters[app.viewKey()]='';app.reload(cx);await flush();assert.equal(app.branchItems().length,1);
  await key('/');await key('escape');await key('escape'); // field, then filter, still inside this remote
  assert.equal(app.remoteContext.name,parent);assert.equal(app.branchItems().length,1);
  await key('enter');assert.equal(app.main,false);assert.equal(app.context().type,'commits');assert.equal(app.panel,'branches');
  await key('escape');assert.equal(app.main,false);assert.equal(app.remoteContext.name,parent);
  await key('escape');assert.equal(app.remoteContext,null);assert.equal(app.item().name,parent);assert.ok(!app.closed);
  await key('k');await key('enter');assert.equal(app.remoteContext.name,'origin');assert.equal(app.branchItems().length,2);
  await key(']');assert.equal(app.branchView,'tags');assert.equal(app.remoteContext,null);
  await key('[');assert.equal(app.branchView,'remotes');assert.equal(app.item().name,'origin');
}));

test('remote rows and breadcrumb open and leave the nested list, including an empty remote',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['remote','add','empty','https://example.invalid/empty.git']);
  await refresh();await key('3');await key(']');app.wide=false;
  elements.length=0;app.render(cx);
  assert.ok(!elements.some(e=>e._id==='view-branches-remote branches'||e._id==='view-branches-worktrees'||e._id==='view-branches-submodules'));
  for(const id of ['view-files-files','view-files-worktrees','view-files-submodules'])assert.ok(elements.some(e=>e._id===id));
  elements.find(e=>e._id==='branches-0').events.on_click({click_count:2},cx);await flush();
  assert.equal(app.remoteContext.name,'empty');assert.equal(app.branchItems().length,0);assert.equal(app.source(),null);
  elements.length=0;app.render(cx);const back=elements.find(e=>e._id==='remote-back');assert.ok(back);
  back.events.on_click({},cx);await flush();assert.equal(app.remoteContext,null);assert.equal(app.item().name,'empty');assert.ok(!app.closed);
  await key('enter');git(['remote','remove','empty']);await refresh();assert.equal(app.remoteContext,null);assert.equal(app.branchItems().length,0);
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
  app.undo(false,cx);await flush();assert.ok(app.pending,app.note);app.pending.then(cx);await flush();assert.equal(git(['rev-parse','HEAD']).trim(),before);
  app.undo(true,cx);await flush();assert.ok(app.pending,app.note);app.pending.then(cx);await flush();assert.equal(git(['log','-1','--format=%s']).trim(),'renamed safely');
}));

test('conflict resolution changes one conflict and detects merge state',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);
  try{git(['merge','other']);}catch{}await refresh();assert.equal(app.operation,'merge');app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();assert.equal(app.conflicts.conflicts.length,1);
  app.render(cx);app.resolveHunk('both',cx);await flush();assert.equal(app.note,null);assert.equal(fs.readFileSync(join(app.root,'f'),'utf8'),'ours\ntheirs\n');
  assert.ok(git(['status','--porcelain']).startsWith('M ')); // Lazygit stages the last resolved conflict
  assert.equal(app.fileStatus,'all');
  app.operationMenu(cx);assert.ok(app.menu.items.some(x=>x.label==='Abort…'));app.render(cx);
}));

test('stale diff cannot change the index',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\n');await refresh();app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();
  put('f','a\nnewer\n');app.applySelection(false,cx);await flush();assert.match(app.note,/changed since/);assert.equal(git(['diff','--cached']),'');
}));

test('worktree creation and repository navigation stay in the selected repository',()=>harness(async({dir,git,put,app,cx,refresh,flush,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);await refresh();
  const path=join(dir,'second checkout');app.perform('Create worktree', [['worktree','add','-b','second','--',path]],cx);await flush();assert.equal(app.note,null);assert.equal(app.worktrees.length,2);
  await key('2');await key(']');await key('j');await refresh();assert.equal(app.item().path,path);
  await key(']');await key('[');assert.equal(app.item().path,path);
  await key('enter');assert.equal(app.root,path);assert.equal(app.branch.name,'second');assert.equal(app.repoStack.length,1);assert.equal(app.fileView,'files');
  await key('escape');assert.equal(app.root,dir);
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
  app.panel='commits';const action=app.commitActions(app.commits[0],cx).filter(Boolean).find(a=>a[1]==='V');action[2](cx);app.pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'base\none\ntwo\n');assert.equal(app.copied.size,0);
}));

test('local bare remote supports tag push and remote branch tracking',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  const remote=join(dir,'upstream.git');execFileSync('git',['init','--bare','-q',remote]);put('f','base');git(['add','f']);git(['commit','-qm','base']);git(['remote','add','origin',remote]);git(['push','-qu','origin','main']);git(['tag','v1']);await refresh();
  assert.ok(app.remoteBranches.some(r=>r.name==='origin/main'));
  app.perform('Push tag',[['push','origin','refs/tags/v1']],cx,{network:true});await flush();assert.equal(app.note,null);
  assert.ok(git(['ls-remote','--tags','origin']).includes('refs/tags/v1'));
  app.perform('Track remote branch',[['switch','--track','-c','tracked','refs/remotes/origin/main']],cx);await flush();assert.equal(app.note,null);assert.equal(app.branch.upstream,'origin/main');
}));

test('nested remote branch actions use the full remote name and the relative branch name',()=>harness(async({dir,git,put,app,cx,refresh,key})=>{
  const remote=join(dir,'upstream.git');execFileSync('git',['init','--bare','-q',remote]);put('f','base');git(['add','f']);git(['commit','-qm','base']);
  git(['remote','add','team/origin',remote]);
  // Recent Git refuses creating overlapping remote names. Existing configs
  // still need their remote refs assigned to the longest matching name.
  git(['config','remote.team.url',remote]);git(['config','remote.team.fetch','+refs/heads/*:refs/remotes/team/*']);
  git(['branch','feature/topic']);git(['push','-q','team/origin','main','feature/topic']);
  await refresh();await key('3');await key(']');await key('enter');assert.equal(app.remoteContext.name,'team');assert.equal(app.branchItems().length,0);
  await key('escape');await key('j');await key('enter');assert.equal(app.remoteContext.name,'team/origin');assert.equal(app.branchItems().length,2);
  app.sel.branches=app.branchItems().findIndex(it=>it.name==='team/origin/feature/topic');
  await key('space');assert.equal(git(['branch','--show-current']).trim(),'feature/topic');assert.equal(app.prompt,null);
  await key('d');assert.ok(app.pending);await key('enter');assert.equal(app.note,null);
  assert.equal(git(['ls-remote','--heads','team/origin','feature/topic']).trim(),'');
  assert.ok(git(['ls-remote','--heads','team/origin','main']).includes('refs/heads/main'));
}));

test('large diff disables partial actions without parsing an incomplete patch',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f',('long line '.repeat(20)+'\n').repeat(5000));await refresh();app.tree=false;app.layoutFiles();app.focusDiff(cx);await flush();
  assert.equal(app.patch,null);assert.equal(app.patchTruncated,true);app.applySelection(false,cx);assert.match(app.note,/too large/);assert.equal(git(['diff','--cached']),'');
}));

for(const split of [false,true])test(`custom patch ${split?'splits into a new commit':'removes changes from an old commit'}`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\nc\nd\ne\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\nc\nD\ne\n');git(['commit','-qam','two changes']);put('later','later');git(['add','.']);git(['commit','-qm','later']);await refresh();
  const cm=app.commits[1];app.panel='commits';app.openChangedFiles(cm,cx);await flush();assert.equal(app.detail.items.length,1);app.openDetailFile(0,cx);await flush();assert.ok(app.historyPatch?.patch);
  app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);assert.equal(app.customPatch.parts.size,1);
  app.rewritePatch(split?'after':'remove',cx,{message:'split change'});await flush();assert.equal(app.note,null);
  assert.equal(git(['rev-list','--count','HEAD']).trim(),split?'4':'3');
  assert.equal(git(['show','HEAD:f']),split?'a\nB\nc\nD\ne\n':'a\nb\nc\nD\ne\n');
  if(split)assert.equal(git(['show','HEAD~2:f']),'a\nb\nc\nD\ne\n');
  assert.equal(git(['status','--porcelain']),'');
}));

async function patchMoveFixture({git,put,app,cx,refresh,flush}) {
  put('f','a\nb\nc\nd\ne\n');put('g','one\n');git(['add','.']);git(['commit','-qm','base']);
  put('f','a\nB\nc\nD\ne\n');git(['commit','-qam','two changes']);put('g','two\n');git(['commit','-qam','other']);put('later','later');git(['add','.']);git(['commit','-qm','later']);await refresh();
  const pick=async(index)=>{app.panel='commits';app.openChangedFiles(app.commits[index],cx);await flush();app.openDetailFile(0,cx);await flush();
    app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);assert.equal(app.customPatch.parts.size,1);};
  return pick;
}
const subjects=git=>git(['log','--format=%s']).trim().split('\n');
test('custom patch menu follows Lazygit rows and keys',()=>harness(async h=>{
  const pick=await patchMoveFixture(h);const {app,cx}=h;await pick(2);
  app.popContext?.(cx);app.main=false;app.contexts.commits=[];app.panel='commits';app.sel.commits=0;app.syncContext();
  app.patchMenu(cx);assert.deepEqual(Array.from(app.menu.items,i=>`${i.key} ${i.label}`),[
    'c Reset patch',`m Move patch to selected commit (${app.commits[0].hash.slice(0,7)})`,'a Apply patch','r Apply patch in reverse',
    `d Remove patch from original commit (${app.commits[2].hash.slice(0,7)})`,'i Move patch out into index',
    'n Move patch into new commit after the original commit','N Move patch into new commit before the original commit','y Copy patch to clipboard']);
}));
test('custom patch moves out into the index, stashing and restoring other changes',()=>harness(async h=>{
  const pick=await patchMoveFixture(h);const {app,cx,flush,git,put}=h;await pick(2);put('later','edited');await h.refresh();
  app.rewritePatch('index',cx);assert.equal(app.pending.title,'Must stash');app.pending.then(cx);await flush();assert.equal(app.note,null);
  assert.equal(git(['show','HEAD~2:f']),'a\nb\nc\nD\ne\n');assert.equal(git(['show',':f']),'a\nB\nc\nD\ne\n');assert.equal(git(['diff','HEAD','--','later']).includes('+edited'),true);
  assert.equal(git(['stash','list']).trim(),'');assert.equal(app.customPatch,null);assert.equal(app.rebaseContinuation,null);
}));
test('custom patch moves into a new commit before the original commit',()=>harness(async h=>{
  const pick=await patchMoveFixture(h);const {app,cx,flush,git}=h;await pick(2);
  app.rewritePatch('before',cx,{message:'just B'});await flush();assert.equal(app.note,null);
  assert.deepEqual(subjects(git),['later','other','two changes','just B','base']);
  assert.equal(git(['show','HEAD~3:f']),'a\nB\nc\nd\ne\n');assert.equal(git(['show','HEAD~2:f']),'a\nB\nc\nD\ne\n');assert.equal(git(['status','--porcelain']),'');
}));
test('custom patch moves to a newer selected commit through a second rebase stop',()=>harness(async h=>{
  const pick=await patchMoveFixture(h);const {app,cx,flush,git}=h;await pick(2);
  app.rewritePatch('move',cx,{target:app.commits[1].hash});await flush();assert.equal(app.note,null);
  assert.deepEqual(subjects(git),['later','other','two changes','base']);
  assert.equal(git(['show','HEAD~2:f']),'a\nb\nc\nD\ne\n');assert.equal(git(['show','HEAD~1:f']),'a\nB\nc\nD\ne\n');assert.equal(git(['show','HEAD~1:g']),'two\n');
  assert.equal(app.customPatch,null);assert.equal(app.operation,null);
}));
test('custom patch moves to an older selected commit with the source keeping the rest',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;
  put('f','a\nb\nc\nd\ne\n');git(['add','.']);git(['commit','-qm','base']);put('g','one\n');git(['add','.']);git(['commit','-qm','older']);
  put('f','a\nB\nc\nD\ne\n');git(['commit','-qam','two changes']);await refresh();
  app.panel='commits';app.openChangedFiles(app.commits[0],cx);await flush();app.openDetailFile(0,cx);await flush();
  app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);
  app.rewritePatch('move',cx,{target:app.commits[1].hash});await flush();assert.equal(app.note,null);
  assert.deepEqual(subjects(git),['two changes','older','base']);assert.equal(git(['show','HEAD~1:f']),'a\nB\nc\nd\ne\n');assert.equal(git(['show','HEAD:f']),'a\nB\nc\nD\ne\n');assert.equal(git(['status','--porcelain']),'');
}));
test('a patch move stopped by a conflict finishes after the person continues',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;
  put('f','a\nb\nc\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\nc\n');put('h','x\n');git(['add','.']);git(['commit','-qm','source']);
  put('f','a\nBB\nc\n');git(['commit','-qam','depends']);put('t','t\n');git(['add','.']);git(['commit','-qm','target']);await refresh();
  app.panel='commits';app.openChangedFiles(app.commits[2],cx);await flush();app.openDetailFile(app.detail.items.findIndex(i=>i.path==='f'),cx);await flush();
  app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);
  app.rewritePatch('move',cx,{target:app.commits[0].hash});await flush();
  assert.ok(app.note);assert.ok(app.rebaseContinuation);assert.equal(app.operation,'rebase');
  put('f','a\nb\nc\n');git(['add','f']);app.continueOperation('rebase',cx);await flush();assert.equal(app.note,null,app.note);
  assert.equal(app.operation,null);assert.equal(app.rebaseContinuation,null);assert.deepEqual(subjects(git),['target','source','base']);
  assert.equal(git(['show','HEAD~1:f']),'a\nb\nc\n');assert.equal(git(['show','HEAD:f']),'a\nB\nc\n');
}));
test('aborting a stopped patch move drops its pending step',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;
  put('f','a\nb\nc\n');git(['add','.']);git(['commit','-qm','base']);put('f','a\nB\nc\n');put('h','x\n');git(['add','.']);git(['commit','-qm','source']);
  put('f','a\nBB\nc\n');git(['commit','-qam','depends']);put('t','t\n');git(['add','.']);git(['commit','-qm','target']);await refresh();const head=git(['rev-parse','HEAD']);
  app.panel='commits';app.openChangedFiles(app.commits[2],cx);await flush();app.openDetailFile(app.detail.items.findIndex(i=>i.path==='f'),cx);await flush();
  app.lineMode=true;const p=app.historyPatch.patch;app.anchor=p.changes.find(n=>p.lines[n]==='-b');app.cursor=p.changes.find(n=>p.lines[n]==='+B');app.addCustomPatch(cx);
  app.rewritePatch('move',cx,{target:app.commits[0].hash});await flush();assert.ok(app.rebaseContinuation);
  app.operationMenu(cx);app.menu.items.find(i=>i.label.startsWith('Abort')).run(cx);app.pending.then(cx);await flush();
  assert.equal(app.rebaseContinuation,null);assert.equal(app.operation,null);assert.equal(git(['rev-parse','HEAD']),head);
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

test('history extends without losing selection or discarding newer commits',()=>harness(async({git,app,cx,refresh,flush})=>{
  let stream='blob\nmark :1\ndata 1\nx\n';
  for(let i=0;i<305;i++){const message=`commit ${i}`;stream+=`commit refs/heads/main\ncommitter Test <test@example.invalid> ${1700000000+i} +0000\ndata ${message.length}\n${message}\nM 100644 :1 f\n\n`;}
  git(['fast-import','--quiet'],stream);git(['reset','--hard']);await refresh();assert.equal(app.commits.length,300);assert.equal(app.moreCommits,true);
  app.panel='commits';app.sel.commits=290;app.pageCommits(cx);await flush();assert.equal(app.commits.length,305);assert.equal(app.moreCommits,false);assert.equal(app.commits[304].subject,'commit 0');assert.equal(app.sel.commits,290);assert.equal(app.commits[0].subject,'commit 304');
}));

test('custom patch can split a root commit',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  put('f','a\nb\nc\n');git(['add','.']);execFileSync('git',['commit','-qm','root'],{cwd:dir,env:{...process.env,GIT_AUTHOR_DATE:'2000-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2000-01-01T00:00:00Z'},stdio:'pipe'});await refresh();
  app.panel='commits';app.openChangedFiles(app.commits[0],cx);await flush();app.openDetailFile(0,cx);await flush();
  app.lineMode=true;app.cursor=app.historyPatch.patch.changes[1];app.addCustomPatch(cx);app.rewritePatch('after',cx,{message:'split root'});await flush();
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'a\nb\nc\n');assert.equal(git(['show','HEAD^:f']),'a\nc\n');
}));

// ---------- waits: each one is visible while it lasts and gone afterwards ----------

test('first read shows a wait in every panel and clears it',()=>harness(async({git,put,app,cx,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f','changed\n');
  const release=hold();app.refresh(cx);await tick();
  assert.equal(app.loading,true);assert.equal(app.loaded,false);assert.equal(app.run.shown,true);
  assert.deepEqual({...app.mainWait()},{label:'Reading repository',fresh:true});app.render(cx);
  release();await flush();
  assert.equal(app.loading,false);assert.equal(app.loaded,true);assert.equal(app.run,null);assert.equal(app.mainWait(),null);assert.equal(app.reading,0);
  assert.equal(app.files.length,1);app.render(cx);
}));

test('a background check stays quiet until it takes long, and a forced one shows at once',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);await refresh();
  // Timers do not run on their own here: the 400 ms mark is reached by hand.
  const after=cx.timer.after;let late=null;cx.timer.after=(ms,cb)=>{if(ms===400)late=cb;else after(ms,cb);return 1;};
  let release=hold();app.refresh(cx);await tick();
  assert.equal(app.loading,true);assert.equal(app.run.shown,false);
  late(cx);assert.equal(app.run.shown,true);
  release();await flush();assert.equal(app.run,null);
  // A check that ended before the mark is not shown by it afterwards.
  release=hold();app.refresh(cx);await tick();const stale=late;release();await flush();stale(cx);assert.equal(app.run,null);
  release=hold();app.refresh(cx,true);await tick();assert.equal(app.run.shown,true);release();await flush();
  cx.timer.after=after;
}));

test('an action is busy, then settling until the lists show its result',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f','changed\n');await refresh();app.tree=false;app.layoutFiles();
  let release=hold();app.keys({key:'space',modifiers:{}},cx);await tick();
  assert.equal(app.busy,'Stage');assert.equal(app.files[0].staged,false);app.render(cx);
  // A second action while one runs is refused, not queued.
  app.keys({key:'a',key_char:'a',modifiers:{}},cx);assert.equal(app.busy,'Stage');
  release();release=hold();await tick();await tick();
  assert.equal(app.busy,null);assert.equal(app.settling,'Stage');assert.equal(app.loading,true);app.render(cx);
  release();await flush();
  assert.equal(app.settling,null);assert.equal(app.loading,false);assert.equal(app.files[0].staged,true);assert.equal(app.info,'Stage');
}));

test('a failed action clears its wait and says why',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);await refresh();
  app.perform('Checkout',[['switch','no-such-branch']],cx);await flush();
  assert.equal(app.busy,null);assert.equal(app.settling,null);assert.equal(app.opening,null);assert.equal(app.loading,false);
  assert.match(app.note,/^Checkout failed: /);
}));

test('an action before the repository is read says so instead of doing nothing',()=>harness(async({git,put,app,cx,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);
  const release=hold();app.refresh(cx);await tick();
  app.perform('Fetch',[['fetch']],cx);assert.equal(app.busy,undefined);assert.equal(app.note,'Still reading the repository');
  release();await flush();
}));

test('a slow read of the main view dims what it replaces and a superseded read is dropped',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('a','one\n');put('b','two\n');git(['add','.']);git(['commit','-qm','base']);put('a','ONE\n');put('b','TWO\n');await refresh();
  app.tree=false;app.layoutFiles();assert.equal(app.shown,'f:unstaged:a');
  const release=hold();app.keys({key:'j',key_char:'j',modifiers:{}},cx);await tick();
  assert.equal(app.reading,1);assert.deepEqual({...app.mainWait()},{label:'Reading diff',fresh:true});app.render(cx);
  assert.match(app.rows.map(r=>r.text).join('\n'),/ONE/); // still the previous file, dimmed
  // Back before it arrives: nothing is waited for, and the late answer is not shown.
  app.keys({key:'k',key_char:'k',modifiers:{}},cx);await tick();assert.equal(app.mainWait(),null);
  release();await flush();
  assert.equal(app.reading,0);assert.equal(app.shown,'f:unstaged:a');assert.match(app.rows.map(r=>r.text).join('\n'),/ONE/);assert.equal(app.mainWait(),null);
}));

test('reading changed files shows a wait in the originating pane and changes nothing',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);await refresh();await (async()=>{app.panel='commits';app.main=false;})();
  const release=hold();app.openChangedFiles(app.commits[0],cx);await tick();
  assert.equal(app.context().loading,true);assert.equal(app.main,false);assert.deepEqual({...app.mainWait()},{label:'Reading changed files',fresh:true});app.render(cx);
  release();await flush();
  assert.equal(app.opening,null);assert.equal(app.settling,null);assert.equal(app.detail.items[0].path,'f');assert.equal(app.mainWait(),null);
}));

test('a failed repository read clears the wait and keeps the error',()=>harness(async({git,put,app,cx,refresh,flush,failOn})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);await refresh();
  failOn((_command,args)=>args.includes('status'));
  app.refresh(cx,true);await flush();
  assert.equal(app.loading,false);assert.equal(app.run,null);assert.equal(app.error,'host went away');assert.equal(app.branch.name,'main');app.render(cx);
  failOn(null);app.refresh(cx,true);await flush();assert.equal(app.error,null);
}));

test('a terminal that cannot start clears its wait',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);await refresh();
  app.launchLazygit(cx);app.launchLazygit(cx);await flush();
  assert.equal(app.launching,null);assert.match(app.note,/^Could not open lazygit: /);
}));

test('closing during a read leaves no wait behind',()=>harness(async({git,put,app,cx,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);
  const release=hold();app.refresh(cx);await tick();app.close();release();await flush();
  assert.equal(app.loading,false);assert.equal(app.loaded,false);assert.equal(app.branch,null);
}));


test('Files selected rows respect hidden untracked files and path-filtered staging preserves ignored files',()=>harness(async({dir,git,put,app,cx,refresh,key,flush})=>{
  fs.mkdirSync(join(dir,'folder'));put('.gitignore','ignored\n');put('folder/tracked','base');git(['add','.']);git(['commit','-qm','base']);
  put('folder/tracked','change');put('folder/untracked','hidden');put('ignored','secret');git(['config','status.showUntrackedFiles','no']);
  await refresh();assert.deepEqual(Array.from(app.files,f=>f.path),['folder/tracked']);app.toggleSelectedFiles(cx);await flush();
  assert.equal(git(['ls-files','--error-unmatch','folder/tracked']).trim(),'folder/tracked');assert.equal(git(['diff','--cached','--name-only']).trim(),'folder/tracked');
  assert.equal(git(['ls-files','folder/untracked']), '');
  await key('b',{control:true});assert.equal(app.menu.title,'Filter files');await key('T');assert.equal(app.fileStatus,'untracked');
  assert.deepEqual(Array.from(app.visibleFiles(),f=>f.path),['folder/untracked']);app.toggleAll(cx);await flush();assert.equal(git(['ls-files','folder/untracked']).trim(),'folder/untracked');
  app.setFileStatus('staged',cx);await flush();app.filter='tracked';app.layoutFiles();app.toggleAll(cx);await flush();
  assert.equal(git(['diff','--cached','--name-only']).trim(),'');assert.equal(git(['ls-files','ignored']), '');
}));

test('path filter opens collapsed folders and excludes hidden files during folder staging',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  fs.mkdirSync(join(dir,'dir'));put('dir/one','1');put('dir/two','2');await refresh();app.collapsed.add('dir');app.filter='one';app.layoutFiles();
  assert.equal(app.nodes.length,2);assert.equal(app.nodes[0].open,true);app.toggleFile(app.nodes[0],cx);await flush();
  assert.equal(git(['diff','--cached','--name-only']).trim(),'dir/one');
  app.toggleAll(cx);await flush();assert.equal(git(['ls-files']), '');
}));

test('unstaging a rename restores both index paths and search matches the former name',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('old name','content');git(['add','.']);git(['commit','-qm','base']);git(['mv','old name','new name']);await refresh();
  app.filter='old';app.layoutFiles();assert.equal(app.nodes.length,1);assert.equal(app.item().file.previousPath,'old name');
  app.toggleFile(app.item(),cx);await flush();assert.equal(app.note,null);assert.equal(git(['diff','--cached']), '');assert.equal(git(['ls-files']).trim(),'old name');
}));

test('staging a literal pathspec-looking filename never adds other paths',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put(':(glob)*','literal');put('other','leave');await refresh();app.tree=false;app.filter='glob';app.layoutFiles();app.toggleAll(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['ls-files','-z']), ':(glob)*\0'.replace('\\0','\0'));
}));

test('merge filter retains resolved paths and rejects unresolved bulk staging',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const f of ['a','b','unrelated'])put(f,'base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);
  for(const f of ['a','b'])put(f,'theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);
  for(const f of ['a','b'])put(f,'ours\n');git(['commit','-qam','ours']);try{git(['merge','other']);}catch{}put('unrelated','working');await refresh();
  assert.equal(app.fileStatus,'conflicted');assert.deepEqual(Array.from(app.visibleFiles(),f=>f.path),['a','b']);
  app.toggleAll(cx);await flush();assert.match(app.note,/Resolve conflicts/);assert.equal(git(['diff','--name-only','--diff-filter=U']).trim(),'a\nb');
  put('a','resolved a\n');await refresh();assert.equal(app.files.find(f=>f.path==='a').conflict,false);assert.deepEqual(Array.from(app.visibleFiles(),f=>f.path),['a','b']);
  put('b','<<<<<<< HEAD\nunclosed\n');await refresh();assert.equal(app.files.find(f=>f.path==='b').conflict,true);
  put('b','resolved b\n');await refresh();assert.equal(app.fileStatus,'all');assert.ok(app.visibleFiles().some(f=>f.path==='unrelated'));
}));

test('modify/delete conflicts show meaningful actions and accepting deletion stages removal',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);git(['rm','f']);git(['commit','-qm','delete']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);
  try{git(['merge','other']);}catch{}await refresh();assert.equal(app.item().file.x+app.item().file.y,'UD');
  assert.match(app.rows.map(r=>r.text).join('\n'),/Deleted by them/);app.conflictMenu(cx);app.menu.items.find(i=>i.label==='Accept theirs deletion…').run(cx);app.pending.then(cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['ls-files','-u']), '');assert.equal(git(['ls-files','f']), '');
}));

test('each side pane owns its nested commits and files, and Escape restores parent selection',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('a','base');git(['add','.']);git(['commit','-qm','first']);put('a','second');put('b','new');git(['add','.']);git(['commit','-qm','second']);git(['branch','topic']);git(['tag','v1']);await refresh();
  await key('3');await key('j');const parent=app.item().name;await key('enter');assert.equal(app.panel,'branches');assert.equal(app.context().type,'commits');assert.equal(app.main,false);
  await key('j');const hash=app.item().hash;await key('enter');assert.equal(app.context().type,'files');assert.equal(app.main,false);assert.equal(app.list()[0].path,'a');assert.ok(app.historyPatch?.patch);
  await key('enter');assert.equal(app.main,true);await key('escape');assert.equal(app.main,false);assert.equal(app.context().type,'files');
  await key('4');assert.equal(app.context(),null);assert.equal(app.detail,null);await key('3');assert.equal(app.context().type,'files');
  await key('escape');assert.equal(app.context().type,'commits');assert.equal(app.item().hash,hash);await key('escape');assert.equal(app.context(),null);assert.equal(app.item().name,parent);
  app.selectView('branches','tags',cx);await flush();await key('enter');assert.equal(app.context().type,'commits');assert.equal(app.panel,'branches');
  await key('escape');await key('4');await key(']');await key('enter');assert.equal(app.context().type,'commits');assert.equal(app.panel,'commits');
  const actions=app.contextActions(cx);assert.ok(!actions.some(a=>['r','d','f','s','e','A','i','V'].includes(a[1])));
}));

test('double-click enters commits and files in the same side pane',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);await refresh();app.wide=false;app.panel='branches';
  for(const type of ['commits','files']){
    elements.length=0;app.render(cx);elements.find(e=>e._id==='branches-0').events.on_click({click_count:2},cx);await flush();assert.equal(app.context().type,type);assert.equal(app.main,false);
  }
  elements.length=0;app.render(cx);elements.find(e=>e._id==='branches-0').events.on_click({click_count:2},cx);await flush();assert.equal(app.main,true);
}));

test('back or close during a nested read discards its late result',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);await refresh();app.panel='branches';
  const release=hold();app.openSubCommits(app.item(),cx);await tick();assert.equal(app.context().loading,true);app.popContext(cx);release();await flush();assert.equal(app.context(),null);assert.equal(app.main,false);assert.equal(app.detail,null);
}));

test('stash branch starts at the stash commit and retains the stash',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);put('f','stashed');git(['stash','push','-qm','work']);await refresh();const st=app.stashes[0];
  app.stashAction('branch',st,cx,'stash-work');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),st.hash);assert.equal(git(['rev-parse','stash@{0}']).trim(),st.hash);assert.equal(git(['status','--porcelain']),'');assert.equal(git(['show','HEAD:f']),'stashed');
}));

test('remote checkout reuses a local branch or offers tracking and detached choices',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['remote','add','origin','https://example.invalid/repo']);git(['branch','topic']);git(['update-ref','refs/remotes/origin/topic','HEAD']);git(['update-ref','refs/remotes/origin/new','HEAD']);await refresh();
  app.checkoutRemote(app.remoteBranches.find(b=>b.name==='origin/topic'),cx);await flush();assert.equal(git(['branch','--show-current']).trim(),'topic');assert.equal(app.prompt,null);
  app.checkoutRemote(app.remoteBranches.find(b=>b.name==='origin/new'),cx);assert.equal(app.menu.items.length,2);app.pickMenu(0,cx);app.prompt.submit('new',cx);app.prompt=null;await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','--abbrev-ref','@{upstream}']).trim(),'origin/new');
}));

test('squash operation menu continues with commit and has no skip action',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','other');git(['commit','-qam','other']);git(['switch','-q','main']);git(['merge','--squash','other']);await refresh();
  assert.equal(app.operation,'squash-merge');app.operationMenu(cx);assert.ok(!app.menu.items.some(i=>i.label.startsWith('Skip')));await key('c');assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(git(['rev-list','--count','HEAD']).trim(),'2');
}));

test('action menus dispatch mnemonics, filter, and keep disabled reasons',()=>harness(async({app,cx,key})=>{
  let chosen='';app.menuItems('Actions', [['Alpha','a',()=>{chosen='a';}],['Beta','b',()=>{chosen='b';},false,null,'Unavailable while rebasing']],cx);
  await key('b');assert.equal(chosen,'');assert.equal(app.note,'Unavailable while rebasing');assert.ok(app.menu);
  await key('/');app.menu.query='alpha';app.menuSearch.set_value('alpha');await key('enter');assert.equal(chosen,'a');assert.equal(app.menu,null);
}));

test('review: branch SubCommits does not inherit branch delete',()=>harness(async({git,put,app,refresh,key})=>{
  put('a','a');git(['add','.']);git(['commit','-qm','base']);await refresh();
  await key('3');await key('enter');assert.equal(app.context().type,'commits');await key('d');
  assert.equal(app.pending,null, JSON.stringify(app.pending));
}));
test('review: filtering CommitFiles synchronizes the selected preview',()=>harness(async({git,put,app,cx,flush,refresh,key})=>{
  // The InputState test mock must expose its existing handlers object.
  put('a','a');put('b','b');git(['add','.']);git(['commit','-qm','base']);await refresh();
  await key('4');await key('enter');assert.equal(app.context().type,'files');assert.equal(app.source().path,'a');
  app.panelSearch.set_value('b');app.panelSearch.handlers.change({},cx);await flush();
  assert.equal(app.item().path,'b');assert.equal(app.source().path,'b');
}));
test('review: comparison mode applies inside SubCommits',()=>harness(async({git,put,app,cx,flush,refresh,key})=>{
  put('a','a');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();
  put('b','b');git(['add','.']);git(['commit','-qm','next']);await refresh();await key('3');await key('enter');
  app.compareBase=base;app.reload(cx);await flush();assert.ok(app.source().key.startsWith('compare:'),app.source().key);
}));
test('review: operation m is available from a nested context',()=>harness(async({git,put,app,refresh,key})=>{
  put('a','a');git(['add','.']);git(['commit','-qm','base']);await refresh();await key('3');await key('enter');
  app.operation='merge';await key('m');assert.ok(app.menu.items.some(x=>x.label==='Continue'),app.menu.title);
}));
test('review: a resolved document containing an equals underline can be marked resolved',()=>harness(async({git,put,app,cx,flush,refresh})=>{
  put('f','Title\n=======\nbase\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','Title\n=======\ntheirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','Title\n=======\nours\n');git(['commit','-qam','ours']);
  try{git(['merge','other']);}catch{}await refresh();put('f','Title\n=======\nresolved\n');await refresh();
  assert.equal(app.files.find(f=>f.path==='f').conflict,false,git(['status','--porcelain']));
}));
test('review: discarding the last squash change ends the squash operation',()=>harness(async({git,put,app,cx,flush,refresh})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','other\n');git(['commit','-qam','other']);git(['switch','-q','main']);git(['merge','--squash','other']);await refresh();
  assert.equal(app.operation,'squash-merge');app.discard(app.files[0],cx);app.pending.then(cx);await flush();
  assert.equal(git(['status','--porcelain']),'');assert.equal(app.operation,null);
}));
test('review race: an older same-file diff must not overwrite a newer read',()=>harness(async({git,put,app,cx,refresh,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f','old result\n');await refresh();app.tree=false;app.layoutFiles();
  const original=app.boundedGit.bind(app);let release,announce;
  const blocked=new Promise(r=>{release=r;}), started=new Promise(r=>{announce=r;});let once=true;
  app.boundedGit=async(args,max)=>{const result=await original(args,max);if(once&&args[0]==='diff'){once=false;announce();await blocked;}return result;};
  app.stale=true;const old=app.load(cx);await started;
  put('f','new result\n');app.stale=true;await app.load(cx);
  assert.ok(app.patch.raw.includes('+new result'));release();await old;
  assert.ok(app.patch.raw.includes('+new result'),app.patch.raw);
}));
test('review race: feature results from the previous repository must be dropped',()=>harness(async({git,put,app,cx,refresh})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);git(['remote','add','old-repo','https://example.invalid/old']);await refresh();
  const original=app.boundedGit.bind(app);let release,announce;
  const blocked=new Promise(r=>{release=r;}), started=new Promise(r=>{announce=r;});let once=true;
  app.boundedGit=async(args,max)=>{const result=await original(args,max);if(once&&args[0]==='remote'){once=false;announce();await blocked;}return result;};
  const old=app.refreshFeatures();await started;
  app.repoKey='next-repo';app.root=app.root+'/next';app.remotes=[{name:'next-repo',url:'https://example.invalid/next'}];
  release();await old;assert.equal(app.remotes[0].name,'next-repo');
}));
test('review staged: squash cannot absorb previously staged unrelated work',()=>harness(async({git,put,app,cx,flush,refresh,key})=>{
  put('f','base\n');put('unrelated','base\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','other\n');git(['commit','-qam','other']);git(['switch','-q','main']);
  put('unrelated','my unrelated staged work\n');git(['add','unrelated']);await refresh();await key('3');
  app.sel.branches=app.branchItems().findIndex(b=>b.name==='other');await key('M');
  const squash=app.menu.items.find(x=>x.label.toLowerCase().includes('squash'));
  assert.ok(squash.disabled,JSON.stringify(squash));
}));
test('review capability: a reflog drilldown cannot rewrite history through a custom patch',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f','next\n');git(['commit','-qam','next']);await refresh();
  await key('4');await key(']');assert.equal(app.commitView,'reflog');await key('enter');assert.equal(app.context().type,'commits');
  await key('enter');assert.equal(app.context().type,'files');await key('enter');assert.ok(app.historyPatch?.patch);await key('space');assert.ok(app.customPatch);
  app.patchMenu(cx);assert.ok(!app.menu.items.some(x=>x.label.startsWith('Remove patch from original commit')),app.menu.items.map(x=>x.label).join(', '));
}));


test('commit range copy keeps ancestry order and Ctrl-R clears it',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);for(const value of ['one','two']){put('f',value);git(['commit','-qam',value]);}await refresh();await key('4');
  await key('v');await key('j');await key('C');assert.equal(app.copied.size,2);assert.equal(app.rangeAnchors[app.viewKey()],null);
  await key('r',{control:true});assert.equal(app.copied.size,0);
  await key('down',{shift:true});assert.equal(app.selectedItems().length,2);await key('escape');assert.equal(app.selectedItems().length,1);
}));

async function rangeFixture({git,put,app,refresh}) {
  for(const path of ['a','b','c','d'])put(path,`${path} base\n`);
  git(['add','.']);git(['commit','-qm','base']);
  for(const path of ['a','b','c','d'])put(path,`${path} changed\n`);
  await refresh();app.tree=false;app.layoutFiles();app.panel='files';app.main=false;app.sel.files=0;
}
test('file range: sticky and nonsticky movement stage exactly the selected rows',()=>harness(async h=>{
  await rangeFixture(h);const {app,key,git}=h;
  await key('v');await key('j');await key('j');assert.deepEqual(Array.from(app.selectedItems(),n=>n.file.path),['a','b','c']);
  await key('space');assert.equal(git(['diff','--cached','--name-only']),'a\nb\nc\n');assert.equal(app.selectedItems().length,3);
  await key('up',{shift:true});assert.equal(app.selectedItems().length,2);await key('j');assert.equal(app.selectedItems().length,1);
  await key('space');assert.equal(git(['diff','--cached','--name-only']),'a\nb\n');
  await key('down',{shift:true});assert.equal(app.selectedItems().length,2);await key('escape');assert.equal(app.sel.files,3);assert.equal(app.selectedItems().length,1);assert.equal(app.closed,undefined);
  await key('v');await key('v');assert.equal(app.rangeAnchors.files,null);
}));
test('file range: mixed staged and unstaged selection stages first, then unstages both rename paths',()=>harness(async h=>{
  await rangeFixture(h);const {app,git,refresh,key}=h;
  git(['add','a']);git(['restore','--','b']);git(['mv','b','renamed']);await refresh();app.sel.files=0;
  await key('v');await key('end');await key('space');assert.equal(git(['diff','--name-only']),'');
  assert.ok(git(['diff','--cached','--name-status']).includes('renamed'));
  await key('space');assert.equal(git(['diff','--cached']),'');assert.equal(git(['ls-files','b']).trim(),'b');assert.equal(git(['ls-files','renamed']),'');
}));
test('file range: filtered tree selection deduplicates descendants and keeps hidden files untouched',()=>harness(async h=>{
  const {dir,git,put,app,cx,refresh,key}=h;
  fs.mkdirSync(join(dir,'folder'));for(const path of ['folder/a','folder/b','folder/hidden','other'])put(path,'base\n');
  put('.gitignore','ignored\n');git(['add','.']);git(['commit','-qm','base']);for(const path of ['folder/a','folder/b','folder/hidden','other'])put(path,'changed\n');put('ignored','keep\n');
  await refresh();app.panel='files';app.tree=true;app.filter='folder';app.layoutFiles();
  app.fileStatus='unstaged';app.filter='folder';app.layoutFiles();app.sel.files=0;await key('v');await key('down');await key('space');
  assert.equal(git(['diff','--cached','--name-only']),'folder/a\nfolder/b\nfolder/hidden\n');assert.equal(git(['diff','--name-only']),'other\n');assert.equal(fs.readFileSync(join(dir,'ignored'),'utf8'),'keep\n');
  assert.equal(app.note,null);app.cancelRange();app.fileStatus='all';app.filter='folder/a';app.layoutFiles();app.toggleAll(cx);await h.flush();assert.equal(git(['diff','--cached','--name-only']),'folder/b\nfolder/hidden\n');
}));
test('file range: mouse drag persists until plain movement; modified clicks leave it unchanged',()=>harness(async h=>{
  await rangeFixture(h);const {app,cx,flush,key}=h;
  app.beginListPointer('files',0,{modifiers:{}},cx);app.extendListPointer('files',2,{modifiers:{}},cx);app.listPointer.released=true;
  app.clickListRow('files',2,{modifiers:{},click_count:1},cx);await flush();assert.equal(app.selectedItems().length,3);
  app.clickListRow('files',1,{modifiers:{shift:true},click_count:1},cx);assert.equal(app.sel.files,2);assert.equal(app.selectedItems().length,3);
  await key('k');assert.equal(app.sel.files,1);assert.equal(app.selectedItems().length,1);
  await key('v');await key('j');app.clickListRow('files',3,{modifiers:{},click_count:1},cx);await flush();assert.equal(app.selectedItems().length,1);assert.equal(app.sel.files,3);
}));
test('file range: rendered row pointer handlers preserve a drag after release',()=>harness(async h=>{
  await rangeFixture(h);const {app,cx,flush}=h;elements.length=0;app.render(cx);
  const first=elements.find(e=>e._id==='files-0'),third=elements.find(e=>e._id==='files-2');assert.ok(first.events['on_mouse_down:left']);
  first.events['on_mouse_down:left']({modifiers:{}},cx);third.events.on_mouse_move({modifiers:{}},cx);await flush();assert.equal(app.selectedItems().length,3);
  const container=elements.find(e=>e.events['on_mouse_up:left']&&e._children.some(child=>child?._id==='list-files'));assert.ok(container);container.events['on_mouse_up:left']({},cx);third.events.on_mouse_move({modifiers:{}},cx);third.events.on_click({click_count:1,modifiers:{}},cx);assert.equal(app.selectedItems().length,3);
}));
test('file range: refresh follows moving-end path and clears only when its index changes',()=>harness(async h=>{
  await rangeFixture(h);const {app,git,put,refresh,key}=h;
  put('0-new','base\n');git(['add','0-new']);git(['commit','-qm','add another file']);await refresh();
  await key('v');await key('j');await refresh();assert.equal(app.selectedItems().length,2);
  put('0-new','new\n');await refresh();assert.equal(app.item().file.path,'b');assert.equal(app.selectedItems().length,1);
  await key('v');await key('j');git(['restore','--','c']);await refresh();assert.equal(app.item().file.path,'d');assert.equal(app.selectedItems().length,2);
  git(['mv','d','z-renamed']);await refresh();assert.equal(app.item().file.path,'z-renamed');assert.equal(app.selectedItems().length,2);
}));

test('file range: discard menu keeps staged changes, clears selection, and deletes selected untracked files',()=>harness(async h=>{
  await rangeFixture(h);const {dir,git,put,app,cx,refresh,key}=h;
  git(['add','a']);put('a','a extra\n');put('z-fresh','new\n');await refresh();app.sel.files=0;
  await key('v');await key('end');await key('d');assert.deepEqual(Array.from(app.menu.items,i=>i.label),['Discard all changes','Discard unstaged changes']);assert.equal(app.menu.items[1].disabled,null);
  await key('escape');assert.equal(app.selectedItems().length,5);await key('d');await key('u');
  assert.equal(app.note,null);assert.equal(app.rangeAnchors.files,null);assert.equal(git(['show',':a']),'a changed\n');assert.equal(git(['diff']),'');assert.equal(fs.existsSync(join(dir,'z-fresh')),false);
  await key('d');assert.match(app.menu.items[1].disabled,/both staged and unstaged/);await key('x');assert.equal(app.note,null);assert.equal(git(['status','--porcelain']),'');
}));
test('file range: discard all restores both rename sides and leaves ignored and hidden paths alone',()=>harness(async h=>{
  const {dir,git,put,app,refresh,key}=h;
  put('.gitignore','ignored\n');put('old[1]','base\n');put('hidden','base\n');git(['add','.']);git(['commit','-qm','base']);git(['mv','old[1]','new[1]']);put('new[1]','base\nextra\n');put('hidden','keep\n');put('ignored','keep ignored\n');
  await refresh();app.tree=false;app.filter='new[1]';app.layoutFiles();app.panel='files';await key('d');await key('x');
  assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'old[1]'),'utf8'),'base\n');assert.equal(fs.existsSync(join(dir,'new[1]')),false);assert.equal(fs.readFileSync(join(dir,'hidden'),'utf8'),'keep\n');assert.equal(fs.readFileSync(join(dir,'ignored'),'utf8'),'keep ignored\n');
}));
test('file range: discard clears range on Git failure and rejects a menu from another repository',()=>harness(async h=>{
  await rangeFixture(h);const {app,key,failOn,cx,flush,git}=h;
  await key('v');await key('j');await key('d');failOn((cmd,args)=>cmd==='env'&&args.includes('checkout'));await key('x');assert.match(app.note,/host went away/);assert.equal(app.rangeAnchors.files,null);
  failOn(null);await key('d');const run=app.menu.items[0].run;app.menu=null;app.repoKey='different';run(cx);await flush();assert.equal(git(['diff','--name-only']),'a\nb\nc\nd\n');
}));
test('file range: ignore and exclude menus preserve literal names and require one selected row',()=>harness(async h=>{
  const {dir,put,git,app,refresh,key}=h;put('tracked','base');git(['add','.']);git(['commit','-qm','base']);put('!wild[1]*','keep');put('!wildx','also keep');await refresh();app.tree=false;app.layoutFiles();app.panel='files';
  app.sel.files=app.nodes.findIndex(n=>n.file.path==='!wild[1]*');await key('v');await key('i');assert.equal(app.menu.title,'Ignore / exclude file');await key('i');assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'.gitignore'),'utf8'),'/\\!wild\\[1\\]\\*\n');assert.equal(git(['check-ignore','!wild[1]*']).trim(),'!wild[1]*');assert.ok(app.files.some(f=>f.path==='!wildx'));
  app.cancelRange();app.sel.files=app.nodes.findIndex(n=>n.file.path==='!wildx');await key('i');await key('e');assert.equal(git(['check-ignore','!wildx']).trim(),'!wildx');assert.equal(fs.readFileSync(join(dir,'!wildx'),'utf8'),'also keep');
  put('a','a');put('b','b');await refresh();app.sel.files=app.nodes.findIndex(n=>n.file.path==='a');await key('v');await key('down');await key('i');assert.equal(app.menu,null);assert.match(app.note,/Range selection/);
}));
test('file range: ignoring a tracked file confirms index removal and keeps its working contents',()=>harness(async h=>{
  await rangeFixture(h);const {dir,git,app,key}=h;
  await key('i');await key('e');assert.ok(app.pending);assert.equal(git(['ls-files','a']).trim(),'a');await key('enter');assert.equal(app.note,null);assert.equal(git(['ls-files','a']),'');assert.equal(fs.readFileSync(join(dir,'a'),'utf8'),'a changed\n');assert.equal(git(['check-ignore','a']).trim(),'a');
}));
test('file range: copy menu restricts single-file entries and copies the whole staged repository diff',()=>harness(async h=>{
  await rangeFixture(h);const {git,app,refresh,key,clipboard}=h;git(['add','d']);await refresh();
  await key('v');await key('down');await key('y');assert.ok(app.menu.items.slice(0,4).every(i=>i.disabled));await key('p');assert.equal(clipboard.length,0);assert.ok(app.menu);
  await key('a');assert.equal(clipboard.at(-1),git(['diff','--cached','--no-ext-diff','--no-textconv','--no-color']));
  await key('escape');await key('y');await key('p');assert.equal(clipboard.at(-1),'b');
}));

test('file range: stage-all matches repository, tracked-only, and text-filter scopes',()=>harness(async h=>{
  await rangeFixture(h);const {git,put,app,cx,refresh,key}=h;put('untracked','new');git(['config','status.showUntrackedFiles','no']);await refresh();
  await key('a');assert.equal(git(['diff','--cached','--name-only']),'a\nb\nc\nd\nuntracked\n');
  app.setFileStatus('staged',cx);await h.flush();await key('a');assert.equal(git(['diff','--cached']),'');
  app.setFileStatus('tracked',cx);await h.flush();await key('a');assert.equal(git(['diff','--cached','--name-only']),'a\nb\nc\nd\n');
  app.filter='a';app.layoutFiles();await key('a');assert.equal(git(['diff','--cached','--name-only']),'b\nc\nd\n');
}));
test('file range: stage-all and unstage-all work before the first commit',()=>harness(async h=>{
  const {app,put,git,refresh,key}=h;put('new','new');await refresh();await key('a');assert.equal(app.note,null);assert.equal(git(['ls-files']).trim(),'new');await key('a');assert.equal(app.note,null);assert.equal(git(['ls-files']),'');
}));
test('file range: configured selection and discard keys dispatch their operations',()=>harness(async h=>{
  await rangeFixture(h);const {app,put,refresh,key,git}=h;
  put('.git/lazygit.yml','keybinding:\n  universal:\n    toggleRangeSelect: Q\n    rangeSelectDown: <ctrl+n>\n  files:\n    confirmDiscard: X\n');await refresh();
  await key('Q');await key('n',{control:true});assert.equal(app.selectedItems().length,2);await key('d');await key('x');assert.ok(app.menu);await key('X');assert.equal(app.note,null);assert.equal(git(['diff','--name-only']),'c\nd\n');
}));
test('file range: single-item guards block keyboard and menu actions without losing the range',()=>harness(async h=>{
  await rangeFixture(h);const {app,key,cx}=h;
  await key('v');await key('j');await key('enter');assert.equal(app.main,false);assert.match(app.note,/single selected item/);
  await key('3');await key('v'); // single branch remains eligible despite sticky mode
  assert.equal(app.branchActions(cx).find(a=>a[1]==='enter')[5],undefined);
  app.branches.push({name:'other',hash:app.head,ref:'refs/heads/other'});await key('j');await key('space');assert.match(app.note,/single selected item/);assert.equal(app.selectedItems().length,2);
  app.main=true;assert.ok(app.branchActions(cx).find(a=>a[1]==='space')[5]);app.main=false;
  app.menuItems('Branches',app.branchActions(cx),cx);await key('enter');assert.ok(app.menu);assert.equal(app.context(),null);
}));

async function commitFilesFixture(h) {
  const {git,put,app,refresh,key}=h;put('a','one\ntwo\nthree\nfour\nfive\n');put('b','base\n');put('binary',Buffer.from([0,1,2]));git(['add','.']);git(['commit','-qm','base']);
  put('a','ONE\ntwo\nthree\nfour\nFIVE\n');put('b','next\n');put('binary',Buffer.from([0,3,4]));git(['add','.']);git(['commit','-qm','changes']);await refresh();await key('4');await key('enter');assert.equal(app.context().type,'files');
}
test('commit-file range: whole-file patch includes binary changes and toggles the full selection',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,key,cx,flush,git}=h;
  await key('v');await key('end');await key('space');assert.equal(app.note,null);assert.equal(app.customPatch.parts.size,3);assert.ok(app.customPatchText().includes('GIT binary patch'));assert.equal(app.selectedItems().length,3);
  git(['apply','--reverse','--check','-'],app.customPatchText());
  app.patchMenu(cx);app.menu.items.find(i=>i.label==='Apply patch in reverse').run(cx);app.menu=null;await flush();assert.equal(app.note,null);assert.equal(git(['show',':a']),'one\ntwo\nthree\nfour\nfive\n');assert.equal(git(['show',':b']),'base\n');
  await key('space');assert.equal(app.customPatch,null);assert.equal(app.selectedItems().length,3);
  await key('escape');assert.equal(app.context().type,'files');assert.equal(app.selectedItems().length,1);await key('escape');assert.equal(app.context(),null);
}));
test('commit-file range: partial selection becomes whole and zero-context patch building is refused',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,key,cx,flush,put,refresh}=h;
  await key('enter');app.lineMode=true;app.cursor=app.rawDiffLines.indexOf('+ONE');await key('space');assert.equal(app.customPatch.parts.get('a').rows.size,1);assert.equal(app.patchFileStatus({path:'a'}),'partial');
  app.main=false;await key('v');await key('down');await key('space');assert.equal(app.customPatch.parts.size,2);assert.equal(app.patchFileStatus({path:'a'}),'whole');await key('space');assert.equal(app.customPatch,null);
  put('.git/lazygit.yml','git:\n  diffContextSize: 0\n');await refresh();await key('space');assert.match(app.note,/Increase the diff context/);assert.equal(app.customPatch,null);
}));
test('commit-file range: all-files binding is remapped through Files configuration and replacement needs confirmation',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,key,git,put,refresh}=h;
  put('.git/lazygit.yml','keybinding:\n  files:\n    toggleStagedAll: A\n');await refresh();await key('A');assert.equal(app.customPatch.parts.size,3);
  await key('escape');await key('j');await key('enter');await key('space');assert.ok(app.pending);assert.equal(app.pending.title,'Discard custom patch');await key('escape');assert.equal(app.customPatch.parts.size,3);
  await key('space');await key('enter');assert.equal(app.note,null);assert.equal(app.customPatch.ref,git(['rev-parse','HEAD^']).trim());assert.equal(app.customPatch.parts.size,1);
}));
test('commit-file range: a read overtaken by leaving the context cannot replace the custom patch',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,cx,hold,tick,flush}=h;
  const release=hold();app.toggleCommitFiles(cx,true);await tick();assert.equal(app.busy,'Updating patch');app.popContext(cx);release();await flush();assert.equal(app.customPatch,null);assert.equal(app.busy,null);assert.equal(app.context(),null);
}));
test('commit-file range: numeric selection survives refresh and clamps empty lists without leaving the context',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,cx,key,flush}=h;await key('v');await key('end');const frame=app.context();
  app.readContext(frame,async()=>({items:[{path:'new',status:'A'},{path:'a',status:'M'}]}),cx);await flush();assert.deepEqual(Array.from(app.selectedItems(),i=>i.path),['a','new']);assert.equal(app.rangeModes[frame.key],'sticky');
  app.readContext(frame,async()=>({items:[]}),cx);await flush();assert.equal(app.sel.commits,-1);assert.equal(app.rangeAnchors[frame.key],-1);await key('escape');assert.equal(app.context(),frame);assert.equal(app.rangeAnchors[frame.key],null);
}));

test('commit-file range: discarding selected files rewrites an older commit and keeps later changes',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,git,put,refresh,key}=h;
  await key('space');assert.ok(app.customPatch);await key('escape');put('later','later content\n');git(['add','later']);git(['commit','-qm','later']);await refresh();app.sel.commits=1;await key('enter');
  await key('v');await key('down');await key('d');assert.match(app.pending.body??app.pending.text??app.pending.description??JSON.stringify(app.pending),/custom patch will be cleared/);await key('enter');
  assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(app.customPatch,null);assert.equal(git(['show','HEAD:a']),'one\ntwo\nthree\nfour\nfive\n');assert.equal(git(['show','HEAD:b']),'base\n');assert.equal(git(['show','HEAD:later']),'later content\n');assert.equal(git(['rev-list','--count','HEAD']).trim(),'3');assert.equal(git(['status','--porcelain']),'');
  assert.equal(app.context().type,'files');assert.deepEqual(Array.from(app.contextItems(),f=>f.path),['binary']);assert.equal(app.rangeAnchors[app.viewKey()],null);assert.equal(app.context().ref,git(['rev-parse','HEAD^']).trim());
}));
test('commit-file range: discarding a root file preserves an empty root commit',()=>harness(async h=>{
  const {app,put,git,refresh,key}=h;put('root','root');git(['add','.']);git(['commit','-qm','root']);await refresh();await key('4');await key('enter');await key('d');await key('enter');
  assert.equal(app.note,null);assert.equal(git(['rev-list','--count','HEAD']).trim(),'1');assert.equal(git(['ls-tree','-r','--name-only','HEAD']),'');assert.equal(app.contextItems().length,0);
}));
test('commit-file range: stale discard confirmation and nonlocal history cannot rewrite commits',()=>harness(async h=>{
  await commitFilesFixture(h);const {app,git,put,cx,refresh,key}=h;const original=app.head;
  await key('d');put('later','later');git(['add','later']);git(['commit','-qm','later']);await key('enter');assert.match(app.note,/HEAD changed/);assert.equal(git(['rev-parse','HEAD^']).trim(),original);assert.equal(git(['status','--porcelain']),'');
  await key('escape');await key(']');await key('enter');await key('enter');assert.equal(app.context().canRebase,false);await key('d');assert.equal(app.pending,null);assert.match(app.note,/single local commit/);
}));

async function commitTreeFixture(h) {
  const {dir,git,put,app,refresh,key}=h;put('top','base\n');git(['add','.']);git(['commit','-qm','base']);
  for(const folder of ['docs','src/x'])fs.mkdirSync(join(dir,folder),{recursive:true});
  put('docs/a.md','a\n');put('docs/b.md','b\n');put('src/x/y.js','y\n');put('top','next\n');git(['add','.']);git(['commit','-qm','tree']);
  await refresh();await key('4');await key('enter');assert.equal(app.context().type,'files');
}
const rowNames=app=>Array.from(app.contextItems(),r=>`${' '.repeat(r.depth??0)}${r.dir?(r.open?'v ':'> '):''}${r.name??r.path}`);
test('commit-file tree: folders group files and Space toggles every file under a folder',()=>harness(async h=>{
  await commitTreeFixture(h);const {app,key}=h;
  assert.deepEqual(rowNames(app),['v docs',' a.md',' b.md','v src/x',' y.js','top']);
  assert.equal(app.item().dir,true);await key('space');assert.equal(app.note,null);
  assert.deepEqual([...app.customPatch.parts.keys()].sort(),['docs/a.md','docs/b.md']);
  assert.equal(app.patchFileStatus(app.item(),app.context()),'whole');
  await key('j');await key('space');assert.deepEqual([...app.customPatch.parts.keys()],['docs/b.md']);
  assert.equal(app.patchFileStatus(app.contextItems()[0],app.context()),'partial');
  await key('k');await key('space');assert.equal(app.customPatch.parts.size,2);await key('space');assert.equal(app.customPatch,null);
  await key('a');assert.equal(app.customPatch.parts.size,4);
}));
test('commit-file tree: Enter folds a folder, - and = fold all, and the selection stays put',()=>harness(async h=>{
  await commitTreeFixture(h);const {app,key}=h;
  await key('enter');assert.equal(app.main,false);assert.deepEqual(rowNames(app),['> docs','v src/x',' y.js','top']);assert.equal(app.item().path,'docs');
  await key('enter');assert.deepEqual(rowNames(app).length,6);
  await key('G');assert.equal(app.item().path,'top');await key('-');assert.deepEqual(rowNames(app),['> docs','> src/x','top']);assert.equal(app.item().path,'top');
  await key('=');assert.equal(rowNames(app).length,6);assert.equal(app.item().path,'top');
  await key('k');assert.equal(app.item().path,'src/x/y.js');await key('enter');assert.equal(app.main,true);assert.equal(app.detail.file.path,'src/x/y.js');
}));
test('commit-file tree: backtick switches to a flat list keeping the selected file',()=>harness(async h=>{
  await commitTreeFixture(h);const {app,key}=h;
  await key('j');await key('j');assert.equal(app.item().path,'docs/b.md');
  await key('`');assert.deepEqual(Array.from(app.contextItems(),r=>r.path),['docs/a.md','docs/b.md','src/x/y.js','top']);assert.equal(app.item().path,'docs/b.md');assert.ok(app.contextItems().every(r=>!r.dir));
  await key('`');assert.equal(app.item().path,'docs/b.md');assert.equal(app.contextItems()[0].dir,true);
}));
test('commit-file tree: a folder previews its combined diff without line picking, and a filter opens folders',()=>harness(async h=>{
  await commitTreeFixture(h);const {app,key,flush,cx}=h;
  const source=app.featureSource();assert.equal(source.folder,true);assert.deepEqual(Array.from(source.args.slice(-2)),['--','docs']);
  app.reload(cx);await flush();assert.equal(app.historyPatch,null);assert.ok(app.rawDiffLines.some(l=>l.includes('docs/b.md')));
  await key('enter');await key('/');app.filters[app.viewKey()]='b.md';app.reload(cx);await flush();
  assert.deepEqual(rowNames(app),['v docs',' b.md']);app.foldCommitFiles(app.contextItems()[0],false,cx);assert.match(app.note??'',/Clear the filter/);
}));

async function refRangeFixture(h) {
  const {dir,git,put,refresh}=h;put('f','base\n');git(['add','.']);git(['commit','-qm','base']);
  const remote=join(dir,'.git','range-remote.git');git(['init','--bare','-q',remote]);git(['remote','add','origin',remote]);
  for(const name of ['alpha','beta','gamma'])git(['branch',name]);for(const name of ['tag-a','tag-b','tag-c'])git(['tag',name]);
  git(['push','-q','origin','--all']);git(['push','-q','origin','--tags']);await refresh();
  return {remote,remoteGit:args=>git(['--git-dir',remote,...args])};
}
async function selectRefRange(h,view,first,last=first) {
  const {app,cx,flush,key}=h;app.selectView('branches',view,cx);await flush();app.cancelRange();
  app.sel.branches=app.list().findIndex(item=>item.name===first);assert.ok(app.sel.branches>=0,first);await key('v');
  const end=app.list().findIndex(item=>item.name===last);assert.ok(end>=0,last);app.move(end,cx);await flush();
}
test('reference range: tag push and local/remote/both deletion use the selected tags and origin prompt',()=>harness(async h=>{
  const {app,key,git}=h,{remoteGit}=await refRangeFixture(h);await selectRefRange(h,'tags','tag-a','tag-b');
  const submit=async()=>{app.input.handlers.submit({},h.cx);await h.flush();};
  await key('d');assert.deepEqual(Array.from(app.menu.items,item=>item.hint),['c','r','b']);await key('r');assert.equal(app.message,'origin');await submit();assert.ok(app.pending);await key('enter');assert.equal(app.note,null);
  assert.equal(remoteGit(['tag','--list']),'tag-c\n');assert.equal(git(['tag','--list']),'tag-a\ntag-b\ntag-c\n');assert.equal(app.selectedItems().length,2);
  await key('P');assert.equal(app.message,'origin');await submit();assert.equal(app.note,null);assert.equal(remoteGit(['tag','--list']),'tag-a\ntag-b\ntag-c\n');
  await key('d');await key('b');await submit();await key('enter');assert.equal(app.note,null);assert.equal(remoteGit(['tag','--list']),'tag-c\n');assert.equal(git(['tag','--list']),'tag-c\n');assert.equal(app.rangeAnchors.tags,null);assert.equal(app.sel.branches,0);
  await key('d');await key('c');assert.equal(app.note,null);assert.equal(app.pending,null);assert.equal(git(['tag','--list']),'');
}));
test('reference range: a tag changed after opening the delete menu is retained',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,put,git}=h;await selectRefRange(h,'tags','tag-a','tag-b');await key('d');put('f','changed');git(['commit','-qam','next']);git(['tag','-f','tag-b']);await key('c');
  assert.match(app.note,/changed/);assert.equal(git(['tag','--list']),'tag-a\ntag-b\ntag-c\n');
}));
test('reference range: deleting remote branches stays inside the entered remote',()=>harness(async h=>{
  const {app,cx,key,flush,git}=h,{remoteGit}=await refRangeFixture(h);git(['remote','add','team/origin',h.dir+'/.git/range-remote.git']);git(['fetch','-q','team/origin']);await h.refresh();
  app.selectView('branches','remotes',cx);await flush();app.openRemote(app.remotes.find(remote=>remote.name==='team/origin'),cx);await flush();app.sel.branches=app.list().findIndex(branch=>branch.name==='team/origin/alpha');await key('v');await key('down');
  await key('d');await key('enter');assert.equal(app.note,null);assert.equal(remoteGit(['for-each-ref','--format=%(refname:short)','refs/heads']),'gamma\nmain\n');assert.equal(app.rangeAnchors[app.viewKey()],null);assert.equal(app.remoteContext.name,'team/origin');
}));
test('reference range: stash drop uses highest indices first and collapses only after refreshed success',()=>harness(async h=>{
  const {git,put,app,refresh,key}=h;put('f','base');git(['add','.']);git(['commit','-qm','base']);for(const name of ['one','two','three','four']){put('f',name);git(['stash','push','-qm',name]);}await refresh();await key('5');app.sel.stash=1;await key('v');await key('down');
  const keep=[app.stashes[0].hash,app.stashes[3].hash];await key('d');await key('enter');assert.equal(app.note,null);assert.deepEqual(Array.from(app.stashes,item=>item.hash),keep);assert.equal(app.sel.stash,1);assert.equal(app.rangeAnchors.stash,null);
  const drops=app.commandLog.filter(entry=>entry.command.startsWith('git stash drop'));assert.deepEqual(Array.from(drops,entry=>entry.command),['git stash drop stash@{2}','git stash drop stash@{1}']);
}));
test('reference range: stale stash confirmation changes no stash and a partial failure retains the range',()=>harness(async h=>{
  const {git,put,app,refresh,key,failOn}=h;put('f','base');git(['add','.']);git(['commit','-qm','base']);for(const name of ['one','two','three']){put('f',name);git(['stash','push','-qm',name]);}await refresh();await key('5');await key('v');await key('end');await key('d');put('f','new');git(['stash','push','-qm','new']);await key('enter');assert.match(app.note,/changed/);assert.equal(app.stashes.length,4);
  app.cancelRange();app.sel.stash=0;await key('v');app.move(2,h.cx);await h.flush();await key('d');failOn((cmd,args)=>cmd==='env'&&args.includes('drop')&&args.at(-1)==='stash@{1}');await key('enter');assert.match(app.note,/host went away/);assert.equal(app.stashes.length,3);assert.equal(app.rangeModes.stash,'sticky');
}));
test('reference range: merged branch deletion runs from the menu and protects current branch',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,git}=h;await selectRefRange(h,'local','alpha','beta');await key('d');assert.deepEqual(Array.from(app.menu.items,item=>item.hint),['c','r','b']);assert.ok(app.menu.items[1].disabled);await key('c');
  assert.equal(app.pending,null);assert.equal(app.note,null);assert.equal(git(['for-each-ref','--format=%(refname:short)','refs/heads']),'gamma\nmain\n');assert.equal(app.rangeAnchors.local,null);
  await selectRefRange(h,'local','main','gamma');await key('d');assert.match(app.menu.items[0].disabled,/checked-out/);await key('c');assert.ok(app.menu);assert.equal(git(['branch','--show-current']).trim(),'main');
}));
test('reference range: unmerged branch deletion asks once and stale confirmation refuses every branch',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,git,put,refresh}=h;git(['switch','-q','alpha']);put('unique','unique');git(['add','.']);git(['commit','-qm','unique']);git(['switch','-q','main']);await refresh();await selectRefRange(h,'local','alpha','beta');await key('d');await key('c');assert.equal(app.pending.title,'Force delete branches');
  git(['update-ref','refs/heads/beta','alpha']);await key('enter');assert.match(app.note,/changed/);assert.equal(git(['branch','--list','alpha','beta']).trim().split('\n').length,2);
  await selectRefRange(h,'local','alpha','beta');await key('d');await key('c');await key('enter');assert.equal(app.note,null);assert.equal(git(['branch','--list','alpha','beta']),'');
}));
test('reference range: delete both follows each branch upstream and retains locals on remote failure',()=>harness(async h=>{
  const {app,key,git,refresh,failOn}=h,{remoteGit}=await refRangeFixture(h);for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);await refresh();await selectRefRange(h,'local','alpha','beta');await key('d');await key('b');assert.ok(app.pending);failOn((cmd,args)=>cmd==='env'&&args.includes('push'));await key('enter');assert.match(app.note,/host went away/);assert.ok(git(['branch','--list','alpha','beta']).includes('alpha'));
  failOn(null);await key('d');await key('b');await key('enter');assert.equal(app.note,null);assert.equal(git(['branch','--list','alpha','beta']),'');assert.equal(remoteGit(['for-each-ref','--format=%(refname:short)','refs/heads']),'gamma\nmain\n');assert.equal(app.rangeAnchors.local,null);
}));
test('reference range: a worktree branch is refused in a range but one branch offers detach or remove',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,git,dir,refresh}=h;const tree=join(dir,'.git','other-tree');git(['worktree','add','-q',tree,'alpha']);await refresh();await selectRefRange(h,'local','alpha','beta');await key('d');await key('c');assert.match(app.note,/another worktree/);assert.equal(git(['-C',tree,'branch','--show-current']).trim(),'alpha');
  await selectRefRange(h,'local','alpha');await key('d');await key('c');assert.deepEqual(Array.from(app.menu.items,item=>item.hint),['r','d']);await key('d');assert.equal(app.note,null);assert.equal(git(['-C',tree,'branch','--show-current']),'');assert.equal(git(['branch','--list','alpha']),'');assert.equal(fs.readFileSync(join(tree,'f'),'utf8'),'base\n');
}));
test('reference range: removing a dirty worktree asks only after Git refuses and retries once',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,git,dir,refresh}=h,tree=join(dir,'.git','other-tree');git(['worktree','add','-q',tree,'alpha']);fs.writeFileSync(join(tree,'f'),'dirty');await refresh();await selectRefRange(h,'local','alpha');await key('d');await key('c');await key('r');
  assert.equal(app.pending.title,'Remove worktree');assert.equal(fs.readFileSync(join(tree,'f'),'utf8'),'dirty');assert.ok(git(['branch','--list','alpha']));
  await key('enter');assert.equal(app.note,null);assert.equal(fs.existsSync(tree),false);assert.equal(git(['branch','--list','alpha']),'');
  const removes=app.commandLog.filter(entry=>entry.command.startsWith('git worktree remove'));assert.equal(removes.length,2);assert.ok(!removes[0].command.includes('--force'));assert.ok(removes[1].command.includes('--force'));
}));
function remoteRangeWriter(h,remote) {
  const path=join(h.dir,'.git','range-writer');h.git(['clone','-q','-b','alpha',remote,path]);const git=args=>h.git(['-C',path,...args]);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid']);git(['config','commit.gpgsign','false']);
  return {path,git,advance(name,{rewrite=false}={}){git(['switch','-q',name]);if(rewrite)git(['reset','--hard','HEAD~1']);fs.writeFileSync(join(path,'f'),`${name}-${rewrite?'rewritten':'advanced'}\n`);git(['commit','-qam',`${name} ${rewrite?'rewritten':'advanced'}`]);git(['push','-q',...(rewrite?['--force']:[]),'origin',name]);return git(['rev-parse','HEAD']).trim();}};
}
test('reference fast-forward: one fetch and atomic local-ref batch preserve range and current HEAD',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh,put}=h;
  for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);const a=writer.advance('alpha'),b=writer.advance('beta'),head=git(['rev-parse','HEAD']);put('.git/FETCH_HEAD','keep fetch head\n');await refresh();await selectRefRange(h,'local','alpha','beta');await key('f');
  assert.equal(app.note,null);assert.equal(git(['rev-parse','alpha']).trim(),a);assert.equal(git(['rev-parse','beta']).trim(),b);assert.equal(git(['rev-parse','HEAD']),head);assert.equal(fs.readFileSync(join(h.dir,'.git','FETCH_HEAD'),'utf8'),'keep fetch head\n');assert.equal(app.selectedItems().length,2);assert.equal(app.rangeModes.local,'sticky');
  const fetches=app.commandLog.filter(entry=>entry.command.startsWith('git fetch '));assert.equal(fetches.length,1);assert.match(fetches[0].command,/--no-write-fetch-head.*\+refs\/heads\/alpha:refs\/remotes\/origin\/alpha.*\+refs\/heads\/beta:refs\/remotes\/origin\/beta/);
}));
test('reference fast-forward: ahead-only or missing upstream refuses before fetching any selected branch',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh,put}=h;
  for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);const old=git(['rev-parse','alpha']);writer.advance('alpha');git(['switch','-q','beta']);put('local','mine');git(['add','local']);git(['commit','-qm','local only']);git(['switch','-q','main']);await refresh();await selectRefRange(h,'local','alpha','beta');await key('f');
  assert.match(app.note,/ahead/);assert.equal(git(['rev-parse','alpha']),old);assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git fetch ')),false);
  git(['branch','--unset-upstream','beta']);await refresh();await key('f');assert.match(app.note,/existing upstream/);assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git fetch ')),false);
}));
test('reference fast-forward: a diverged branch with unique commits prevents all local updates after fetch',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh,put}=h;for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);const old=git(['rev-parse','alpha']);writer.advance('alpha');writer.advance('beta');git(['fetch','-q','origin']);git(['switch','-q','beta']);put('local','mine');git(['add','local']);git(['commit','-qm','local only']);git(['switch','-q','main']);await refresh();await selectRefRange(h,'local','alpha','beta');await key('f');
  assert.match(app.note,/local-only commits/);assert.equal(git(['rev-parse','alpha']),old);assert.equal(app.commandLog.filter(entry=>entry.command.startsWith('git fetch ')).length,1);assert.equal(app.rangeModes.local,'sticky');
}));
test('reference fast-forward: rewritten upstream history permits reset without losing local-only commits',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh}=h;const old=writer.advance('alpha');git(['fetch','-q','origin']);git(['update-ref','refs/heads/alpha',old]);git(['branch','--set-upstream-to=origin/alpha','alpha']);const next=writer.advance('alpha',{rewrite:true});await refresh();await selectRefRange(h,'local','alpha');await key('f');assert.equal(app.note,null);assert.equal(git(['rev-parse','alpha']).trim(),next);assert.ok(git(['reflog','show','--format=%H','origin/alpha']).includes(old));
}));
test('reference fast-forward: missing upstream history refuses a rewritten branch conservatively',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh}=h;const old=writer.advance('alpha');git(['fetch','-q','origin']);git(['update-ref','refs/heads/alpha',old]);git(['branch','--set-upstream-to=origin/alpha','alpha']);writer.advance('alpha',{rewrite:true});git(['fetch','-q','origin']);fs.rmSync(join(h.dir,'.git','logs','refs','remotes','origin','alpha'));await refresh();await selectRefRange(h,'local','alpha');await key('f');assert.match(app.note,/local-only commits/);assert.equal(git(['rev-parse','alpha']).trim(),old);
}));
test('reference fast-forward: rewritten checked-out branches require clean tracked files but retain untracked files',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh}=h;const old=writer.advance('alpha');git(['fetch','-q','origin']);git(['update-ref','refs/heads/alpha',old]);git(['branch','--set-upstream-to=origin/alpha','alpha']);const tree=join(h.dir,'.git','other-tree');git(['worktree','add','-q',tree,'alpha']);const next=writer.advance('alpha',{rewrite:true});fs.writeFileSync(join(tree,'f'),'dirty');await refresh();await selectRefRange(h,'local','alpha');await key('f');assert.match(app.note,/uncommitted changes/);assert.equal(git(['rev-parse','alpha']).trim(),old);assert.equal(fs.readFileSync(join(tree,'f'),'utf8'),'dirty');
  git(['-C',tree,'restore','f']);fs.writeFileSync(join(tree,'untracked'),'keep');await key('f');assert.equal(app.note,null);assert.equal(git(['rev-parse','alpha']).trim(),next);assert.equal(fs.readFileSync(join(tree,'untracked'),'utf8'),'keep');assert.equal(fs.readFileSync(join(tree,'f'),'utf8'),'alpha-rewritten\n');
}));
test('reference fast-forward: batch failure still updates checked-out worktrees and reports the failure',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh,failOn}=h;for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);const old=git(['rev-parse','alpha']),a=writer.advance('alpha'),b=writer.advance('beta'),tree=join(h.dir,'.git','other-tree');git(['worktree','add','-q',tree,'beta']);await refresh();await selectRefRange(h,'local','alpha','beta');failOn((cmd,args)=>cmd==='sh'&&args.some(arg=>arg.includes('git update-ref --stdin')));await key('f');assert.match(app.note,/host went away/);assert.notEqual(old.trim(),a);assert.equal(git(['rev-parse','alpha']),old);assert.equal(git(['rev-parse','beta']).trim(),b);assert.equal(fs.readFileSync(join(tree,'f'),'utf8'),'beta-advanced\n');assert.equal(app.rangeModes.local,'sticky');
}));
test('reference fast-forward: rebase and bisect worktrees are refused before fetch even with detached HEAD',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh}=h;git(['branch','--set-upstream-to=origin/alpha','alpha']);writer.advance('alpha');const tree=join(h.dir,'.git','other-tree');git(['worktree','add','-q',tree,'alpha']);const gitdir=git(['-C',tree,'rev-parse','--absolute-git-dir']).trim();git(['-C',tree,'checkout','-q','--detach']);fs.mkdirSync(join(gitdir,'rebase-merge'));fs.writeFileSync(join(gitdir,'rebase-merge','head-name'),'refs/heads/alpha\n');await refresh();await selectRefRange(h,'local','alpha');await key('f');assert.match(app.note,/rebase or bisect/);assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git fetch ')),false);
  fs.rmSync(join(gitdir,'rebase-merge'),{recursive:true});fs.writeFileSync(join(gitdir,'BISECT_LOG'),'# bisect\n');fs.writeFileSync(join(gitdir,'BISECT_START'),'alpha\n');await key('f');assert.match(app.note,/rebase or bisect/);assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git fetch ')),false);
}));
test('reference fast-forward: a branch changed while fetching prevents every local update',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh,afterExec}=h;for(const name of ['alpha','beta'])git(['branch',`--set-upstream-to=origin/${name}`,name]);const old=git(['rev-parse','beta']),a=writer.advance('alpha');writer.advance('beta');await refresh();await selectRefRange(h,'local','alpha','beta');afterExec((cmd,args)=>{if(cmd==='env'&&args.includes('fetch'))git(['update-ref','refs/heads/alpha','refs/remotes/origin/alpha']);});await key('f');assert.match(app.note,/changed/);assert.equal(git(['rev-parse','beta']),old);assert.equal(git(['rev-parse','alpha']).trim(),a);
}));
test('reference fast-forward: local upstream and current worktree update without a network fetch',()=>harness(async h=>{
  await refRangeFixture(h);const {app,key,git,put,refresh}=h;git(['switch','-q','alpha']);put('f','advanced local');git(['commit','-qam','advanced local']);git(['switch','-q','main']);git(['branch','--set-upstream-to=alpha','main']);await refresh();await selectRefRange(h,'local','main');await key('f');assert.equal(app.note,null);assert.equal(git(['rev-parse','main']),git(['rev-parse','alpha']));assert.equal(fs.readFileSync(join(h.dir,'f'),'utf8'),'advanced local');assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git fetch ')),false);
}));
test('reference fast-forward: a missing unrelated worktree does not prevent the selected update',()=>harness(async h=>{
  const {remote}=await refRangeFixture(h),writer=remoteRangeWriter(h,remote),{app,key,git,refresh}=h;git(['branch','--set-upstream-to=origin/alpha','alpha']);const next=writer.advance('alpha'),tree=join(h.dir,'.git','missing-tree');git(['worktree','add','-q','--detach',tree]);fs.rmSync(tree,{recursive:true});await refresh();await selectRefRange(h,'local','alpha');await key('f');assert.equal(app.note,null);assert.equal(git(['rev-parse','alpha']).trim(),next);assert.ok(git(['worktree','list','--porcelain']).includes('prunable'));
}));
test('reference range: preparation and final mutation refresh remain visibly busy',()=>harness(async h=>{
  await refRangeFixture(h);const {app,cx,key,hold,tick,flush,afterExec}=h;await selectRefRange(h,'local','alpha','beta');let release=hold();app.localBranchDeleteMenu(cx);await tick();assert.equal(app.busy,'Reading branch deletion options');assert.equal(app.opening,app.busy);app.render(cx);release();await flush();assert.equal(app.busy,null);assert.ok(app.menu);
  afterExec((cmd,args)=>{if(cmd==='env'&&args.includes('branch')&&args.includes('-D')){release=hold();afterExec(null);}});app.pickMenu(0,cx);await tick();await tick();assert.equal(app.busy,null);assert.equal(app.settling,'Delete branches');app.render(cx);release();await flush();assert.equal(app.busy,null);assert.equal(app.settling,null);assert.equal(app.rangeAnchors.local,null);
}));
test('reference range: late branch metadata cannot open a menu in another repository',()=>harness(async h=>{
  await refRangeFixture(h);const {app,cx,hold,tick,flush}=h;await selectRefRange(h,'local','alpha','beta');const release=hold();app.localBranchDeleteMenu(cx);await tick();app.repoKey+='changed';release();await flush();assert.ok(!app.menu);assert.equal(app.busy,null);assert.equal(app.opening,null);assert.match(app.note,/repository changed/);
}));
async function combinedCommitFixture(h) {
  const {git,put,refresh}=h,old='old [x]\nname',next='new [x]\nname';put('f','base\n');put(old,'rename bytes\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();git(['mv',old,next]);put('f','middle\n');put('temporary','only in the middle');git(['add','.']);git(['commit','-qm','middle']);const middle=git(['rev-parse','HEAD']).trim();git(['rm','temporary']);put('f','final\n');put('added','last');git(['add','.']);git(['commit','-qm','final']);const top=git(['rev-parse','HEAD']).trim();await refresh();return {old,next,base,middle,top};
}
test('combined commit range: preview and Enter use oldest parent to newest and retain the parent range',()=>harness(async h=>{
  const {base,middle,top,next,old}=await combinedCommitFixture(h),{app,key,cx,flush,git}=h;await key('4');await key('v');await key('down');assert.deepEqual({...app.source().range},{from:middle,to:top,title:`${middle.slice(0,7)}-${top.slice(0,7)}`});assert.ok(app.rawDiffLines.includes('-base'));assert.ok(app.rawDiffLines.includes('+final'));assert.equal(app.rawDiffLines.some(line=>line.includes('temporary')),false);
  await key('enter');const frame=app.context();assert.equal(frame.type,'files');assert.equal(frame.diffFrom,base);assert.equal(frame.diffTo,top);assert.equal(frame.checkoutRef,top);assert.equal(frame.canRebase,false);assert.deepEqual(Array.from(frame.items,item=>item.path),['added','f',next]);assert.deepEqual({...frame.items[2]},{status:'R',path:next,previousPath:old});
  app.sel.commits=2;app.syncContext();await key('space');const patch=app.customPatchText();assert.match(patch,/rename from/);assert.match(patch,/rename to/);git(['apply','--reverse','--check','-'],patch);assert.equal(app.customPatch.canRebase,false);
  app.openDetailFile(2,cx);await flush();assert.ok(app.rawDiffLines.some(line=>line.startsWith('rename from')));await key('escape');await key('escape');assert.equal(app.context(),null);assert.equal(app.sel.commits,1);assert.equal(app.rangeModes.commits,'sticky');assert.equal(app.selectedItems().length,2);await key('escape');assert.equal(app.source().range,undefined);assert.equal(app.source().keep,middle);
}));
test('combined commit range: selection direction does not change the diff and root uses the empty tree',()=>harness(async h=>{
  const {base,top}=await combinedCommitFixture(h),{app,key,cx,flush,git}=h;await key('4');app.sel.commits=2;await key('v');app.move(0,cx);await flush();assert.equal(app.source().range.from,base);assert.equal(app.source().range.to,top);await key('enter');assert.equal(app.detail.diffFrom,git(['hash-object','-t','tree','--stdin'],'').trim());assert.equal(app.detail.diffTo,top);assert.equal(app.detail.items.every(item=>item.status==='A'),true);assert.equal(app.detail.items.some(item=>item.path==='temporary'),false);assert.equal(app.sel.commits,0);
}));
test('combined commit range: nested branch history stays in its pane and mixed divergence falls back to cursor',()=>harness(async h=>{
  const {middle,top}=await combinedCommitFixture(h),{app,cx,key,flush}=h;app.selectView('branches','local',cx);await flush();app.sel.branches=app.list().findIndex(branch=>branch.name==='main');await key('enter');const parent=app.context();assert.equal(parent.type,'commits');await key('v');await key('down');await key('enter');assert.equal(app.panel,'branches');assert.equal(app.detail.diffTo,top);assert.equal(app.detail.canRebase,false);await key('escape');assert.equal(app.context(),parent);assert.equal(app.selectedItems().length,2);
  parent.items[0].divergence='ahead';parent.items[1].divergence='behind';app.reload(cx);await flush();assert.equal(app.source().range,undefined);await key('enter');assert.equal(app.detail.range,null);assert.equal(app.detail.diffTo,middle);assert.equal(app.detail.ref,middle);
}));
test('combined commit range: active comparison uses the top endpoint and reverse checkout uses its base',()=>harness(async h=>{
  const {base,top}=await combinedCommitFixture(h),{app,cx,key,flush}=h;await key('4');await key('v');await key('down');app.compareBase=base;app.compareReverse=true;app.reload(cx);await flush();assert.ok(app.source().args.includes(top));await key('enter');assert.equal(app.detail.diffFrom,base);assert.equal(app.detail.diffTo,top);assert.equal(app.detail.checkoutRef,base);assert.equal(app.detail.canRebase,false);assert.ok(app.detail.patchArgs.includes('-R'));assert.equal(app.detail.items.find(item=>item.path==='added').status,'D');
}));
test('combined commit range: TODO endpoints fall back to the moving commit and late file reads stay out of closed contexts',()=>harness(async h=>{
  await combinedCommitFixture(h);const {app,key,cx,hold,tick,flush}=h;await key('4');await key('v');await key('down');app.commits[0].todo={action:'pick'};app.reload(cx);await flush();assert.equal(app.source().range,undefined);delete app.commits[0].todo;
  const release=hold();app.openChangedFiles(app.item(),cx);await tick();const frame=app.context();assert.equal(frame.loading,true);assert.equal(app.mainWait().label,'Reading changed files');app.popContext(cx);release();await flush();assert.equal(app.context(),null);assert.equal(app.detail,null);assert.equal(app.selectedItems().length,2);assert.equal(frame.items.length,0);
}));
test('combined commit range: discarding one rename restores both paths while later changes survive',()=>harness(async h=>{
  const {old,next}=await combinedCommitFixture(h),{app,key,git,cx,flush}=h;await key('4');await key('down');await key('enter');app.sel.commits=app.detail.items.findIndex(file=>file.path===next);app.syncContext();assert.equal(app.item().previousPath,old);await key('d');await key('enter');assert.equal(app.note,null);assert.equal(git(['show',`HEAD:${old}`]),'rename bytes\n');assert.equal(git(['ls-tree','--name-only','HEAD','--',next]),'');assert.equal(git(['show','HEAD:f']),'final\n');assert.equal(app.detail.items.some(file=>file.path===old||file.path===next),false);app.openDetailFile(0,cx);await flush();assert.ok(app.rawDiffLines.length);
}));
test('graph stash: Space validates the captured stash identity just like the menu',()=>harness(async h=>{
  const {app,cx,git,put,refresh,flush}=h;put('f','base');git(['add','.']);git(['commit','-qm','base']);put('f','old stash');git(['stash','push','-qm','old']);const old=git(['rev-parse','stash@{0}']).trim();await refresh();app.goto('status',cx);await flush();app.main=true;app.cursor=app.graph.rows.findIndex(row=>row.commit.hash===old);assert.ok(app.cursor>=0);
  put('f','new stash');git(['stash','push','-qm','new']);app.graphKeys(cx).space();await flush();assert.match(app.note,/changed/);assert.equal(fs.readFileSync(join(h.dir,'f'),'utf8'),'base');assert.equal(app.stashes.length,2);
  app.cursor=app.graph.rows.findIndex(row=>row.commit.hash===old);app.graphKeys(cx).space();await flush();assert.equal(app.note,null);assert.equal(fs.readFileSync(join(h.dir,'f'),'utf8'),'old stash');assert.equal(app.stashes.length,2);
}));

test('commit search retains surrounding history while reflog filtering narrows rows',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','base']);for(const value of ['needle','last']){put('f',value);git(['commit','-qam',value]);}await refresh();await key('4');
  app.panelSearch.set_value('needle');app.panelSearch.handlers.change({},cx);await flush();assert.equal(app.list().length,3);assert.equal(app.item().subject,'needle');
  await key(']');app.panelSearch.set_value('needle');app.panelSearch.handlers.change({},cx);await flush();assert.equal(app.list().length,1);
}));

test('copy attribute menu reads message author tags and web URL without rewriting history',()=>harness(async({git,put,app,cx,refresh,key,clipboard})=>{
  put('f','base');git(['add','.']);git(['commit','-qm','Subject','-m','The body']);git(['tag','v1']);git(['remote','add','origin','git@github.com:owner/repo.git']);await refresh();await key('4');
  await key('y');await key('b');assert.equal(clipboard.at(-1),'The body');await key('y');await key('t');assert.equal(clipboard.at(-1),'v1');await key('y');await key('u');assert.equal(clipboard.at(-1),`https://github.com/owner/repo/commit/${app.head}`);
  await key('o',{control:true});assert.equal(clipboard.at(-1),app.head);assert.equal(git(['status','--porcelain']),'');
}));

test('fast-forward fetches a noncurrent branch without moving current HEAD',()=>harness(async({dir,git,put,app,cx,refresh,flush})=>{
  const upstream=join(dir,'upstream.git');execFileSync('git',['init','--bare','-q',upstream]);put('f','base');git(['add','f']);git(['commit','-qm','base']);git(['remote','add','origin',upstream]);git(['branch','topic']);git(['push','-qu','origin','topic']);
  const writer=join(dir,'writer');execFileSync('git',['clone','-q','-b','topic',upstream,writer]);
  const writeGit=args=>execFileSync('git',args,{cwd:writer,encoding:'utf8',stdio:'pipe'});writeGit(['config','user.name','Test']);writeGit(['config','user.email','test@example.invalid']);writeGit(['config','commit.gpgsign','false']);
  fs.writeFileSync(join(writer,'f'),'remote change');writeGit(['commit','-qam','remote change']);writeGit(['push','-q']);const next=writeGit(['rev-parse','HEAD']).trim();const head=git(['rev-parse','HEAD']).trim();
  await refresh();app.fastForward(app.branches.find(b=>b.name==='topic'),cx);await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','topic']).trim(),next);assert.equal(git(['rev-parse','HEAD']).trim(),head);assert.equal(git(['show','HEAD:f']),'base');
}));

test('custom conflict marker size resolves and stages only after all markers are gone',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');put('.gitattributes','f conflict-marker-size=3\n');git(['add','.']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);try{git(['merge','other']);}catch{}await refresh();
  assert.equal(app.conflicts.markerSize,3);assert.equal(app.conflicts.conflicts.length,1);app.resolveHunk('theirs',cx);await flush();assert.equal(app.note,null);assert.equal(git(['ls-files','-u']),'');assert.equal(git(['show',':f']),'theirs\n');
}));

function pauseRebase(git,put,extra=[]) {
  put('.git/pause-editor.sh', 'sed \'1s/^pick /edit /\' "$1" > "$1.new"\nmv "$1.new" "$1"\n');
  git(['-c','sequence.editor=sh .git/pause-editor.sh','rebase','-i',...extra,'HEAD~4']);
}

test('pending rebase keys edit, move and drop inside Commits without continuing it',()=>harness(async({git,put,app,cx,refresh,key})=>{
  for(const name of ['base','one','two','three','four']){put(name,name);git(['add',name]);git(['commit','-qm',name]);}
  pauseRebase(git,put);await refresh();await key('4');
  assert.equal(app.operation,'rebase');assert.deepEqual(Array.from(app.list().slice(0,3),it=>it.subject),['four','three','two']);
  const paused=git(['rev-parse','HEAD']);await key('j',{control:true});assert.equal(app.note,null);assert.equal(app.item().subject,'four');
  await key('k');await key('d');assert.equal(app.item().todo.action,'drop');
  await key('j');await key('j');await key('f');assert.equal(app.item().subject,'two');assert.equal(app.item().todo.action,'fixup');
  assert.equal(git(['rev-parse','HEAD']),paused);assert.equal(app.plan,null);
  app.render(cx);await key('m');await key('c');
  assert.equal(app.note,null);assert.equal(app.operation,null);assert.equal(app.pendingRebase,null);
  assert.deepEqual(git(['log','--reverse','--format=%s']).trim().split('\n'),['base','one','four']);
}));

test('native update-ref removal asks Git to reconcile the pending branch update',()=>harness(async({dir,git,put,app,refresh,key})=>{
  let saved;
  for(const name of ['base','one','two','three','four']){put(name,name);git(['add',name]);git(['commit','-qm',name]);if(name==='two'){git(['branch','saved']);saved=git(['rev-parse','HEAD']).trim();}}
  pauseRebase(git,put,['--update-refs']);git(['commit','--amend','-qm','one rewritten']);await refresh();await key('4');
  app.sel.commits=app.list().findIndex(it=>it.todo?.action==='update-ref');assert.ok(app.sel.commits>=0);await key('d');assert.equal(app.note,null);
  const bookkeeping=join(dir,git(['rev-parse','--git-path','rebase-merge/update-refs']).trim());
  if(fs.existsSync(bookkeeping))assert.ok(!fs.readFileSync(bookkeeping,'utf8').includes('refs/heads/saved'));
  await key('m');await key('c');assert.equal(app.note,null);assert.equal(git(['rev-parse','saved']).trim(),saved);
}));

test('pending rebase edit refuses stale todo bytes and unsupported exec actions',()=>harness(async({dir,git,put,app,refresh,key})=>{
  for(const name of ['base','one','two','three','four']){put(name,name);git(['add',name]);git(['commit','-qm',name]);}
  pauseRebase(git,put);await refresh();await key('4');
  const path=join(dir,git(['rev-parse','--git-path','rebase-merge/git-rebase-todo']).trim());
  const newer=fs.readFileSync(path,'utf8')+'exec printf safe\\n\n';fs.writeFileSync(path,newer);await key('d');
  assert.match(app.note,/todo changed/);assert.equal(fs.readFileSync(path,'utf8'),newer);
  app.sel.commits=app.list().findIndex(it=>it.todo?.action==='exec');assert.ok(app.sel.commits>=0);await key('f');
  assert.match(app.note,/exec/);assert.equal(fs.readFileSync(path,'utf8'),newer);assert.equal(app.plan,null);
}));

test('Lazygit YAML settings load per repository and malformed reload retains the last valid values',()=>harness(async({git,put,app,cx,refresh})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);
  put('.lazygit.yml','gui:\n  showFileTree: true\n'); // upstream does not trust repo-root YAML
  put('.git/lazygit.yml','gui:\n  showFileTree: false\n  fileTreeSortOrder: foldersFirst\ngit:\n  diffContextSize: 8\n  disableForcePushing: true\n  autoFetch: false\n');
  await refresh();assert.equal(app.configuration.stale,false);assert.equal(app.tree,false);assert.equal(app.diffContext,8);assert.equal(app.fileSortOrder,'foldersFirst');
  app.moreMenu(cx);assert.match(app.menu.items.find(it=>it.label==='Force push with lease…').disabled,/disabled/);app.menu=null;
  put('.git/lazygit.yml','gui: [\n');await refresh();assert.equal(app.configuration.stale,true);assert.equal(app.tree,false);assert.equal(app.diffContext,8);
  assert.ok(app.configuration.diagnostics.some(d=>d.line&&d.source.endsWith('/.git/lazygit.yml')));
  app.configOpen=true;app.render(cx);app.configOpen=false;
  put('.git/lazygit.yml','gui:\n  showFileTree: true\ngit:\n  diffContextSize: 1\n');await refresh();assert.equal(app.configuration.stale,false);assert.equal(app.tree,true);assert.equal(app.diffContext,1);
}));

test('configured keys replace defaults and retain context and modifier precedence',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);put('f','next');
  put('.git/lazygit.yml','keybinding:\n  files:\n    commitChanges: ["<ctrl+shift+c>", "x"]\n  universal:\n    select: "t"\n    nextItem: "<disabled>"\n    refresh: "<ctrl+alt+r>"\n');await refresh();
  await key('space');assert.equal(git(['diff','--cached']), '');await key('t');assert.ok(git(['diff','--cached']));
  await key('c');assert.equal(app.prompt,null);await key('c',{control:true,shift:true});assert.equal(app.prompt.kind,'commit');app.cancelPrompt(cx);
  await key('x');assert.equal(app.prompt.kind,'commit');app.cancelPrompt(cx);
  let refreshes=0;const original=app.refresh;app.refresh=()=>refreshes++;
  await key('R');assert.equal(refreshes,0);await key('r',{control:true,alt:true});assert.equal(refreshes,1);app.refresh=original;
  await key('4');await key('x');assert.ok(app.menu);assert.equal(app.prompt,null);app.menu=null; // Files override is scoped
  await flush();
}));

test('configured sign-off is applied to an explicit staged commit',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','one');git(['add','f']);put('.git/lazygit.yml','git:\n  commit:\n    signOff: true\n');await refresh();
  app.ask2('commit','Commit summary',cx);app.message='Signed work';app.submit(cx);await flush();assert.equal(app.note,null);
  assert.match(git(['log','-1','--format=%B']),/Signed-off-by: Test <test@example.invalid>/);
}));

test('disabling auto-stage leaves a resolved conflict unstaged until requested',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);try{git(['merge','other']);}catch{}
  put('.git/lazygit.yml','git:\n  autoStageResolvedConflicts: false\n');await refresh();app.resolveHunk('ours',cx);await flush();assert.equal(app.note,null);assert.ok(git(['ls-files','-u']));
  await refresh();assert.ok(git(['ls-files','-u']));app.conflictMenu(cx);app.menu.items.find(item=>item.label==='Mark file resolved').run(cx);await flush();assert.equal(git(['ls-files','-u']),'');
}));

test('configured command prompts preserve the captured commit, raw answers and response indices',()=>harness(async({dir,git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);put('f','next');git(['commit','-qam','next']);const head=git(['rev-parse','HEAD']).trim();
  put('.git/lazygit.yml',JSON.stringify({customCommands:[{key:'x',context:'commits',description:'Captured command',output:'popup',outputTitle:'Result {{.Form.choice}}',
    command:"printf '%s\\n' {{quote .SelectedLocalCommit.Hash}} {{quote (index .PromptResponses 0)}} {{quote (index .PromptResponses 1)}} {{quote .Form.choice}} > command-result; cat command-result",
    prompts:[{type:'confirm',title:'Proceed',body:'Use the selected commit?'},{type:'input',key:'answer',title:'Answer',initialValue:'initial'},
      {type:'menu',key:'choice',title:'Choice',options:[{name:'Choose one',value:'chosen',key:'o'}]}]}]}));
  await refresh();await key('4');await key('x');assert.equal(app.pending.title,'Proceed');assert.deepEqual([...app.customSession.data.PromptResponses],['','','']);
  await key('enter');assert.equal(app.prompt.kind,'value');assert.equal(app.message,'initial');
  app.sel.commits=1;app.message=" spaced ' answer ";app.submit(cx);await flush();assert.equal(app.menu.title,'Choice');await key('o');
  assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'command-result'),'utf8'),head+"\n\n spaced ' answer \nchosen\n");
  assert.equal(app.customOutput.title,'Result chosen');assert.equal(app.customOutput.running,false);assert.equal(app.customSession,null);assert.equal(app.busy,null);assert.equal(app.info,'Command completed');
  app.render(cx);await key('escape');assert.equal(app.customOutput,null);
}));

test('custom command cancellation leaves drafts on first Escape and never executes the cancelled command',()=>harness(async({dir,git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();
  const command={command:'touch should-not-exist',prompts:[{type:'input',title:'Input'}]};
  app.startConfiguredCommand(command,cx);await flush();mountPrompt(app,cx);app.message='retained';await key('escape');assert.ok(app.prompt);assert.equal(app.message,'retained');
  await key('escape');assert.equal(app.prompt,null);assert.equal(app.customSession,null);assert.equal(fs.existsSync(join(dir,'should-not-exist')),false);
  app.startConfiguredCommand({...command,prompts:[{type:'confirm',title:'Confirm'}]},cx);await flush();await key('n');assert.equal(app.customSession,null);
  app.startConfiguredCommand({...command,prompts:[{type:'menu',title:'Menu',options:[{name:'Run',value:'yes'}]}]},cx);await flush();await key('escape');assert.equal(app.customSession,null);
  assert.equal(fs.existsSync(join(dir,'should-not-exist')),false);
}));

test('menuFromCommand uses direct arguments, capture templates and native menu shortcut groups',()=>harness(async({dir,git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();
  put('menu-data','alpha:one\nbeta:two\n');
  app.startConfiguredCommand({description:'Group',commandMenu:[{key:'x',description:'Pick a record',command:"printf '%s' {{quote .Form.item}} > picked",output:'none',outputTitle:'{{.DoesNotExist}}',prompts:[{type:'menuFromCommand',key:'item',title:'Records',command:'cat menu-data',filter:'(?P<name>[^:]+):(?P<value>.*)',valueFormat:'{{.value}}',labelFormat:'{{.name}}'}]}]},cx);
  await key('x');assert.deepEqual(Array.from(app.menu.items,it=>it.label),['alpha','beta']);await key('down');await key('enter');
  assert.equal(app.note,null);assert.equal(fs.readFileSync(join(dir,'picked'),'utf8'),'two');assert.equal(app.customOutput,null);assert.equal(app.customSession,null);
  app.startConfiguredCommand({command:'touch unused',prompts:[{type:'input',key:'a',title:'With suggestions',suggestions:{command:"printf 'first\\nsecond\\n'"}}]},cx);await flush();
  app.message='COND';assert.deepEqual(Array.from(app.promptSuggestions(),it=>it.value),['second']);app.render(cx);app.cancelPrompt(cx);
}));

test('context custom keys override built-ins and global custom keys stay behind contextual actions',()=>harness(async({dir,git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);put('f','changed');
  put('.git/lazygit.yml',JSON.stringify({customCommands:[{key:'c',context:'global',command:'touch global-command'},{key:'c',context:'files',command:'touch files-command'}]}));await refresh();
  await key('c');assert.equal(fs.existsSync(join(dir,'files-command')),true);assert.equal(fs.existsSync(join(dir,'global-command')),false);assert.equal(app.prompt,null);
  await key('3');await key('c');assert.equal(app.prompt.title,'Branch name (- for previous)');app.cancelPrompt(cx);assert.equal(fs.existsSync(join(dir,'global-command')),false);
  await key('1');await key('c');assert.equal(fs.existsSync(join(dir,'global-command')),true);assert.equal(app.note,null);
}));

test('disabled commit keys and empty pane shortcuts cannot fall through universal aliases',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);
  put('.git/lazygit.yml',JSON.stringify({keybinding:{commits:{checkoutCommit:'<disabled>',openInBrowser:'<disabled>'},universal:{jumpToBlock:[]}}}));await refresh();
  await key('3');assert.equal(app.panel,'files');app.goto('commits',cx);await key('space');assert.equal(app.pending,null);assert.equal(app.menu??null,null);
  await key('o');assert.equal(app.note??null,null);assert.equal(app.launching,null);
  let calls=0;app.refresh=()=>calls++;app.configuration.environment.platform='linux';app.configuration.environment.env.LAZYGIT_KEYBINDING_PLATFORM='darwin';app.lazygitConfig.keybinding.universal.refresh='<meta+r>';
  await key('r',{platform:true});assert.equal(calls,1);
}));

test('cancelled command preparation never starts shell execution after its read finishes',()=>harness(async({dir,git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();
  const release=hold();app.startConfiguredCommand({command:'touch cancelled-command'},cx);await tick();assert.equal(app.busy,'Preparing command');
  app.cancelConfiguredCommand();release();await flush();assert.equal(fs.existsSync(join(dir,'cancelled-command')),false);assert.equal(app.busy,null);
}));

test('PTY command output uses captured repository and removes the finished background terminal',()=>harness(async({dir,git,put,app,cx,refresh,flush,setCore})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();const calls=[];let reads=0;
  setCore(async args=>{calls.push(args);return {code:0,stderr:'',stdout:JSON.stringify(args[0]==='run'?{address:'t-fixture',state:'live'}:args[0]==='get'?{state:'finished',exit_code:0}:args[0]==='read'?{text:++reads===1?'Working':'Done'}:{})};});
  app.startConfiguredCommand({command:'printf Done',output:'logWithPty'},cx);await flush();assert.equal(app.note,null);assert.equal(app.customOutput.text,'Done');assert.equal(app.customOutput.running,false);
  const run=calls.find(args=>args[0]==='run');assert.equal(run[run.indexOf('--cwd')+1],dir);assert.ok(calls.some(args=>args[0]==='rm'&&args[1]==='t-fixture'));
}));

test('commit-file checkout stages the selected version and rejects a file changed after confirmation',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);put('f','next');git(['commit','-qam','next']);await refresh();await key('4');app.sel.commits=1;
  await key('enter');assert.equal(app.context().type,'files');await key('c');assert.ok(app.pending);app.pending.then(cx);app.pending=null;await flush();assert.equal(app.note,null);assert.equal(git(['show',':f']),'base');
  git(['restore','--source=HEAD','--staged','--worktree','--','f']);await refresh();await key('c');assert.ok(app.pending);put('f','new work');app.pending.then(cx);app.pending=null;await flush();
  assert.match(app.note,/change|modified/i);assert.equal(git(['show',':f']),'next');
}));

test('a remapped search key only navigates search matches and cannot create a branch',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','one');git(['add','f']);git(['commit','-qm','one']);put('f','two');git(['commit','-qam','two']);put('f','three');git(['commit','-qam','one again']);
  put('.git/lazygit.yml',JSON.stringify({keybinding:{universal:{nextMatch:'x'}}}));await refresh();await key('3');await key('x');assert.equal(app.prompt,null);
  await key('n');assert.equal(app.prompt.title,'New branch name');app.cancelPrompt(cx);await key('4');app.filters.commits='one';app.sel.commits=0;
  await key('x');assert.equal(app.sel.commits,2);assert.equal(app.prompt,null);await key('x');assert.equal(app.sel.commits,0);
}));

test('a failed configured merge enters conflict resolution and offers continue after resolution',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','base']);git(['switch','-qc','other']);put('f','theirs\n');git(['commit','-qam','theirs']);git(['switch','-q','main']);put('f','ours\n');git(['commit','-qam','ours']);await refresh();
  app.startConfiguredCommand({command:'git merge other',after:{checkForConflicts:true}},cx);await flush();assert.equal(app.operation,'merge');assert.equal(app.startedOperation,'merge');assert.equal(app.fileStatus,'conflicted');
  app.resolveHunk('ours',cx);await flush();assert.ok(app.pending?.operation==='merge');assert.equal(git(['ls-files','-u']),'');
}));

test('author menu changes HEAD metadata while preserving staged changes',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);put('f','staged');git(['add','f']);await refresh();await key('4');await key('a');assert.equal(app.menu.title,'Amend commit attribute');
  await key('A');assert.equal(app.prompt.title,'Set author (Name <Email>)');app.message='Other Person <other@example.invalid>';app.submit(cx);await flush();assert.ok(app.pending);await key('enter');
  assert.equal(app.note,null);assert.equal(git(['log','-1','--format=%an <%ae>']).trim(),'Other Person <other@example.invalid>');assert.equal(git(['show','HEAD:f']),'base');assert.equal(git(['show',':f']),'staged');
  await key('a');await key('a');await key('enter');assert.equal(app.note,null);assert.equal(git(['log','-1','--format=%an <%ae>']).trim(),'Test <test@example.invalid>');assert.equal(git(['show',':f']),'staged');
}));

test('co-author amendment rewrites a selected older range and preserves later commit content',()=>harness(async({git,put,app,cx,refresh,key,flush})=>{
  for(let n=1;n<=3;n++){put('f',String(n));git(['add','f']);git(['commit','-qm',`change ${n}`]);}
  await refresh();await key('4');app.sel.commits=2;app.rangeAnchors.commits=1;await key('a');await key('c');app.message='Friend <friend@example.invalid>';app.submit(cx);await flush();await key('enter');
  assert.equal(app.note,null);assert.equal(git(['show','HEAD:f']),'3');const messages=git(['log','--reverse','--format=%B%x00']).split('\0');
  assert.match(messages[0],/Co-authored-by: Friend/);assert.match(messages[1],/Co-authored-by: Friend/);assert.doesNotMatch(messages[2],/Co-authored/);assert.equal(app.operation,null);
}));

test('author confirmation rejects a changed HEAD without modifying the new commit',()=>harness(async({git,put,app,cx,refresh,key})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();await key('4');await key('a');await key('a');assert.ok(app.pending);
  put('f','new');git(['commit','-qam','new']);const head=git(['rev-parse','HEAD']);await key('enter');assert.match(app.note,/HEAD changed/);assert.equal(git(['rev-parse','HEAD']),head);
}));

test('commit co-author input returns to the retained draft on confirm or cancel',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','new');git(['add','f']);await refresh();app.ask2('commit','Commit',cx);app.message='New feature';app.commitBody='Description';app.bodyInput.set_value(app.commitBody);
  app.commitCoAuthor(cx);app.message='discarded';app.cancelPrompt(cx);assert.equal(app.prompt.kind,'commit');assert.equal(app.message,'New feature');assert.equal(app.commitBody,'Description');
  app.commitCoAuthor(cx);app.message='One <one@example.invalid>';app.submit(cx);assert.equal(app.message,'New feature');assert.equal(app.commitBody,'Description\n\nCo-authored-by: One <one@example.invalid>');
  app.commitCoAuthor(cx);app.message='Two <two@example.invalid>';app.submit(cx);assert.match(app.commitBody,/One <one@example.invalid>\nCo-authored-by: Two/);
  app.submit(cx);await flush();assert.equal(app.note,null);assert.match(git(['log','-1','--format=%B']),/^New feature\n\nDescription\n\nCo-authored-by: One/);
}));

test('author confirmation refuses another branch even when its HEAD is the same commit',()=>harness(async({git,put,app,refresh,key})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();await key('4');await key('a');await key('a');
  git(['switch','-qc','other']);const head=git(['rev-parse','HEAD']);await key('enter');assert.match(app.note,/branch changed/);assert.equal(git(['rev-parse','HEAD']),head);
}));

test('cancelling while command storage is allocated prevents execution and clears only its own busy job',()=>harness(async({dir,git,put,app,cx,refresh,flush,afterExec})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();let temp;
  afterExec((command,args,_options,result)=>{if(command==='sh'&&args[1]?.includes('mktemp -d')&&args[1].includes('herdr-git-command.')){temp=result.stdout.trim();app.cancelConfiguredCommand();}});
  app.startConfiguredCommand({command:'touch cancelled-at-allocation'},cx);await flush();assert.ok(temp);assert.equal(fs.existsSync(temp),false);assert.equal(fs.existsSync(join(dir,'cancelled-at-allocation')),false);
  assert.equal(app.busy,null);assert.equal(app.customJob,null);assert.equal(app.commandCaptures.size,0);
}));

test('expired output timer context cleans storage without starting the command',()=>harness(async({dir,git,put,app,cx,refresh,flush,afterExec})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();let temp;
  afterExec((command,args,_options,result)=>{if(command==='sh'&&args[1]?.includes('mktemp -d')&&args[1].includes('herdr-git-command.'))temp=result.stdout.trim();});
  cx.timer.every=()=>{throw new Error('Context expired');};app.startConfiguredCommand({command:'touch timer-expired-command',output:'log'},cx);await flush();
  assert.match(app.note,/Context expired/);assert.ok(temp);assert.equal(fs.existsSync(temp),false);assert.equal(fs.existsSync(join(dir,'timer-expired-command')),false);assert.equal(app.commandCaptures.size,0);assert.equal(app.busy,null);
}));

test('failed PTY reads clean up the owned noninteractive terminal and preserve the error',()=>harness(async({git,put,app,cx,refresh,flush,setCore})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();const calls=[];let state='live';
  setCore(async args=>{calls.push(args[0]);if(args[0]==='read')return {code:1,stdout:'',stderr:'read failed'};if(args[0]==='kill')state='finished';return {code:0,stderr:'',stdout:JSON.stringify({address:'t-fixture',state})};});
  app.startConfiguredCommand({command:'printf Done',output:'logWithPty'},cx);await flush();assert.match(app.note,/read failed/);assert.ok(calls.includes('kill'));assert.equal(calls.at(-1),'rm');assert.equal(app.busy,null);
}));

test('commit attribute and diff clipboard actions use a fresh asynchronous context',()=>harness(async({git,put,app,cx,refresh,flush,clipboard})=>{
  put('f','base');git(['add','f']);git(['commit','-qm','base']);await refresh();let expired=false;
  const event=Object.create(cx);event.notify=()=>{if(expired)throw new Error('Event context expired');};event.write_to_clipboard=()=>{if(expired)throw new Error('Event context expired');};
  app.copyCommitAttribute(app.commits[0],event);expired=true;await flush();assert.equal(app.note,null);assert.ok(app.menu);
  app.menu.items.find(it=>it.label==='Hash').run(cx);assert.equal(clipboard.at(-1),app.head);
  expired=false;const diff=app.menu.items.find(it=>it.label==='Diff');diff.run(event);expired=true;await flush();assert.equal(app.note,null);assert.match(clipboard.at(-1),/diff --git/);
}));

async function focusGraph(app,cx,flush) {app.goto('status',cx);await flush();assert.ok(app.graph);}
async function inspectGraph(app,cx,flush,hash,modifiers={}) {app.inspectGraphCommit(hash,modifiers,cx);assert.equal(app.graphInspection?.loading,true);await flush();assert.equal(app.graphInspection?.loading,false,app.note??'Graph details did not load');return app.graphInspection.data;}

test('graph details read root, renamed, binary and merge files against the first parent',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('base','base\n');put('old\tname\n中文','same\n');put('binary',Buffer.from([0,1,2]));git(['add','.']);git(['commit','-qm','Root subject\n\nFull body']);const root=git(['rev-parse','HEAD']).trim();
  git(['mv','old\tname\n中文','new\tname\n中文']);put('binary',Buffer.from([0,3,4]));git(['add','.']);git(['commit','-qm','Rename']);const rename=git(['rev-parse','HEAD']).trim();
  git(['switch','-qc','topic',root]);put('topic-file','topic\n');git(['add','.']);git(['commit','-qm','Topic']);git(['switch','-q','main']);git(['merge','--no-ff','--no-edit','topic']);const merge=git(['rev-parse','HEAD']).trim();
  await refresh();await focusGraph(app,cx,flush);
  let data=await inspectGraph(app,cx,flush,root);assert.equal(data.commit.body,'Root subject\n\nFull body');assert.equal(data.commit.parents.length,0);assert.ok(data.files.every(file=>file.type==='A'));assert.equal(app.graph.rows.length,4);assert.equal(app.peek,null);
  data=await inspectGraph(app,cx,flush,rename);const file=data.files.find(file=>file.type==='R');assert.equal(file.oldFilePath,'old\tname\n中文');assert.equal(file.newFilePath,'new\tname\n中文');assert.equal(data.files.find(file=>file.newFilePath==='binary').additions,null);
  data=await inspectGraph(app,cx,flush,merge);assert.equal(data.commit.parents.length,2);assert.deepEqual(Array.from(data.files,file=>file.newFilePath),['topic-file']);
}));

test('graph details distinguish stash untracked files from raw-tree comparisons and WIP ignores',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');put('.gitignore','ignored\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();
  put('f','staged\n');git(['add','f']);put('f','unstaged\n');put('untracked','saved\n');put('ignored','ignored\n');git(['stash','push','-uqm','saved']);const stash=git(['rev-parse','refs/stash']).trim();
  await refresh();await focusGraph(app,cx,flush);let data=await inspectGraph(app,cx,flush,stash);assert.ok(data.files.some(file=>file.newFilePath==='f'));const untracked=data.files.find(file=>file.newFilePath==='untracked');assert.equal(untracked.type,'U');assert.equal(untracked.untrackedParent,git(['rev-parse',stash+'^3']).trim());
  data=await inspectGraph(app,cx,flush,base,{platform:true});assert.equal(data.commit,null);assert.ok(!data.files.some(file=>file.newFilePath==='untracked'));assert.equal(data.from,base);assert.equal(data.to,stash);
  put('f','working\n');put('new [literal]','new\n');await refresh();app.closeGraphInspection(cx);data=await inspectGraph(app,cx,flush,'*');assert.equal(data.commit,null);assert.ok(data.files.some(file=>file.newFilePath==='new [literal]'&&file.type==='U'));assert.ok(!data.files.some(file=>file.newFilePath==='ignored'));
  data=await inspectGraph(app,cx,flush,base,{control:true});assert.equal(data.to,'*');assert.equal(data.from,base);assert.ok(data.files.some(file=>file.newFilePath==='new [literal]'));
}));

test('graph comparison gestures open on one click, toggle either modifier and keep the source graph',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','next']);const top=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);
  elements.length=0;app.graphView(app.colors());const list=elements.find(e=>e.virtualArgs?.[0]==='git-graph'),wrapper=elements.find(e=>e.events.on_click&&e._children.includes(list));assert.ok(wrapper);
  list.events.on_item_click(base,cx);wrapper.events.on_click({modifiers:{},click_count:1},cx);assert.equal(app.graphInspection.primary,base);await flush();
  list.events.on_item_click(top,cx);wrapper.events.on_click({modifiers:{platform:true},click_count:1},cx);await flush();assert.equal(app.graphInspection.from,base);assert.equal(app.graphInspection.to,top);assert.equal(app.graphInspection.secondary,top);assert.equal(app.graph.rows.length,2);
  list.events.on_item_click(top,cx);wrapper.events.on_click({modifiers:{control:true},click_count:1},cx);await flush();assert.equal(app.graphInspection.secondary,null);
  list.events.on_item_click(base,cx);wrapper.events.on_click({modifiers:{control:true},click_count:1},cx);assert.equal(app.graphInspection,null);assert.equal(app.peek,null);
}));

test('graph details reject overtaken reads, stale errors, source changes and closed requests',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','next']);const top=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);
  let release=hold();app.inspectGraphCommit(base,{},cx);const first=app.graphInspection;await tick();app.inspectGraphCommit(top,{},cx);const second=app.graphInspection;assert.notEqual(first,second);assert.equal(second.loading,true);release();await flush();assert.equal(app.graphInspection,second);assert.equal(second.data.commit.hash,top);
  release=hold();app.inspectGraphCommit(base,{},cx);await tick();app.goto('files',cx);release();await flush();assert.equal(app.graphInspection,null);
  await focusGraph(app,cx,flush);const original=app.readGraphDetails;let reject;app.readGraphDetails=()=>new Promise((_resolve,no)=>{reject=no;});app.inspectGraphCommit(base,{},cx);await tick();app.closeGraphInspection(cx);reject(new Error('old read failed'));await flush();assert.ok(!app.note?.includes('old read failed'));app.readGraphDetails=original;
  release=hold();app.inspectGraphCommit(top,{},cx);await tick();app.close();release();await flush();assert.equal(app.graphInspection,null);
}));

test('graph comparison errors return to primary details and reordered rows refresh the endpoints',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','next']);const top=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);await inspectGraph(app,cx,flush,base);const original=app.readGraphDetails;
  app.readGraphDetails=function(job){if(job.secondary)throw new Error('comparison failure');return original.call(this,job);};app.inspectGraphCommit(top,{control:true},cx);await flush();assert.equal(app.graphInspection.primary,base);assert.equal(app.graphInspection.secondary,null);assert.equal(app.graphInspection.data.commit.hash,base);assert.match(app.note,/comparison failure/);app.readGraphDetails=original;
  await inspectGraph(app,cx,flush,top,{control:true});app.graph={...app.graph,rows:app.graph.rows.slice().reverse()};app.syncGraph(cx,'status');await flush();assert.equal(app.graphInspection.from,top);assert.equal(app.graphInspection.to,base);
}));

test('graph file preview keeps rename endpoints, restores details on Escape and renders stash and WIP untracked content',()=>harness(async({git,put,app,cx,refresh,flush,key})=>{
  put('old [x]','same\n');git(['add','.']);git(['commit','-qm','base']);git(['mv','old [x]','new [x]']);git(['commit','-qm','rename']);const rename=git(['rev-parse','HEAD']).trim();
  await refresh();await focusGraph(app,cx,flush);let data=await inspectGraph(app,cx,flush,rename);app.openGraphFile(data.files[0],cx);await flush();assert.ok(app.rawDiffLines.some(line=>line==='rename from old [x]'));assert.ok(app.rawDiffLines.some(line=>line==='rename to new [x]'));assert.equal(app.graph,null);await key('escape');assert.ok(app.graph);assert.equal(app.graphInspection.primary,rename);
  put('untracked','stash bytes\n');git(['stash','push','-uqm','untracked']);await refresh();data=await inspectGraph(app,cx,flush,git(['rev-parse','refs/stash']).trim());app.openGraphFile(data.files.find(file=>file.type==='U'),cx);await flush();assert.ok(app.rawDiffLines.includes('+stash bytes'));await key('escape');
  put('untracked','working bytes\n');await refresh();app.closeGraphInspection(cx);data=await inspectGraph(app,cx,flush,'*');app.openGraphFile(data.files.find(file=>file.type==='U'),cx);await flush();assert.ok(app.rawDiffLines.includes('+working bytes'));assert.ok(!app.rawDiffLines.some(line=>line.startsWith('Cannot show')));
}));

test('graph reference segments keep nested remote identities and badge clicks never compare commits',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const hash=git(['rev-parse','HEAD']).trim();git(['branch','topic/x']);git(['remote','add','team/origin','https://example.invalid/repo.git']);git(['update-ref','refs/remotes/team/origin/topic/x',hash]);git(['tag','-a','annotated','-m','tag body']);git(['tag','lightweight']);await refresh();await focusGraph(app,cx,flush);
  const cm=app.graphRowsByHash.get(hash).commit,groups=app.graphReferenceGroups(cm),group=groups.find(group=>group[0].name==='topic/x');assert.equal(group[1].remote,'team/origin');assert.equal(group[1].branch,'topic/x');assert.equal(group[1].ref,'refs/remotes/team/origin/topic/x');assert.equal(app.graphReferences(cm).find(ref=>ref.name==='annotated').annotated,true);assert.equal(app.graphReferences(cm).find(ref=>ref.name==='lightweight').annotated,false);
  elements.length=0;app.graphLabelViews.get(hash).view.render();const badge=elements.find(e=>e._children.includes('team/origin')&&e.events.on_click);assert.ok(badge);let stopped=0;app.graphClick=hash;badge.events.on_click({modifiers:{platform:true},click_count:1},{stop_propagation(){stopped++;}});assert.equal(stopped,1);assert.equal(app.graphClick,null);assert.equal(app.graphInspection,null);
  badge.events['on_mouse_down:right']({},cx);assert.equal(app.menu.title,'team/origin/topic/x');assert.ok(app.menu.items.some(item=>item.label==='Fetch into local branch…'));assert.ok(!app.menu.items.some(item=>item.label.includes('Rebase')));
}));

test('graph background badge events preserve active forms, confirmations and menus',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;put('f','base');git(['add','f']);git(['commit','-qm','Base']);graphLocalRemote(h);git(['push','-q','team/origin','main:refs/heads/topic']);for(let i=0;i<5;i++)git(['tag',`v${i}`]);await refresh();await focusGraph(app,cx,flush);
  elements.length=0;app.graphLabelViews.get(app.head).view.render();const badge=elements.find(e=>e._children.includes('team/origin/topic')&&e.events.on_click),more=elements.find(e=>e._children.some(value=>typeof value==='string'&&/^\+\d+$/.test(value))&&e.events.on_click);assert.ok(badge&&more);
  badge.events.on_click({click_count:2},cx);assert.equal(app.prompt.title,'Local branch name');assert.equal(app.message,'topic');const prompt=app.prompt;
  for(const kind of ['prompt','pending','menu']){
    app.prompt=null;app.pending=null;app.menu=null;
    if(kind==='prompt'){app.prompt=prompt;app.message='draft name';}
    else if(kind==='pending')app.ask('Keep this confirmation','Captured target',()=>{},cx);
    else app.menuItems('Keep this menu',[['Existing choice','',()=>{}]],cx);
    const active=app[kind];badge.events.on_click({click_count:1},cx);badge.events.on_click({click_count:2},cx);badge.events['on_mouse_down:right']({},cx);more.events.on_click({},cx);
    app.graphCommitMenu(graphCommitTarget(app,app.head),cx);app.graphWorktreeMenu(cx);
    assert.equal(app[kind],active);assert.equal(app.message,'draft name');for(const other of ['prompt','pending','menu'].filter(value=>value!==kind))assert.ok(!app[other]);
  }
  app.menu=null;badge.events['on_mouse_down:right']({},cx);assert.equal(app.menu.title,'team/origin/topic');
}));

test('graph badge mutations capture their target, reject moved refs and refuse a different repository',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();git(['branch','topic']);put('f','next\n');git(['commit','-qam','next']);const top=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);const target=app.graphReferences(app.graphRowsByHash.get(base).commit).find(ref=>ref.name==='topic');assert.ok(target);
  app.panel='files';app.graphReferenceAction('Rename branch',target,[['branch','-m','topic','renamed']],cx);await flush();assert.equal(git(['rev-parse','renamed']).trim(),base);git(['branch','topic',base]);git(['branch','-f','topic',top]);app.graphReferenceAction('Rename branch',target,[['branch','-m','topic','wrong']],cx);await flush();assert.match(app.note,/topic changed/);assert.equal(git(['branch','--list','wrong']).trim(),'');
  const repo=app.repoKey;app.repoKey='other-repository';app.graphReferenceAction('Delete branch',target,[['branch','-D','topic']],cx);assert.match(app.note,/repository changed/);app.repoKey=repo;assert.equal(git(['rev-parse','topic']).trim(),top);
}));

test('graph stash branch restores tracked and untracked changes without changing Lazygit branch semantics',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);put('f','saved\n');git(['add','f']);put('new','untracked\n');git(['stash','push','-uqm','saved']);const hash=git(['rev-parse','refs/stash']).trim();await refresh();await focusGraph(app,cx,flush);const target=app.graphReferences(app.graphRowsByHash.get(hash).commit)[0];app.graphStashAction(target,'branch',cx);assert.equal(app.prompt.title,'New branch from stash');app.message='restored';app.submit(cx);await flush();assert.equal(git(['branch','--show-current']).trim(),'restored');assert.equal(git(['diff','--cached','--name-only']).trim(),'f');assert.equal(git(['ls-files','--others','--exclude-standard']).trim(),'new');assert.equal(git(['stash','list']).trim(),'');
}));

test('graph polling preserves immutable detail jobs and refreshes WIP without dropping loaded content',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','.']);git(['commit','-qm','base']);const hash=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);await inspectGraph(app,cx,flush,hash);const immutable=app.graphInspection;await refresh();assert.equal(app.graphInspection,immutable);
  put('f','changed\n');await refresh();await inspectGraph(app,cx,flush,'*');const before=app.graphInspection,release=hold();app.syncGraph(cx,'status');await tick();const updating=app.graphInspection;assert.notEqual(updating,before);assert.equal(updating.loading,true);assert.equal(updating.data,before.data);app.syncGraph(cx,'status');assert.equal(app.graphInspection,updating);release();await flush();assert.equal(updating.loading,false);
}));

function graphMenuPick(app,cx,label) {
  const index=app.menu?.items.findIndex(item=>item.label===label||item.label.slice(2)===label)??-1;
  assert.ok(index>=0,`Missing ${label} in ${app.menu?.title}: ${app.menu?.items.map(item=>item.label).join(', ')}`);
  app.pickMenu(index,cx);
}
function graphConfirm(app,cx) {assert.ok(app.pending,app.note??'Missing confirmation');const pending=app.pending;app.pending=null;pending.then(cx);}
function graphTarget(app,kind,name) {
  const target=app.graph.rows.flatMap(row=>Array.from(app.graphReferences(row.commit))).find(ref=>ref.kind===kind&&ref.name===name);
  assert.ok(target,`Missing ${kind} ${name}`);return target;
}
function graphCommitTarget(app,hash) {const row=app.graphRowsByHash.get(hash);assert.ok(row);return app.graphCommitTarget(row.commit);}
function graphPickOption(app,cx,label,value) {
  const index=app.menu.items.findIndex(item=>item.label.startsWith(`${label}: `));assert.ok(index>=0);app.pickMenu(index,cx);
  const choice=app.menu.items.findIndex(item=>item.label.startsWith(value));assert.ok(choice>=0);app.pickMenu(choice,cx);
}
function graphLocalRemote({dir,git,put},name='team/origin') {
  const remote=join(dir,'.git',`${name.replaceAll('/','-')}.git`);git(['init','--bare','-q',remote]);git(['remote','add',name,remote]);
  put('.git/lazygit.yml','git:\n  autoFetch: false\n');return remote;
}

function graphWorktreeFixture({git,put}) {
  put('f','base\n');put('.gitignore','ignored\n');git(['add','.']);git(['commit','-qm','Base']);
  put('f','index\n');git(['add','f']);put('f','worktree\n');put('new','untracked\n');put('ignored','ignored\n');
}

test('graph uncommitted row exposes its own actions and opens Files',()=>harness(async h=>{
  const {app,cx,refresh,flush}=h;graphWorktreeFixture(h);await refresh();await focusGraph(app,cx,flush);app.cursor=app.graphOrder.indexOf('*');app.graphKeys(cx).menu();
  assert.deepEqual(Array.from(app.menu.items,item=>item.label),['Stash uncommitted changes…','Reset uncommitted changes…','Clean untracked files…','Go to Files']);
  graphMenuPick(app,cx,'Go to Files');await flush();assert.equal(app.panel,'files');assert.equal(app.main,false);
}));

for(const untracked of [true,false])test(`graph worktree stash ${untracked?'includes':'leaves'} untracked files and keeps ignored files`,()=>harness(async h=>{
  const {app,cx,git,refresh,flush,dir}=h;graphWorktreeFixture(h);await refresh();await focusGraph(app,cx,flush);
  app.graphStashWorktree(app.graphWorktreeTarget(),cx);assert.equal(app.opening,'Reading stash options');await flush();assert.equal(app.prompt.empty,true);app.message=untracked?'saved graph work':'';app.submit(cx);
  assert.equal(app.menu.items[0].label,'☑ Include untracked files');if(!untracked)graphMenuPick(app,cx,'Include untracked files');graphMenuPick(app,cx,'Continue');await flush();
  assert.equal(app.note,null);assert.equal(git(['show','stash@{0}:f']),'worktree\n');assert.equal(git(['show','stash@{0}^2:f']),'index\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'base\n');assert.equal(fs.existsSync(join(dir,'new')),!untracked);assert.equal(fs.readFileSync(join(dir,'ignored'),'utf8'),'ignored\n');
  if(untracked){assert.equal(git(['show','stash@{0}^3:new']),'untracked\n');assert.match(git(['stash','list']),/saved graph work/);assert.equal(git(['ls-tree','--name-only','stash@{0}^3']).trim(),'new');}
  assert.equal(app.busy,null);assert.equal(app.settling,null);
}));

for(const mode of ['mixed','hard'])test(`graph worktree reset ${mode} preserves HEAD and applies the selected index/worktree behavior`,()=>harness(async h=>{
  const {app,cx,git,refresh,flush,dir}=h;graphWorktreeFixture(h);const head=git(['rev-parse','HEAD']);await refresh();await focusGraph(app,cx,flush);
  app.graphResetWorktree(app.graphWorktreeTarget(),cx);await flush();assert.match(app.menu.items[0].label,/Reset mode: Mixed/);graphPickOption(app,cx,'Reset mode',mode==='hard'?'Hard':'Mixed');graphMenuPick(app,cx,'Continue');assert.match(app.pending.title,new RegExp(mode));assert.equal(git(['show',':f']),'index\n');graphConfirm(app,cx);await flush();
  assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']),head);assert.equal(git(['show',':f']),'base\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),mode==='hard'?'base\n':'worktree\n');assert.ok(fs.existsSync(join(dir,'new'))&&fs.existsSync(join(dir,'ignored')));
}));

for(const directories of [true,false])test(`graph worktree clean ${directories?'includes':'leaves'} directories while preserving ignored files and nested repositories`,()=>harness(async h=>{
  const {app,cx,git,refresh,flush,dir}=h;graphWorktreeFixture(h);fs.mkdirSync(join(dir,'folder'));fs.writeFileSync(join(dir,'folder','new'),'folder file');
  git(['init','-q',join(dir,'nested')]);fs.writeFileSync(join(dir,'nested','new'),'nested file');await refresh();await focusGraph(app,cx,flush);
  app.graphCleanWorktree(app.graphWorktreeTarget(),cx);await flush();assert.equal(app.menu.items[0].label,'☑ Clean untracked directories');if(!directories)graphMenuPick(app,cx,'Clean untracked directories');graphMenuPick(app,cx,'Continue');assert.equal(app.pending.title,'Clean untracked files');assert.ok(fs.existsSync(join(dir,'new')));graphConfirm(app,cx);await flush();
  assert.equal(app.note,null);assert.equal(fs.existsSync(join(dir,'new')),false);assert.equal(fs.existsSync(join(dir,'folder')),!directories);assert.equal(fs.readFileSync(join(dir,'ignored'),'utf8'),'ignored\n');assert.equal(fs.readFileSync(join(dir,'nested','new'),'utf8'),'nested file');assert.ok(fs.existsSync(join(dir,'nested','.git')));assert.equal(git(['show',':f']),'index\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'worktree\n');
}));

test('graph worktree actions reject a replacement current branch at the same hash',()=>harness(async h=>{
  const {app,cx,git,refresh,flush,dir}=h;graphWorktreeFixture(h);git(['branch','same-tip']);await refresh();await focusGraph(app,cx,flush);
  for(const action of ['graphResetWorktree','graphCleanWorktree','graphStashWorktree']){
    app[action](app.graphWorktreeTarget(),cx);await flush();if(app.prompt){app.message='';app.submit(cx);}git(['switch','-q','same-tip']);graphMenuPick(app,cx,'Continue');if(app.pending)graphConfirm(app,cx);await flush();
    assert.match(app.note,/HEAD or the current branch changed/);assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'worktree\n');assert.ok(fs.existsSync(join(dir,'new')));assert.equal(git(['stash','list']).trim(),'');git(['switch','-q','main']);await refresh();
  }
}));

test('reference preparation Escape clears loading immediately and late results cannot reopen a menu',()=>harness(async h=>{
  const {app,cx,git,put,refresh,flush,hold,tick}=h;put('f','base');git(['add','f']);git(['commit','-qm','Base']);await refresh();await focusGraph(app,cx,flush);
  const target=graphCommitTarget(app,app.head),release=hold();app.graphReset(target,cx);await tick();assert.equal(app.refReading!==null,true);assert.equal(app.opening,'Reading reset options');app.main=true;
  app.keys({key:'escape',modifiers:{}},cx);assert.equal(app.main,true);assert.ok(!app.closed);assert.equal(app.busy,null);assert.equal(app.opening,null);assert.equal(app.refReading,null);
  app.graphCherryPick(target,cx);assert.equal(app.opening,'Reading cherry-pick options');release();await flush();assert.match(app.menu.title,/Cherry-pick/);assert.equal(app.menu.items.some(item=>item.label.startsWith('Reset mode')),false);assert.equal(app.opening,null);
}));

test('reference preparation close clears loading and ignores delayed failures',()=>harness(async h=>{
  const {app,cx,git,put,refresh,flush,hold,tick,failOn}=h;put('f','base');git(['add','f']);git(['commit','-qm','Base']);await refresh();await focusGraph(app,cx,flush);
  const release=hold();app.graphReset(graphCommitTarget(app,app.head),cx);await tick();app.close();assert.equal(app.refReading,null);assert.equal(app.busy,null);assert.equal(app.opening,null);failOn(()=>true);release();await flush();assert.ok(!app.menu);assert.ok(!app.pending);assert.equal(app.note,null);
}));

function graphReplace(app,cx,kind) {
  const index=app.menu?.items.findIndex(item=>item.label.startsWith(`Replace existing ${kind} (`))??-1;assert.ok(index>=0,app.note??'Missing replacement choice');app.pickMenu(index,cx);
}
function graphCollisionFixture({git,put}) {
  put('f','base\n');git(['add','f']);git(['commit','-qm','Base']);const base=git(['rev-parse','HEAD']).trim();git(['branch','existing']);git(['tag','-a','-m','Before','existing']);
  put('f','next\n');git(['commit','-qam','Next']);return {base,tip:git(['rev-parse','HEAD']).trim()};
}
test('reference names keep their actual namespace when branches, tags and remotes share a short name',()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h;graphLocalRemote(h);const {base,tip}=graphCollisionFixture(h);git(['branch','team/origin/topic/x',base]);git(['tag','team/origin/topic/x',base]);git(['push','-q','team/origin','main:refs/heads/topic/x']);await refresh();await focusGraph(app,cx,flush);
  assert.equal(app.branches.find(branch=>branch.ref==='refs/heads/existing')?.name,'existing');assert.equal(app.tags.find(tag=>tag.ref==='refs/tags/existing')?.name,'existing');assert.equal(app.remoteBranches.find(branch=>branch.ref==='refs/remotes/team/origin/topic/x')?.name,'team/origin/topic/x');
  assert.equal(graphTarget(app,'local','team/origin/topic/x').hash,base);assert.equal(graphTarget(app,'tag','team/origin/topic/x').hash,base);assert.equal(graphTarget(app,'remote','team/origin/topic/x').hash,tip);
}));
async function graphCreateBranchForm(h,name,checkout=false) {
  const {app,cx,flush}=h;app.graphCreateBranch(graphCommitTarget(app,app.head),cx);app.message=name;app.submit(cx);if(checkout)graphMenuPick(app,cx,'Check out branch');graphMenuPick(app,cx,'Continue');await flush();
}

test('graph branch collision can cancel or choose another name while retaining checkout',()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h,{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);
  await graphCreateBranchForm(h,'existing',true);assert.match(app.menu.title,/already exists/);app.cancelMenu(cx);assert.equal(git(['rev-parse','refs/heads/existing']).trim(),base);assert.equal(git(['branch','--show-current']).trim(),'main');
  await graphCreateBranchForm(h,'existing',true);graphMenuPick(app,cx,'Choose another branch name');assert.equal(app.message,'existing');app.message='another/topic';app.submit(cx);assert.equal(app.menu.items[0].label,'☑ Check out branch');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','another/topic']).trim(),tip);assert.equal(git(['branch','--show-current']).trim(),'another/topic');assert.equal(git(['rev-parse','refs/heads/existing']).trim(),base);
}));

for(const checkout of [false,true])test(`graph branch replacement ${checkout?'checks out':'does not check out'} the explicitly replaced branch`,()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h,{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);await graphCreateBranchForm(h,'existing',checkout);assert.equal(git(['rev-parse','refs/heads/existing']).trim(),base);graphReplace(app,cx,'branch');await flush();
  assert.equal(app.note,null);assert.equal(git(['rev-parse','refs/heads/existing']).trim(),tip);assert.equal(git(['branch','--show-current']).trim(),checkout?'existing':'main');
}));

test('graph branch replacement refuses a moved ref and a branch checked out in any worktree',()=>harness(async h=>{
  const {app,cx,git,refresh,flush,dir}=h,{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);await graphCreateBranchForm(h,'existing');git(['branch','-f','existing',tip]);graphReplace(app,cx,'branch');await flush();assert.match(app.note,/existing changed/);assert.equal(git(['rev-parse','refs/heads/existing']).trim(),tip);
  git(['branch','-f','existing',base]);git(['worktree','add','-q',join(dir,'.git','linked'),'existing']);await refresh();await focusGraph(app,cx,flush);await graphCreateBranchForm(h,'existing',true);graphReplace(app,cx,'branch');await flush();assert.match(app.note,/checked out|used by worktree/);assert.equal(git(['rev-parse','refs/heads/existing']).trim(),base);assert.equal(git(['branch','--show-current']).trim(),'main');
}));

test('graph tag collision retains its annotation and single-remote push choice with another name',()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h,remote=graphLocalRemote(h),{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);
  app.graphCreateTag(graphCommitTarget(app,tip),cx);app.message='existing';app.submit(cx);assert.equal(app.menu.items[1].label,'☐ Push to team/origin');graphMenuPick(app,cx,'Push to team/origin');graphMenuPick(app,cx,'Continue');app.message='Release annotation';app.submit(cx);await flush();assert.match(app.menu.title,/already exists/);assert.equal(git(['rev-parse','existing^{commit}']).trim(),base);
  graphMenuPick(app,cx,'Choose another tag name');assert.equal(app.message,'existing');app.message='release/new';app.submit(cx);assert.equal(app.menu.items[0].label,'Tag type: Annotated');assert.equal(app.menu.items[1].label,'☑ Push to team/origin');graphMenuPick(app,cx,'Continue');assert.equal(app.message,'Release annotation');app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','release/new^{commit}']).trim(),tip);assert.match(git(['cat-file','tag','release/new']),/Release annotation/);assert.equal(git(['--git-dir',remote,'rev-parse','refs/tags/release/new']),git(['rev-parse','refs/tags/release/new']));assert.equal(git(['rev-parse','refs/tags/existing^{commit}']).trim(),base);
}));

test('graph tag replacement is explicit and detects annotation-only changes at the same commit',()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h,{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);
  const open=async()=>{app.graphCreateTag(graphCommitTarget(app,tip),cx);app.message='existing';app.submit(cx);graphPickOption(app,cx,'Tag type','Lightweight');graphMenuPick(app,cx,'Continue');await flush();};
  await open();app.cancelMenu(cx);assert.equal(git(['cat-file','-t','refs/tags/existing']).trim(),'tag');await open();git(['tag','-f','-a','-m','Changed annotation','existing',base]);const changed=git(['rev-parse','refs/tags/existing']);graphReplace(app,cx,'tag');await flush();assert.match(app.note,/existing changed/);assert.equal(git(['rev-parse','refs/tags/existing']),changed);
  await open();graphReplace(app,cx,'tag');await flush();assert.equal(app.note,null);assert.equal(git(['cat-file','-t','refs/tags/existing']).trim(),'commit');assert.equal(git(['rev-parse','refs/tags/existing']).trim(),tip);
}));

test('graph tag push failure retains the new local tag and does not push to another remote',()=>harness(async h=>{
  const {app,cx,git,refresh,flush}=h,first=graphLocalRemote(h),second=graphLocalRemote(h,'archive'),{tip}=graphCollisionFixture(h);git(['push','-q','team/origin','refs/tags/existing']);await refresh();await focusGraph(app,cx,flush);
  app.graphCreateTag(graphCommitTarget(app,tip),cx);app.message='existing';app.submit(cx);assert.equal(app.menu.items[1].label,'Push to: Do not push');graphPickOption(app,cx,'Push to','team/origin');graphMenuPick(app,cx,'Continue');app.message='New local tag';app.submit(cx);await flush();graphReplace(app,cx,'tag');await flush();
  assert.match(app.note,/already exists|rejected/);assert.equal(git(['rev-parse','refs/tags/existing^{commit}']).trim(),tip);assert.match(git(['cat-file','tag','refs/tags/existing']),/New local tag/);assert.notEqual(git(['--git-dir',first,'rev-parse','refs/tags/existing']),git(['rev-parse','refs/tags/existing']));assert.equal(git(['--git-dir',second,'tag','--list']).trim(),'');assert.ok(app.tags.some(tag=>tag.name==='existing'));assert.equal(app.busy,null);assert.equal(app.settling,null);
}));

test('graph name preparation refuses invalid names and a late collision without replacing it',()=>harness(async h=>{
  const {app,cx,git,refresh,flush,afterExec}=h,{base,tip}=graphCollisionFixture(h);await refresh();await focusGraph(app,cx,flush);
  for(const name of ['-unsafe','bad..name','bad:name']){await graphCreateBranchForm(h,name);assert.match(app.note,/Invalid branch name/);assert.equal(app.menu,null);}
  let reads=0;afterExec((_cmd,args)=>{if(args.includes('refs/heads/late')&&args.includes('--verify')&&++reads===1)git(['branch','late',base]);});await graphCreateBranchForm(h,'late');afterExec(null);assert.match(app.note,/late changed|already exists/);assert.equal(git(['rev-parse','late']).trim(),base);assert.notEqual(base,tip);
}));

async function graphRemoteCollisionFixture(h) {
  const {git,app,cx,refresh,flush}=h;graphLocalRemote(h);const values=graphCollisionFixture(h);git(['branch','topic/x',values.base]);git(['push','-q','team/origin','main:refs/heads/topic/x']);await refresh();await focusGraph(app,cx,flush);return {...values,target:graphTarget(app,'remote','team/origin/topic/x')};
}

test('graph remote checkout always asks for a name and can cancel or choose a new branch',()=>harness(async h=>{
  const {app,cx,git,flush}=h,{base,tip,target}=await graphRemoteCollisionFixture(h);
  app.checkoutGraphReference(target,cx);assert.equal(app.message,'topic/x');assert.equal(git(['branch','--show-current']).trim(),'main');app.submit(cx);await flush();assert.equal(app.menu.title,'Branch topic/x already exists');app.cancelMenu(cx);assert.equal(git(['rev-parse','topic/x']).trim(),base);
  app.checkoutGraphReference(target,cx);app.submit(cx);await flush();graphMenuPick(app,cx,'Choose another branch name');assert.equal(app.message,'topic/x');app.message='chosen/topic';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'chosen/topic');assert.equal(git(['rev-parse','HEAD']).trim(),tip);assert.equal(git(['rev-parse','topic/x']).trim(),base);
}));

test('graph remote checkout of an existing branch pulls from the clicked remote instead of its upstream',()=>harness(async h=>{
  const {app,cx,git,flush}=h,{base,tip,target}=await graphRemoteCollisionFixture(h);const other=graphLocalRemote(h,'archive');git(['push','-q','archive','topic/x']);git(['branch','--set-upstream-to=archive/topic/x','topic/x']);
  app.checkoutGraphReference(target,cx);app.submit(cx);await flush();graphMenuPick(app,cx,'Checkout existing branch and pull');await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'topic/x');assert.equal(git(['rev-parse','HEAD']).trim(),tip);assert.equal(git(['--git-dir',other,'rev-parse','refs/heads/topic/x']).trim(),base);assert.equal(git(['config','branch.topic/x.remote']).trim(),'archive');
}));

for(const moved of ['local','remote'])test(`graph remote checkout rejects a ${moved} reference that moved after the name prompt`,()=>harness(async h=>{
  const {app,cx,git,flush}=h,{base,tip,target}=await graphRemoteCollisionFixture(h);app.checkoutGraphReference(target,cx);app.submit(cx);await flush();
  git(['update-ref',moved==='local'?'refs/heads/topic/x':target.ref,moved==='local'?tip:base]);graphMenuPick(app,cx,'Checkout existing branch and pull');await flush();assert.match(app.note,/changed/);assert.equal(git(['branch','--show-current']).trim(),'main');assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git pull ')),false);
}));

test('graph remote checkout with an unknown remote retains the full name and skips pull',()=>harness(async h=>{
  const {app,cx,git,flush}=h,{base,target}=await graphRemoteCollisionFixture(h);git(['branch',target.name,base]);app.checkoutGraphReference({...target,remote:''},cx);assert.equal(app.message,target.name);app.submit(cx);await flush();graphMenuPick(app,cx,'Checkout existing branch');await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),target.name);assert.equal(git(['rev-parse','HEAD']).trim(),base);assert.equal(app.commandLog.some(entry=>entry.command.startsWith('git pull ')),false);
}));

test('graph detail controls drop events from an earlier selection',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','next']);const tip=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);await inspectGraph(app,cx,flush,tip);
  elements.length=0;app.graphDetailsView.view.render();const close=elements.find(e=>e._children.includes('×')&&e.events.on_click),toggle=elements.find(e=>e._children.includes('☷')&&e.events.on_click),parent=elements.find(e=>e._children.includes(base)&&e.events.on_click),files=elements.find(e=>e._id==='graph-detail-files'),list=elements.find(e=>e.virtualArgs?.[0]==='graph-files');assert.ok(close&&toggle&&parent&&files&&list);
  await inspectGraph(app,cx,flush,base);const current=app.graphInspection,tree=app.graphFileTree;close.events.on_click({},cx);toggle.events.on_click({},cx);parent.events.on_click({},cx);files.events.on_action({},cx);files.events.on_key_down({key:'escape'},cx);list.events.on_item_click(list.virtualArgs[3](0),cx);await flush();
  assert.equal(app.graphInspection,current);assert.equal(app.graphFileTree,tree);assert.equal(app.graphFile,null);
}));

test('graph merge, rebase and pull reject a different current branch at the same commit',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;graphLocalRemote(h);put('f','base\n');git(['add','f']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();git(['branch','same-tip']);
  git(['switch','-qc','topic/x']);put('next','next\n');git(['add','next']);git(['commit','-qm','next']);git(['push','-q','team/origin','topic/x']);git(['switch','-q','main']);await refresh();await focusGraph(app,cx,flush);
  for(const action of ['merge','rebase','pull']){
    const target=graphTarget(app,action==='pull'?'remote':'local',action==='pull'?'team/origin/topic/x':'topic/x');
    app[action==='merge'?'graphMergeReference':action==='rebase'?'graphRebaseReference':'graphPullReference'](target,cx);assert.match(app.busy,/Reading .* options/);await flush();
    git(['switch','-q','same-tip']);
    if(action!=='rebase')graphMenuPick(app,cx,'Continue');
    if(action!=='pull')graphConfirm(app,cx);
    await flush();assert.match(app.note,/HEAD or the current branch changed/);assert.equal(git(['rev-parse','HEAD']).trim(),base);assert.equal(git(['branch','--show-current']).trim(),'same-tip');assert.equal(app.busy,null);
    git(['switch','-q','main']);await refresh();await focusGraph(app,cx,flush);
  }
}));

for(const kind of ['apply','pop'])for(const index of [false,true])test(`graph stash ${kind} ${index?'reinstates':'does not reinstate'} the saved index`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','base']);put('f','index\n');git(['add','f']);put('f','worktree\n');put('new','untracked\n');git(['stash','push','-uqm','saved']);await refresh();await focusGraph(app,cx,flush);
  app.graphStashAction(graphTarget(app,'stash','stash@{0}'),kind,cx);assert.equal(app.busy,'Reading stash options');await flush();assert.equal(app.menu.items[0].label,'☐ Reinstate index');if(index)graphMenuPick(app,cx,'Reinstate index');graphMenuPick(app,cx,'Continue');await flush();
  assert.equal(app.note,null);assert.equal(git(['show',':f']),index?'index\n':'base\n');assert.equal(git(['diff','--name-only']).trim(),'f');assert.equal(git(['ls-files','--others','--exclude-standard']).trim(),'new');assert.equal(git(['stash','list']).trim()==='',kind==='pop');assert.equal(app.busy,null);
}));

test('graph stash apply and pending reads cannot affect a replacement branch or repository',()=>harness(async({git,put,app,cx,refresh,flush,hold,tick})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','base']);git(['branch','same-tip']);put('f','saved\n');git(['stash','push','-qm','saved']);await refresh();await focusGraph(app,cx,flush);const target=graphTarget(app,'stash','stash@{0}');
  app.graphStashAction(target,'apply',cx);await flush();git(['switch','-q','same-tip']);graphMenuPick(app,cx,'Continue');await flush();assert.match(app.note,/HEAD or the current branch changed/);assert.equal(git(['status','--porcelain']),'');assert.ok(git(['stash','list']).trim());
  const repo=app.repoKey,release=hold();app.graphStashAction(target,'apply',cx);await tick();app.repoKey='replaced';release();await flush();assert.equal(app.menu,null);assert.equal(app.busy,null);assert.equal(app.opening,null);app.repoKey=repo;
  app.busy='Fetch';app.checkoutGraphReference({...target,kind:'remote',branch:'missing'},cx);assert.equal(app.prompt,null);app.graphReferenceMenu(target,cx);assert.equal(app.menu,null);app.busy=null;
  app.settling='Fetch';app.graphStashAction(target,'branch',cx);assert.equal(app.prompt,null);app.settling=null;
}));

test('graph branch deletion offers force and deletes only explicitly selected matching remotes',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h,first=graphLocalRemote(h),second=graphLocalRemote(h,'archive');put('f','base\n');git(['add','f']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();
  git(['switch','-qc','topic/x']);put('next','next\n');git(['add','next']);git(['commit','-qm','unmerged']);const tip=git(['rev-parse','HEAD']).trim();git(['push','-q','team/origin','topic/x']);git(['push','-q','archive','topic/x']);git(['switch','-q','main']);await refresh();await focusGraph(app,cx,flush);const target=graphTarget(app,'local','topic/x');
  app.graphDeleteReference(target,cx);assert.ok(app.menu.items.slice(0,-1).every(item=>item.label.startsWith('☐ ')));graphMenuPick(app,cx,'Continue');graphConfirm(app,cx);await flush();assert.match(app.note,/not fully merged/);assert.equal(git(['rev-parse','topic/x']).trim(),tip);
  app.graphDeleteReference(target,cx);graphMenuPick(app,cx,'Force delete');graphMenuPick(app,cx,'Also delete on team/origin');graphMenuPick(app,cx,'Continue');graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['branch','--list','topic/x']).trim(),'');assert.equal(git(['--git-dir',first,'for-each-ref','--format=%(refname)','refs/heads/topic/x']).trim(),'');assert.equal(git(['--git-dir',second,'rev-parse','refs/heads/topic/x']).trim(),tip);assert.equal(git(['rev-parse','main']).trim(),base);
}));

test('graph push records upstream choice and annotated tag deletion is scoped to its chosen remote',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h,first=graphLocalRemote(h),second=graphLocalRemote(h,'archive');put('f','base\n');git(['add','f']);git(['commit','-qm','base']);git(['branch','topic/x']);git(['tag','-am','release body','v1']);await refresh();await focusGraph(app,cx,flush);
  app.graphPushReference(graphTarget(app,'local','topic/x'),cx);graphMenuPick(app,cx,'team/origin');assert.equal(app.menu.items[0].label,'☑ Set upstream');graphMenuPick(app,cx,'Continue');graphMenuPick(app,cx,'Normal');await flush();assert.equal(app.note,null);assert.equal(git(['config','branch.topic/x.remote']).trim(),'team/origin');assert.equal(git(['--git-dir',second,'for-each-ref','--format=%(refname)','refs/heads/topic/x']).trim(),'');
  await focusGraph(app,cx,flush);const tag=graphTarget(app,'tag','v1');assert.equal(tag.annotated,true);app.graphReferenceMenu(tag,cx);graphMenuPick(app,cx,'View tag details');assert.equal(app.opening,'Reading tag details');await flush();assert.match(app.customOutput.text,/release body/);app.customOutput=null;
  app.graphPushReference(tag,cx);graphMenuPick(app,cx,'team/origin');await flush();assert.equal(app.note,null);assert.equal(git(['--git-dir',first,'cat-file','-t','refs/tags/v1']).trim(),'tag');git(['push','-q','archive','refs/tags/v1']);await refresh();
  app.graphDeleteReference(tag,cx);graphMenuPick(app,cx,'Local and team/origin');graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['tag','--list','v1']).trim(),'');assert.equal(git(['--git-dir',first,'tag','--list','v1']).trim(),'');assert.equal(git(['--git-dir',second,'cat-file','-t','refs/tags/v1']).trim(),'tag');
}));

test('graph push can leave upstream unset, refuses a stale lease and confirms an explicit force',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h,remote=graphLocalRemote(h);put('f','base\n');git(['add','f']);git(['commit','-qm','base']);git(['switch','-qc','topic/x']);await refresh();await focusGraph(app,cx,flush);
  const push=mode=>{app.graphPushReference(graphTarget(app,'local','topic/x'),cx);graphMenuPick(app,cx,'team/origin');graphMenuPick(app,cx,'Set upstream');graphMenuPick(app,cx,'Continue');graphMenuPick(app,cx,mode);};
  push('Normal');await flush();assert.equal(app.note,null);assert.doesNotMatch(git(['config','--list']),/^branch\./m);
  const previous=git(['rev-parse','HEAD']).trim(),tree=git(['rev-parse','HEAD^{tree}']).trim();
  const outside=git(['--git-dir',remote,'-c','user.name=Remote','-c','user.email=remote@example.invalid','commit-tree',tree,'-p',previous,'-m','Remote work']).trim();git(['--git-dir',remote,'update-ref','refs/heads/topic/x',outside]);
  put('f','local\n');git(['commit','-qam','Local work']);const local=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);
  push('Force with lease');await flush();assert.match(app.note,/stale info|rejected/);assert.equal(git(['--git-dir',remote,'rev-parse','refs/heads/topic/x']).trim(),outside);
  await focusGraph(app,cx,flush);push('Force…');assert.equal(app.pending.title,'Force push');assert.equal(git(['--git-dir',remote,'rev-parse','refs/heads/topic/x']).trim(),outside);graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['--git-dir',remote,'rev-parse','refs/heads/topic/x']).trim(),local);
}));

test('graph fetch, pull and remote checkout preserve nested remote and branch names',()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;graphLocalRemote(h);put('f','base\n');git(['add','f']);git(['commit','-qm','base']);const base=git(['rev-parse','HEAD']).trim();git(['switch','-qc','topic/x']);put('next','next\n');git(['add','next']);git(['commit','-qm','next']);const tip=git(['rev-parse','HEAD']).trim();git(['push','-q','team/origin','topic/x']);git(['switch','-q','main']);git(['branch','-f','topic/x',base]);await refresh();await focusGraph(app,cx,flush);let target=graphTarget(app,'remote','team/origin/topic/x');
  app.graphReferenceMenu(target,cx);graphMenuPick(app,cx,'Fetch into local branch…');assert.equal(app.menu.items[0].label,'☐ Force fetch');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','topic/x']).trim(),tip);assert.equal(git(['rev-parse','HEAD']).trim(),base);
  git(['switch','-q','topic/x']);git(['commit','--allow-empty','-qm','Local only']);const local=git(['rev-parse','HEAD']).trim();git(['switch','-q','main']);await refresh();await focusGraph(app,cx,flush);
  app.graphReferenceMenu(target,cx);graphMenuPick(app,cx,'Fetch into local branch…');graphMenuPick(app,cx,'Continue');await flush();assert.match(app.note,/non-fast-forward|rejected/);assert.equal(git(['rev-parse','topic/x']).trim(),local);
  app.graphReferenceMenu(target,cx);graphMenuPick(app,cx,'Fetch into local branch…');graphMenuPick(app,cx,'Force fetch');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','topic/x']).trim(),tip);
  app.graphPullReference(target,cx);await flush();graphMenuPick(app,cx,'No fast-forward');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD^1']).trim(),base);assert.equal(git(['rev-parse','HEAD^2']).trim(),tip);
  git(['branch','-D','topic/x']);await refresh();await focusGraph(app,cx,flush);target=graphTarget(app,'remote','team/origin/topic/x');app.checkoutGraphReference(target,cx);assert.equal(app.message,'topic/x');app.message='tracking/x';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'tracking/x');assert.equal(git(['config','branch.tracking/x.remote']).trim(),'team/origin');assert.equal(git(['rev-parse','HEAD']).trim(),tip);
}));

for(const setting of ['true','false','simple'])test(`graph remote checkout honors branch.autoSetupMerge=${setting}`,()=>harness(async h=>{
  const {git,put,app,cx,refresh,flush}=h;graphLocalRemote(h);put('f','base\n');git(['add','f']);git(['commit','-qm','Base']);const hash=git(['rev-parse','HEAD']).trim();git(['push','-q','team/origin','main:refs/heads/topic/x']);git(['config','branch.autoSetupMerge',setting]);await refresh();await focusGraph(app,cx,flush);
  app.checkoutGraphReference(graphTarget(app,'remote','team/origin/topic/x'),cx);assert.equal(app.prompt.title,'Local branch name');assert.equal(app.message,'topic/x');app.message='chosen-name';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'chosen-name');assert.equal(git(['rev-parse','HEAD']).trim(),hash);
  assert.equal(git(['for-each-ref','--format=%(upstream)','refs/heads/chosen-name']).trim(),setting==='true'?'refs/remotes/team/origin/topic/x':'');
}));

function graphMergeFixture({git,put}) {
  put('base','base\n');git(['add','base']);git(['commit','-qm','Base']);const base=git(['rev-parse','HEAD']).trim();git(['switch','-qc','topic']);put('topic-file','topic\n');git(['add','topic-file']);git(['commit','-qm','Topic']);const second=git(['rev-parse','HEAD']).trim();
  git(['switch','-q','main']);put('main-file','main\n');git(['add','main-file']);git(['commit','-qm','Main']);const first=git(['rev-parse','HEAD']).trim();git(['merge','--no-ff','--no-edit','topic']);return {base,first,second,merge:git(['rev-parse','HEAD']).trim()};
}

test('graph commit checkout captures the row and detaches even when branches share its hash',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','Base']);const base=git(['rev-parse','HEAD']).trim();git(['branch','topic']);put('f','next\n');git(['commit','-qam','Next']);const head=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);
  app.cursor=app.graphOrder.indexOf(base);app.graphKeys(cx).menu();assert.equal(app.menu.items.filter(item=>item.label.includes('Checkout')).length,1);assert.ok(!app.menu.items.some(item=>item.label==='Checkout branch / commit'));app.cursor=app.graphOrder.indexOf(head);
  graphMenuPick(app,cx,'Checkout commit…');assert.match(app.pending.text,/detached HEAD/);graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['branch','--show-current']).trim(),'');assert.equal(git(['rev-parse','HEAD']).trim(),base);assert.equal(git(['rev-parse','main']).trim(),head);assert.equal(git(['rev-parse','topic']).trim(),base);
}));

test('graph keyboard shortcuts reach Graph checkout, merge-parent options, reset and direct hash copy',()=>harness(async h=>{
  const {app,cx,refresh,flush,key,clipboard}=h,{merge}=graphMergeFixture(h);await refresh();await focusGraph(app,cx,flush);app.main=true;app.cursor=app.graphOrder.indexOf(merge);
  await key('space');assert.equal(app.pending.title,'Checkout commit');app.cancelConfirmation(cx);
  await key('c');assert.match(app.menu.title,/Cherry-pick/);assert.match(app.menu.items[0].label,/Parent hash: 1:/);await key('escape');
  await key('t');assert.match(app.menu.title,/Revert/);assert.match(app.menu.items[0].label,/Parent hash: 1:/);await key('escape');
  await key('r');assert.match(app.menu.title,/Reset/);assert.match(app.menu.items[0].label,/Reset mode: Mixed/);await key('escape');
  await key('y');assert.equal(clipboard.at(-1),merge);assert.equal(app.menu,null);
  await key('b');assert.match(app.prompt.title,/New branch at/);app.cancelPrompt(cx);
}));

test('graph merge cherry-pick selects the second parent and records its origin',()=>harness(async h=>{
  const {git,app,cx,refresh,flush}=h,{second,merge}=graphMergeFixture(h);git(['switch','-qc','replay',second]);await refresh();await focusGraph(app,cx,flush);
  app.graphCherryPick(graphCommitTarget(app,merge),cx);assert.equal(app.busy,'Reading cherry-pick options');await flush();assert.match(app.menu.items[0].label,/Parent hash: 1:/);graphPickOption(app,cx,'Parent hash','2:');graphMenuPick(app,cx,'Record origin');graphMenuPick(app,cx,'Continue');await flush();
  assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD^']).trim(),second);assert.equal(git(['show','HEAD:main-file']),'main\n');assert.match(git(['log','-1','--format=%B']),new RegExp(`cherry picked from commit ${merge}`));assert.equal(git(['rev-list','--parents','-n','1','HEAD']).trim().split(' ').length,2);
}));

test('graph merge cherry-pick can leave first-parent changes staged without a commit',()=>harness(async h=>{
  const {git,app,cx,refresh,flush}=h,{first,merge}=graphMergeFixture(h);git(['switch','-qc','replay',first]);await refresh();await focusGraph(app,cx,flush);app.graphCherryPick(graphCommitTarget(app,merge),cx);await flush();graphMenuPick(app,cx,'No commit');graphMenuPick(app,cx,'Continue');await flush();
  assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),first);assert.equal(git(['diff','--cached','--name-only']).trim(),'topic-file');assert.equal(git(['show',':topic-file']),'topic\n');assert.equal(git(['diff','--name-only']).trim(),'');
}));

test('graph merge revert uses the selected parent and ordinary revert confirms separately',()=>harness(async h=>{
  const {git,app,cx,refresh,flush}=h,{second,merge}=graphMergeFixture(h);await refresh();await focusGraph(app,cx,flush);app.graphRevert(graphCommitTarget(app,merge),cx);await flush();graphPickOption(app,cx,'Parent hash','2:');graphMenuPick(app,cx,'Continue');await flush();
  assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD^{tree}']).trim(),git(['rev-parse',`${second}^{tree}`]).trim());const reverted=git(['rev-parse','HEAD']).trim();await focusGraph(app,cx,flush);app.graphRevert(graphCommitTarget(app,reverted),cx);await flush();assert.equal(app.pending.title,'Revert commit');graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD^{tree}']).trim(),git(['rev-parse',`${merge}^{tree}`]).trim());
}));

test('graph commit branch and tag creation keep the captured revision and default to no checkout and annotated tags',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','Base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','Next']);const head=git(['rev-parse','HEAD']).trim();await refresh();await focusGraph(app,cx,flush);const target=graphCommitTarget(app,base);
  app.graphCreateBranch(target,cx);app.message='new/topic';app.submit(cx);assert.equal(app.menu.items[0].label,'☐ Check out branch');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','new/topic']).trim(),base);assert.equal(git(['branch','--show-current']).trim(),'main');assert.equal(git(['rev-parse','HEAD']).trim(),head);
  app.graphCreateTag(target,cx);app.message='v1';app.submit(cx);assert.equal(app.menu.items[0].label,'Tag type: Annotated');graphMenuPick(app,cx,'Continue');assert.equal(app.prompt.title,'Tag message');app.message='Release body';app.submit(cx);await flush();assert.equal(app.note,null);assert.equal(git(['cat-file','-t','refs/tags/v1']).trim(),'tag');assert.equal(git(['rev-parse','v1^{commit}']).trim(),base);assert.match(git(['cat-file','tag','v1']),/Release body/);
  app.graphCreateTag(target,cx);app.message='light';app.submit(cx);graphPickOption(app,cx,'Tag type','Lightweight');graphMenuPick(app,cx,'Continue');await flush();assert.equal(app.note,null);assert.equal(git(['cat-file','-t','refs/tags/light']).trim(),'commit');assert.equal(git(['rev-parse','light']).trim(),base);
}));

test('graph commit options refuse a changed current branch before cherry-pick, revert or reset',()=>harness(async h=>{
  const {git,app,cx,refresh,flush}=h,{merge}=graphMergeFixture(h);git(['branch','same-tip']);await refresh();await focusGraph(app,cx,flush);
  for(const action of ['graphCherryPick','graphRevert','graphReset']){
    app[action](graphCommitTarget(app,merge),cx);await flush();git(['switch','-q','same-tip']);graphMenuPick(app,cx,'Continue');if(action==='graphReset')graphConfirm(app,cx);await flush();assert.match(app.note,/HEAD or the current branch changed/);assert.equal(git(['rev-parse','HEAD']).trim(),merge);assert.equal(git(['status','--porcelain']).trim(),'');git(['switch','-q','main']);await refresh();await focusGraph(app,cx,flush);
  }
}));

for(const mode of ['soft','mixed','hard'])test(`graph reset ${mode} preserves its expected index and worktree state`,()=>harness(async({git,put,app,cx,refresh,flush})=>{
  put('f','base\n');git(['add','f']);git(['commit','-qm','Base']);const base=git(['rev-parse','HEAD']).trim();put('f','next\n');git(['commit','-qam','Next']);await refresh();await focusGraph(app,cx,flush);app.graphReset(graphCommitTarget(app,base),cx);await flush();graphPickOption(app,cx,'Reset mode',mode[0].toUpperCase()+mode.slice(1));graphMenuPick(app,cx,'Continue');assert.equal(app.pending.title,`Reset (${mode})`);graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['rev-parse','HEAD']).trim(),base);assert.equal(git(['show',':f']),mode==='soft'?'next\n':'base\n');assert.equal(git(['diff','--name-only']).trim(),mode==='mixed'?'f':'');
}));

test('graph drop preserves later linear commits and hides the action for roots',()=>harness(async({git,put,app,cx,refresh,flush})=>{
  for(const name of ['root','drop','keep']){put(name,`${name}\n`);git(['add',name]);git(['commit','-qm',name]);}const head=git(['rev-parse','HEAD']).trim(),drop=git(['rev-parse','HEAD^']).trim(),root=git(['rev-parse','HEAD^^']).trim();await refresh();await focusGraph(app,cx,flush);
  app.graphCommitMenu(graphCommitTarget(app,root),cx);assert.ok(!app.menu.items.some(item=>item.label==='Drop…'));app.menu=null;const target=graphCommitTarget(app,drop);app.graphCommitMenu(target,cx);graphMenuPick(app,cx,'Drop…');await flush();graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(git(['log','--format=%s']).trim(),'keep\nroot');assert.equal(git(['ls-tree','--name-only','HEAD']).trim(),'keep\nroot');assert.notEqual(git(['rev-parse','HEAD']).trim(),head);
}));

async function archiveFixture(h) {
  const {dir,git,put,app,cx,refresh,flush}=h;
  put('f','committed\n');put('omit','not exported\n');put('subst','$Format:%H$\n');put('.gitattributes','omit export-ignore\nsubst export-subst\n');put('.gitignore','ignored\n');
  git(['add','.']);git(['commit','-qm','Archive source']);const hash=git(['rev-parse','HEAD']).trim();
  git(['remote','add','team/origin','https://example.invalid/repo.git']);git(['update-ref','refs/remotes/team/origin/topic',hash]);git(['tag','-a','release','-m','Release']);
  const folder=join(dir,"exports ' café");fs.mkdirSync(folder);
  put('f','staged\n');git(['add','f']);put('f','working\n');put('untracked','untracked\n');put('ignored','ignored\n');
  await refresh();await focusGraph(app,cx,flush);return {folder,hash,target:graphTarget(app,'local','main')};
}
function archiveName(app,cx,name) {app.archiveNameInput.set_value(name);app.archiveNameInput.handlers.change({},cx);}
async function openArchive(h,target,folder,name='release.tar') {
  const {app,cx,flush}=h;app.openGraphArchive(target,cx,{folder});await flush();assert.equal(app.archive.error,null);archiveName(app,cx,name);
}
const archiveTemps=folder=>fs.readdirSync(folder).filter(name=>name.startsWith('.herdr-archive.'));

for(const format of ['tar','zip'])test(`graph archive ${format} exports committed bytes and attributes to a literal destination`,()=>harness(async h=>{
  const {dir,git,app,cx,flush}=h,{folder,hash,target}=await archiveFixture(h),name=`quote ' café \`id\` $(id).${format.toUpperCase()}`,path=join(folder,name);
  await openArchive(h,target,folder,name);app.saveArchive(cx);assert.equal(app.archive.preparing,true);await flush();assert.equal(app.note,null);assert.equal(app.archive,null);assert.ok(fs.existsSync(path));
  const read=file=>execFileSync(format==='tar'?'tar':'unzip',format==='tar'?['-xOf',path,file]:['-p',path,file],{encoding:'utf8'});
  const list=execFileSync(format==='tar'?'tar':'unzip',format==='tar'?['-tf',path]:['-Z1',path],{encoding:'utf8'}).trim().split('\n');
  assert.equal(read('f'),'committed\n');assert.equal(read('subst'),hash+'\n');for(const file of ['omit','untracked','ignored'])assert.ok(!list.includes(file));
  assert.equal(git(['show',':f']),'staged\n');assert.equal(fs.readFileSync(join(dir,'f'),'utf8'),'working\n');assert.equal(git(['rev-parse','HEAD']).trim(),hash);assert.deepEqual(archiveTemps(folder),[]);
}));

test('graph archive is available on local, remote and tag references and exports the selected remote or tag',()=>harness(async h=>{
  const {app,cx,flush}=h,{folder,target}=await archiveFixture(h);
  for(const [kind,name]of [['local','main'],['remote','team/origin/topic'],['tag','release']]){
    const reference=graphTarget(app,kind,name);app.graphReferenceMenu(reference,cx);assert.ok(app.menu.items.some(item=>item.label==='Create archive…'));graphMenuPick(app,cx,'Create archive…');await flush();assert.equal(app.archive.target.ref,reference.ref);
    app.loadArchiveFolder(folder,cx);await flush();archiveName(app,cx,kind);app.saveArchive(cx);await flush();assert.equal(app.note,null);assert.ok(fs.existsSync(join(folder,kind+'.tar')));
  }
  app.graphReferenceMenu({...target,kind:'stash',name:'stash@{0}',ref:'stash@{0}'},cx);assert.ok(!app.menu.items.some(item=>item.label==='Create archive…'));app.menu=null;
  app.graphCommitMenu(graphCommitTarget(app,target.hash),cx);assert.ok(!app.menu.items.some(item=>item.label==='Create archive…'));
}));

test('graph archive replacement preserves the draft on cancel and changes bytes only after confirmation',()=>harness(async h=>{
  const {app,cx,flush}=h,{folder,target}=await archiveFixture(h),path=join(folder,'release.zip');fs.writeFileSync(path,'existing bytes');
  await openArchive(h,target,folder,'release.zip');app.saveArchive(cx);await flush();assert.equal(app.pending.title,'Replace archive');assert.equal(fs.readFileSync(path,'utf8'),'existing bytes');
  app.cancelConfirmation(cx);await flush();assert.equal(app.archive.name,'release.zip');assert.equal(app.archive.folder,folder);assert.equal(app.archive.format,'zip');
  app.saveArchive(cx);await flush();graphConfirm(app,cx);await flush();assert.equal(app.note,null);assert.equal(execFileSync('unzip',['-p',path,'f'],{encoding:'utf8'}),'committed\n');assert.deepEqual(archiveTemps(folder),[]);
}));

test('graph archive refuses changed existing destinations and cleans its temporary file',()=>harness(async h=>{
  const {app,cx,flush}=h,{folder,target}=await archiveFixture(h),path=join(folder,'release.tar');fs.writeFileSync(path,'first');
  await openArchive(h,target,folder);app.saveArchive(cx);await flush();fs.writeFileSync(path,'concurrent');graphConfirm(app,cx);await flush();assert.match(app.note,/destination changed/);assert.equal(fs.readFileSync(path,'utf8'),'concurrent');assert.deepEqual(archiveTemps(folder),[]);
}));

test('graph archive refuses a destination appearing during export without overwriting it',()=>harness(async h=>{
  const {app,cx,flush,afterExec}=h,{folder,target}=await archiveFixture(h),path=join(folder,'release.tar');
  await openArchive(h,target,folder);afterExec((command,args)=>{if(command==='env'&&args.includes('archive'))fs.writeFileSync(path,'concurrent');});
  app.saveArchive(cx);await flush();assert.match(app.note,/destination now exists/);assert.equal(fs.readFileSync(path,'utf8'),'concurrent');assert.deepEqual(archiveTemps(folder),[]);
}));

test('graph archive validates extensions and directory destinations without losing the entered name',()=>harness(async h=>{
  const {app,cx,flush}=h,{folder,target}=await archiveFixture(h);await openArchive(h,target,folder,'release.tgz');app.saveArchive(cx);assert.match(app.archive.error,/file extension/);assert.equal(app.archive.name,'release.tgz');
  archiveName(app,cx,'directory.tar');fs.mkdirSync(join(folder,'directory.tar'));app.saveArchive(cx);await flush();assert.match(app.archive.error,/regular file destination/);assert.equal(app.archive.preparing,false);assert.equal(app.busy,undefined);
}));

for(const cancel of ['escape','close','edit','repository'])test(`graph archive discards destination preparation after ${cancel}`,()=>harness(async h=>{
  const {app,cx,flush,hold,key}=h,{folder,target}=await archiveFixture(h);await openArchive(h,target,folder);
  const job=app.archive,release=hold();app.saveArchive(cx);assert.equal(job.preparing,true);
  if(cancel==='escape')app.keys({key:'escape',modifiers:{}},cx);if(cancel==='close')app.close();if(cancel==='edit')archiveName(app,cx,'new-name.zip');if(cancel==='repository')app.repoKey='another-repository';
  release();await flush();assert.equal(app.pending,null);assert.equal(job.preparing,false);assert.equal(fs.existsSync(join(folder,'release.tar')),false);
  if(cancel==='edit'){assert.equal(app.archive.name,'new-name.zip');app.saveArchive(cx);await flush();assert.ok(fs.existsSync(join(folder,'new-name.zip')));}else assert.equal(app.archive,null);
}));

test('graph archive folder reads show loading, keep the newest navigation and drop results after close',()=>harness(async h=>{
  const {dir,app,cx,flush,hold}=h,{folder,target}=await archiveFixture(h);const release=hold();app.openGraphArchive(target,cx);const job=app.archive;assert.equal(job.loading,true);app.loadArchiveFolder(folder,cx);release();await flush();assert.equal(job.folder,folder);assert.equal(job.loading,false);
  const releaseAgain=hold();app.loadArchiveFolder(dir,cx);app.dismissArchive(cx);releaseAgain();await flush();assert.equal(app.archive,null);assert.equal(job.loading,false);
}));

test('graph archive rejects stale references before publishing an output file',()=>harness(async h=>{
  const {git,put,app,cx,flush}=h,{folder,target}=await archiveFixture(h);await openArchive(h,target,folder);put('new-commit','new');git(['add','new-commit']);git(['commit','-qm','Concurrent commit']);
  app.saveArchive(cx);await flush();assert.match(app.note,/main changed/);assert.equal(fs.existsSync(join(folder,'release.tar')),false);assert.deepEqual(archiveTemps(folder),[]);
}));

test('graph archive command failure retains an approved destination and clears busy state',()=>harness(async h=>{
  const {app,cx,flush,failOn}=h,{folder,target}=await archiveFixture(h),path=join(folder,'release.tar');fs.writeFileSync(path,'original');
  await openArchive(h,target,folder);app.saveArchive(cx);await flush();failOn((command,args)=>command==='env'&&args.includes('archive'));graphConfirm(app,cx);await flush();assert.match(app.note,/host went away/);assert.equal(fs.readFileSync(path,'utf8'),'original');assert.deepEqual(archiveTemps(folder),[]);assert.equal(app.busy,null);
}));
