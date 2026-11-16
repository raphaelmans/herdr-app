import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source=dirname(fileURLToPath(import.meta.url));
const available=!spawnSync('herdr-app',['--version'],{stdio:'ignore'}).error;
const seed = `
    this.root='/tmp/herdr-git-fixture'; this.repo='fixture'; this.hasHead=true; this.head='a'.repeat(40);
    this.branch={name:'feature/parity',upstream:'origin/main',ahead:2,behind:1};
    this.files=[{path:'src/example.txt',x:' ',y:'M',staged:false,unstaged:true,add:2,del:1}];
    this.branches=[{name:'main',when:'2 days ago'},{name:'feature/parity',current:true,when:'1 hour ago'}];
    this.commits=[{hash:this.head,subject:'A commit summary',who:'Test',when:'1 hour ago',unpushed:true}];
    this.stashes=[{hash:'b'.repeat(40),ref:'stash@{0}',subject:'On main: saved work',when:'1 day ago'}];
    this.remotes=[{name:'origin',url:'https://example.invalid/repo.git'}];
    this.remoteBranches=[{name:'origin/main',ref:'refs/remotes/origin/main',hash:this.head}];
    this.tags=[{name:'v1',ref:'refs/tags/v1',hash:this.head}];
    this.worktrees=[{path:'/tmp/checkout',name:'/tmp/checkout',branch:'other',hash:this.head}];
    this.submodules=[{path:'vendor/library',name:'library'}]; this.reflog=[{...this.commits[0],ref:'HEAD@{0}'}];
    this.tree=false; this.wide=false; this.layoutFiles(); this.size={width:1400,height:850};
    const raw='diff --git a/src/example.txt b/src/example.txt\\n--- a/src/example.txt\\n+++ b/src/example.txt\\n@@ -1,2 +1,3 @@\\n context\\n-old\\n+new\\n+added\\n';
    this.setFilePatch({patch:parsePatch(raw),file:this.files[0],side:'unstaged'});this.setLines(raw.trimEnd().split('\\n'));this.cursor=4;
`;
const scenarios={
  diff:'this.main=true;',
  menu:'this.panel="commits";this.menuItems("Commit actions",this.commitActions(this.commits[0],cx),cx);',
  commit:'this.ask2("commit","Commit summary",cx);this.message="Draft summary";this.input.set_value(this.message);',
  branches:'this.panel="branches";this.branchView="remote branches";',
  worktrees:'this.panel="branches";this.branchView="worktrees";',
  submodules:'this.panel="branches";this.branchView="submodules";',
  reflog:'this.panel="commits";this.commitView="reflog";this.panelSearchOpen=true;',
  rebase:'this.main=true;this.plan={entries:[{...this.commits[0],action:"pick"},{hash:"b".repeat(40),subject:"Fix something",action:"fixup"}],branch:"main"};',
  conflict:'this.main=true;this.operation="merge";this.files[0].conflict=true;this.conflicts=parseConflicts("<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> other\\n");',
  help:'this.help=true;',
  commit_files:'this.panel="commits";this.main=true;this.detail={title:"Changed files",items:[{status:"M",path:"src/example.txt"}],at:0,file:null};',
  custom_patch:'this.panel="commits";this.main=true;this.patch=null;this.detail={key:"fixture",title:"Commit",file:{path:"src/example.txt"},items:[],patchArgs:["show",this.head],ref:this.head};this.historyPatch={patch:parsePatch(raw),path:"src/example.txt",ref:this.head};this.customPatch={ref:this.head,parts:new Map([["src/example.txt",{path:"src/example.txt",patch:parsePatch(raw),rows:new Set([6])}]])};this.patchMenu(cx);',
};
for(const [name,state]of Object.entries(scenarios)) test(`native renderer: ${name}`,{skip:!available},()=>{
  const folder=mkdtempSync(join(tmpdir(),'herdr-render-'));
  try {
    for(const file of ['main.js','features.js','patch.js','graph.js','mermaid.js','pele.js'])copyFileSync(join(source,file),join(folder,file==='main.js'?'git.js':file));
    writeFileSync(join(folder,'mod.json'),'{"place":"none"}');
    writeFileSync(join(folder,'main.js'),`import Git from './git.js';\nimport {parsePatch,parseConflicts} from './patch.js';\nexport default class Fixture extends Git {\ninit(p,cx){super.init(p,cx);${seed}\n${state}\n}\n}`);
    const r=spawnSync('herdr-app',['check',folder],{encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
