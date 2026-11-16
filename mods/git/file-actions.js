import { exec } from "herdr";
import { GitSelection } from "./selection.js";
import { filePaths, parseStatus } from "./status.js";

const checked = result => { if (result.code) throw new Error((result.stderr || result.stdout).trim()); return result.stdout; };
const untracked = file => ["??", "A ", "AM"].includes(file.x + file.y);
const pathOf = node => node?.path ?? node?.file?.path;

export class GitFiles extends GitSelection {
  fileScope() {
    return { repo: this.repoKey, root: this.root, on: this.on, key: this.viewKey(), nodes: this.selectedItems().slice(), files: this.selectedFiles().map(file => ({...file})) };
  }
  fileScopeCurrent(scope) { return !this.closed && scope.repo === this.repoKey && scope.root === this.root && scope.on === this.on; }
  discardFilesMenu(cx) {
    const scope = this.fileScope(); if (!scope.files.length) return;
    const modules = scope.files.filter(file => this.submodules.some(module => module.path === file.path));
    const worktrees = scope.files.map(file => this.worktrees.find(tree => tree.path === `${scope.root}/${file.path}`)).filter(Boolean);
    if ((modules.length || worktrees.length) && scope.files.length > 1) return this.say("Select a single submodule or worktree to discard its changes",cx);
    if (modules.length) return this.menuItems(modules[0].path, [["Stash and reset", "", cx => {
      if (!this.fileScopeCurrent(scope)) return;
      const prefix = ["-C", modules[0].path];
      this.perform("Stash and reset submodule", [[...prefix,"stash","push","--include-untracked"],[...prefix,"reset","--hard"]],cx);
    }]],cx);
    if (worktrees.length) return this.menuItems(worktrees[0].path, [["Remove worktree…","",cx => this.ask("Remove worktree",`Remove ${worktrees[0].path}? Git will refuse if it has changes or is locked.`,cx => {
      if(this.fileScopeCurrent(scope))this.perform("Remove worktree",[["worktree","remove","--",worktrees[0].path]],cx);
    },cx)]],cx);
    const keys = this.configuredBindingKeys({section:"files",name:"confirmDiscard",defaults:"x"});
    this.openMenu({title:"Discard changes",items:[
      {label:"Discard all changes",hint:keys.join(" / "),keys,danger:true,run:cx=>this.discardFileScope(scope,false,cx)},
      {label:"Discard unstaged changes",hint:"u",key:"u",danger:true,disabled:scope.files.some(f=>f.staged)&&scope.files.some(f=>f.unstaged)?null:"The selection must have both staged and unstaged changes",run:cx=>this.discardFileScope(scope,true,cx)},
    ]},cx);
  }
  discardFileScope(scope, unstagedOnly, cx, nestedConfirmed = false) {
    if (!this.fileScopeCurrent(scope)) return;
    const nested = scope.files.filter(file => file.directory);
    if (nested.length && !nestedConfirmed) return this.ask("Discard nested repository",`Discarding ${nested.map(f=>f.path).join(", ")} can remove the nested repository and its uncommitted changes. Continue?`,cx=>this.discardFileScope(scope,unstagedOnly,cx,true),cx);
    if (this.busy) return;
    this.rangeAnchors[scope.key] = null; delete this.rangeModes[scope.key];
    this.perform(unstagedOnly ? "Discard unstaged changes" : "Discard all changes", async (git, context) => {
      // Splitting rename records lets Git decide whether each old/new path is
      // added, deleted or tracked. Literal pathspecs also protect wildcard names.
      const result = await this.boundedGit(["--literal-pathspecs","status","--porcelain=v1","-z","--no-renames","--untracked-files=all","--",...filePaths(scope.files)],262144,context);
      checked(result); const parsed = parseStatus(result.stdout);
      if (result.truncated || parsed.limited) throw new Error("Too many selected files to discard safely; narrow the selection");
      const reset = [], restore = [], remove = [];
      for (const file of parsed.files) {
        const code = file.x + file.y;
        if (unstagedOnly) { if (file.fresh) remove.push(file.path); else if(file.unstaged) restore.push(file.path); continue; }
        if (code === "AA") { await git(["--literal-pathspecs","checkout","--ours","--",file.path]); await git(["--literal-pathspecs","add","--",file.path]); continue; }
        if (code === "DU") { await git(["--literal-pathspecs","rm","--",file.path]); continue; }
        if (file.staged || file.conflict) reset.push(file.path);
        if (["DD","AU"].includes(code)) continue;
        if (untracked(file) || file.y === "A") remove.push(file.path); else restore.push(file.path);
      }
      if (reset.length) await git(["--literal-pathspecs","reset","-q","--",...reset]);
      if (remove.length) checked(await exec("sh",["-c",'for path do rm -rf -- "$path" || exit; done',"sh",...remove],context));
      if (restore.length) await git(["--literal-pathspecs","checkout","--",...restore]);
    },cx);
  }
  ignoreFileMenu(cx) {
    if(this.multipleSelected())return this.say("Range selection is not supported for ignoring files",cx);
    const node=this.item(), path=pathOf(node); if(!path)return;
    const scope=this.fileScope(), tracked=scope.files.some(file=>!untracked(file));
    const apply=(exclude,cx)=>{
      if(path===".gitignore")return this.say("The repository's .gitignore cannot ignore or exclude itself",cx);
      const run=cx=>{
        if(!this.fileScopeCurrent(scope))return;
        this.perform(exclude?"Exclude file":"Ignore file",async(git,context)=>{
          if(tracked){
            const staged=scope.files.filter(file=>file.staged);
            if(staged.length)await git(["--literal-pathspecs","reset","-q","--",...filePaths(staged)]);
            await git(["--literal-pathspecs","rm","--cached","-r","--",path]);
          }
          const target=exclude?(await git(["rev-parse","--git-path","info/exclude"])).trim():".gitignore";
          const pattern="/"+path.replace(/^[!#]|[\[\]*]/g,"\\$&");
          checked(await exec("sh",["-c",'mkdir -p -- "$(dirname -- "$1")" && printf "%s\\n" "$2" >> "$1"',"sh",target,pattern],context));
        },cx);
      };
      if(tracked)this.ask(exclude?"Exclude tracked file":"Ignore tracked file",`Stop tracking ${path} and ${exclude?"exclude":"ignore"} it? Its working files will be kept.`,run,cx);else run(cx);
    };
    this.menuItems("Ignore / exclude file",[["Ignore file","i",cx=>apply(false,cx)],["Exclude file","e",cx=>apply(true,cx)]],cx);
  }
  copyFileMenu(cx) {
    const node=this.item(), frame=this.context(), path=pathOf(node); if(!path)return;
    const multi=this.multipleSelected()?"Range selection is not supported for this action":null, repo=this.repoKey, context={cwd:this.root,on:this.on};
    const paths=frame?filePaths([node]):filePaths(node.dir?node.files:[node.file]);
    const selectedFiles=frame?[]:node.dir?node.files:[node.file],selectedStaged=selectedFiles.some(f=>f.staged);
    const staged=this.files.some(f=>f.staged), hasDiff=this.files.some(f=>!f.fresh);
    const read=(args,cx)=>this.perform("Reading clipboard contents",async()=>{
      const result=await this.boundedGit(["--literal-pathspecs",...args],1_000_000,context);checked(result);
      if(result.truncated)throw new Error("Clipboard contents exceed the output limit");
      if(!this.closed&&this.repoKey===repo&&this.root===context.cwd)cx.write_to_clipboard(result.stdout);
    },cx,{reads:true});
    const diff=all=>frame?[...frame.patchArgs,...(all?[]:["--",...paths])]:["diff","--no-ext-diff","--no-textconv","--no-color",...((all?staged:selectedStaged)?["--cached"]:[]),...(all?[]:["--",...paths])];
    const copy=value=>cx=>{if(this.repoKey===repo&&this.root===context.cwd)cx.write_to_clipboard(value);};
    this.menuItems("Copy to clipboard",[
      ["File name","n",copy(path.split("/").at(-1)),false,null,multi],
      ["Relative path","p",copy(path),false,null,multi],
      ["Absolute path","P",copy(`${context.cwd}/${path}`),false,null,multi],
      ["Selected diff","s",cx=>read(diff(false),cx),false,null,multi??(!frame&&!selectedFiles.some(f=>f.staged||!f.fresh)?"Untracked files have no Git diff":null)],
      ["All files diff","a",cx=>read(diff(true),cx),false,null,!frame&&!hasDiff?"No tracked changes":null],
      frame&&["File contents","c",cx=>read(["show",`${frame.untracked?.has(path)?`${frame.stashHash}^3`:frame.checkoutRef}:${path}`],cx),false,null,multi],
    ],cx);
  }
}
