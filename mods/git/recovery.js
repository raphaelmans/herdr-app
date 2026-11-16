import { exec } from "herdr";
import { GitAuthors } from "./authors.js";
import { findReflogAction } from "./reflog.js";
import { OPERATION_STATE_SCRIPT, operationFromState } from "./status.js";

const checked=result=>{if(result.code!==0)throw new Error((result.stderr||result.stdout).trim().slice(-1800)||`Git exited ${result.code}`);return result.stdout;};
const LIMIT=1000;
const FIND_OBSTRUCTIONS=`
scratch=$1; shift
refuse() { printf 'Recovery would overwrite untracked or ignored files at %s; move them aside first.\\n' "$1" >&2; exit 1; }
for path do
  part=$path
  while :; do
    if [ -e "$part" ] || [ -L "$part" ]; then
      if [ -d "$part" ] && [ ! -L "$part" ]; then
        if [ "$part" = "$path" ]; then
          # An index file hides an untracked directory which replaced it.
          # Gitlinks need an index lookup; their objects live in the submodule.
          if git rev-parse --verify --quiet --end-of-options ":$part" >/dev/null; then refuse "$part"; fi
          # Without exclude rules, --others includes ignored files as well.
          git --no-optional-locks --literal-pathspecs ls-files --others --directory -z -- "$part" > "$scratch" || exit 1
          if [ -s "$scratch" ]; then refuse "$part"; fi
        fi
      else
        # An untracked file can also hide tracked children of a directory.
        if ! git rev-parse --verify --quiet --end-of-options ":$part" >/dev/null; then refuse "$part"; fi
      fi
    fi
    case "$part" in */*) part=\${part%/*} ;; *) break ;; esac
  done
done
`;
const CHECK_OBSTRUCTIONS=String.raw`
umask 077
temp=$(mktemp -d) || exit 1
trap 'rm -rf "$temp"' EXIT
git --no-optional-locks diff --cached --name-only --diff-filter=DT --no-renames --no-ext-diff --no-textconv -z "$1" -- > "$temp/paths" || exit 1
git --no-optional-locks diff --name-only --diff-filter=DT --no-renames --no-ext-diff --no-textconv -z -- >> "$temp/paths" || exit 1
if [ -s "$temp/paths" ]; then xargs -0 sh -c "$2" sh "$temp/check" < "$temp/paths"; fi
`;

