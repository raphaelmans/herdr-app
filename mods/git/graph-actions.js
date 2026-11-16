import { GitArchive } from "./archive-runtime.js";

// Graph targets are captured from the clicked badge, never from a side pane.
export class GitGraphActions extends GitArchive {
  graphReferenceGroups(commit) {
    const target=(kind,name,ref,extra={})=>({kind,name,ref,hash:commit.hash,repo:this.repoKey,root:this.root,on:this.on,...extra});
    return commit.refs.map(label=>{
      if(label.kind==="head")return [target("local",label.name,label.name==="HEAD"?"HEAD":`refs/heads/${label.name}`,{current:label.current,detached:label.name==="HEAD"}),
        ...label.remotes.map(remote=>target("remote",`${remote}/${label.name}`,`refs/remotes/${remote}/${label.name}`,{remote,branch:label.name,caption:remote}))];
      if(label.kind==="remote")return [target("remote",label.name,`refs/remotes/${label.name}`,this.remoteBranchParts({name:label.name}))];
      if(label.kind==="stash")return [target("stash",label.name,label.name)];
      const tag=this.tags.find(tag=>tag.ref===`refs/tags/${label.name}`);
      return [target("tag",label.name,`refs/tags/${label.name}`,{annotated:tag?.type==="tag",refHash:tag?.hash})];
    });
  }
  graphReferences(commit) {return this.graphReferenceGroups(commit).flat();}
  graphTargetCurrent(target,cx) {return this.refScopeCurrent(target,cx);}
  graphActionReady(target,cx) {return !this.busy&&!this.settling&&!this.prompt&&!this.pending&&!this.menu&&!this.archive&&this.graphTargetCurrent(target,cx);}
  async graphHeadState(context) {
    const [head,branch]=await Promise.all([
      this.boundedGit(["rev-parse","--verify","HEAD"],1024,context),
      this.boundedGit(["symbolic-ref","--quiet","HEAD"],65536,context),
    ]);
    if(head.code!==0||head.truncated||![0,1].includes(branch.code)||branch.truncated)throw new Error(head.stderr||branch.stderr||"Cannot read the current branch");
    return {hash:head.stdout.trim(),ref:branch.code===1?"":branch.stdout.trim()};
  }
  graphWithHead(label,target,then,cx) {
    if(!this.graphActionReady(target,cx))return;
    this.readRefPlan(label,target,context=>this.graphHeadState(context),then,cx);
  }
  graphReferenceAction(label,target,work,cx,options={}) {
    if(!this.graphActionReady(target,cx))return;
    this.perform(label,async(git,context,cx)=>{
      if((await git(["rev-parse","--verify","--end-of-options",`${target.ref}^{commit}`])).trim()!==target.hash)throw new Error(`${target.name} changed; open its menu again`);
      if(target.refHash&&(await git(["rev-parse","--verify",target.ref])).trim()!==target.refHash)throw new Error(`${target.name} changed; open its menu again`);
      if(options.head){const head=await this.graphHeadState(context);if(head.hash!==options.head.hash||head.ref!==options.head.ref)throw new Error("HEAD or the current branch changed; open the action again");}
      if(typeof work==="function")await work(git,context,cx);else for(const args of work)await git(args);
    },cx,options);
  }
  checkoutGraphReference(target,cx) {
    if(!this.graphActionReady(target,cx)||!["local","remote"].includes(target.kind)||target.detached)return;
    if(target.kind==="local")return target.current?this.say(`Already on ${target.name}`,cx):this.graphReferenceAction("Checkout",target,[["switch",target.name]],cx);
    const prompt=(value,cx)=>{
      if(!this.graphActionReady(target,cx))return;
      this.promptValue("Local branch name",value,(name,cx)=>this.readRefPlan("Reading checkout options",target,context=>this.graphNamedRef("branch",name,context),(existing,cx)=>{
        if(!existing.hash)return this.graphReferenceAction("Checkout remote branch",target,[["switch","-c",name,target.ref]],cx);
        this.menuItems(`Branch ${name} already exists`,[
          ["Choose another branch name","",cx=>prompt(name,cx)],
          [target.remote?"Checkout existing branch and pull":"Checkout existing branch","",cx=>this.graphReferenceAction("Checkout remote branch",target,async(git,context)=>{
            await this.graphCheckNamedRef(existing,context);await git(["switch",name]);
            if(target.remote)await git(["pull","--no-edit","--",target.remote,target.branch]);
          },cx,{network:Boolean(target.remote)})],
        ],cx);
      },cx),cx);
    };
    prompt(target.remote?target.branch:target.name,cx);
  }
  async graphNamedRef(kind,name,context) {
    const ref=`refs/${kind==="branch"?"heads":"tags"}/${name}`;
    const format=await this.boundedGit(["check-ref-format",ref],1024,context);
    if(name.startsWith("-")||!name||format.code!==0||format.truncated)throw new Error(`Invalid ${kind} name: ${name}`);
    const result=await this.boundedGit(["rev-parse","--quiet","--verify","--end-of-options",ref],1024,context);
    if(![0,1].includes(result.code)||result.truncated)throw new Error(result.stderr||`Cannot read ${kind} ${name}`);
    return {kind,name,ref,hash:result.code===0?result.stdout.trim():null};
  }
  async graphCheckNamedRef(expected,context) {
    const current=await this.graphNamedRef(expected.kind,expected.name,context);
    if(current.hash!==expected.hash)throw new Error(`${expected.name} changed; open the action again`);
  }
  graphCreateNamedRef(kind,name,target,create,rename,cx) {
    if(!this.graphActionReady(target,cx))return;
    this.readRefPlan(`Reading ${kind} options`,target,context=>this.graphNamedRef(kind,name,context),(existing,cx)=>{
      if(!existing.hash)return create(existing,cx);
      this.menuItems(`${kind==="branch"?"Branch":"Tag"} ${name} already exists`,[
        [`Choose another ${kind} name`,"",cx=>rename(name,cx)],
        [`Replace existing ${kind} (${existing.hash.slice(0,7)} → ${target.hash.slice(0,7)})`,"",cx=>create(existing,cx),true],
      ],cx);
    },cx);
  }
  graphOptions(title,options,submit,cx) {
    const show=cx=>this.menuItems(title,[...options.map(option=>option.choices
      ?[`${option.label}: ${option.choices.find(choice=>choice.value===option.value)?.label??option.value}`,"",cx=>this.menuItems(option.label,option.choices.map(choice=>[choice.label,"",cx=>{option.value=choice.value;show(cx);}]),cx)]
      :[`${option.value?"☑":"☐"} ${option.label}`,"",cx=>{option.value=!option.value;show(cx);}]),["Continue","enter",cx=>submit(options.map(option=>option.value),cx)]],cx);
    show(cx);
  }
  graphDeleteReference(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    if(target.kind==="local"){
      const matching=this.remotes.filter(remote=>this.remoteBranches.some(branch=>branch.name===`${remote.name}/${target.name}`));
      this.graphOptions(`Delete ${target.name}`,[{label:"Force delete",value:false},...matching.map(remote=>({label:`Also delete on ${remote.name}`,value:false}))],(values,cx)=>{
        const remotes=matching.filter((_remote,index)=>values[index+1]);
        this.ask("Delete branch",`Delete ${target.name}${remotes.length?` and its branch on ${remotes.map(remote=>remote.name).join(", ")}`:" locally"}?`,cx=>this.graphReferenceAction("Delete branch",target,
          [...remotes.map(remote=>["push","--",remote.name,`:refs/heads/${target.name}`]),["branch",values[0]?"-D":"-d","--",target.name]],cx,{network:remotes.length>0}),cx);
      },cx);return;
    }
    if(target.kind==="remote")return this.ask("Delete remote branch",`Delete ${target.branch} on ${target.remote}?`,cx=>this.graphReferenceAction("Delete remote branch",target,[["push","--",target.remote,`:refs/heads/${target.branch}`]],cx,{network:true}),cx);
    const remove=(remote,cx)=>this.ask("Delete tag",`Delete ${target.name} locally${remote?` and on ${remote}`:""}?`,cx=>this.graphReferenceAction("Delete tag",target,[...(remote?[["push","--",remote,`:refs/tags/${target.name}`]]:[]),["tag","-d","--",target.name]],cx,{network:Boolean(remote)}),cx);
    this.menuItems(`Delete ${target.name}`,[["Local only","",cx=>remove(null,cx)],...this.remotes.map(remote=>[`Local and ${remote.name}`,"",cx=>remove(remote.name,cx)])],cx);
  }
  graphStashAction(target,kind,cx) {
    if(!this.graphActionReady(target,cx))return;
    if(kind==="branch")return this.promptValue("New branch from stash","",(name,cx)=>this.graphReferenceAction("Create branch from stash",target,[["stash","branch",name,target.ref]],cx),cx);
    if(kind==="drop")return this.ask("Drop stash",`Remove ${target.name}?`,cx=>this.graphReferenceAction("Drop stash",target,[["stash","drop",target.ref]],cx),cx);
    this.graphWithHead("Reading stash options",target,(head,cx)=>this.graphOptions(`${kind==="pop"?"Pop":"Apply"} ${target.name}`,[{label:"Reinstate index",value:false}],([index],cx)=>this.graphReferenceAction(`${kind==="pop"?"Pop":"Apply"} stash`,target,[["stash",kind,...(index?["--index"]:[]),target.ref]],cx,{head}),cx),cx);
  }
  graphMergeReference(target,cx) {
    this.graphWithHead("Reading merge options",target,(head,cx)=>this.graphOptions(`Merge ${target.name}`,[{label:"Create a merge commit even when fast-forward is possible",value:false},{label:"Squash",value:false},{label:"No commit",value:false}],([noff,squash,nocommit],cx)=>
      this.ask("Merge",`Merge ${target.name} into ${head.ref.replace(/^refs\/heads\//,"")||"HEAD"}?`,cx=>this.graphReferenceAction("Merge",target,[["merge",...(squash?["--squash"]:noff?["--no-ff"]:[]),...(nocommit?["--no-commit"]:[]),"--no-edit",target.ref]],cx,{head}),cx),cx),cx);
  }
  graphRebaseReference(target,cx) {
    this.graphWithHead("Reading rebase options",target,(head,cx)=>this.ask("Rebase",`Rebase ${head.ref.replace(/^refs\/heads\//,"")||"HEAD"} onto ${target.name}?`,cx=>this.graphReferenceAction("Rebase",target,[["rebase",target.ref]],cx,{head}),cx),cx);
  }
  graphPullReference(target,cx) {
    this.graphWithHead("Reading pull options",target,(head,cx)=>this.graphOptions(`Pull ${target.name}`,[{label:"No fast-forward",value:false},{label:"Squash",value:false}],([noff,squash],cx)=>this.graphReferenceAction("Pull",target,[["pull",...(squash?["--squash"]:noff?["--no-ff"]:[]),"--no-edit","--",target.remote,target.branch]],cx,{network:true,head}),cx),cx);
  }
  graphPushReference(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    // Each menu closure keeps its own remote and upstream choice.
    const choose=(remote,cx)=>{
      if(target.kind==="tag")return this.graphReferenceAction("Push tag",target,[["push","--",remote,target.ref]],cx,{network:true});
      this.graphOptions(`Push ${target.name} to ${remote}`,[{label:"Set upstream",value:true}],([upstream],cx)=>{
      const run=(flags,cx)=>this.graphReferenceAction("Push branch",target,[["push",...flags,...(upstream?["--set-upstream"]:[]),"--",remote,`${target.ref}:refs/heads/${target.name}`]],cx,{network:true});
      this.menuItems("Push mode",[["Normal","",cx=>run([],cx)],["Force with lease","",cx=>run(["--force-with-lease"],cx)],["Force…","",cx=>this.ask("Force push",`Replace ${target.name} on ${remote}?`,cx=>run(["--force"],cx),cx)]],cx);
      },cx);
    };
    this.chooseRemote(`Push ${target.name}`,choose,cx);
  }
  graphReferenceMenu(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    const action=(label,run,danger=false)=>[label,"",run,danger],items=[];
    if(target.kind==="stash")items.push(action("Apply…",cx=>this.graphStashAction(target,"apply",cx)),action("Create branch from stash…",cx=>this.graphStashAction(target,"branch",cx)),action("Pop…",cx=>this.graphStashAction(target,"pop",cx)),action("Drop…",cx=>this.graphStashAction(target,"drop",cx),true),action("Copy selector",cx=>cx.write_to_clipboard(target.ref)),action("Copy hash",cx=>cx.write_to_clipboard(target.hash)));
    else if(target.detached)items.push(action("Copy hash",cx=>cx.write_to_clipboard(target.hash)));
    else {
      if(target.kind!=="tag"){
        if(!target.current)items.push(action("Checkout",cx=>this.checkoutGraphReference(target,cx)),action("Merge into current branch…",cx=>this.graphMergeReference(target,cx)));
        if(target.kind==="local"){
          if(!target.current)items.push(action("Rebase current branch onto here…",cx=>this.graphRebaseReference(target,cx)));
          items.push(action("Rename branch…",cx=>this.promptValue("Branch name",target.name,(name,cx)=>this.graphReferenceAction("Rename branch",target,[["branch","-m","--",target.name,name]],cx),cx)));
        }else if(target.remote){
          if(this.branches.some(branch=>branch.name===target.branch&&!branch.current))items.push(action("Fetch into local branch…",cx=>this.graphOptions(`Fetch ${target.name}`,[{label:"Force fetch",value:false}],([force],cx)=>this.graphReferenceAction("Fetch into local branch",target,[["fetch",...(force?["--force"]:[]),"--",target.remote,`refs/heads/${target.branch}:refs/heads/${target.branch}`]],cx,{network:true}),cx)));
          items.push(action("Pull into current branch…",cx=>this.graphPullReference(target,cx)));
        }
      }else if(target.annotated)items.push(action("View tag details",cx=>this.graphReferenceAction("Reading tag details",target,async(_git,context,cx)=>{const result=await this.boundedGit(["cat-file","tag",target.ref],262144,context);if(result.code||result.truncated)throw new Error(result.stderr||"Tag details exceed the output limit");if(!this.graphTargetCurrent(target,cx))return;this.customOutput={title:target.name,text:result.stdout,popup:true,running:false,scroll:this.planScroll,cursor:0};cx.notify();},cx,{reads:true,done:""})));
      if(!target.current&&(target.kind!=="remote"||target.remote))items.push(action("Delete…",cx=>this.graphDeleteReference(target,cx),true));
      if(target.kind!=="remote"&&this.remotes.length)items.push(action("Push…",cx=>this.graphPushReference(target,cx)));
      items.push(action("Create archive…",cx=>this.openGraphArchive(target,cx)),action("Copy name",cx=>cx.write_to_clipboard(target.name)));
    }
    this.menuItems(target.name,items,cx);
  }
}
