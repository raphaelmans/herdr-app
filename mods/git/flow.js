import { exec } from "herdr";
import { GitSubprocess } from "./subprocess.js";
import { gitFlowPrefixes, gitFlowFinish, GIT_FLOW_STARTS } from "./flow-config.js";

const checked=result=>{if(result.code!==0)throw new Error((result.stderr||result.stdout).trim().slice(-1800)||`Command exited ${result.code}`);return result.stdout;};

export class GitFlow extends GitSubprocess {
  async readGitFlow(context) {
    const results=await Promise.all(["gitflow.prefix","gitflow\\.branch\\..*\\.prefix"].map(pattern=>this.boundedGit(["config","--local","--get-regexp",pattern],65536,context)));
    for(const result of results){if(result.code!==0&&result.code!==1)checked(result);if(result.truncated)throw new Error("Git-flow configuration exceeds the read limit");}
    return gitFlowPrefixes(...results.map(result=>result.stdout));
  }
  gitFlowMenu(branch,cx) {
    if(!branch)return this.say("Select a local branch",cx);
    const plan={kind:"Git-flow",terminalName:"git-flow",context:{cwd:this.root,on:this.on,timeout:60000},repoKey:this.repoKey,branch:{...branch},multiple:this.selectedItems().length>1};
    this.perform("Reading Git-flow configuration",async(_git,context,cx)=>{
      const prefixes=await this.readGitFlow(context);if(!this.subprocessCurrent(plan))return;
      if(!prefixes.size)throw new Error("Install git-flow and enable it in this repository to use Git-flow actions");
      plan.prefixes=prefixes;
      this.menuItems("Git-flow",[
        [`Finish branch '${branch.name}'…`,"",cx=>{
          let argv;try{argv=gitFlowFinish(branch.name,prefixes);}catch(error){return this.say(error.message,cx);}
          this.ask("Finish Git-flow branch",`Finish ${branch.name} (${branch.hash?.slice(0,7)??""})? Git-flow may merge it, create a tag or remove the branch according to this repository's settings.`,cx=>this.runGitFlow(plan,argv,cx),cx);
        },false,null,plan.multiple?"Select one branch to finish":null],
        ...GIT_FLOW_STARTS.map(([type,key])=>[`Start ${type}…`,key,cx=>this.promptValue(`New ${type} name`,"",(name,cx)=>this.runGitFlow(plan,["git","flow",type,"start",name],cx),cx)]),
      ],cx);
    },cx,{reads:true,done:""});
  }
  runGitFlow(plan,argv,cx) {
    if(!this.subprocessCurrent(plan))return this.say("The repository changed; open Git-flow again",cx);
    const finish=argv[3]==="finish",label=finish?`Finishing ${plan.branch.name}`:`Starting ${argv[2]}`;let completed=false;
    this.perform(label,async(_git,context,cx)=>{
      if(!this.subprocessCurrent(plan))return;
      await this.prepareGitTerminal();
      const version=await this.boundedGit(["flow","version"],4096,context);
      if(version.code!==0)throw new Error("Git-flow is not available on this repository's machine; install git-flow to run this action");
      if(!this.subprocessCurrent(plan))return;
      const prefixes=await this.readGitFlow(context);
      if(!this.subprocessCurrent(plan))return;
      if(!prefixes.size)throw new Error("Git-flow is no longer enabled in this repository");
      if(finish){
        if(JSON.stringify(gitFlowFinish(plan.branch.name,prefixes))!==JSON.stringify(argv))throw new Error("Git-flow prefixes changed; review the branch again");
        const hash=checked(await exec("git",["rev-parse","--verify","--end-of-options",`${plan.branch.ref??`refs/heads/${plan.branch.name}`}^{commit}`],context)).trim();
        if(hash!==plan.branch.hash)throw new Error("The selected branch changed; review it before finishing");
      }
      if(!this.subprocessCurrent(plan))return;
      const result=await this.gitTerminal(plan,argv,label,cx);
      checked(result);completed=true;
    },cx,{done:"",after:()=>{if(completed)this.info=finish?`Finished ${plan.branch.name}`:`Started ${argv[2]} ${argv[4]}`;}});
  }
}
