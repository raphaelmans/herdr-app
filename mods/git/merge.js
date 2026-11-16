import { exec } from "herdr";
import { GitFlow } from "./flow.js";
import { mergeArgs, mergeChoices, squashMergeMessage, WRITE_SQUASH_MESSAGE, REBASE_BRANCH } from "./merge-config.js";
import { OPERATION_STATE_SCRIPT, operationFromState, operationCommands } from "./status.js";

const checked=result=>{if(result.code!==0)throw new Error((result.stderr||result.stdout).trim().slice(-1800)||`Git exited ${result.code}`);if(result.truncated)throw new Error("Merge metadata exceeds the read limit");return result.stdout;};
const optional=result=>result.code===1?"":checked(result).replace(/\n$/,"");

export class GitMerge extends GitFlow {
  mergeSettings() {return {args:this.configValue("git.merging.args",""),message:this.configValue("git.merging.squashMergeMessage","Squash merge {{selectedRef}} into {{currentBranch}}")};}
  async readMergeState(context,ref) {
    const [head,branch,selected,ff,staged]=await Promise.all([
      this.boundedGit(["rev-parse","--quiet","--verify","HEAD"],128,context),
      this.boundedGit(["symbolic-ref","--quiet","HEAD"],65536,context),
      this.boundedGit(["rev-parse","--verify","--end-of-options",`${ref}^{commit}`],128,context),
      this.boundedGit(["config","--get","merge.ff"],65536,context),
      this.boundedGit(["diff","--cached","--quiet","--no-ext-diff","--no-textconv"],1024,context),
    ]);
    if(staged.code!==0&&staged.code!==1)checked(staged);
    return {head:optional(head),branch:optional(branch),hash:checked(selected).trim(),ff:optional(ff),staged:staged.code===1};
  }
  async mergeBranchName(state,context) {
    if(state.branch.startsWith("refs/heads/"))return state.branch.slice(11);
    const rebasing=checked(await exec("sh",["-c",REBASE_BRANCH],context)).replace(/\n$/,"");
    return rebasing.startsWith("refs/heads/")?rebasing.slice(11):"HEAD";
  }
  mergeMenu(it,cx) {
    if(!it)return this.say("Select a branch to merge",cx);
    if(this.selectedItems().length>1)return this.say("Select one branch to merge",cx);
    const plan={context:{cwd:this.root,on:this.on,timeout:60000},repoKey:this.repoKey,ref:it.ref??it.name,name:it.name,settings:this.mergeSettings()};
    this.perform("Reading merge options",async(_git,context,cx)=>{
      const state=await this.readMergeState(context,plan.ref);if(!this.subprocessCurrent(plan))return;
      if(state.branch===plan.ref||(it.current&&!it.detached))throw new Error("Cannot merge a branch into itself");
      plan.state=state;plan.branch=await this.mergeBranchName(state,context);
      const ancestor=state.head?await this.boundedGit(["merge-base","--is-ancestor",state.head,state.hash],1024,context):{code:1};
      if(ancestor.code!==0&&ancestor.code!==1)checked(ancestor);
      if(!this.subprocessCurrent(plan))return;
      this.menuItems(`Merge ${plan.name} into ${plan.branch}`,mergeChoices(plan.settings.args,state.ff,ancestor.code===0,state.staged).map(choice=>[
        choice.label,choice.key,cx=>this.ask(choice.label,`Merge ${plan.name} (${state.hash.slice(0,7)}) into ${plan.branch}${choice.variant==="squash"?(choice.commit?" as one commit":" and leave the changes staged"):""}?`,cx=>this.runMerge(plan,choice,cx),cx),false,null,choice.disabled,
      ]),cx);
    },cx,{reads:true,done:""});
  }
  runMerge(plan,choice,cx) {
    if(!this.subprocessCurrent(plan))return this.say("The repository changed; open merge options again",cx);
    const squash=choice.variant==="squash",label=squash?"Squash merge":"Merge";let completed=false;
    this.perform(label,async(git,context)=>{
      const state=await this.readMergeState(context,plan.ref);if(!this.subprocessCurrent(plan))return;
      if(state.head!==plan.state.head||state.branch!==plan.state.branch||state.hash!==plan.state.hash)throw new Error("HEAD or the selected branch changed; review merge options again");
      if(state.ff!==plan.state.ff||JSON.stringify(this.mergeSettings())!==JSON.stringify(plan.settings))throw new Error("Merge settings changed; review merge options again");
      if(squash&&state.staged)throw new Error("Commit or unstage existing staged changes before squash merging");
      this.startedOperation=squash?(choice.commit?"squash-merge":null):"merge";
      let mergeError;
      try{await git(mergeArgs(plan.ref,choice.variant,plan.settings.args));}catch(error){mergeError=error;}
      if(squash){
        const message=squashMergeMessage(plan.settings.message,plan.name,plan.branch);
        checked(await exec("sh",["-c",WRITE_SQUASH_MESSAGE,"sh",message],context));
      }
      if(mergeError)throw mergeError;
      // Upstream's immediate squash-and-commit skips the editor even when
      // manualCommit is enabled. Manual continuation below honors that setting.
      if(squash&&choice.commit)await git(["commit","--no-edit"]);
      completed=!squash||choice.commit;
    },cx,{after:()=>{if(completed)this.sel.commits=0;}});
  }
  continueOperation(op,cx) {
    const commands=operationCommands(op);if(!commands)return this.say("No Git operation in progress",cx);
    const plan={kind:commands.label,terminalName:"git-continue",context:{cwd:this.root,on:this.on,timeout:60000},repoKey:this.repoKey};
    const manual=(op==="merge"||op==="squash-merge")&&this.configValue("git.merging.manualCommit",false);
    let completed=false;
    this.perform(`Continue ${commands.label}`,async(git,context,cx)=>{
      if(manual)await this.prepareGitTerminal();
      const state=checked(await exec("sh",["-c",OPERATION_STATE_SCRIPT],context));
      if(!this.subprocessCurrent(plan))return;
      if(operationFromState(state)!==op)throw new Error("The Git operation changed; review it before continuing");
      if(manual)checked(await this.gitTerminal(plan,["git",...(op==="squash-merge"?["commit"]:commands.continue)],`Continue ${commands.label}`,cx));
      else await git(commands.continue);
      if(op==="rebase")await this.runRebaseContinuation(git,context);
      completed=true;
    },cx,{after:()=>{if(completed&&(op==="merge"||op==="squash-merge"))this.sel.commits=0;}});
  }
}
