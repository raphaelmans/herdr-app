import { exec } from "herdr";
import { div } from "gpui-kit";
import { h_flex, v_flex, Button } from "gpui-base";
import { GitTodo } from "./todo.js";
import { LAZYGIT_DEFAULTS, loadLazygitConfig } from "./configuration.js";

const clone = value => JSON.parse(JSON.stringify(value));
const finite = (value,fallback,min,max) => Number.isFinite(value)&&value>=min&&value<=max ? value : fallback;

export class GitConfiguration extends GitTodo {
  initConfiguration() {
    this.configuration=null; this.lazygitConfig=clone(LAZYGIT_DEFAULTS); this.configOpen=false;
    this.diffContext=3; this.ignoreWhitespace=false; this.renameThreshold=50; this.logOrder="topo-order";
    this.lastRefresh=this.lastExternalCheck=this.lastFetch=Date.now(); this.externalCheck=null;
  }
  async refreshConfiguration(context) {
    const previous=this.configuration, key=this.repoKey;
    const next=await loadLazygitConfig(context,{exec},previous);
    if(this.closed||this.repoKey!==key||this.root!==context.cwd||this.on!==context.on)return false;
    this.configuration=next;
    if(previous?.fingerprint===next.fingerprint&&previous?.config===next.config)return false;
    const cfg=next.config, old=previous?.config;
    this.lazygitConfig=cfg;
    if(!old||cfg.gui.showFileTree!==old.gui.showFileTree)this.tree=cfg.gui.showFileTree;
    if(!old||cfg.gui.fileTreeSortOrder!==old.gui.fileTreeSortOrder)this.fileSortOrder=cfg.gui.fileTreeSortOrder;
    if(!old||cfg.gui.fileTreeSortCaseSensitive!==old.gui.fileTreeSortCaseSensitive)this.fileSortCaseSensitive=cfg.gui.fileTreeSortCaseSensitive;
    if(!old||cfg.git.localBranchSortOrder!==old.git.localBranchSortOrder)this.branchSort=cfg.git.localBranchSortOrder;
    if(!old||cfg.git.remoteBranchSortOrder!==old.git.remoteBranchSortOrder)this.remoteSort=cfg.git.remoteBranchSortOrder;
    if(!old||cfg.git.diffContextSize!==old.git.diffContextSize)this.diffContext=finite(cfg.git.diffContextSize,3,0,10000);
    if(!old||cfg.git.renameSimilarityThreshold!==old.git.renameSimilarityThreshold)this.renameThreshold=finite(cfg.git.renameSimilarityThreshold,50,0,100);
    if(!old||cfg.git.ignoreWhitespaceInDiffView!==old.git.ignoreWhitespaceInDiffView)this.ignoreWhitespace=cfg.git.ignoreWhitespaceInDiffView;
    if(!old||cfg.git.log.order!==old.git.log.order)this.logOrder=cfg.git.log.order;
    this.stale=true; return true;
  }
  configValue(path,fallback) { return path.split(".").reduce((v,key)=>v?.[key],this.lazygitConfig) ?? fallback; }
  historyOrder() { return ["date-order","author-date-order","topo-order"].includes(this.logOrder)?[`--${this.logOrder}`]:[]; }
  diffOptions() { return [`--unified=${this.diffContext??3}`,...(this.ignoreWhitespace?["--ignore-all-space"]:[])]; }
  diffStyleKey() { return `${this.diffContext}:${this.ignoreWhitespace}`; }
  withDiffOptions(args) {
    return args[0]==="diff"||args[0]==="show" ? [args[0],...this.diffOptions(),...args.slice(1)]
      : args[0]==="stash"&&args[1]==="show" ? [...args.slice(0,2),...this.diffOptions(),...args.slice(2)] : args;
  }
  fetchArgs() { return ["fetch",...(this.configValue("git.fetchAll",true)?["--all"]:[]),"--prune"]; }
  fetch(cx) { this.perform("Fetch",[this.fetchArgs()],cx,{network:true,done:"Fetched"}); }
  configurationView(c) {
    const state=this.configuration, diagnostics=state?.diagnostics??[];
    return v_flex().size_full().p(16).gap(10).overflow_y_scroll()
      .child(div().text_size(15).font_semibold().child("Lazygit configuration"))
      .child(div().text_size(12).text_color(c.muted).child(state?.stale?"Using the last valid settings. Edit the file to fix the error, then reload.":"Settings are read from the repository’s machine. Later files override earlier files. Edit a configuration file to change its settings."))
      .children((state?.files??[]).filter(file=>file.exists!==false).map(file=>div().font_family(c.mono).text_size(12).child(file.path)))
      .when(!(state?.files??[]).some(file=>file.exists!==false),e=>e.child(div().text_size(12).text_color(c.muted).child("Using Lazygit defaults; no configuration files found.")))
      .children(diagnostics.map(d=>div().text_size(12).text_color(d.severity==="error"?c.red:c.yellow).child(`${d.source??""}${d.line?`:${d.line}`:""}${d.source?": ":""}${d.message}`)))
      .child(h_flex().child(Button.new("edit-git-configuration").h(28).px(10).rounded(7).text_size(12).bg(c.raised)
        .text_color(this.busy?c.dim:c.foreground).disabled(Boolean(this.busy)).child("Edit configuration file").on_click((_e,cx)=>this.editConfiguration(cx))))
      .child(div().text_size(11).text_color(c.dim).child("e edit · R reload · Esc back"));
  }
  configurationKeys(e,cx) {
    if(this.configOpen&&!this.menu){if(e.key==="escape")this.configOpen=false;else if((e.key_char??e.key)==="R")this.refresh(cx,true);else if((e.key_char??e.key)==="e")this.editConfiguration(cx);cx.notify();return true;}
    const k=e.key,ch=e.key_char??k,m=e.modifiers??{};
    if((m.control&&k==="w")||["{","}","(",")"].includes(ch)){
      if(m.control&&k==="w")this.ignoreWhitespace=!this.ignoreWhitespace;
      else if(ch==="{"||ch==="}")this.diffContext=Math.max(0,Math.min(10000,this.diffContext+(ch==="}"?1:-1)));
      else {this.renameThreshold=Math.max(0,Math.min(100,this.renameThreshold+(ch===")"?5:-5)));this.refresh(cx,true);}
      this.reload(cx);return true;
    }
    if(m.control&&k==="l"&&!this.main&&!this.context()&&this.panel==="commits"){
      this.menuItems("Commit log",[
        ...["topo-order","date-order","author-date-order","default"].map((order,i)=>[`${this.logOrder===order?"●":"○"} ${order}`,String(i+1),cx=>{this.logOrder=order;this.refresh(cx,true);}]),
        [`${this.configValue("git.log.showWholeGraph",false)?"●":"○"} All branches`,"a",cx=>{this.lazygitConfig.git.log.showWholeGraph=!this.lazygitConfig.git.log.showWholeGraph;this.refresh(cx,true);}],
      ],cx);return true;
    }
    return false;
  }
  tickRefresh(cx) {
    if(this.closed||!this.root||this.busy||this.loading)return;
    const now=Date.now(),interval=(key,fallback)=>{
      const value=this.configValue(`refresher.${key}`,fallback);
      // Upstream disables the corresponding background job for <=0. Positive
      // intervals are not capped to a day, and missing values keep defaults.
      return Number.isFinite(value)?value>0?value*1000:null:fallback*1000;
    };
    const fetchInterval=interval("fetchInterval",60),refreshInterval=interval("refreshInterval",10),externalInterval=interval("externalChangeCheckInterval",2);
    if(fetchInterval!==null&&this.configValue("git.autoFetch",true)&&this.remotes.length&&now-this.lastFetch>=fetchInterval){
      this.lastFetch=now;this.fetch(cx);return;
    }
    if(refreshInterval!==null&&this.configValue("git.autoRefresh",true)&&now-this.lastRefresh>=refreshInterval){
      this.lastRefresh=now;this.refresh(cx);return;
    }
    if(externalInterval!==null&&this.configValue("git.autoDetectExternalChanges",true)&&!this.externalCheck&&now-this.lastExternalCheck>=externalInterval){
      this.lastExternalCheck=now;const key=this.repoKey,token=this.externalCheck={};
      cx.spawn(async cx=>{
        try{const mark=await this.mark();if(!this.closed&&this.repoKey===key&&this.lastRefMark&&mark.refs!==this.lastRefMark)this.refresh(cx);}
        catch{} finally{if(this.externalCheck===token)this.externalCheck=null;}
      });
    }
  }
}
