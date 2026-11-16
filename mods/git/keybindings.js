import { GitConfiguration } from "./configuration-runtime.js";
import { normalizeKey } from "./config.js";

export function eventKey(e,platform="darwin") {
  const m=e.modifiers??{}, modified=m.control||m.alt||m.platform||m.super;
  let key=e.key??"";
  if(key==="space"||e.key_char===" ")return [...[m.control&&"ctrl",m.alt&&"alt",m.shift&&"shift",m.platform&&(platform==="darwin"?"cmd":"super")].filter(Boolean),"space"].join("-");
  if(!modified&&Array.from(e.key_char??key).length===1)return e.key_char??(m.shift?key.toUpperCase():key);
  const prefixes=[m.control&&"ctrl",m.alt&&"alt",m.shift&&"shift",(m.platform||m.super)&&(platform==="darwin"?"cmd":"super")].filter(Boolean);
  return [...prefixes,key.toLowerCase()].join("-");
}
export function nativeEvent(token) {
  const modifiers={},names={ctrl:"control",alt:"alt",shift:"shift",cmd:"platform",super:"super"};
  let key=token,match;
  while((match=/^(ctrl|alt|shift|cmd|super)-/.exec(key))){modifiers[names[match[1]]]=true;key=key.slice(match[0].length);}
  const printable=Array.from(key).length===1;
  return {key:printable?key.toLowerCase():key,key_char:printable?key:undefined,modifiers,_bindingBypass:true};
}

