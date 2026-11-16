import { GitFiles } from "./file-actions.js";
import { checking, exec } from "herdr";

const checked = result => { if(result.code)throw new Error((result.stderr||result.stdout).trim());if(result.truncated)throw new Error("Reference information exceeds the output limit");return result.stdout; };
const fields = "%00";

export class GitReferences extends GitFiles {
  captureRefSelection(panel=this.panel,items=null) {
    const key=this.viewKey(panel),anchor=this.rangeAnchors[key],at=this.sel[panel];
    return {repo:this.repoKey,root:this.root,on:this.on,panel,key,top:Math.min(anchor??at,at),ranged:items==null&&anchor!=null,
      items:(items??this.selectedItems(panel)).map(item=>({...item}))};
  }
  refScopeCurrent(scope,cx) {
    if(!this.closed&&scope.repo===this.repoKey&&scope.root===this.root&&scope.on===this.on)return true;
    if(!this.closed)this.say("The repository changed; select the references again",cx);
    return false;
  }
  collapseRefsAfterRefresh(scope) { if(scope.ranged)(this.rangeRefreshes??=[]).push(scope); }
  finishRangeRefresh(cx) {
    const pending=this.rangeRefreshes??[];this.rangeRefreshes=[];
    for(const scope of pending){
      if(scope.repo!==this.repoKey||scope.root!==this.root||scope.on!==this.on||scope.key!==this.viewKey(scope.panel))continue;
      this.sel[scope.panel]=scope.top;this.cancelRange(scope.panel);this.clampRange(scope.panel);
      this.scroll[scope.panel].scroll_to_item(this.sel[scope.panel]);
      if(this.panel===scope.panel)this.syncContext();
    }
    if(pending.length)cx.notify();
  }
  async checkCapturedRefs(scope,git,kind) {
    for(const item of scope.items){
      const ref=item.ref??`refs/${kind}/${item.name}`;
      if((await git(["rev-parse","--verify",ref])).trim()!==item.hash)throw new Error(`${item.name??item.ref} changed; select the references again`);
    }
  }
  readRefPlan(label,scope,read,then,cx) {
    if(checking()||this.busy||!this.refScopeCurrent(scope,cx))return;
    const job=this.refReading={},context={cwd:scope.root,on:scope.on};this.busy=label;this.opening=label;this.note=null;
    cx.spawn(async cx=>{
      let value,error;
      try {value=await read(context);}
      catch(e){error=e;}
      if(this.refReading!==job)return;
      this.refReading=null;this.busy=null;this.opening=null;
      if(this.refScopeCurrent(scope,cx)){if(error)this.say(`${label} failed: ${error.message??error}`,cx);else then(value,cx);}
      cx.notify();
    });cx.notify();
  }
  cancelRefPlan(cx) {
    if(!this.refReading)return false;
    this.refReading=null;this.busy=null;this.opening=null;cx?.notify();return true;
  }
  async readBranchMetadata(scope,context) {
    if(scope.items.some(item=>item.detached))throw new Error("Select real local branches");
    const format=["%(refname)","%(objectname)","%(HEAD)","%(upstream)","%(upstream:remotename)","%(upstream:remoteref)","%(upstream:track)"].join(fields);
    const raw=checked(await this.boundedGit(["for-each-ref",`--format=${format}`,...scope.items.map(item=>`refs/heads/${item.name}`)],1_000_000,context));
    const found=new Map(raw.split("\n").filter(Boolean).map(line=>{
      const [ref,hash,head,upstream,remote,merge,track]=line.split("\0");return [ref,{ref,hash,name:ref.slice(11),current:head==="*",upstream,remote,merge,gone:track==="[gone]"}];
    }));
    return scope.items.map(item=>{const branch=found.get(`refs/heads/${item.name}`);if(!branch||branch.hash!==item.hash)throw new Error(`${item.name} changed; select the branches again`);return branch;});
  }
  async readRefWorktrees(context) {
    const raw=checked(await this.boundedGit(["worktree","list","--porcelain","-z"],1_000_000,context)),trees=[];let tree;
    for(const field of raw.split("\0")){
      if(field.startsWith("worktree ")){tree={path:field.slice(9)};trees.push(tree);}
      else if(tree&&field.startsWith("branch "))tree.branch=field.slice(7);
      else if(tree&&field.startsWith("HEAD "))tree.hash=field.slice(5);
      else if(tree&&field.startsWith("locked"))tree.locked=true;
      else if(tree&&field==="bare")tree.bare=true;
    }
    return trees.filter(tree=>!tree.bare);
  }
  async branchesMerged(branches,context) {
    const main=[];
    for(const name of this.configValue("git.mainBranches",["master","main"])){
      const upstream=await this.boundedGit(["rev-parse","--symbolic-full-name",`${name}@{upstream}`],262144,context);
      if(!upstream.code&&upstream.stdout.trim()){main.push(upstream.stdout.trim());continue;}
      for(const ref of [`refs/remotes/origin/${name}`,`refs/heads/${name}`]){
        const exists=await this.boundedGit(["rev-parse","--verify","--quiet",ref],262144,context);
        if(!exists.code){main.push(ref);break;}
      }
    }
    for(const branch of branches){
      const args=["rev-list","--max-count=1",branch.ref,"^HEAD",...(!branch.gone&&branch.upstream?[`^${branch.upstream}`]:[]),...main.map(ref=>`^${ref}`),"--"];
      if(checked(await this.boundedGit(args,262144,context)).trim())return false;
    }
    return true;
  }
  async readForwardWorktrees(context,branches) {
    const trees=await this.readRefWorktrees(context);
    // A rebase/bisect detaches HEAD. Its original branch still belongs to this
    // worktree and must not be treated as an unchecked-out ref we can move.
    const script='if [ ! -d "$1" ]; then printf "missing\\n"; exit 0; fi; cd -- "$1" || exit; for name in rebase-merge rebase-apply BISECT_LOG; do p=$(git rev-parse --git-path "$name") || exit; if [ -e "$p" ]; then printf "state:%s\\n" "$name"; fi; done; for name in rebase-merge/head-name rebase-apply/head-name BISECT_START; do p=$(git rev-parse --git-path "$name") || exit; if [ -f "$p" ]; then printf "branch:"; head -c 1024 "$p"; printf "\\n"; fi; done';
    for(const tree of trees){
      if(tree.branch&&!branches.some(branch=>branch.ref===tree.branch))continue;
      const state=checked(await exec("sh",["-c",script,"sh",tree.path],context));
      tree.operation=/^state:/m.test(state);
      if(tree.operation){const original=state.split("\n").find(line=>line.startsWith("branch:"))?.slice(7);if(original)tree.branch=original.startsWith("refs/heads/")?original:`refs/heads/${original}`;}
    }
    return trees;
  }
  fastForward(item,cx) {
    const scope=this.captureRefSelection("branches",item?[item]:null);if(!scope.items.length||!this.refScopeCurrent(scope,cx))return;
    this.perform("Fast-forward",async(git,context)=>{
      const branches=await this.readBranchMetadata(scope,context);
      for(const branch of branches){
        if(!branch.remote||!branch.merge||!branch.upstream||branch.gone)throw new Error(`${branch.name} needs an existing upstream`);
        const counts=checked(await this.boundedGit(["rev-list","--left-right","--count",`${branch.ref}...${branch.upstream}`,"--"],262144,context)).trim().split(/\s+/).map(Number);
        if(counts[0]>0&&counts[1]===0)throw new Error(`${branch.name} is ahead of its upstream and cannot be fast-forwarded`);
      }
      const trees=await this.readForwardWorktrees(context,branches);
      for(const branch of branches){branch.tree=trees.find(tree=>tree.branch===branch.ref);if(branch.tree?.operation)throw new Error(`Finish the rebase or bisect in ${branch.tree.path} before fast-forwarding ${branch.name}`);}
      const groups=new Map();for(const branch of branches){if(!groups.has(branch.remote))groups.set(branch.remote,[]);groups.get(branch.remote).push(branch);}
      for(const [remote,items]of groups){
        // Git also permits a local branch as upstream (remote="."). It is
        // already local; fetching it into refs/remotes/./ would be invalid.
        if(remote!==".")await git(["fetch","--no-write-fetch-head","--",remote,...items.map(branch=>`+${branch.merge}:${branch.upstream}`)]);
      }
      // Fetch may have rewritten upstreams. Validate every plan before any
      // local ref or worktree changes, using upstream reflogs as provenance.
      for(const branch of branches){
        const ancestor=await this.boundedGit(["merge-base","--is-ancestor",branch.ref,branch.upstream],262144,context);
        if(ancestor.code>1)checked(ancestor);branch.reset=ancestor.code!==0;
        if(!branch.reset)continue;
        const history=await this.boundedGit(["reflog","show","--format=%H",branch.upstream],1_000_000,context);let hashes=[];
        if(!history.code){hashes=checked(history).trim().split("\n").filter(Boolean);const before=await this.boundedGit(["rev-parse","-q","--verify",`${branch.upstream}@{${hashes.length}}`],262144,context);if(!before.code)hashes.push(checked(before).trim());}
        const unique=checked(await this.boundedGit(["rev-list","--max-count=1","--ignore-missing",branch.ref,`^${branch.upstream}`,...[...new Set(hashes)].map(hash=>`^${hash}`),"--"],262144,context));
        if(unique.trim())throw new Error(`${branch.name} has local-only commits; no selected local branches were changed`);
        if(branch.tree&&checked(await this.boundedGit(["-C",branch.tree.path,"status","--porcelain","--untracked-files=no","--ignore-submodules"],262144,context)).trim())throw new Error(`${branch.name} has uncommitted changes in ${branch.tree.path}`);
      }
      const latest=await this.readBranchMetadata(scope,context);
      if(latest.some((branch,i)=>branch.upstream!==branches[i].upstream||branch.remote!==branches[i].remote||branch.merge!==branches[i].merge))throw new Error("The upstream configuration changed; select the branches again");
      const currentTrees=await this.readForwardWorktrees(context,branches);
      for(const branch of branches){const tree=currentTrees.find(tree=>tree.branch===branch.ref);if(tree?.path!==branch.tree?.path||tree?.operation)throw new Error(`The worktree for ${branch.name} changed; select the branches again`);}
      const errors=[],updates=branches.filter(branch=>!branch.tree).map(branch=>`update ${branch.ref} ${branch.upstream} ${branch.hash}\n`).join("");
      if(updates){
        try {checked(await exec("sh",["-c",'printf "%s" "$1" | git update-ref --stdin -m "lazygit: update to upstream branch"',"sh",updates],context));}
        catch(e){errors.push(e.message??String(e));}
      }
      for(const branch of branches){
        if(!branch.tree)continue;
        try {
          const branchNow=checked(await this.boundedGit(["-C",branch.tree.path,"symbolic-ref","--quiet","HEAD"],262144,context)).trim();
          if(branchNow!==branch.ref||(await git(["rev-parse",branch.ref])).trim()!==branch.hash)throw new Error(`${branch.name} changed; select the branch again`);
          await git(["-C",branch.tree.path,...(branch.reset?["reset","--keep"]:["merge","--ff-only"]),branch.upstream]);
        }catch(e){errors.push(`${branch.name}: ${e.message??e}`);}
      }
      if(errors.length)throw new Error(errors.join("\n"));
    },cx,{network:true});
  }
  localBranchDeleteMenu(cx) {
    const scope=this.captureRefSelection("branches");if(!scope.items.length)return;
    this.readRefPlan("Reading branch deletion options",scope,context=>this.readBranchMetadata(scope,context),(branches,cx)=>{
      const current=branches.some(branch=>branch.current)?"The checked-out branch cannot be deleted":null;
      const upstream=branches.every(branch=>branch.remote&&branch.merge&&branch.upstream&&!branch.gone)?null:"Every selected branch needs an existing upstream";
      const noun=branches.length===1?"branch":"branches";
      this.menuItems(`Delete ${branches.length===1?branches[0].name:`${branches.length} branches`}`,[
        [`Delete local ${noun}`,"c",cx=>this.prepareBranchDelete(scope,"local",cx),true,null,current],
        [`Delete remote ${noun}…`,"r",cx=>this.prepareBranchDelete(scope,"remote",cx),true,null,upstream],
        [`Delete local and remote ${noun}…`,"b",cx=>this.prepareBranchDelete(scope,"both",cx),true,null,current??upstream],
      ],cx);
    },cx);
  }
  prepareBranchDelete(scope,kind,cx,treeAction=null) {
    this.readRefPlan("Checking selected branches",scope,async context=>{
      const branches=await this.readBranchMetadata(scope,context);
      if(kind!=="remote"&&branches.some(branch=>branch.current))throw new Error("The checked-out branch cannot be deleted");
      if(kind!=="local"&&branches.some(branch=>!branch.remote||!branch.merge||!branch.upstream||branch.gone))throw new Error("Every selected branch needs an existing upstream");
      const trees=kind==="remote"?[]:(await this.readRefWorktrees(context)).filter(tree=>tree.path!==scope.root&&branches.some(branch=>branch.ref===tree.branch));
      if(trees.length&&branches.length>1)throw new Error("Some selected branches are checked out in another worktree; select one branch");
      const tree=trees[0]??null;
      const merged=kind==="remote"?true:await this.branchesMerged(branches,context);
      return {scope,kind,branches,tree,treeAction,merged};
    },(plan,cx)=>{
      if(plan.tree&&!treeAction)return this.menuItems(`${plan.branches[0].name} is checked out in ${plan.tree.path}`,[
        ["Remove worktree and delete branch…","r",cx=>this.prepareBranchDelete(scope,kind,cx,"remove"),true],
        ["Detach worktree and delete branch…","d",cx=>this.prepareBranchDelete(scope,kind,cx,"detach"),true],
      ],cx);
      const remote=kind!=="local",names=plan.branches.map(branch=>branch.name).join(", ");
      const targets=plan.branches.map(branch=>`${branch.remote}/${branch.merge.replace(/^refs\/heads\//,"")}`).join(", ");
      const description=`Delete ${kind==="remote"?targets:remote?`${names} and upstreams ${targets}`:names}?${!plan.merged?" Some selected commits are unmerged; this will force-delete those branches.":""}${plan.treeAction==="remove"?` Remove worktree ${plan.tree.path}.`:plan.treeAction==="detach"?` Keep ${plan.tree.path} with a detached HEAD.`:""}`;
      if(remote&&!treeAction||!plan.merged)return this.ask(!plan.merged?"Force delete branches":"Delete branches",description,cx=>this.executeBranchDelete(plan,cx),cx);
      this.executeBranchDelete(plan,cx);
    },cx);
  }
  executeBranchDelete(plan,cx) {
    const {scope,kind}=plan;if(!this.refScopeCurrent(scope,cx))return;let forceRetry=false;
    this.perform("Delete branches",async(git,context)=>{
      const branches=await this.readBranchMetadata(scope,context);
      if(kind!=="remote"&&branches.some(branch=>branch.current))throw new Error("The checked-out branch changed; select the branches again");
      if(kind!=="local"&&branches.some((branch,index)=>branch.remote!==plan.branches[index].remote||branch.merge!==plan.branches[index].merge))throw new Error("The upstream configuration changed; select the branches again");
      if(kind!=="remote"&&plan.merged&&!await this.branchesMerged(branches,context))throw new Error("The branch merge status changed; select the branches again");
      if(plan.tree){
        const tree=(await this.readRefWorktrees(context)).find(tree=>tree.path===plan.tree.path);
        if(!tree||tree.branch!==plan.tree.branch)throw new Error("The worktree changed; select the branch again");
        if(plan.treeAction==="remove"){
          try {await git(["worktree","remove",...(plan.forceRemove?["--force"]:[]),"--",tree.path]);}
          catch(e){if(!plan.forceRemove&&/--force|fatal: working trees containing submodules cannot be moved or removed/.test(e.message??String(e))){forceRetry=true;return;}throw e;}
        }
        else await git(["-C",tree.path,"checkout","--detach",tree.hash]);
      }
      if(kind!=="local"){
        const groups=new Map();for(const branch of branches){if(!groups.has(branch.remote))groups.set(branch.remote,[]);groups.get(branch.remote).push(branch.merge);}
        for(const [remote,refs]of groups)await git(["push","--delete","--",remote,...refs]);
      }
      if(kind!=="remote"){await git(["branch","-D","--",...branches.map(branch=>branch.name)]);this.collapseRefsAfterRefresh(scope);}
    },cx,{network:kind!=="local",after:cx=>{
      if(forceRetry&&this.refScopeCurrent(scope,cx)){this.info=null;this.ask("Remove worktree",`Force-remove ${plan.tree.path}, discarding its uncommitted changes, then delete ${plan.branches[0].name}?`,cx=>this.executeBranchDelete({...plan,forceRemove:true},cx),cx);}
    }});
  }
  dropStashes(cx,items=null) {
    const scope=this.captureRefSelection("stash",items);if(!scope.items.length)return;
    this.ask("Drop stash",`Permanently remove ${scope.items.map(item=>item.ref).join(", ")}?`,cx=>{
      if(!this.refScopeCurrent(scope,cx))return;
      this.perform("Drop stashes",async git=>{
        // Check all identities first; highest indices then leave lower ones valid.
        await this.checkCapturedRefs(scope,git,"stash");
        const ordered=scope.items.slice().sort((a,b)=>Number(/\{(\d+)\}/.exec(b.ref)?.[1])-Number(/\{(\d+)\}/.exec(a.ref)?.[1]));
        for(const item of ordered){
          if((await git(["rev-parse",item.ref])).trim()!==item.hash)throw new Error("The stash list changed; select the remaining stashes again");
          await git(["stash","drop",item.ref]);
        }
        this.collapseRefsAfterRefresh(scope);
      },cx);
    },cx);
  }
  tagSelectionMenu(cx) {
    const scope=this.captureRefSelection("branches");if(!scope.items.length)return;
    const label=scope.items.length===1?scope.items[0].name:`${scope.items.length} tags`;
    this.menuItems(`Delete ${label}`,[["Delete local tags","c",cx=>this.deleteTagSelection(scope,"local",cx),true],
      ["Delete remote tags…","r",cx=>this.deleteTagSelection(scope,"remote",cx),true],
      ["Delete local and remote tags…","b",cx=>this.deleteTagSelection(scope,"both",cx),true]],cx);
  }
  promptTagRemote(title,scope,then,cx) {
    this.promptValue(title,"origin",(remote,cx)=>{if(this.refScopeCurrent(scope,cx))then(remote,cx);},cx,{suggestions:this.remotes.map(remote=>remote.name)});
  }
  deleteTagSelection(scope,kind,cx) {
    const execute=(remote,cx)=>{
      if(!this.refScopeCurrent(scope,cx))return;
      this.perform("Delete tags",async git=>{
        await this.checkCapturedRefs(scope,git,"tags");
        if(remote)await git(["push","--delete","--",remote,...scope.items.map(item=>`refs/tags/${item.name}`)]);
        if(kind!=="remote"){
          try {await git(["tag","-d","--",...scope.items.map(item=>item.name)]);}
          finally {this.collapseRefsAfterRefresh(scope);}
        }
      },cx,{network:Boolean(remote)});
    };
    if(kind==="local")return execute(null,cx);
    this.promptTagRemote("Remote to delete tags from",scope,(remote,cx)=>this.ask("Delete tags",`Delete ${scope.items.map(item=>item.name).join(", ")} from ${remote}${kind==="both"?" and this repository":""}?`,cx=>execute(remote,cx),cx),cx);
  }
  pushTagSelection(cx) {
    const scope=this.captureRefSelection("branches");if(!scope.items.length)return;
    this.promptTagRemote("Remote to push tags to",scope,(remote,cx)=>this.perform("Push tags",async git=>{
      await this.checkCapturedRefs(scope,git,"tags");
      await git(["push","--",remote,...scope.items.flatMap(item=>["tag",item.name])]);
    },cx,{network:true}),cx);
  }
  deleteRemoteBranches(cx) {
    const scope=this.captureRefSelection("branches");if(!scope.items.length)return;
    scope.items=scope.items.map(item=>({...item,...this.remoteBranchParts(item)}));
    if(scope.items.some(item=>!item.remote))return this.say("The selected remote branch has no configured remote",cx);
    this.ask("Delete remote branches",`Delete ${scope.items.map(item=>`${item.remote}/${item.branch}`).join(", ")}?`,cx=>{
      if(!this.refScopeCurrent(scope,cx))return;
      this.perform("Delete remote branches",async git=>{
        await this.checkCapturedRefs(scope,git,"remotes");
        const groups=new Map();for(const item of scope.items){if(!groups.has(item.remote))groups.set(item.remote,[]);groups.get(item.remote).push(item.branch);}
        for(const [remote,branches]of groups)await git(["push","--delete","--",remote,...branches.map(branch=>`refs/heads/${branch}`)]);
        this.collapseRefsAfterRefresh(scope);
      },cx,{network:true});
    },cx);
  }
}