// Lazygit's undo_controller.go treats the HEAD reflog as the history of user
// actions. Its markers make undo/redo survive reopening either application.
// The confirmation pins the reflog, checked-out branch and destination, rather
// than retaining a numbered reflog ref which another Git command could move.
export class GitRecovery extends GitAuthors {
  recoveryCurrent(plan) {
    return !this.closed&&this.repoKey===plan.repoKey&&this.root===plan.context.cwd&&this.on===plan.context.on;
  }
  async recoveryState(context) {
    const [head,branch,log,state]=await Promise.all([
      exec("git",["rev-parse","--verify","HEAD"],context),
      exec("git",["symbolic-ref","--quiet","HEAD"],context),
      this.boundedGit(["reflog","show","-z","--date=raw","-n",String(LIMIT+1),"--format=%H%x00%gs%x00%gD","HEAD","--"],524288,context),
      exec("sh",["-c",OPERATION_STATE_SCRIPT],context),
    ]);
    if(head.code!==0)throw new Error("There is no commit to undo or redo");
    if(branch.code!==0&&branch.code!==1)checked(branch);
    const operation=operationFromState(checked(state));
    if(operation)throw new Error(`Finish or abort the ${operation} before undoing or redoing history`);
    checked(log);
    if(log.truncated)throw new Error("The reflog exceeds the recovery read limit; inspect Commits → Reflog");
    const fields=log.stdout.split("\0");if(fields.at(-1)==="")fields.pop();
    if(fields.length%3)throw new Error("The reflog changed while it was read; try again");
    const entries=[];
    for(let at=0;at<fields.length;at+=3)entries.push({hash:fields[at],subject:fields[at+1]});
    const hash=head.stdout.trim();
    if(entries.length&&entries[0].hash!==hash)throw new Error("HEAD changed while reading the reflog; try again");
    return {head:hash,branch:branch.code===0?branch.stdout.trim():null,log:log.stdout,entries};
  }
  async recoveryTarget(action,redo,context) {
    const name=redo?action.to:action.from;
    if(!name)throw new Error("The previous commit is unavailable in the reflog; an initial commit cannot be undone here");
    const branch=action.kind==="checkout"?await exec("git",["show-ref","--verify","--quiet",`refs/heads/${name}`],context):null;
    if(branch&&branch.code!==0&&branch.code!==1)checked(branch);
    const ref=branch?.code===0?`refs/heads/${name}`:null;
    const result=await exec("git",["rev-parse","--verify","--end-of-options",`${ref??name}^{commit}`],context);
    if(result.code!==0)throw new Error(`The recovery target ${name} is no longer available`);
    return {name,ref,hash:result.stdout.trim()};
  }
  undo(redo,cx) {
    const plan={context:{cwd:this.root,on:this.on,timeout:60000},repoKey:this.repoKey,redo};
    this.perform("Reading reflog",async(_git,context,cx)=>{
      const state=await this.recoveryState(context);
      if(!this.recoveryCurrent(plan))return;
      const action=findReflogAction(state.entries,{redo});
      if(!action)return this.say(`No ${redo?"redoable":"undoable"} action in the latest ${LIMIT} reflog entries`,cx);
      if(action.kind==="currentRebase")throw new Error("An unfinished rebase cannot be undone from the reflog; continue or abort it");
      const target=await this.recoveryTarget(action,redo,context);
      if(!this.recoveryCurrent(plan))return;
      Object.assign(plan,{state,action,target});
      const label=redo?"Redo":"Undo",soft=!redo&&action.kind==="commit";
      const description=action.kind==="checkout"?`Check out ${target.name}? Local changes will be kept; if they prevent checkout, you can auto-stash them.`
        :soft?`Soft reset to ${target.hash.slice(0,7)}? The undone changes stay staged and working files are kept.`
        :`Hard reset to ${target.hash.slice(0,7)}? Tracked local changes will be auto-stashed and reapplied. Conflicts keep the stash available.`;
      this.ask(label,description,cx=>this.applyRecovery(plan,cx),cx);
    },cx,{reads:true,done:""});
  }
  async validateRecovery(plan,{reflog=true}={}) {
    if(!this.recoveryCurrent(plan))throw new Error("The repository changed; request undo or redo again");
    const state=await this.recoveryState(plan.context);
    if(state.head!==plan.state.head||state.branch!==plan.state.branch||(reflog&&state.log!==plan.state.log))throw new Error("HEAD, branch or reflog changed; request undo or redo again");
    const target=await this.recoveryTarget(plan.action,plan.redo,plan.context);
    if(target.hash!==plan.target.hash||target.ref!==plan.target.ref)throw new Error("The recovery target changed; request undo or redo again");
    if(!this.recoveryCurrent(plan))throw new Error("The repository changed; request undo or redo again");
  }
  async recoveryRun(args,plan,tagged=false) {
    const result=await exec("env",["GIT_TERMINAL_PROMPT=0","GIT_EDITOR=true","LC_ALL=C",...(tagged?[`GIT_REFLOG_ACTION=[lazygit ${plan.redo?"redo":"undo"}]`]:[]),"git",...args],plan.context);
    this.commandLog.push({label:plan.redo?"Redo":"Undo",command:"git "+args.join(" "),code:result.code,output:(result.stderr||result.stdout).slice(-2500)});
    if(this.commandLog.length>30)this.commandLog.shift();
    return result;
  }
  async recoveryStash(plan) {
    const checks=await Promise.all([[],["--cached"]].map(extra=>exec("git",["diff","--quiet","--ignore-submodules=all",...extra,"--"],plan.context)));
    for(const result of checks)if(result.code!==0&&result.code!==1)checked(result);
    if(checks.every(result=>result.code===0))return null;
    const id=`${Date.now()}-${Math.random().toString(36).slice(2)}`,ref=`refs/herdr/recovery/${id}`;
    const message=`Auto-stash for ${plan.redo?"redo":"undo"} to ${plan.target.hash.slice(0,7)}`;
    const hash=checked(await this.recoveryRun(["stash","create",message],plan)).trim();
    if(!hash)return null;
    // Keep the snapshot reachable without touching refs/stash. A concurrent
    // stash push can never be removed by recovery's successful cleanup.
    checked(await this.recoveryRun(["update-ref",ref,hash,""],plan));
    return {hash,ref,message};
  }
  async checkRecoveryObstructions(target,plan) {
    checked(await exec("sh",["-c",CHECK_OBSTRUCTIONS,"sh",target,FIND_OBSTRUCTIONS],plan.context));
  }
  async checkRecoverySnapshot(stash,plan) {
    for(const args of [["diff","--quiet","--ignore-submodules=all",stash.hash,"--"],["diff","--cached","--quiet","--ignore-submodules=all",`${stash.hash}^2`,"--"]]){
      const result=await exec("git",args,plan.context);
      if(result.code===1)throw new Error("Working files or the index changed while preparing recovery; inspect the saved stash before trying again");
      checked(result);
    }
  }
  async restoreRecoveryStash(stash,plan) {
    checked(await this.recoveryRun(["stash","apply",stash.hash],plan));
    checked(await this.recoveryRun(["update-ref","-d",stash.ref,stash.hash],plan));
  }
  async keepRecoveryStash(stash,plan) {
    // A failed apply keeps the complete original snapshot in the normal Stash
    // view. If storing fails, the private ref remains reachable for recovery.
    try {
      checked(await this.recoveryRun(["stash","store","-m",stash.message,stash.hash],plan));
      checked(await this.recoveryRun(["update-ref","-d",stash.ref,stash.hash],plan));
      return `Recovery stash ${stash.hash.slice(0,7)} was kept; inspect Stash to restore it.`;
    }catch(error){return `Recovery snapshot ${stash.ref} was kept (${stash.hash.slice(0,7)}): ${error.message}`;}
  }
  applyRecovery(plan,cx,autoStashCheckout=false) {
    if(!this.recoveryCurrent(plan))return this.say("The repository changed; request undo or redo again",cx);
    const label=plan.redo?"Redo":"Undo";let completed=false;
    this.perform(label,async(_git,_context,cx)=>{
      await this.validateRecovery(plan);
      const checkout=plan.action.kind==="checkout",soft=!plan.redo&&plan.action.kind==="commit";
      const args=checkout?["switch","--no-guess","--no-overwrite-ignore","--no-recurse-submodules",...(plan.target.ref?[]:["--detach"]),"--",plan.target.ref?plan.target.name:plan.target.hash]
        :["reset",soft?"--soft":"--hard","--no-recurse-submodules",plan.target.hash,"--"];
      let stash=null;
      try {
        if(!checkout&&!soft)await this.checkRecoveryObstructions(plan.target.hash,plan);
        if(autoStashCheckout)await this.checkRecoveryObstructions("HEAD",plan);
        if((!checkout&&!soft)||autoStashCheckout)stash=await this.recoveryStash(plan);
        await this.validateRecovery(plan);
        if(stash)await this.checkRecoverySnapshot(stash,plan);
        if(checkout&&stash){
          await this.checkRecoveryObstructions("HEAD",plan);
          checked(await this.recoveryRun(["reset","--hard","--no-recurse-submodules","HEAD","--"],plan));
          await this.validateRecovery(plan,{reflog:false});
        }
        if(!checkout&&!soft){
          await this.checkRecoveryObstructions(plan.target.hash,plan);
        }
        const result=await this.recoveryRun(args,plan,true);
        if(checkout&&result.code!==0&&!autoStashCheckout&&(result.stderr||result.stdout).includes("Please commit your changes or stash them before you switch branch")){
          if(this.recoveryCurrent(plan))this.ask("Auto-stash",`Auto-stash local changes, check out ${plan.target.name}, then reapply them? Conflicts keep the stash available.`,cx=>this.applyRecovery(plan,cx,true),cx);
          return;
        }
        checked(result);completed=true;
        if(stash)await this.restoreRecoveryStash(stash,plan);
        this.commitLimit=300;this.reflogLimit=300;this.sel.commits=0;
        if(checkout&&this.recoveryCurrent(plan)){
          this.panel="branches";this.main=false;this.branchView="local";this.remoteContext=null;this.contexts.branches=[];
          this.filters.local="";this.panelSearchOpen=false;this.syncContext();
          this.recoverySelection={repoKey:plan.repoKey,ref:plan.target.ref};
        }
      }catch(error){
        if(stash)throw new Error(`${error.message}\n${await this.keepRecoveryStash(stash,plan)}`);
        throw error;
      }
    },cx,{done:"",after:()=>{if(completed)this.info=`${label} completed`;}});
  }
}
