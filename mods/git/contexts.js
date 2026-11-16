import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { fileNodes, filesOf } from "./file-tree.js";

const LOG = "--format=%H%x1f%s%x1f%an%x1f%cr";
const check = (r) => { if (r.code) throw new Error((r.stderr || r.stdout).trim()); return r; };

// Lazygit pushes contexts inside the window that was entered. Each frame owns
// its selection, parent and pending read; switching panes never moves its list.
export class GitContexts extends View {
  context(panel = this.panel) { return this.contexts?.[panel]?.at(-1) ?? null; }
  contextItems(panel = this.panel) {
    const frame = this.context(panel);
    if (!frame) return null;
    if (frame.type !== "files") return frame.items;
    const term=this.filters[frame.key]??"", tree=this.commitFilesTree();
    frame.collapsed??=new Set();
    const memo=frame.rows;
    if(memo&&memo.items===frame.items&&memo.term===term&&memo.tree===tree&&memo.folds===frame.folds)return memo.out;
    const shown=this.filterItems(frame.items,term,f=>f.path);
    // Lazygit's CommitFiles is a tree like Files: a folder row stands for every
    // file under it. File rows keep the file's own fields, so patch, checkout
    // and copy code reads them as before.
    const out=!tree?shown:fileNodes(shown,{tree:true,collapsed:term.trim()?new Set():frame.collapsed,filter:term,fileSortOrder:this.fileSortOrder,fileSortCaseSensitive:this.fileSortCaseSensitive})
      .map(n=>n.dir?n:{...n.file,key:n.key,depth:n.depth,name:n.name});
    frame.rows={items:frame.items,term,tree,folds:frame.folds,out};
    return out;
  }
  commitFilesTree() { return this.commitFileTree ?? this.configValue("gui.showFileTree", true) !== false; }
  // The selected rows' files, a folder giving all of its own.
  selectedCommitFiles(all = false) { return filesOf(all ? this.contextItems() : this.selectedItems()); }
  foldCommitFiles(node, closed, cx) {
    const frame=this.context();if(frame?.type!=="files")return;
    if(this.filters[frame.key]?.trim())return this.say("Clear the filter to fold folders",cx);
    const key=this.commitFileKey();
    if(node){if(!node.dir)return;if(node.open)frame.collapsed.add(node.path);else frame.collapsed.delete(node.path);}
    else frame.collapsed=new Set(closed?fileNodes(frame.items,{tree:true,collapsed:new Set(),filter:""}).filter(n=>n.dir).map(n=>n.path):[]);
    frame.folds=(frame.folds??0)+1;this.reselectCommitFile(key,cx);
  }
  toggleCommitFilesTree(cx) {
    const key=this.commitFileKey();this.commitFileTree=!this.commitFilesTree();
    for(const stack of Object.values(this.contexts))for(const frame of stack)if(frame.type==="files")frame.rows=null;
    this.reselectCommitFile(key,cx);
  }
  commitFileKey(it=this.item()) { return it ? it.key ?? `f:${it.path}` : null; }
  // Folding or switching tree/flat keeps the same row selected, or its folder.
  reselectCommitFile(key,cx) {
    const rows=this.contextItems(),fileKey=key?.startsWith("d:")?null:key?.replace(/^f:/,"");
    let at=rows.findIndex(r=>r.key===key||fileKey!=null&&r.path===fileKey&&!r.dir);
    if(at<0&&fileKey!=null)at=rows.findIndex(r=>r.dir&&r.files.some(f=>f.path===fileKey));
    this.cancelRange();this.sel[this.panel]=Math.max(0,Math.min(at<0?this.sel[this.panel]:at,rows.length-1));
    this.syncContext();this.scroll[this.panel]?.scroll_to_item(this.sel[this.panel]);this.reload(cx);
  }
  syncContext() {
    const frame = this.context();
    this.detail = frame?.type === "files" ? frame : null;
    if (this.detail) this.detail.file = this.contextItems()[this.sel[this.panel]] ?? null;
  }
  pushContext(type, title, cx) {
    const panel = this.panel, stack = this.contexts[panel] ??= [];
    const frame = {type, title, key:`${panel}:${type}:${++this.contextSequence}`, items:[], parentSelection:this.sel[panel], parentMain:this.main, parentPeek:this.peek,
      parentSearch:this.panelSearchOpen, worktreeBranch:this.diffWorktreeBranch?.()??null, loading:true, error:null, at:0};
    stack.push(frame); this.sel[panel]=0; this.main=false; this.peek=null; this.panelSearchOpen=false; this.historyPatch=null;
    this.syncContext(); this.handle.focus(); cx.notify(); return frame;
  }
  popContext(cx, panel = this.panel) {
    const stack=this.contexts[panel], frame=stack?.pop(); if(!frame)return;
    this.panel=panel; this.sel[panel]=frame.parentSelection; this.main=frame.parentMain; this.peek=frame.parentPeek;
    this.panelSearchOpen=frame.parentSearch; this.historyPatch=null; this.syncContext();
    this.scroll[panel].scroll_to_item(this.sel[panel]); this.handle.focus(); this.reload(cx);
  }
  readContext(frame, work, cx) {
    const repo=this.repoKey, root=this.root;
    const current=()=>!this.closed&&this.repoKey===repo&&this.root===root&&Object.values(this.contexts).some((s)=>s.includes(frame));
    cx.spawn(async(cx)=>{
      try {const result=await work();if(current()){Object.assign(frame,result);for(const panel of Object.keys(this.contexts))if(this.context(panel)===frame)this.clampRange(panel);}}
      catch(e){if(current())frame.error=`Cannot read ${frame.type}: ${e.message??e}`;}
      finally {frame.loading=false;if(current()){this.syncContext();this.reload(cx);}cx.notify();}
    });
  }
  openSubCommits(item, cx) {
    if(!item)return;
    const ref=item.ref?.startsWith("refs/")?item.ref:item.hash??item.name;
    const frame=this.pushContext("commits",item.name??item.subject??ref,cx);
    frame.ref=ref; frame.limit=300;
    this.readContext(frame,()=>this.readSubCommits(frame),cx);
  }
  async readSubCommits(frame) {
    const r=check(await this.boundedGit(["log","--date-order","-n",String(frame.limit+1),LOG,frame.ref,"--"]));
    const records=r.stdout.split("\n").filter(Boolean);
    return {items:records.slice(0,frame.limit).map((l)=>{const[hash,subject,who,when]=l.split("\x1f");return {hash,subject,who,when};}),more:records.length>frame.limit,truncated:r.truncated};
  }
  extendContext(cx) {
    const frame=this.context();if(frame?.type!=="commits"||!frame.more||frame.loading)return;
    frame.limit+=100;frame.loading=true;cx.notify();this.readContext(frame,()=>this.readSubCommits(frame),cx);
  }
  selectedCommitRange(item=this.item()) {
    const frame=this.context();
    if(this.peek||!(frame?.type==="commits"||!frame&&this.panel==="commits"&&this.commitView==="commits")||item?.hash!==this.item()?.hash)return null;
    const selected=this.selectedItems();if(selected.length<2)return null;
    const from=selected.at(-1),to=selected[0];
    if(!from.hash||!to.hash||from.todo||to.todo||frame&&from.divergence!==to.divergence)return null;
    return {from:from.hash,to:to.hash,title:`${from.hash.slice(0,7)}-${to.hash.slice(0,7)}`};
  }
  async commitDiffBase(hash,context) {
    const parents=check(await this.boundedGit(["rev-list","--parents","-n","1",hash],262144,context));
    if(parents.truncated)throw new Error("Commit parents exceed the output limit");
    const parent=parents.stdout.trim().split(" ")[1];
    return parent??check(await this.boundedGit(["hash-object","-t","tree","--stdin"],262144,context)).stdout.trim();
  }
  contextSource() {
    const frame=this.context(), it=this.item();if(!frame)return null;
    if(!it)return {key:frame.key,title:frame.title,text:[frame.loading?"":frame.error??"No items"]};
    if(frame.type==="commits")return {key:`c:${it.hash}`,title:"Patch",subject:it.subject,hash:it.hash.slice(0,7),keep:it.hash,
      args:["show","--no-color","--no-ext-diff","--stat","--patch","--format=commit %H%nAuthor: %an <%ae>%nDate: %ad%n%n    %s%n%n%b",it.hash]};
    return null;
  }
  contextActions(cx) {
    const frame=this.context(), it=this.item();
    if(frame?.type==="commits")return this.commitActions(it,cx,false);
    if(frame?.type==="files")return [
      it&&["Toggle file in custom patch","space",cx=>this.toggleCommitFiles(cx)],
      it?.dir&&!this.multipleSelected()&&[it.open?"Collapse folder":"Expand folder","enter",cx=>this.foldCommitFiles(it,false,cx)],
      it&&["Toggle all files in custom patch","a",cx=>this.toggleCommitFiles(cx,true)],
      it&&["Discard file changes…","d",cx=>this.discardCommitFiles(cx),true,null,!frame.canRebase||this.operation?"Only a single local commit outside an active Git operation can be changed":null],
      it&&!(it.dir&&!this.multipleSelected())&&["Open diff","enter",(cx)=>this.openDetailFile(this.sel[this.panel],cx),false,null,this.multipleSelected()?"This action requires a single selected item":null],
      it&&frame.checkoutRef&&!it.dir&&["Checkout file…","c",cx=>this.checkoutCommitFile(frame,it,cx),false,null,this.multipleSelected()?"Range selection is not supported for checkout":null],
      it&&["Edit file","e",cx=>this.editSelectedFiles(cx)],
      it&&["Open file","o",cx=>this.openSelectedFile(cx)],
      it&&["Open diff tool","ctrl-t",cx=>this.openDiffTool(cx)],
      it&&["Copy to clipboard…","y",(cx)=>this.copyFileMenu(cx)],
      [this.commitFilesTree()?"Show flat list":"Show file tree","`",cx=>this.toggleCommitFilesTree(cx)],
      this.commitFilesTree()&&["Collapse all folders","-",cx=>this.foldCommitFiles(null,true,cx)],
      this.commitFilesTree()&&["Expand all folders","=",cx=>this.foldCommitFiles(null,false,cx)],
      ["Back","esc",(cx)=>this.popContext(cx)],
    ].filter(Boolean);
    return null;
  }
  checkoutCommitFile(frame,file,cx) {
    if(this.multipleSelected())return this.say("Range selection is not supported for checkout",cx);
    const ref=frame.untracked?.has(file.path)?`${frame.stashHash}^3`:frame.checkoutRef,path=file.path;
    if(!ref)return;
    this.ask("Checkout file",`Restore ${path} from ${ref.slice(0,12)} into the working tree and index?`,cx=>this.perform("Checkout file",async git=>{
      const status=await git(["--literal-pathspecs","status","--porcelain=v1","-z","--",path]);
      if(status.split("\0").some(row=>row&&row.slice(0,2)!=="??"))throw new Error("Commit or stash the existing changes to this file first");
      await git(["--literal-pathspecs","checkout",ref,"--",path]);
    },cx),cx);
  }
  activateItem(cx) {
    const frame=this.context();
    const actions=frame?this.contextActions(cx):this.panel==="branches"?this.branchActions(cx):this.panel==="commits"?this.commitActions(this.item(),cx):this.panel==="stash"?this.stashActions(cx):this.fileView!=="files"?this.repositoryActions(cx):[];
    const enter=actions.filter(Boolean).find(a=>a[1]==="enter");if(enter)enter[2](cx);
    else if(this.item()?.dir)this.fold(this.item(),cx);else if(this.item()?.file)this.focusDiff(cx);
  }
  contextBody(panel,c) {
    const frame=this.context(panel);if(!frame)return null;
    const items=this.contextItems(panel);
    return v_flex().size_full()
      .child(h_flex().h(28).flex_none().px(12).gap(8).items_center().border_b(1).border_color(c.border)
        .child(div().id(`back-${panel}`).flex_none().text_size(11).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>this.popContext(cx,panel)).child("← Back"))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(c.muted).child(frame.title)))
      .when(this.panel===panel&&this.panelSearchOpen,e=>e.child(this.filterBar(c)))
      .when(Boolean(frame.loading),e=>e.child(div().px(12).py(6).child(this.waiting(frame.type==="commits"?"Reading commits":"Reading changed files",c))))
      .child(div().flex_1().min_h(0).child(this.rowsIn(panel,items,(it)=>frame.type==="files"?[
        div().w(14).flex_none().text_color(c.accent).child(this.patchFileStatus(it,frame)==="whole"?"✓":this.patchFileStatus(it,frame)==="partial"?"–":""),
        ...(it.depth?[div().w(it.depth*14).flex_none()]:[]),
        it.dir?div().w(18).flex_none().text_color(c.muted).child(it.open?"▾":"▸"):div().w(18).flex_none().font_family(c.mono).text_color(it.status==="D"?c.red:c.green).child(it.status),
        div().flex_1().min_w(0).truncate().text_color(it.dir?c.muted:c.foreground).child(it.name??it.path),
      ]:[
        div().flex_none().font_family(c.mono).text_size(11).text_color(this.copied.has(it.hash)?c.yellow:c.dim).child(it.hash.slice(0,7)),
        div().flex_1().min_w(0).truncate().child(it.subject),
      ],c,frame.loading?"":frame.error??"No items")))
      .when(Boolean(frame.more)&&!frame.loading,e=>e.child(div().id(`more-${panel}`).h(24).px(12).flex_none().text_size(11).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>{this.panel=panel;this.extendContext(cx);}).child("Load more commits")))
      .when(Boolean(frame.truncated),e=>e.child(div().px(12).text_size(11).text_color(c.yellow).child("Output limit reached")));
  }
}
