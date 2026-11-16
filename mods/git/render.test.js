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
  remotes:'this.panel="branches";this.branchView="remotes";',
  branches:'this.panel="branches";this.branchView="remotes";this.remoteContext={name:"origin"};',
  empty_remote:'this.panel="branches";this.branchView="remotes";this.remoteContext={name:"origin"};this.remoteBranches=[];',
  worktrees:'this.panel="files";this.fileView="worktrees";',
  submodules:'this.panel="files";this.fileView="submodules";',
  reflog:'this.panel="commits";this.commitView="reflog";this.panelSearchOpen=true;',
  rebase:'this.main=true;this.plan={entries:[{...this.commits[0],action:"pick"},{hash:"b".repeat(40),subject:"Fix something",action:"fixup"}],branch:"main"};',
  conflict:'this.main=true;this.operation="merge";this.files[0].conflict=true;this.conflicts=parseConflicts("<<<<<<< HEAD\\nours\\n=======\\ntheirs\\n>>>>>>> other\\n");',
  help:'this.help=true;',
  commit_files:'this.panel="commits";this.contexts.commits=[{type:"files",key:"fixture",title:"Changed files",items:[{status:"M",path:"src/example.txt"},{status:"A",path:"src/deep/other.txt"},{status:"D",path:"README.md"}],patchArgs:["show",this.head],ref:this.head}];this.syncContext();',
  commit_files_folded:'this.panel="commits";this.contexts.commits=[{type:"files",key:"fixture",title:"Changed files",items:[{status:"M",path:"src/example.txt"},{status:"A",path:"src/deep/other.txt"}],patchArgs:["show",this.head],ref:this.head,collapsed:new Set(["src"])}];this.syncContext();',
  subcommits:'this.panel="branches";this.contexts.branches=[{type:"commits",key:"fixture",title:"feature/parity",items:this.commits,more:true}];',
  reading_subcommits:'this.panel="branches";this.contexts.branches=[{type:"commits",key:"fixture",title:"feature/parity",items:[],loading:true}];',
  reading_commit_files:'this.panel="stash";this.contexts.stash=[{type:"files",key:"fixture",title:"Saved work",items:[],loading:true}];this.syncContext();',
  wide_graph:'this.panel="status";this.main=true;this.graph={lanes:24,rows:[],more:true};',
  graph_details_loading:'this.graphInspection={primary:this.head,repo:"fixture",loading:true,label:"Reading commit details"};this.fixtureGraphView=Object.create(GraphDetails.prototype);this.fixtureGraphView.init({owner:this},cx);',
  graph_details:'this.graphInspection={primary:this.head,repo:"fixture",loading:false,data:{commit:{hash:this.head,parents:[],author:"Test",authorEmail:"test@example.invalid",authorTime:100,committer:"Test",committerEmail:"test@example.invalid",commitTime:100,body:"Subject\\n\\nFull message"},files:[{type:"M",oldFilePath:"src/file.txt",newFilePath:"src/file.txt",additions:2,deletions:1}]}};this.fixtureGraphView=Object.create(GraphDetails.prototype);this.fixtureGraphView.init({owner:this},cx);',
  graph_comparison:'this.graphInspection={primary:this.head,secondary:"b".repeat(40),from:"b".repeat(40),to:this.head,repo:"fixture",loading:false,data:{commit:null,files:[]}};this.fixtureGraphView=Object.create(GraphDetails.prototype);this.fixtureGraphView.init({owner:this},cx);',
  graph_badges:'this.graphRowsByHash.set(this.head,{color:0,commit:{hash:this.head,refs:[{kind:"head",name:"main",current:true,remotes:["origin"]},{kind:"tag",name:"v1",remotes:[]}]}});this.fixtureGraphView=Object.create(GraphLabels.prototype);this.fixtureGraphView.init({owner:this,hash:this.head},cx);',
  graph_commit_menu:'this.graphCommitMenu(this.graphCommitTarget({...this.commits[0],parents:["b".repeat(40)]}),cx);',
  graph_worktree_menu:'this.graphWorktreeMenu(cx);',
  archive:'this.openGraphArchive({kind:"local",name:"feature/parity",ref:"refs/heads/feature/parity",hash:this.head,repo:this.repoKey,root:this.root,on:this.on},cx);this.archive.items=[{name:"folder",directory:true},{name:"release.zip",directory:false}];this.archive.name="release.zip";this.archiveNameInput.set_value("release.zip");',
  archive_loading:'this.openGraphArchive({kind:"tag",name:"v1",ref:"refs/tags/v1",hash:this.head,repo:this.repoKey,root:this.root,on:this.on},cx);this.archive.loading=true;',
  archive_preparing:'this.openGraphArchive({kind:"local",name:"feature/parity",ref:"refs/heads/feature/parity",hash:this.head,repo:this.repoKey,root:this.root,on:this.on},cx);this.archive.name="release.tar";this.archive.preparing=true;',
  archive_error:'this.openGraphArchive({kind:"local",name:"feature/parity",ref:"refs/heads/feature/parity",hash:this.head,repo:this.repoKey,root:this.root,on:this.on},cx);this.archive.error="The archive file must have a *.tar or *.zip extension.";',
  graph_parent_options:'this.graphOptions("Cherry-pick",[this.graphParentChoice({parents:[this.head,"b".repeat(40)]}),{label:"Record origin",value:false},{label:"No commit",value:false}],()=>{},cx);',
  menu_filter:'this.menuItems("Filter",[["Disabled","d",()=>{},false,null,"Not available"]],cx);this.menu.searchOpen=true;',
  file_filter:'this.fileStatus="staged";this.layoutFiles();',
  file_range:'this.panel="files";this.rangeAnchors.files=0;this.rangeModes.files="sticky";',
  branch_range:'this.panel="branches";this.sel.branches=1;this.rangeAnchors.local=0;this.rangeModes.local="sticky";this.menuItems("Branch actions",this.branchActions(cx),cx);',
  tag_delete:'this.panel="branches";this.branchView="tags";this.tagSelectionMenu(cx);',
  reference_loading:'this.panel="branches";this.busy="Reading branch deletion options";this.opening=this.busy;',
  reference_refresh:'this.panel="stash";this.rangeAnchors.stash=0;this.rangeModes.stash="sticky";this.settling="Drop stashes";',
  combined_commits:'this.panel="commits";this.commits.push({hash:"b".repeat(40),subject:"Earlier commit",who:"Test",when:"2 hours ago"});this.sel.commits=1;this.rangeAnchors.commits=0;this.rangeModes.commits="sticky";this.reading=1;this.wait={key:this.source().key,shown:true};',
  file_discard:'this.panel="files";this.discardFilesMenu(cx);',
  file_copy:'this.panel="files";this.copyFileMenu(cx);',
  updating_patch:'this.panel="commits";this.busy="Updating patch";this.opening=this.busy;',
  first_read:'this.loaded=false;this.loading=true;this.run={shown:true};this.branch=null;this.files=[];this.layoutFiles();this.branches=[];this.commits=[];this.stashes=[];this.patch=null;this.setLines([]);',
  updating:'this.loaded=true;this.loading=true;this.run={shown:true};this.paging=true;this.panel="commits";this.error="Could not read the repository";',
  reading_main:'this.reading=1;this.shown="other";this.wait={key:this.source().key,shown:true};',
  reading_blank:'this.reading=1;this.shown=null;this.patch=null;this.setLines([]);this.wait={key:this.source().key,shown:true};',
  opening:'this.busy="Read changed files";this.opening=this.busy;',
  busy:'this.busy="Fetch";',
  settling:'this.settling="Stage";this.main=true;',
  launching:'this.launching="Opening Lazygit";',
  writing:'this.ask2("commit","Commit summary",cx);this.writing=this.prompt;',
  custom_patch:'this.panel="commits";this.main=true;this.patch=null;this.detail={key:"fixture",title:"Commit",file:{path:"src/example.txt"},items:[],patchArgs:["show",this.head],ref:this.head};this.historyPatch={patch:parsePatch(raw),path:"src/example.txt",ref:this.head,canRebase:true};this.customPatch={ref:this.head,canRebase:true,parts:new Map([["src/example.txt",{path:"src/example.txt",patch:parsePatch(raw),rows:new Set([6])}]])};this.patchMenu(cx);',
  configured_prompt:'this.promptValue("Choose author","Test",()=>{},cx,{empty:true,raw:true,suggestions:["Test <test@example.invalid>","Other <other@example.invalid>"]});',
  configured_menu:'this.openMenu({title:"Configured command",items:[{label:"Create branch",hint:"from selected commit",keys:["ctrl-b"],run:()=>{}}]},cx);',
  command_popup:'this.customOutput={title:"Command output",text:"first line\\nsecond line",popup:true,running:false,scroll:this.planScroll,cursor:0};',
  command_log:'this.customOutput={title:"Build",text:"Building\\nWorking",popup:false,running:true,scroll:this.planScroll,cursor:0};this.main=true;this.busy="Build";',
  configuration_error:'this.configuration={files:[{path:"/tmp/config.yml"}],stale:true,diagnostics:[{source:"/tmp/config.yml",line:3,severity:"error",message:"Invalid keybinding"}]};this.configOpen=true;',
  pending_todo:'this.panel="commits";this.operation="rebase";this.pendingRebase={doc:{valid:true,rows:[{hash:this.head,subject:"Pending commit",action:"pick",editable:true,movable:true}]}};',
  reading_reflog:'this.busy="Reading reflog";this.opening=this.busy;',
  undo_confirmation:'this.ask("Undo","Soft reset to abc1234? The undone changes stay staged and working files are kept.",()=>{},cx);',
  recovery_autostash:'this.ask("Auto-stash","Auto-stash local changes, check out main, then reapply them? Conflicts keep the stash available.",()=>{},cx);',
  flow_menu:'this.panel="branches";this.menuItems("Git-flow",[["Finish branch feature/parity…","",()=>{}],["Start feature…","f",()=>{}],["Start hotfix…","h",()=>{}],["Start bugfix…","b",()=>{}],["Start release…","r",()=>{}]],cx);',
  flow_loading:'this.busy="Reading Git-flow configuration";this.opening=this.busy;',
  flow_running:'this.busy="Starting feature";this.gitTask={label:this.busy,terminal:"fixture-terminal",finished:false};',
  merge_menu:'this.menuItems("Merge topic into main",[["Regular merge (with merge commit)","m",()=>{}],["Regular merge (fast-forward)","f",()=>{},false,null,"Cannot fast-forward: the current branch is not an ancestor of the selected branch"],["Squash merge and leave uncommitted","s",()=>{}],["Squash merge and commit","S",()=>{}]],cx);',
  merge_loading:'this.busy="Reading merge options";this.opening=this.busy;',
  merge_editor:'this.busy="Continue merge";this.gitTask={kind:"merge",label:this.busy,terminal:"fixture-terminal",finished:false};',
  editor_reading:'this.busy="Preparing editor";this.opening=this.busy;',
  editor_running:'this.busy="Editing file";this.gitTask={kind:"editor",label:this.busy,terminal:"fixture-terminal",finished:false};',
  hunk_applying:'this.main=true;this.busy="Applying edited hunk";',
  editor_refresh:'this.busy="Refreshing repository";this.settling="Edit hunk";',
  configuration_files:'this.configuration={files:[{path:"/tmp/config.yml",exists:true},{path:"/tmp/missing.yml",exists:false}]};this.configOpen=true;this.editConfiguration=()=>{};',
  configuration_chooser:'this.openMenu({title:"Select configuration file",pathLabels:true,items:[{label:"/tmp/a long configuration directory/another long ancestor/repository/.git/config.yml",run:()=>{}},{label:"/tmp/a long configuration directory/another long ancestor/repository/.git/lazygit.yml",run:()=>{}}]},cx);',
  link_opening:'this.busy="Opening browser";',
  edited_line:'this.editedLine={index:5,lines:this.rawDiffLines};',
};
for(const [name,state]of Object.entries(scenarios)) test(`native renderer: ${name}`,{skip:!available},()=>{
  const folder=mkdtempSync(join(tmpdir(),'herdr-render-'));
  try {
    for(const file of ['main.js','features.js','graph-runtime.js','graph-actions.js','archive-runtime.js','archive-data.js','archive-view.js','graph-commit-actions.js','graph-worktree-actions.js','graph-details.js','graph-view.js','ref-actions.js','file-actions.js','selection.js','external.js','editor-config.js','editor-diff.js','editor-hunk.js','merge.js','merge-config.js','flow.js','flow-config.js','subprocess.js','subprocess-script.js','recovery.js','reflog.js','authors.js','command-runtime.js','command-data.js','command-hydration.js','templates.js','status.js','contexts.js','history.js','hosting.js','todo.js','rebase.js','configuration-runtime.js','configuration.js','config.js','keybindings.js','yaml.js','search.js','patch.js','file-tree.js','graph.js','mermaid.js','pele.js'])copyFileSync(join(source,file),join(folder,file==='main.js'?'git.js':file));
    writeFileSync(join(folder,'mod.json'),'{"place":"none"}');
    writeFileSync(join(folder,'main.js'),`import Git from './git.js';\nimport {div} from 'gpui-kit';\nimport {GraphDetails,GraphLabels} from './graph-view.js';\nimport {parsePatch,parseConflicts} from './patch.js';\nexport default class Fixture extends Git {\ninit(p,cx){super.init(p,cx);${seed}\n${state}\n}\nrender(cx){return this.fixtureGraphView?div().w(900).h(250).child(this.fixtureGraphView.render(cx)):super.render(cx);}\n}`);
    const r=spawnSync('herdr-app',['check',folder],{encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,`${r.stdout}\n${r.stderr}`);
  }finally{rmSync(folder,{recursive:true,force:true});}
});
