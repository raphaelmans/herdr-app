import { exec, hc, openOverlay } from "herdr";
import { div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { GitKeybindings, eventKey } from "./keybindings.js";
import { commandsForContext, normalizeKey } from "./config.js";
import { renderTemplate, splitCommandArgs } from "./templates.js";
import { snapshotCommandData, menuFromOutput } from "./command-data.js";
import { hydrateCommandData } from "./command-hydration.js";
import { shellQuote } from "./patch.js";
import { OPERATION_STATE_SCRIPT, operationFromState } from "./status.js";

const checked=r=>{if(r.code!==0)throw new Error((r.stderr||r.stdout).trim()||`Command exited ${r.code}`);return r.stdout;};
const colors=Object.fromEntries(["default","black","red","green","yellow","blue","magenta","cyan","white","bold","underline"].map(name=>[name,text=>text]));
const CAPTURE='dir=$1; shift; trap \'rm -rf -- "$dir"\' EXIT; "$@" > "$dir/output" 2>&1; code=$?; bytes=$(wc -c < "$dir/output"); if test "$bytes" -gt 262144; then printf "[Earlier output omitted]\\n"; fi; tail -c 262144 "$dir/output"; exit "$code"';
const clone=x=>JSON.parse(JSON.stringify(x));

export class GitCommands extends GitKeybindings {
  initCommands() { this.customSession=null;this.customJob=null;this.customOutput=null;this.commandCaptures=new Set(); }
  commandPlatform() { return this.configuration?.environment?.env?.LAZYGIT_KEYBINDING_PLATFORM||this.configuration?.environment?.platform||"darwin"; }
  configuredCommands(context=this.keyContext()) { return commandsForContext(this.lazygitConfig,context); }
  runCustomBinding(context,key,cx,globalOnly) {
    const command=this.configuredCommands(context).find(command=>{
      const global=command.context==="global"||Array.isArray(command.commandMenu);
      return global===globalOnly&&normalizeKey(command.key??[],this.commandPlatform()).includes(key);
    });
    if(!command)return false;this.startConfiguredCommand(command,cx);return true;
  }
  customCommandsMenu(cx) {
    const commands=this.configuredCommands();
    this.menuItems("Custom commands",commands.map(command=>[command.description||command.command||"Command menu",(Array.isArray(command.key)?command.key:[command.key]).filter(Boolean).join(" / "),cx=>this.startConfiguredCommand(command,cx)]),cx);
    if(!commands.length)this.say("No custom commands are configured for this context",cx);
  }
  cancelConfiguredCommand(session=this.customSession) { if(session){session.cancelled=true;if(this.customSession===session)this.customSession=null;} }
  customCurrent(session) { return !session.cancelled&&!this.closed&&this.customSession===session&&this.repoKey===session.repoKey&&this.root===session.context.cwd&&this.on===session.context.on; }
  customWork(session,label,work,cx) {
    if(!this.customCurrent(session)||this.busy)return;
    const job=session.job={};this.customJob=job;this.busy=label;this.note=null;cx.notify();
    cx.spawn(async cx=>{
      try{await work(cx);}
      catch(error){if(this.customCurrent(session)){this.note=`${label}: ${error.message??error}`;this.cancelConfiguredCommand(session);}}
      finally{if(this.customJob===job){this.customJob=null;this.busy=null;}if(!this.closed)cx.notify();}
    });
  }
  commandShell(session) {
    const shell=session.environment?.env?.SHELL||"bash";
    const file=session.config.os?.shellFunctionsFile;
    // User configuration deliberately supplies shell code. Values substituted
    // through quote are quoted for this shell, never by the UI's host shell.
    return {shell,prefix:file?`. ${shellQuote(file)}\n`:""};
  }
  shellArgv(command,session) { const {shell,prefix}=this.commandShell(session);return [shell,"-c",prefix+command]; }
  templateOptions(session) {
    const {shell}=this.commandShell(session),name=shell.split(/[\\/]/).pop().toLowerCase();
    return {quote:value=>{
      if(name==="fish")return "'"+String(value).replace(/\\/g,"\\\\").replace(/'/g,"\\'")+"'";
      if(["pwsh","powershell"].includes(name))return "'"+String(value).replace(/'/g,"''")+"'";
      if(name==="cmd"||name==="cmd.exe")throw new Error("The quote helper requires a POSIX shell, fish or PowerShell");
      return shellQuote(value);
    },runCommand:async command=>{
      if(!this.customCurrent(session))throw new Error("Command cancelled");
      const argv=splitCommandArgs(command,{platform:session.environment?.platform==="windows"?"windows":"posix"});
      if(!argv.length)throw new Error("runCommand is empty");
      return checked(await this.captureCustom(argv,session.context,null,null,()=>this.customCurrent(session)));
    }};
  }
  async renderCommand(text,session,data=session.data,labels=false) {
    return renderTemplate(String(text??""),data,{...this.templateOptions(session),...(labels?{colors}:{})});
  }
  async captureCustom(argv,context,onOutput,cx,current=()=>!this.closed) {
    if(!current())throw new Error("Command cancelled");
    const temp=checked(await exec("sh",["-c",'umask 077; mktemp -d "${TMPDIR:-/tmp}/herdr-git-command.XXXXXX"'],context)).replace(/\n$/,"");
    let ended=false,polling=false;
    const capture={temp,context,timer:null};
    try{
      if(!current())throw new Error("Command cancelled");
      this.commandCaptures.add(capture);
      if(onOutput&&cx)capture.timer=cx.timer.every(250,cx=>{
        if(ended||polling||!current())return;polling=true;
        cx.spawn(async()=>{try{const r=await exec("sh",["-c",'test -f "$1/output" && tail -c 65536 "$1/output"',"sh",temp],context);if(!ended&&current()&&r.code===0)onOutput(r.stdout);}catch{}finally{polling=false;}});
      });
      return await exec("sh",["-c",CAPTURE,"sh",temp,...argv],{...context,timeout:600000});
    }
    finally{ended=true;capture.timer?.cancel();this.commandCaptures.delete(capture);await exec("sh",["-c",'rm -rf -- "$1"',"sh",temp],context);}
  }
  async hydrateCommandData(session) {
    return hydrateCommandData(session.data,{exec,context:session.context,current:()=>this.customCurrent(session)});
  }
  startConfiguredCommand(command,cx) {
    if(this.busy||this.loading)return this.say("Wait for the current operation to finish",cx);
    if(!this.root)return this.say("No repository",cx);
    this.cancelConfiguredCommand();
    this.customOutput=null;
    const session={command:clone(command),data:snapshotCommandData(this),context:{cwd:this.root,on:this.on},repoKey:this.repoKey,environment:clone(this.configuration?.environment??{}),config:clone(this.lazygitConfig),index:0};
    this.customSession=session;
    session.data.PromptResponses=Array(command.prompts?.length??0).fill("");
    if(command.commandMenu?.length)return this.showCommandGroup(session,command.commandMenu,cx);
    this.customWork(session,"Preparing command",async cx=>{await this.hydrateCommandData(session);await this.nextCommandPrompt(session,cx);},cx);
  }
  showCommandGroup(session,commands,cx) {
    this.openMenu({title:session.command.description||"Custom commands",items:commands.map(command=>({label:command.description||command.command||"Command menu",hint:(Array.isArray(command.key)?command.key:[command.key]).filter(Boolean).join(" / "),keys:normalizeKey(command.key??[],this.commandPlatform()),run:cx=>{
      session.command=command;session.index=0;
      session.data.PromptResponses=Array(command.prompts?.length??0).fill("");session.data.Form={};
      if(command.commandMenu?.length)this.showCommandGroup(session,command.commandMenu,cx);
      else this.customWork(session,"Preparing command",async cx=>{await this.hydrateCommandData(session);await this.nextCommandPrompt(session,cx);},cx);
    }})),onCancel:()=>this.cancelConfiguredCommand(session)},cx);
  }
  async nextCommandPrompt(session,cx) {
    if(!this.customCurrent(session))return;
    const prompts=session.command.prompts??[],index=session.index++,prompt=prompts[index];
    if(!prompt)return this.executeConfiguredCommand(session,cx);
    const condition=prompt.condition? (await this.renderCommand(prompt.condition,session)).trim():"true";
    if(!condition||condition==="false"){
      if(!Object.hasOwn(session.data.Form,prompt.key??""))session.data.Form[prompt.key??""]="";
      return this.nextCommandPrompt(session,cx);
    }
    const title=await this.renderCommand(prompt.title||"Custom command",session);
    const answer=(value,cx)=>{
      if(!this.customCurrent(session))return;
      if(prompt.type!=="confirm"){session.data.PromptResponses[index]=value;session.data.Form[prompt.key??""]=value;}
      this.customWork(session,"Preparing command",cx=>this.nextCommandPrompt(session,cx),cx);
    };
    if(prompt.type==="confirm"){
      const body=await this.renderCommand(prompt.body??"",session);if(!this.customCurrent(session))return;
      this.ask(title,body,cx=>answer("",cx),cx);this.pending.onCancel=()=>this.cancelConfiguredCommand(session);return;
    }
    if(prompt.type==="input"){
      const initial=await this.renderCommand(prompt.initialValue??"",session),suggestions=await this.commandSuggestions(prompt.suggestions,session);
      if(!this.customCurrent(session))return;
      this.promptValue(title,initial,answer,cx,{empty:true,raw:true,suggestions,onCancel:()=>this.cancelConfiguredCommand(session)});return;
    }
    let options;
    if(prompt.type==="menu"){
      options=await Promise.all((prompt.options??[]).map(async option=>({value:await this.renderCommand(option.value??"",session),label:await this.renderCommand(option.name||option.value||"",session),description:await this.renderCommand(option.description??"",session),keys:normalizeKey(option.key??[],session.environment.env?.LAZYGIT_KEYBINDING_PLATFORM||session.environment.platform||"darwin")})));
    }else if(prompt.type==="menuFromCommand"){
      const command=await this.renderCommand(prompt.command??"",session),argv=splitCommandArgs(command,{platform:session.environment.platform==="windows"?"windows":"posix"});
      if(!argv.length)throw new Error("Menu command is empty");
      if(!this.customCurrent(session))return;
      const output=checked(await this.captureCustom(argv,session.context,null,null,()=>this.customCurrent(session)));
      const filter=await this.renderCommand(prompt.filter??"",session);
      options=await menuFromOutput(output,{...prompt,filter},(text,data,opts)=>renderTemplate(text,data,{missingKey:"default",mapZeroValue:"",allowCommands:false,...(opts?.kind==="label"?{colors}:{})}));
    }else throw new Error(`Unsupported prompt type ${prompt.type}`);
    if(!this.customCurrent(session))return;
    this.openMenu({title,items:options.map(option=>({label:option.label??option.name??option.value,hint:option.description??"",keys:option.keys??[],run:cx=>answer(option.value,cx)})),onCancel:()=>this.cancelConfiguredCommand(session)},cx);
    if(!options.length)this.say("No menu options matched the command output",cx);
  }
  async commandSuggestions(suggestions,session) {
    if(!suggestions)return [];
    if(suggestions.command&&suggestions.preset)throw new Error("Command suggestions must use either a preset or a command");
    if(suggestions.command){const command=await this.renderCommand(suggestions.command,session);if(!this.customCurrent(session))return [];return checked(await this.captureCustom(this.shellArgv(command,session),session.context,null,null,()=>this.customCurrent(session))).split(/\r?\n/).filter(Boolean).slice(0,1000);}
    const args={authors:["log","-n","1000","--format=%an <%ae>"],branches:["for-each-ref","--format=%(refname:short)","refs/heads"],refs:["for-each-ref","--format=%(refname:short)"],remotes:["remote"],remoteBranches:["for-each-ref","--format=%(refname:short)","refs/remotes"],tags:["tag","--list"],files:["ls-files","--cached","--others","--exclude-standard","-z"]}[suggestions.preset];
    if(!args)throw new Error(`Unknown command suggestion preset ${suggestions.preset}`);
    if(!this.customCurrent(session))return [];
    const result=await this.captureCustom(["git",...args],session.context,null,null,()=>this.customCurrent(session));
    return [...new Set(checked(result).split(args.includes("-z")?"\0":/\r?\n/).filter(Boolean))].slice(0,1000);
  }
  async executeConfiguredCommand(session,cx) {
    const command=await this.renderCommand(session.command.command??"",session),output=session.command.output||"none";
    if(!command.trim())throw new Error("Custom command is empty");
    if(!["none","popup","log","logWithPty","terminal"].includes(output))throw new Error(`Unsupported output mode ${output}`);
    if(!this.customCurrent(session))return;
    const title=command,label=session.command.loadingText||"Running command";
    this.busy=label;
    const record={title,text:"",running:true,popup:output==="popup",terminal:null,scroll:ScrollHandle.new(),cursor:0};
    if(output==="log"||output==="logWithPty"){this.customOutput=record;this.main=true;}cx.notify();
    let result;
    try{
      if(output==="terminal"||output==="logWithPty")result=await this.runCustomTerminal(this.shellArgv(command,session),session,record,output==="terminal",cx);
      else result=await this.captureCustom(this.shellArgv(command,session),session.context,output==="log"?text=>{if(this.customCurrent(session)){record.text=text;cx.notify();}}:null,cx,()=>this.customCurrent(session));
      if(!this.customCurrent(session))return;
      record.text=result.stdout||result.stderr;record.code=result.code;
      this.commandLog.push({label,command,code:result.code,output:record.text.slice(-2500)});if(this.commandLog.length>30)this.commandLog.shift();
      if(result.code!==0){
        this.note=`${label} failed (${result.code}): ${(result.stderr||result.stdout).slice(-1200)}`;
        if(session.command.after?.checkForConflicts&&output!=="terminal"){
          const state=await exec("sh",["-c",OPERATION_STATE_SCRIPT],session.context);
          if(!this.customCurrent(session))return;
          this.startedOperation=operationFromState(state.stdout);this.customOutput=null;this.panel="files";this.fileView="files";this.main=false;this.contexts.files=[];
        }
      }else{
        this.info="Command completed";
        if(output==="popup"){
          record.title=session.command.outputTitle?await this.renderCommand(session.command.outputTitle,session):command;
          if(!this.customCurrent(session))return;
          record.text=record.text.trim()?record.text:"Empty output";this.customOutput=record;
        }
      }
    }catch(error){
      if(this.customCurrent(session))this.note=`${label} failed: ${error.message??error}`;
    }finally{
      const current=this.customCurrent(session);record.running=false;
      if(this.customJob===session.job){this.customJob=null;this.busy=null;}
      this.cancelConfiguredCommand(session);
      if(current){this.settling=label;this.refresh(cx,true);cx.notify();}
    }
  }
  async runCustomTerminal(argv,session,record,interactive,cx) {
    const args=["run","--json","--bg","--no-parent","--no-notify","--cwd",session.context.cwd,"--name",`git-command-${Date.now()}`];
    if(session.context.on)args.push("--on",session.context.on);
    const started=JSON.parse(checked(await hc([...args,"--",...argv])));
    const address=session.context.on&&!started.address.includes("/")?`${session.context.on}/${started.address}`:started.address;record.terminal=address;
    if(interactive&&this.customCurrent(session))this.openCommandTerminal(address);
    let terminal=started,text="",failure;
    try{
      while(terminal.state!=="finished"){
        if(!interactive){const read=JSON.parse(checked(await hc(["read",address,"--json","--lines","1000"])));text=read.text;if(this.customCurrent(session)){record.text=text;cx.notify();}}
        checked(await hc(["wait",address,"--timeout","1","--json"]));terminal=JSON.parse(checked(await hc(["get",address,"--json"])));
      }
      text=JSON.parse(checked(await hc(["read",address,"--json","--lines","1000"]))).text;
      return {code:terminal.exit_code??1,stdout:text,stderr:""};
    }catch(error){failure=error;throw error;}
    finally{
      if(!interactive)try{
        if(failure){
          const state=await hc(["get",address,"--json"]);
          if(state.code!==0||JSON.parse(state.stdout).state!=="finished")checked(await hc(["kill",address]));
        }
        checked(await hc(["rm",address]));
      }catch(error){if(failure)failure.message+=`; could not clean up ${address}: ${error.message}`;else throw error;}
    }
  }
  openCommandTerminal(address) { openOverlay({kind:"dialog",modal:true,width:0.94,height:0.9,layout:{type:"block",content:{terminal:address}}}); }
  customOutputView(c) {
    const output=this.customOutput;if(!output)return null;
    return v_flex().size_full().min_h(0).p(12).gap(10)
      .child(h_flex().items_center().gap(10).child(div().flex_1().font_semibold().child(output.title))
        .when(output.running,e=>e.child(this.waiting("Running",c)))
        .when(Boolean(output.terminal)&&output.running,e=>e.child(this.button("command-terminal","Open terminal",c,()=>this.openCommandTerminal(output.terminal),{duringBusy:true})))
        .child(this.button("close-command-output","Close",c,cx=>{this.customOutput=null;cx.notify();},{duringBusy:true})))
      .child(v_flex().id("custom-command-output").flex_1().min_h(0).overflow_y_scroll().track_scroll(output.scroll).children(output.text.split("\n").slice(-2000).map(line=>div().flex_none().font_family(c.mono).text_size(12).child(line||" "))));
  }
  customOutputModal(c) { return div().absolute().inset_0().flex().items_center().justify_center().bg(c.background+"88").child(div().w(720).h(480).rounded(10).bg(c.popover).border_1().border_color(c.border).child(this.customOutputView(c))); }
  customFlowKeys(e,cx) {
    if(this.customOutput&&!this.prompt&&!this.pending&&!this.menu&&(this.customOutput.popup||this.main)){
      const output=this.customOutput,k=e.key,ch=e.key_char??k;
      if(k==="escape"){this.customOutput=null;cx.notify();return true;}
      const by={j:1,k:-1,down:1,up:-1,pagedown:20,pageup:-20}[ch];
      if(by){output.cursor=Math.max(0,Math.min(Math.min(2000,output.text.split("\n").length)-1,output.cursor+by));output.scroll.scroll_to_item(output.cursor);cx.notify();return true;}
      if(output.popup)return true;
    }
    if(!this.typing&&this.menu?.items.some(it=>it.keys?.length)){
      const key=eventKey(e,this.commandPlatform()),at=this.menuEntries().findIndex(it=>it.keys?.includes(key));
      if(at>=0){this.pickMenu(at,cx);return true;}
    }
    return false;
  }
  promptSuggestions() { return (this.prompt?.suggestions??[]).filter(value=>value.toLowerCase().includes(this.message.toLowerCase())).slice(0,8).map(value=>({value})); }
  suggestionView(c) {
    return v_flex().max_h(160).overflow_y_scroll().gap(2).children(this.promptSuggestions().map((it,n)=>div().id(`command-suggestion-${n}`).px(8).py(4).rounded(4).text_size(12).text_color(c.muted).cursor_pointer().hover(s=>s.bg(c.hover)).on_click((_e,cx)=>{this.message=it.value;this.input.set_value(it.value);this.input.focus();cx.notify();}).child(it.value)));
  }
}
