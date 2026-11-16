import { GitGraphCommitActions } from "./graph-commit-actions.js";

export class GitGraphWorktreeActions extends GitGraphCommitActions {
  graphWorktreeTarget() {
    return {kind:"worktree",name:"Uncommitted changes",ref:"HEAD",hash:this.head,repo:this.repoKey,root:this.root,on:this.on};
  }
  graphStashWorktree(target,cx) {
    this.graphWithHead("Reading stash options",target,(head,cx)=>this.promptValue("Stash message","",(message,cx)=>
      this.graphOptions("Stash uncommitted changes",[{label:"Include untracked files",value:true}],([untracked],cx)=>
        this.graphReferenceAction("Stash uncommitted changes",target,[["stash","push",...(untracked?["--include-untracked"]:[]),...(message?["--message",message]:[])]],cx,{head}),cx),cx,{empty:true}),cx);
  }
  graphResetWorktree(target,cx) {
    this.graphWithHead("Reading reset options",target,(head,cx)=>this.graphOptions("Reset uncommitted changes",[{label:"Reset mode",value:"mixed",choices:[
      {label:"Mixed — keep working files",value:"mixed"},{label:"Hard — discard changes",value:"hard"},
    ]}],([mode],cx)=>this.ask(`Reset uncommitted changes (${mode})`,mode==="hard"?"Discard all uncommitted tracked changes? Untracked paths that obstruct tracked files are also removed.":"Reset the index to HEAD and keep working files?",
      cx=>this.graphReferenceAction("Reset uncommitted changes",target,[["reset",`--${mode}`,"HEAD"]],cx,{head}),cx),cx),cx);
  }
  graphCleanWorktree(target,cx) {
    this.graphWithHead("Reading clean options",target,(head,cx)=>this.graphOptions("Clean untracked files",[{label:"Clean untracked directories",value:true}],([directories],cx)=>
      this.ask("Clean untracked files",`Delete untracked files${directories?" and directories":""}? Ignored files and nested repositories are kept.`,cx=>
        this.graphReferenceAction("Clean untracked files",target,[["clean",directories?"-fd":"-f"]],cx,{head}),cx),cx),cx);
  }
  graphWorktreeMenu(cx,at={}) {
    const target=this.graphWorktreeTarget();
    if(!this.graphActionReady(target,cx))return;
    const item=(label,run,danger=false,hint="")=>({label,run,danger,hint});
    this.openMenu({...at,title:target.name,items:[
      item("Stash uncommitted changes…",cx=>this.graphStashWorktree(target,cx)),
      item("Reset uncommitted changes…",cx=>this.graphResetWorktree(target,cx),true),
      item("Clean untracked files…",cx=>this.graphCleanWorktree(target,cx),true),
      item("Go to Files",cx=>{if(this.graphActionReady(target,cx))this.goto("files",cx);},false,"enter"),
    ]},cx);
  }
}
