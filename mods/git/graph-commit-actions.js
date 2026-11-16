import { GitGraphActions } from "./graph-actions.js";
import { graphCanDropCommit } from "./graph-details.js";

export class GitGraphCommitActions extends GitGraphActions {
  graphCommitTarget(commit) {
    return {kind:"commit",name:commit.hash.slice(0,7),ref:commit.hash,hash:commit.hash,subject:commit.subject,
      parents:[...commit.parents],repo:this.repoKey,root:this.root,on:this.on};
  }
  graphCheckoutCommit(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    this.ask("Checkout commit",`Check out ${target.name} “${target.subject}” with a detached HEAD?`,cx=>
      this.graphReferenceAction("Checkout commit",target,[["switch","--detach",target.hash]],cx),cx);
  }
  graphCreateBranch(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    const draft={name:"",checkout:false};
    const prepare=cx=>this.graphCreateNamedRef("branch",draft.name,target,(existing,cx)=>this.graphReferenceAction("Create branch",target,async(git,context)=>{
      await this.graphCheckNamedRef(existing,context);
      if(draft.checkout&&!existing.hash)await git(["switch","-c",draft.name,target.hash]);
      else {
        await git(["branch",...(existing.hash?["-f"]:[]),"--",draft.name,target.hash]);
        if(draft.checkout)await git(["switch",draft.name]);
      }
    },cx),(name,cx)=>prompt(name,cx),cx);
    const prompt=(name,cx)=>{
      if(!this.graphActionReady(target,cx))return;
      this.promptValue(`New branch at ${target.name}`,name,(name,cx)=>{
        draft.name=name;
        this.graphOptions(`Create ${name}`,[{label:"Check out branch",value:draft.checkout}],([checkout],cx)=>{draft.checkout=checkout;prepare(cx);},cx);
      },cx);
    };
    prompt("",cx);
  }
  graphCreateTag(target,cx) {
    if(!this.graphActionReady(target,cx))return;
    const draft={name:"",type:"annotated",message:"",remote:null},remotes=this.remotes.map(remote=>remote.name);
    const prepare=cx=>this.graphCreateNamedRef("tag",draft.name,target,(existing,cx)=>this.graphReferenceAction("Create tag",target,async(git,context)=>{
      await this.graphCheckNamedRef(existing,context);
      await git(["tag",...(existing.hash?["-f"]:[]),...(draft.type==="annotated"?["-a","-m",draft.message]:[]),"--",draft.name,target.hash]);
      if(draft.remote)await git(["push","--",draft.remote,`refs/tags/${draft.name}`]);
    },cx,{network:Boolean(draft.remote)}),(name,cx)=>prompt(name,cx),cx);
    const prompt=(name,cx)=>{
      if(!this.graphActionReady(target,cx))return;
      this.promptValue(`New tag at ${target.name}`,name,(name,cx)=>{
        draft.name=name;
        this.graphOptions(`Create ${name}`,[
          {label:"Tag type",value:draft.type,choices:[{label:"Annotated",value:"annotated"},{label:"Lightweight",value:"lightweight"}]},
          ...(remotes.length===1?[{label:`Push to ${remotes[0]}`,value:Boolean(draft.remote)}]:remotes.length>1?[{label:"Push to",value:draft.remote,choices:[{label:"Do not push",value:null},...remotes.map(name=>({label:name,value:name}))]}]:[]),
        ],([type,remote],cx)=>{
          draft.type=type;draft.remote=remotes.length===1?(remote?remotes[0]:null):remote;
          if(type==="annotated")this.promptValue("Tag message",draft.message,(message,cx)=>{draft.message=message;prepare(cx);},cx,{empty:true});else prepare(cx);
        },cx);
      },cx);
    };
    prompt("",cx);
  }
  graphParentChoice(target) {
    return {label:"Parent hash",value:1,choices:target.parents.map((hash,index)=>({value:index+1,
      label:`${index+1}: ${hash.slice(0,7)}${this.graphRowsByHash.get(hash)?.commit.subject?` — ${this.graphRowsByHash.get(hash).commit.subject}`:""}`}))};
  }
  graphCherryPick(target,cx) {
    this.graphWithHead("Reading cherry-pick options",target,(head,cx)=>{
      const merge=target.parents.length>1;
      this.graphOptions(`Cherry-pick ${target.name}`,[...(merge?[this.graphParentChoice(target)]:[]),{label:"Record origin",value:false},{label:"No commit",value:false}],(values,cx)=>{
        const parent=merge?values.shift():0,[origin,noCommit]=values;
        this.graphReferenceAction("Cherry-pick",target,[["cherry-pick",...(noCommit?["--no-commit"]:[]),...(origin?["-x"]:[]),...(parent?["-m",String(parent)]:[]),target.hash]],cx,{head});
      },cx);
    },cx);
  }
  graphRevert(target,cx) {
    this.graphWithHead("Reading revert options",target,(head,cx)=>{
      const run=(parent,cx)=>this.graphReferenceAction("Revert",target,[["revert","--no-edit",...(parent?["-m",String(parent)]:[]),target.hash]],cx,{head});
      if(target.parents.length>1)this.graphOptions(`Revert ${target.name}`,[this.graphParentChoice(target)],([parent],cx)=>run(parent,cx),cx);
      else this.ask("Revert commit",`Revert ${target.name} “${target.subject}” with a new commit?`,cx=>run(0,cx),cx);
    },cx);
  }
  graphReset(target,cx) {
    this.graphWithHead("Reading reset options",target,(head,cx)=>this.graphOptions(`Reset to ${target.name}`,[{label:"Reset mode",value:"mixed",choices:[
      {label:"Soft — keep changes staged",value:"soft"},{label:"Mixed — keep working files",value:"mixed"},{label:"Hard — discard changes",value:"hard"},
    ]}],([mode],cx)=>this.ask(`Reset (${mode})`,`Move ${head.ref.replace(/^refs\/heads\//,"")||"HEAD"} to ${target.name}? ${mode==="hard"?"Discard all tracked changes after it, including uncommitted tracked changes.":mode==="soft"?"Keep changes staged.":"Keep working files and reset the index."}`,
      cx=>this.graphReferenceAction("Reset",target,[["reset",`--${mode}`,target.hash]],cx,{head}),cx),cx),cx);
  }
  graphDropPossible(target) {return graphCanDropCommit(this.graph?.rows.map(row=>row.commit)??[],target.hash,this.head);}
  graphDropCommit(target,cx) {
    if(!this.graphDropPossible(target))return this.say("Drop requires a loaded linear history ending at HEAD",cx);
    this.graphWithHead("Reading drop options",target,(head,cx)=>this.ask("Drop commit",`Drop ${target.name} “${target.subject}” and replay the commits after it?`,cx=>this.graphReferenceAction("Drop commit",target,async(git,context)=>{
      if(!this.graphDropPossible(target))throw new Error("The graph changed; open the commit menu again");
      await git(["merge-base","--is-ancestor",target.hash,head.hash]);
      const result=await this.boundedGit(["rev-list","--parents",`${target.hash}..${head.hash}`,"--"],1_000_000,context);
      if(result.code||result.truncated)throw new Error(result.stderr||"History exceeds the read limit");
      if(result.stdout.trim().split("\n").some(line=>line.split(" ").length>2))throw new Error("Drop cannot replay a history containing merges");
      await git(["rebase","--onto",`${target.hash}^`,target.hash]);
    },cx,{head}),cx),cx);
  }
  graphCommitMenu(target,cx,at={}) {
    if(!this.graphActionReady(target,cx))return;
    const item=(label,run,hint="",danger=false)=>({label,run,hint,danger});
    this.openMenu({...at,title:`${target.name}  ${target.subject}`,items:[
      item("Add tag…",cx=>this.graphCreateTag(target,cx)),item("Create branch…",cx=>this.graphCreateBranch(target,cx),"b"),
      item("Checkout commit…",cx=>this.graphCheckoutCommit(target,cx),"space"),item("Cherry-pick…",cx=>this.graphCherryPick(target,cx),"c"),item("Revert…",cx=>this.graphRevert(target,cx),"t"),
      ...(this.graphDropPossible(target)?[item("Drop…",cx=>this.graphDropCommit(target,cx),"",true)]:[]),
      item("Merge into current branch…",cx=>this.graphMergeReference(target,cx)),item("Rebase current branch onto this commit…",cx=>this.graphRebaseReference(target,cx)),item("Reset current branch to this commit…",cx=>this.graphReset(target,cx),"r",true),
      item("Copy hash",cx=>cx.write_to_clipboard(target.hash),"y"),item("Copy commit summary",cx=>cx.write_to_clipboard(target.subject)),
    ]},cx);
  }
}
