import { exec, checking, notify } from "herdr";
import { GitMerge } from "./merge.js";
import { EDITOR_ENVIRONMENT, editorEnvironment, editorCommand, openCommand, diffToolArgs, absoluteEditorPath } from "./editor-config.js";
import { diffLineTarget, adjustEditorLine } from "./editor-diff.js";
import { patchLineIdentity, prepareEditableHunk, normalizeEditedHunk } from "./editor-hunk.js";
import { filePaths } from "./status.js";

const checked=result=>{if(result.code!==0)throw new Error(`Command exited ${result.code}${(result.stderr||result.stdout).trim()?": "+(result.stderr||result.stdout).trim().slice(-1800):""}`);if(result.truncated)throw new Error("Editor metadata exceeds the read limit");return result.stdout;};
const clone=value=>JSON.parse(JSON.stringify(value));

export class GitExternal extends GitMerge {
  externalCurrent(plan) {return this.externalJob===plan&&this.subprocessCurrent(plan);}
  externalStage(plan,label,cx,reading=false) {
    if(!this.externalCurrent(plan))return false;
    this.busy=label;this.opening=reading?label:null;cx.notify();return true;
  }
  externalWork(label,work,cx) {
    if(this.busy||checking())return;
    if(this.loading||this.reading)return this.say("Wait for the repository to finish loading",cx);
    if(!this.root)return this.say("No repository",cx);
    const plan={label,kind:label,terminalName:"git-external",context:{cwd:this.root,on:this.on,timeout:60000},repoKey:this.repoKey,
      os:clone(this.lazygitConfig?.os??{}),environment:clone(this.configuration?.environment??{}),refresh:false};
    this.externalJob=plan;this.note=null;this.info=null;this.externalStage(plan,`Preparing ${label.toLowerCase()}`,cx,true);
    cx.spawn(async cx=>{
      try{await work(plan,cx);if(this.externalCurrent(plan))this.info=label;}
      catch(error){if(this.externalCurrent(plan))this.note=`${label} failed: ${error.message??error}`;}
      finally{
        const current=this.externalCurrent(plan);
        if(this.externalJob===plan){this.externalJob=null;this.busy=null;this.opening=null;}
        if(current){
          if(plan.refresh||this.externalRefreshNeeded){this.externalRefreshNeeded=false;this.externalSettling=plan;this.busy="Refreshing repository";this.settling=label;this.refresh(cx,true);}
          cx.notify();
        }
      }
    });
  }
  async readEditorConfiguration(plan) {
    const [environment,core]=await Promise.all([
      exec("sh",["-c",EDITOR_ENVIRONMENT],plan.context),
      this.boundedGit(["config","--get","core.editor"],65536,plan.context),
    ]);
    plan.environment=editorEnvironment(checked(environment),plan.environment);
    plan.coreEditor=core.code===1?"":checked(core).replace(/\n$/,"");
  }
  async externalCommand(plan,command,label,cx) {
    if(!this.externalCurrent(plan))return;
    if(command.terminal)await this.prepareGitTerminal();
    if(!this.externalStage(plan,label,cx))return;
    plan.started=true;
    let result;
    if(command.terminal)result=await this.gitTerminal(plan,command.argv,label,cx);
    else {
      result=await this.captureCustom(command.argv,plan.context,null,null,()=>this.externalCurrent(plan));
      this.commandLog.push({label,command:command.argv.join(" "),code:result.code,output:(result.stderr||result.stdout).slice(-2500)});
      if(this.commandLog.length>30)this.commandLog.shift();
    }
    checked(result);
  }
  async browseURL(url,plan,cx) {
    await this.readEditorConfiguration(plan);
    await this.externalCommand(plan,openCommand(plan.os,plan.environment,url,true),"Opening browser",cx);
  }
  openLink(url,cx,label="Open link") {
    this.externalWork(label,(plan,cx)=>this.browseURL(url,plan,cx),cx);
  }
  editConfiguration(cx) {
    const candidates=(this.configuration?.files??[]).map(file=>file.path);
    this.externalWork("Configuration editor",async(plan,cx)=>{
      const text=checked(await exec("sh",["-c",'for path do if test -f "$path"; then printf "%s\\0" "$path"; fi; done',"sh",...candidates],plan.context));
      if(!this.externalCurrent(plan))return;
      const paths=text.split("\0").filter(Boolean);
      if(!paths.length)throw new Error("No configuration file found");
      if(paths.length>1){
        this.openMenu({title:"Select configuration file",pathLabels:true,items:paths.map(path=>({label:path,run:cx=>{
          if(!this.subprocessCurrent(plan))return this.say("The repository changed; open the configuration menu again",cx);
          this.editFiles([path],cx,{existing:true});
        }}))},cx);
        return;
      }
      await this.readEditorConfiguration(plan);if(!this.externalCurrent(plan))return;
      const path=absoluteEditorPath(paths[0],plan.context.cwd,plan.environment.platform);
      plan.refresh=true;plan.kind="configuration editor";
      await this.externalCommand(plan,editorCommand(plan.os,plan.environment,plan.coreEditor,{paths:[path]}),"Editing configuration",cx);
    },cx);
  }
  diffWorktreeBranch() {
    const frame=this.context();
    if(frame)return frame.worktreeBranch??null;
    return this.panel==="branches"&&this.branchContext()==="local"?this.item()?.name:null;
  }
  async editorWorktree(plan,branch) {
    if(!branch)return plan.context.cwd;
    const text=checked(await this.boundedGit(["worktree","list","--porcelain","-z"],262144,plan.context));
    for(const block of text.split("\0\0")){
      const fields=block.split("\0");if(!fields.includes(`branch refs/heads/${branch}`)||fields.some(s=>s.startsWith("prunable")))continue;
      const path=fields.find(s=>s.startsWith("worktree "))?.slice(9);
      if(path&&(await exec("sh",["-c",'test -d "$1"',"sh",path],plan.context)).code===0)return path;
    }
    return plan.context.cwd;
  }
  async existingEditorPaths(plan,paths,worktree) {
    const r=checked(await exec("sh",["-c",'for path do if test -e "$path"; then printf "%s\\0" "$path"; fi; done',"sh",...paths],plan.context));
    const existing=r.split("\0").filter(Boolean);
    if(!existing.length)throw new Error(paths.length===1?`File does not exist in the worktree: ${paths[0]}`:`None of the selected files exist in ${worktree}`);
    return existing;
  }
  editFiles(paths,cx,{line,dir,existing=false,branch=null,ref=null,staged=false}={}) {
    if(!paths.length&&dir==null)return this.say("Select a file to edit",cx);
    this.externalWork("Editor",async(plan,cx)=>{
      await this.readEditorConfiguration(plan);if(!this.externalCurrent(plan))return;
      const worktree=await this.editorWorktree(plan,branch),platform=plan.environment.platform;
      let files=paths.map(path=>absoluteEditorPath(path,worktree,platform));
      if(existing)files=await this.existingEditorPaths(plan,files,worktree);
      let targetLine=line;
      if(line!=null&&(ref||staged)){
        const result=await this.boundedGit(["--literal-pathspecs","diff","--no-color","--no-ext-diff","--no-textconv","--unified=0",...(ref?[ref]:[]),"--",files[0]],262144,{...plan.context,cwd:worktree});
        // Upstream keeps the original line when this optional mapping fails.
        if(result.code===0&&!result.truncated)targetLine=adjustEditorLine(result.stdout,line);
      }
      const command=editorCommand(plan.os,plan.environment,plan.coreEditor,{paths:files,line:targetLine,dir:dir==null?undefined:absoluteEditorPath(dir,worktree,platform)});
      plan.refresh=true;plan.kind="editor";
      await this.externalCommand(plan,command,dir==null?"Editing file":"Opening directory in editor",cx);
    },cx);
  }
  mainEditorTarget(index=this.cursor) {
    if(this.graph||this.plan||this.logOpen||this.configOpen||this.md)return null;
    if(this.conflicts&&this.diffFile)return {path:this.diffFile.path,line:index+1};
    return diffLineTarget(this.rawDiffLines??[],index);
  }
  editMain(cx,index=this.cursor) {
    const target=this.mainEditorTarget(index);if(!target)return this.say("Select a file or line in a unified diff",cx);
    const working=this.panel==="files"&&this.fileView==="files"&&!this.detail&&!this.peek;
    this.editFiles([target.path],cx,{line:target.line,existing:true,branch:this.diffWorktreeBranch(),
      ref:working?null:this.detail?.adjustRef??this.peek?.hash??this.item()?.hash??this.item()?.ref,
      staged:working&&this.shownSide==="staged"});
  }
  clickDiff(index,modifiers,cx) {
    if(this.busy||this.loading||this.reading)return;
    if((modifiers?.alt||modifiers?.shift)&&!modifiers.control&&!modifiers.platform){
      if(!this.mainEditorTarget(index))return;
      const flash=this.editedLine={index,lines:this.rawDiffLines};cx.notify();
      cx.timer.after(200,cx=>{if(this.editedLine===flash){this.editedLine=null;if(!this.closed)cx.notify();}});
      this.editMain(cx,index);return;
    }
    this.handle.focus();this.main=true;this.cursor=index;cx.notify();
  }
  editSelectedFiles(cx) {
    const detail=this.context()?.type==="files";
    const paths=this.selectedItems().filter(it=>detail?!it.dir:Boolean(it.file)).map(it=>detail?it.path:it.file.path);
    this.editFiles(paths,cx,{existing:detail,branch:this.diffWorktreeBranch()});
  }
  openSelectedFile(cx) {
    if(this.selectedItems().length!==1)return this.say("Select one file or directory to open",cx);
    const it=this.item(),path=it?.path??it?.file?.path;if(!path)return this.say("Select a file or directory to open",cx);
    const existing=this.context()?.type==="files",branch=this.diffWorktreeBranch();
    this.externalWork("Open file",async(plan,cx)=>{
      await this.readEditorConfiguration(plan);if(!this.externalCurrent(plan))return;
      const worktree=await this.editorWorktree(plan,branch),file=absoluteEditorPath(path,worktree,plan.environment.platform);
      if(existing)await this.existingEditorPaths(plan,[file],worktree);
      await this.externalCommand(plan,openCommand(plan.os,plan.environment,file),"Opening file",cx);
    },cx);
  }
  openDiffTool(cx) {
    if(this.selectedItems().length!==1)return this.say("Select one file, directory or ref for the diff tool",cx);
    const it=this.item(),frame=this.context();let spec,refresh=false,commit=null;
    if(frame?.type==="files")spec={path:it.path,directory:Boolean(it.dir),from:this.compareBase||frame.diffFrom,to:frame.diffTo,reverse:Boolean(this.compareBase&&this.compareReverse)};
    else if(!frame&&this.panel==="files"&&this.fileView==="files"){
      const files=it.file?[it.file]:this.files.filter(file=>file.path.startsWith(it.path+"/"));
      spec={path:it.file?.path??it.path,directory:Boolean(it.dir),staged:!files.some(file=>file.unstaged||file.fresh),from:this.compareBase??"",reverse:Boolean(this.compareBase&&this.compareReverse)};refresh=true;
    }else if(frame?.type==="commits"||this.panel==="commits"){
      commit=it.hash;spec={path:".",directory:true,from:this.compareBase??"",to:it.hash,reverse:Boolean(this.compareBase&&this.compareReverse)};
    }else if(this.panel==="branches"&&this.branchContext()!=="remotes"){
      spec={path:".",directory:true,from:this.compareBase??"",to:it.ref??it.hash??it.name,reverse:Boolean(this.compareBase&&this.compareReverse)};
    }else return this.say("Select a file, directory or ref for the diff tool",cx);
    this.externalWork("Diff tool",async(plan,cx)=>{
      if(commit&&!spec.from){const parents=checked(await this.boundedGit(["rev-list","--parents","-n","1",commit],1024,plan.context)).trim().split(" ");spec.from=parents[1]??"4b825dc642cb6eb9a060e54bf8d69288fbee4904";}
      plan.refresh=refresh;plan.kind="diff tool";
      await this.externalCommand(plan,{terminal:true,argv:diffToolArgs(spec)},"Running diff tool",cx);
    },cx);
  }
  openMergeTool(cx) {
    this.externalWork("Merge tool",async(plan,cx)=>{
      plan.refresh=true;plan.kind="merge tool";
      await this.externalCommand(plan,{terminal:true,argv:["git","mergetool"]},"Running merge tool",cx);
    },cx);
  }
  commitInEditor(cx) {
    this.externalWork("Commit",async(plan,cx)=>{
      const staged=await this.boundedGit(["diff","--cached","--quiet"],1024,plan.context);
      if(staged.code===0)throw new Error("Stage changes before committing");if(staged.code!==1)checked(staged);
      plan.refresh=true;plan.kind="commit editor";
      await this.externalCommand(plan,{terminal:true,argv:["git","commit"]},"Editing commit message",cx);
    },cx);
  }
  editHunk(cx) {
    if(!this.main||this.detail||this.peek||this.graph||this.panel!=="files"||this.fileView!=="files"||!this.patch||!this.diffFile)return;
    const row=this.selectedRows()[0],identity=row==null?null:patchLineIdentity(this.patch,row);if(!identity)return;
    const file={...this.diffFile},side=this.shownSide,context=this.diffContext??3,rename=this.renameThreshold??50;
    this.externalWork("Edit hunk",async(plan,cx)=>{
      await this.readEditorConfiguration(plan);if(!this.externalCurrent(plan))return;
      const fresh=file.fresh&&side!=="staged",args=["--literal-pathspecs","diff","--no-ext-diff","--no-textconv","--color=never","--src-prefix=a/","--dst-prefix=b/",`--unified=${context}`,`--find-renames=${rename}%`,"--submodule",...(side==="staged"?["--cached"]:[]),...(fresh?["--no-index"]:[]),"--",...(fresh?["/dev/null",file.path]:filePaths([file]))];
      const result=await this.boundedGit(args,262144,plan.context);
      if(fresh&&result.code===1)result.code=0;
      const prepared=prepareEditableHunk(checked(result),file.path,identity);
      if(!this.externalCurrent(plan))return;
      const folder=checked(await exec("sh",["-c",'umask 077; mktemp -d "${TMPDIR:-/tmp}/herdr-git-patch.XXXXXX"'],plan.context)).replace(/\n$/,"");
      const patchPath=`${folder}/edited.patch`,applyPath=`${folder}/apply.patch`,originalPath=`${folder}/original.patch`;
      const retained={path:patchPath,applyPath,originalPath,folder,context:plan.context,file:file.path,side};
      (this.editedPatches??=[]).push(retained);
      const retain=()=>{this.lastEditedPatch=retained;};retain();
      try{
        checked(await exec("sh",["-c",'umask 077; printf "%s" "$2" > "$1/original.patch" && cp "$1/original.patch" "$1/edited.patch"',"sh",folder,prepared.text],plan.context));
        plan.kind="hunk editor";
        await this.externalCommand(plan,editorCommand(plan.os,plan.environment,plan.coreEditor,{paths:[patchPath],line:prepared.editorLine,wait:true}),"Editing hunk",cx);
        if(!this.externalCurrent(plan))throw new Error("The Git dialog or repository changed; the edited hunk was not applied");
        this.externalStage(plan,"Applying edited hunk",cx);
        const edited=checked(await exec("sh",["-c",'test -f "$1" || { printf "Edited patch is missing" >&2; exit 1; }; test "$(wc -c < "$1")" -le 262144 || { printf "Edited patch exceeds 256 KiB" >&2; exit 1; }; cat "$1"',"sh",patchPath],plan.context));
        const normalized=normalizeEditedHunk(edited,file.path);
        checked(await exec("sh",["-c",'umask 077; printf "%s" "$2" > "$1"',"sh",applyPath,normalized],plan.context));
        if(!this.externalCurrent(plan))throw new Error("The Git dialog or repository changed; the edited hunk was not applied");
        const applied=await this.captureCustom(["git","apply","--cached",...(side==="staged"?["--reverse"]:[]),applyPath],plan.context,null,null,()=>this.externalCurrent(plan));
        this.commandLog.push({label:"Apply edited hunk",command:`git apply --cached${side==="staged"?" --reverse":""} ${applyPath}`,code:applied.code,output:(applied.stderr||applied.stdout).slice(-2500)});
        checked(applied);retained.applied=true;plan.refresh=true;
      }catch(error){
        const message=`${error.message??error}\nPatch files kept in ${folder}${plan.context.on?` on ${plan.context.on}`:""}\nEdited patch: ${patchPath}`;
        if(!this.externalCurrent(plan))notify({title:"Edited hunk kept",body:message,level:"warning",timeout:0});
        throw new Error(message);
      }
    },cx);
  }
  externalKeys(e,cx) {
    const k=e.key,m=e.modifiers??{},ch=e.key_char??(m.shift?k.toUpperCase():k);
    if(m.control&&k==="t"){this.openDiffTool(cx);return true;}
    if(m.platform||m.alt||m.control)return false;
    if(!this.main&&this.panel==="status"&&ch==="e"){this.editConfiguration(cx);return true;}
    if(this.main){
      if(ch==="e"&&!this.graph){this.editMain(cx);return true;}
      if(ch==="E"&&!this.graph){this.editHunk(cx);return true;}
      return false;
    }
    if(this.context()?.type==="files"||!this.context()&&this.panel==="files"&&this.fileView==="files"){
      if(ch==="e"){this.editSelectedFiles(cx);return true;}
      if(ch==="o"){this.openSelectedFile(cx);return true;}
    }
    if(!this.context()&&this.panel==="files"&&this.fileView==="worktrees"&&ch==="o"){
      if(this.selectedItems().length!==1){this.say("Select one worktree to open",cx);return true;}
      const path=this.item()?.path;if(path)this.editFiles([],cx,{dir:path});return true;
    }
    return false;
  }
}
