import { hc, openOverlay, closeOverlay, notify } from "herdr";
import { GitRecovery } from "./recovery.js";
import { GIT_SUBPROCESS } from "./subprocess-script.js";

const checked=result=>{if(result.code!==0)throw new Error((result.stderr||result.stdout).trim().slice(-1800)||`Command exited ${result.code}`);return result.stdout;};

// Interactive Git commands own one terminal and its current overlay. Leaving
// the parent retains its output; cleanup failure never changes the exit result.
export class GitSubprocess extends GitRecovery {
  subprocessCurrent(plan) {return !this.closed&&this.root===plan.context.cwd&&this.on===plan.context.on&&this.repoKey===plan.repoKey;}
  async prepareGitTerminal() {
    const previous=this.gitTask;if(!previous?.terminal)return;
    const state=JSON.parse(checked(await hc(["get",previous.terminal,"--json"])));
    if(state.state!=="finished")throw new Error(`${previous.kind} is still running in ${previous.terminal}; open its terminal from More`);
    if(!previous.retained){
      if(!previous.captured)await this.captureGitOutput(previous,state);
      checked(await hc(["rm",previous.terminal]));
    }
    this.gitTask=null;
  }
  gitTerminalNotice(task,body) {
    try{notify({title:task.label,body:`${body}\nTerminal: ${task.terminal}`,level:"warning",timeout:0,action:{name:"terminal.peek",args:{terminal:task.terminal}}});}catch{}
  }
  gitTerminalOnClose() {
    const task=this.gitTask;
    if(task?.terminal&&(!task.finished||!task.captured)&&!task.closeNotified){
      task.closeNotified=true;
      this.gitTerminalNotice(task,task.finished?`The Git dialog closed before ${task.kind} output was captured. Its terminal remains available.`:`The Git dialog closed while ${task.kind} was running. Open its terminal to continue.`);
    }
  }
  openGitTerminal(task=this.gitTask) {
    if(!task?.terminal)return;
    if(task.overlay)closeOverlay(task.overlay);
    task.overlay=openOverlay({kind:"dialog",modal:true,width:0.94,height:0.9,layout:{type:"block",content:{terminal:task.terminal}}});
  }
  async captureGitOutput(task,state) {
    const output=JSON.parse(checked(await hc(["read",task.terminal,"--json","--lines","1000"])));
    const result={code:state.exit_code??1,stdout:output.text??"",stderr:""};
    this.commandLog.push({label:task.label,command:task.argv.join(" "),code:result.code,output:result.stdout.slice(-2500)});
    if(this.commandLog.length>30)this.commandLog.shift();
    task.captured=true;return result;
  }
  async gitTerminal(plan,argv,label,cx) {
    const task={label,argv,kind:plan.kind??"Git command",terminal:null,overlay:null,finished:false,captured:false};this.gitTask=task;
    try {
      const args=["run","--json","--bg","--no-parent","--no-notify","--cwd",plan.context.cwd,"--name",`${plan.terminalName??"git-command"}-${Date.now()}`];
      if(plan.context.on)args.push("--on",plan.context.on);
      const wrapper=["sh","-c",GIT_SUBPROCESS,"sh",String(this.configValue("promptToReturnFromSubprocess",true)),...argv];
      let state=JSON.parse(checked(await hc([...args,"--",...wrapper])));
      if(typeof state.address!=="string"||!state.address)throw new Error("Herdr did not return a terminal address");
      task.terminal=plan.context.on&&!state.address.includes("/")?`${plan.context.on}/${state.address}`:state.address;
      cx.notify();
      if(state.state!=="finished"){
        if(this.subprocessCurrent(plan))this.openGitTerminal(task);
        else if(this.closed)this.gitTerminalOnClose();
        else this.gitTerminalNotice(task,`${task.kind} started for the previous repository. Open its terminal to continue.`);
      }
      while(state.state!=="finished"){
        checked(await hc(["wait",task.terminal,"--timeout","1","--json"]));
        state=JSON.parse(checked(await hc(["get",task.terminal,"--json"])));
      }
      task.finished=true;
      return await this.captureGitOutput(task,state);
    }catch(error){
      if(task.terminal)this.gitTerminalNotice(task,task.finished?`Could not read ${task.kind} output. Its terminal remains available.`:`Could not observe ${task.kind} finishing. Its terminal remains available.`);
      throw error;
    }finally{
      if(task.finished&&task.captured&&this.subprocessCurrent(plan)){
        try{
          if(task.overlay)closeOverlay(task.overlay);
          checked(await hc(["rm",task.terminal]));
          if(this.gitTask===task)this.gitTask=null;
        }catch(error){this.gitTerminalNotice(task,`${task.kind} finished, but its terminal could not be removed: ${error.message}`);}
        // Closing a terminal overlay leaves its terminal focus handle behind.
        // Return keys even if removing its already-finished terminal failed.
        if(this.subprocessCurrent(plan))this.handle.focus();
      }else if(task.finished&&task.terminal&&!this.subprocessCurrent(plan)){
        task.retained=true;
        if(!task.closeNotified)this.gitTerminalNotice(task,`${task.kind} finished after leaving its Git dialog. Its terminal and output remain available.`);
      }else if(!task.terminal&&this.gitTask===task)this.gitTask=null;
      cx.notify();
    }
  }
}
