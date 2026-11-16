import { GitGraphWorktreeActions } from "./graph-worktree-actions.js";
import { parseStatus } from "./status.js";
import { graphComparison, clickGraphCommit, graphDiffArgs, parseGraphFiles, parseGraphCommit } from "./graph-details.js";
import { GraphLabels, GraphDetails } from "./graph-view.js";
import { refsOf } from "./graph.js";

const checked=result=>{if(result.code)throw new Error((result.stderr||result.stdout).trim());if(result.truncated)throw new Error("Graph details exceed the output limit");return result.stdout;};
const FORMAT="%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%B";

export class GitGraph extends GitGraphWorktreeActions {
  initGraph(cx) {
    this.graphRootCx=cx;this.graphInspection=null;this.graphOrder=[];this.graphSourceKey=null;
    this.graphRowsByHash=new Map();this.graphFile=null;this.graphGeneration=0;
    this.graphFileTree=true;this.graphCollapsed=new Set();this.graphFileAt=0;this.graphLastFile=null;
    this.graphLabelViews=new Map();this.graphDetailsView=cx.new(GraphDetails,{owner:this});
    this.graphDetailsHeight=250;this.graphDivider=0.5;this.graphClick=null;
  }
  resetGraph() {
    this.graphInspection=null;this.graphFile=null;this.graphOrder=[];this.graphRowsByHash.clear();this.graphSourceKey=null;this.graphGeneration++;
    this.graphCollapsed.clear();this.graphFileAt=0;
    for(const entity of this.graphLabelViews.values())entity.release();this.graphLabelViews.clear();
    this.graphClick=null;
  }
  notifyGraph(cx) {cx.notify(this.graphDetailsView);cx.notify();}
  loadGraphPrefs() {
    const key=`herdr.git.graph:${JSON.stringify([this.on??null,this.root])}`;
    if(this.graphPrefsKey===key)return;this.graphPrefsKey=key;
    let saved={};try{saved=JSON.parse(localStorage.getItem(key)??"{}");}catch{}
    this.graphFileTree=typeof saved.fileTree==="boolean"?saved.fileTree:true;
    this.graphDivider=Number.isFinite(saved.divider)?Math.max(0.2,Math.min(0.8,saved.divider)):0.5;
  }
  saveGraphPrefs() {if(this.graphPrefsKey)try{localStorage.setItem(this.graphPrefsKey,JSON.stringify({fileTree:this.graphFileTree,divider:this.graphDivider}));}catch{}}
  syncGraphEntities(cx) {
    for(const [hash,entity]of this.graphLabelViews)if(!this.graphRowsByHash.get(hash)?.commit.refs.length){entity.release();this.graphLabelViews.delete(hash);}
    for(const [hash,row]of this.graphRowsByHash)if(row.commit.refs.length){
      const entity=this.graphLabelViews.get(hash);
      if(entity)cx.notify(entity);else this.graphLabelViews.set(hash,cx.new(GraphLabels,{owner:this,hash}));
    }
    this.notifyGraph(cx);
  }
  graphDisplayIndex(index) {const primary=this.graphInspection?this.graphOrder.indexOf(this.graphInspection.primary):-1;return index+(primary>=0&&index>primary?1:0);}
  graphClickRow(hash) {this.graphClick=this.graphRowsByHash.has(hash)?hash:null;}
  finishGraphClick(event,cx) {const hash=this.graphClick;this.graphClick=null;if(hash)this.inspectGraphCommit(hash,event.modifiers,cx);}
  syncGraph(cx,sourceKey) {
    this.loadGraphPrefs();
    for(const row of this.graph.rows)if(row.commit.rawRefs!==undefined)row.commit.refs=refsOf(row.commit.rawRefs,this.remotes.map(remote=>remote.name));
    this.graphOrder=this.graph.rows.map(row=>row.commit.hash);
    this.graphRowsByHash=new Map(this.graph.rows.map(row=>[row.commit.hash,row]));
    if(this.graphSourceKey!==sourceKey){this.graphInspection=null;this.graphFile=null;this.graphCollapsed.clear();}
    this.graphSourceKey=sourceKey;
    const selected=graphComparison(this.graphInspection,this.graphOrder);
    if(selected){
      const job=this.graphInspection,same=job.repo===this.repoKey&&job.source===sourceKey&&["primary","secondary","from","to"].every(key=>job[key]===selected[key]);
      // Commit trees are immutable. Polling may update labels without restarting
      // their details; a worktree comparison refreshes its data, not its selection.
      if(!same||(!job.loading&&(selected.primary==="*"||selected.secondary==="*")))this.readGraphInspection(selected,cx,true);
    }
    else this.graphInspection=null;
    this.syncGraphEntities?.(cx);
  }
  inspectGraphCommit(hash,modifiers,cx) {
    if(this.busy||this.settling||!this.graphRowsByHash.has(hash))return;
    const selected=clickGraphCommit(this.graphInspection,hash,modifiers,this.graphOrder);
    this.cursor=this.graphOrder.indexOf(hash);this.main=true;this.handle.focus();this.menu=null;this.graphFile=null;
    if(!selected)return this.closeGraphInspection(cx);
    this.graphCollapsed.clear();this.graphFileAt=0;this.graphLastFile=null;
    this.readGraphInspection(selected,cx);
    this.graphScroll.scroll_to_item(this.graphDisplayIndex(this.graphOrder.indexOf(selected.primary)),"center");
  }
  closeGraphInspection(cx) {
    this.graphInspection=null;this.graphFile=null;this.graphGeneration++;this.menu=null;
    this.notifyGraph?.(cx);cx.notify();
  }
  graphReadCurrent(job) {
    return !this.closed&&this.graphInspection===job&&this.repoKey===job.repo&&this.root===job.context.cwd&&this.on===job.context.on&&this.graphSourceKey===job.source&&(this.source()?.key===job.source||this.graphFile?.inspection===job);
  }
  async readGraphFiles(from,to,context) {
    const [names,stats]=await Promise.all([this.boundedGit(graphDiffArgs(from,to),2_000_000,context),this.boundedGit(graphDiffArgs(from,to,true),2_000_000,context)]);
    return parseGraphFiles(checked(names),checked(stats));
  }
  async graphEmptyTree(context) {return checked(await this.boundedGit(["hash-object","-t","tree","--stdin"],262144,context)).trim();}
  async readGraphDetails(job) {
    const {primary,secondary,context}=job;
    let from=job.from,to=job.to,commit=null,untrackedParent=null;
    if(!secondary){
      if(primary==="*")from="HEAD";
      else {
        commit=parseGraphCommit(checked(await this.boundedGit(["-c","log.showSignature=false","show","--quiet",`--format=${FORMAT}`,primary,"--"],1_000_000,context)));
        from=commit.parents[0]??await this.graphEmptyTree(context);to=primary;
        if(job.stash&&commit.parents.length===3)untrackedParent=commit.parents[2];
      }
    }
    const files=await this.readGraphFiles(from,to,context);
    if(to==="*"){
      const status=parseStatus(checked(await this.boundedGit(["status","--porcelain=v1","-z","--untracked-files=all"],2_000_000,context)),{},{},50000);
      if(status.limited)throw new Error("Uncommitted changes exceed the file limit");
      const known=new Map(files.map(file=>[file.newFilePath,file]));
      for(const file of status.files){
        if(known.has(file.path)){if(file.x==="D"||file.y==="D")known.get(file.path).type="D";continue;}
        if(file.x==="D"||file.y==="D"||file.fresh)files.push({type:file.fresh?"U":"D",oldFilePath:file.path,newFilePath:file.path,additions:null,deletions:null});
      }
    }else if(untrackedParent){
      const extra=await this.readGraphFiles(await this.graphEmptyTree(context),untrackedParent,context);
      files.push(...extra.filter(file=>file.type==="A").map(file=>({...file,type:"U",untrackedParent})));
    }
    return {commit,files,from,to,untrackedParent};
  }
  readGraphInspection(selected,cx,refresh=false) {
    const prior=this.graphInspection,job=this.graphInspection={...selected,generation:++this.graphGeneration,
      repo:this.repoKey,source:this.graphSourceKey,context:{cwd:this.root,on:this.on},stash:Boolean(this.graphRowsByHash.get(selected.primary)?.commit.stash),
      loading:true,label:selected.secondary?"Reading commit comparison":selected.primary==="*"?"Reading uncommitted changes":"Reading commit details",
      data:refresh&&prior?.primary===selected.primary&&prior?.secondary===selected.secondary?prior.data:null};
    this.notifyGraph?.(cx);cx.notify();
    cx.spawn(async cx=>{
      try {
        const data=await this.readGraphDetails(job);if(!this.graphReadCurrent(job))return;
        job.data=data;job.loading=false;this.graphFileAt=Math.max(0,Math.min(this.graphFileAt,data.files.length-1));
      }catch(e){
        if(!this.graphReadCurrent(job))return;
        this.note=`Cannot read graph details: ${e.message??e}`;
        if(job.secondary)this.readGraphInspection(graphComparison({primary:job.primary},this.graphOrder),cx);
        else this.graphInspection=null;
      }
      if(!this.closed){this.notifyGraph?.(cx);cx.notify();}
    });
  }
  graphFileSource() {
    const preview=this.graphFile;if(!preview)return null;
    if(this.panel!==preview.panel||this.viewKey()!==preview.view||this.sel[this.panel]!==preview.selected)return null;
    return {key:preview.key,title:preview.file.newFilePath,graphFile:true,custom:true,ref:preview.to,path:preview.file.newFilePath,canRebase:false,args:preview.args,allowDifferences:preview.to==="*"&&preview.file.type==="U"};
  }
  openGraphFile(file,cx) {
    const job=this.graphInspection;if(!job?.data||job.loading||!this.graphReadCurrent(job))return;
    const {from,to}=job.data,options=["--no-ext-diff","--no-textconv","--no-color","--find-renames","--src-prefix=a/","--dst-prefix=b/"];
    const args=file.untrackedParent?["show","--format=",...options,file.untrackedParent,"--",file.newFilePath]
      :to==="*"&&file.type==="U"?["diff","--no-index",...options,"--","/dev/null",file.newFilePath]
      :["diff",...options,from,...(to==="*"?[]:[to]),"--",...new Set([file.oldFilePath,file.newFilePath])];
    this.graphAt=this.graphOrder.indexOf(job.primary);this.graphLastFile=file.newFilePath;
    this.graphFile={key:`graph-file:${job.generation}:${file.newFilePath}`,inspection:job,panel:this.panel,view:this.viewKey(),selected:this.sel[this.panel],file,from,to,args};
    this.main=true;this.handle.focus();this.reload(cx);
  }
  closeGraphFile(cx) {this.graphFile=null;this.historyPatch=null;this.reload(cx);}
}