// Configuration names follow Lazygit's schema. A binding runs its operation;
// it never reinterprets a new key as a global action in a different context.
export class GitKeybindings extends GitConfiguration {
  keyContext() {
    if(this.prompt)return this.prompt.kind==="commit"?"commitMessage":"prompt";
    if(this.pending)return "confirmation";
    if(this.menu)return "menu";
    if(this.typing)return "search";
    if(this.main)return this.conflicts?.conflicts.length?"mergeConflicts":"main";
    const frame=this.context();if(frame)return frame.type==="files"?"commitFiles":"subCommits";
    if(this.panel==="files")return this.fileView;
    if(this.panel==="branches")return {local:"localBranches",remotes:"remotes","remote branches":"remoteBranches",tags:"tags"}[this.branchContext()];
    if(this.panel==="commits")return this.commitView==="reflog"?"reflogCommits":"commits";
    return this.panel;
  }
  builtinBindings(cx) {
    const context=this.keyContext(),bindings=[];
    const native=key=>()=>this.keys(nativeEvent(key),cx);
    const add=(section,name,key,run,defaults=key)=>bindings.push({section,name,defaults,run:run??native(key),native:key});
    const group=(section,entries)=>{for(const [name,key,defaults] of entries)add(section,name,key,null,defaults??key);};
    const actions={
      files:[["commitChanges","c"],["amendLastCommit","A"],["commitChangesWithEditor","C"],["ignoreFile","i"],["stashAllChanges","s"],["viewStashOptions","S"],["toggleStagedAll","a"],["viewResetOptions","D"],["fetch","f"],["toggleTreeView","`"],["openMergeOptions","M"],["openStatusFilter","ctrl-b","<ctrl+b>"],["collapseAll","-"],["expandAll","="]],
      branches:[["checkoutBranchByName","c"],["renameBranch","R"],["rebaseBranch","r"],["mergeIntoCurrentBranch","M"],["createTag","T"],["setUpstream","u"],["sortOrder","s"]],
      commits:[["resetCommitAuthor","a"],["squashDown","s"],["renameCommit","r"],["viewResetOptions","g"],["markCommitAsFixup","f"],["setFixupMessage","c"],["createFixupCommit","F"],["squashAboveCommits","S"],["moveDownCommit","ctrl-j",["<ctrl+j>","<alt-down>"]],["moveUpCommit","ctrl-k",["<ctrl+k>","<alt-up>"]],["amendToCommit","A"],["pickCommit","p"],["revertCommit","t"],["cherryPickCopy","C"],["pasteCommits","V"],["markCommitAsBaseForRebase","B"],["createTag","T"],["checkoutCommit","space","<space>"],["resetCherryPick","ctrl-r","<ctrl+r>"],["copyCommitAttributeToClipboard","y"],["openLogMenu","ctrl-l","<ctrl+l>"],["openInBrowser","o"],["openPullRequestInBrowser","G"],["viewBisectOptions","b"],["startInteractiveRebase","i"]],
    };
    if(context==="files"){
      group("files",actions.files);
      add("files","refreshFiles","r",()=>this.refresh(cx,true));
      add("files","copyFileInfoToClipboard","y",()=>this.copyFileMenu(cx));
    }
    if(["localBranches","remoteBranches","tags","remotes"].includes(context)){
      group("branches",actions.branches);
      if(context==="localBranches")group("branches",[["viewGitFlowOptions","i"],["fastForward","f"],["copyPullRequestURL","ctrl-y","<ctrl+y>"],["createPullRequest","o"],["viewPullRequestOptions","O"],["openPullRequestInBrowser","G"]]);
      else if(context==="tags")group("branches",[["pushTag","P"]]);
      else group("branches",[["fetchRemote","f"]]);
      if(context==="localBranches")add("branches","checkoutPreviousBranch","-",()=>this.checkoutRef("-",cx));
    }
    if(["commits","subCommits","reflogCommits"].includes(context)){
      const readOnly=new Set(["g","t","C","ctrl-r","ctrl-o","y","T","o","enter","space","b"]);
      group("commits",context==="commits"?actions.commits:actions.commits.filter(([,key])=>readOnly.has(key)));
      for(const binding of bindings){
        if(binding.section!=="commits"||["ctrl-r","ctrl-l","ctrl-j","ctrl-k"].includes(binding.native))continue;
        binding.run=()=>{
          const action=this.commitActions(this.item(),cx).find(item=>item[1]===binding.native);
          if(action?.[5])this.say(action[5],cx);else if(action)action[2](cx);else this.say("This action is unavailable for the selected commit",cx);
        };
      }
    }
    if(context==="stash")group("stash",[["popStash","g"],["renameStash","r"]]);
    if(context==="commitFiles"){group("commitFiles",[["checkoutCommitFile","c"]]);group("files",[["toggleStagedAll","a"],["copyFileInfoToClipboard","y"],["toggleTreeView","`"],["collapseAll","-"],["expandAll","="]]);}
    if(context==="submodules")group("submodules",[["init","i"],["update","u"]]);
    if(["main","mergeConflicts"].includes(context)&&!this.graph){
      group("main",[["prevHunk","h",["<left>","h"]],["nextHunk","l",["<right>","l"]],["toggleSelectHunk","a"],["pickBothHunks","b"]]);
      if(context==="main"&&this.panel==="files"&&this.fileView==="files"&&!this.detail&&!this.peek)add("main","editSelectHunk","E");
      add("universal","togglePanel","tab",null,"<tab>");
    }
    const searching=!this.typing&&(this.main&&this.graph&&this.query||!this.main&&this.isCommitSearch()&&this.filters[this.viewKey()]);
    if(searching)for(const[name,key,by]of [["nextMatch","n",1],["prevMatch","N",-1]])add("universal",name,key,()=>this.main?this.nextMatch(by,cx):this.nextPanelMatch(by,cx));
    const specific=bindings.length;
    if(this.typing||["prompt","commitMessage","confirmation","menu","search"].includes(context)){
      bindings.splice(0);
      add("universal","return","escape",null,"<esc>");
      add("universal",context==="menu"?"confirmMenu":"confirm","enter",null,"<enter>");
      if(this.typing)add("universal","confirmInEditor","cmd-enter",()=>this.submit(cx),"<meta+enter>");
      return {bindings,specific:0,editing:true};
    }
    for(const[name,key,defaults]of [
      ["return","escape","<esc>"],["select","space","<space>"],["goInto","enter","<enter>"],["remove","d"],["new","n"],["newWorktree","w"],["edit","e"],["openFile","o"],["openDiffTool","ctrl-t","<ctrl+t>"],
      ["startSearch","/"],["toggleRangeSelect","v"],["rangeSelectDown","shift-down","<shift+down>"],["rangeSelectUp","shift-up","<shift+up>"],
      ["executeShellCommand",":"],["createRebaseOptionsMenu","m"],["createPatchOptionsMenu","ctrl-p","<ctrl+p>"],["nextTab","]"],["prevTab","["],["undo","z"],["redo","Z"],
      ["diffingMenu","W"],["diffingMenu-alt","W","<ctrl+e>"],["copyToClipboard","ctrl-o","<ctrl+o>"],["toggleWhitespaceInDiffView","ctrl-w","<ctrl+w>"],
      ["increaseContextInDiffView","}"],["decreaseContextInDiffView","{"],["increaseRenameSimilarityThreshold",")"],["decreaseRenameSimilarityThreshold","("],
    ])add("universal",name,key,null,defaults??key);
    if(!searching){add("universal","nextMatch","n",()=>{});add("universal","prevMatch","N",()=>{});}
    add("universal","editConfig","alt-shift-c",()=>this.editConfiguration(cx),"<alt+shift+c>");
    add("universal","extrasMenu","@",()=>this.moreMenu(cx));
    add("universal","quit","q",()=>this.close());add("universal","quit-alt1","ctrl-c",()=>this.close(),"<ctrl+c>");
    add("universal","quitWithoutChangingDirectory","Q",()=>this.close());
    add("universal","refresh","R",()=>this.refresh(cx,true));add("universal","pushFiles","P",()=>this.push(cx));
    add("universal","pullFiles","p",()=>this.act("Pull",[["pull","--ff-only"]],cx,{network:true}));
    add("universal","optionMenu","?",()=>{this.help=true;cx.notify();});
    for(const[name,key,by]of [["prevItem","<up>",-1],["nextItem","<down>",1],["prevItem-alt","k",-1],["nextItem-alt","j",1],["prevPage",",",-20],["nextPage",".",20]]){
      add("universal",name,key,Math.abs(by)===1?native(by<0?"up":"down"):()=>this.move((this.main?this.cursor:this.sel[this.panel])+by,cx));
    }
    for(const[name,key,end]of [["gotoTop","<",false],["gotoBottom",">",true],["gotoTop-alt","<home>",false],["gotoBottom-alt","<end>",true]]){
      add("universal",name,key,()=>this.move(end?(this.main?(this.graph?.rows.length??this.rows.length):this.list().length)-1:0,cx));
    }
    for(const[name,key,by]of [["prevBlock","<left>",-1],["nextBlock","<right>",1],["prevBlock-alt","h",-1],["nextBlock-alt","l",1],["prevBlock-alt2","<backtab>",-1],["nextBlock-alt2","<tab>",1]])add("universal",name,key,()=>this.step(by,cx));
    for(const[name,key,by]of [["scrollUpMain","<pgup>",-20],["scrollDownMain","<pgdown>",20],["scrollUpMain-alt1","K",-3],["scrollDownMain-alt1","J",3],["scrollUpMain-alt2","<ctrl+u>",-20],["scrollDownMain-alt2","<ctrl+d>",20]])add("universal",name,key,()=>this.scrollMain(by,cx));
    add("universal","focusMainView","0",()=>{this.main=true;cx.notify();});
    for(const[index,panel]of ["status","files","branches","commits","stash"].entries())add("universal",`jumpToBlock.${index}`,String(index+1),()=>this.goto(panel,cx));
    return {bindings,specific,editing:false};
  }
  configuredBindingKeys(binding) {
    const platform=this.configuration?.environment?.env?.LAZYGIT_KEYBINDING_PLATFORM||this.configuration?.environment?.platform||"darwin";
    if(binding.name.startsWith("jumpToBlock.")&&Object.hasOwn(this.lazygitConfig?.keybinding?.universal??{},"jumpToBlock")&&this.bindingValue(binding)===undefined)return [];
    const configured=this.bindingValue(binding),value=configured===undefined?binding.defaults:configured;
    return normalizeKey(value,platform);
  }
  bindingValue(binding) {return binding.name.split(".").reduce((value,key)=>value?.[key],this.lazygitConfig?.keybinding?.[binding.section]);}
  dispatchConfiguredKey(e,cx) {
    if(e._bindingBypass||this.help||this.plan||this.configOpen||this.logOpen||this.busy)return false;
    const platform=this.configuration?.environment?.env?.LAZYGIT_KEYBINDING_PLATFORM||this.configuration?.environment?.platform||"darwin",key=eventKey(e,platform),{bindings,specific,editing}=this.builtinBindings(cx);
    // Text input keeps ordinary characters. Only explicit input-context
    // overrides are intercepted; the native input owns its normal editing.
    const active=editing?bindings.filter(b=>this.bindingValue(b)!==undefined):bindings;
    try {
      if(!editing&&this.runCustomBinding?.(this.keyContext(),key,cx,false))return true;
      for(const b of active.slice(0,editing?0:specific))if(this.configuredBindingKeys(b).includes(key)){b.run();return true;}
      if(!editing&&this.runCustomBinding?.(this.keyContext(),key,cx,true))return true;
      const shadowed=active.slice(0,editing?0:specific).filter(b=>this.bindingValue(b)!==undefined&&!this.configuredBindingKeys(b).includes(key));
      for(const b of active.slice(editing?0:specific))if(this.configuredBindingKeys(b).includes(key)){
        // A universal alias must not revive the contextual action whose key
        // was moved or disabled (select/checkout and openFile/openInBrowser).
        if(shadowed.some(context=>context.native===b.native))continue;
        b.run();return true;
      }
      // Once a default is moved/disabled, it must not fall through to the old
      // hard-coded event handler. Another matching context binding wins above.
      return active.some(b=>(this.bindingValue(b)!==undefined||b.name.startsWith("jumpToBlock.")&&Object.hasOwn(this.lazygitConfig?.keybinding?.universal??{},"jumpToBlock"))&&normalizeKey(b.defaults,platform).includes(key));
    }catch(error){this.say(`Keybinding: ${error.message}`,cx);return true;}
  }
}
