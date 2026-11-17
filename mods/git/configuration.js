import { parseConfigLayer, mergeConfigLayers, resolveConfigPaths, normalizeKey } from "./config.js";

export const LAZYGIT_DEFAULTS = {
  gui:{showFileTree:true,fileTreeSortOrder:"mixed",fileTreeSortCaseSensitive:true,filterMode:"substring",sidePanelWidth:0.3333,
    showBottomLine:true,showCommandLog:true,skipStashWarning:false,switchToFilesAfterStashPop:true,switchToFilesAfterStashApply:true},
  git:{autoStageResolvedConflicts:true,autoFetch:true,autoRefresh:true,autoDetectExternalChanges:true,fetchAll:true,disableForcePushing:false,
    mainBranches:["master","main"],localBranchSortOrder:"date",remoteBranchSortOrder:"date",diffContextSize:3,renameSimilarityThreshold:50,
    ignoreWhitespaceInDiffView:false,log:{order:"topo-order",showGraph:"always",showWholeGraph:false},
    commit:{signOff:false,autoWrapCommitMessage:true,autoWrapWidth:72},
    merging:{manualCommit:false,args:"",squashMergeMessage:"Squash merge {{selectedRef}} into {{currentBranch}}"}},
  refresher:{refreshInterval:10,fetchInterval:60,externalChangeCheckInterval:2},services:{},keybinding:{},customCommands:[],os:{},promptToReturnFromSubprocess:true,
};

const ENV_KEYS=["HOME","XDG_CONFIG_HOME","XDG_CONFIG_DIRS","CONFIG_DIR","LG_CONFIG_FILE","LOCALAPPDATA","APPDATA","ProgramData","SHELL","LAZYGIT_KEYBINDING_PLATFORM"];
const ENV_SCRIPT='printf "%s\\0" "$(uname -s)" "$HOME" "$XDG_CONFIG_HOME" "$XDG_CONFIG_DIRS" "$CONFIG_DIR" "$LG_CONFIG_FILE" "$LOCALAPPDATA" "$APPDATA" "$ProgramData" "$SHELL" "$LAZYGIT_KEYBINDING_PLATFORM"; common=$(git rev-parse --path-format=absolute --git-common-dir; printf "."); common=${common%.}; common=${common%?}; printf "%s\\0" "$common"; git worktree list --porcelain -z';
const checked=r=>{if(r.code!==0)throw new Error((r.stderr||r.stdout).trim()||`Command exited ${r.code}`);return r.stdout;};
const fingerprint=s=>{let n=2166136261;for(let i=0;i<s.length;i++)n=Math.imul(n^s.charCodeAt(i),16777619)>>>0;return n.toString(16)+":"+s.length;};

// One line per path: inode, mtime and size, or "-" when it is absent. Every
// file read and every path whose existence chose one is stamped, so an edit,
// a replacement or a new file changes the stamp.
const STAMP_SCRIPT='for f; do stat -f "%i %m %z" "$f" 2>/dev/null || stat -c "%i %Y %s" "$f" 2>/dev/null || echo -; done';
const stampOf=async(io,context,paths)=>{const r=await io.exec("sh",["-c",STAMP_SCRIPT,"sh",...paths],context);return r.code===0&&r.stdout?r.stdout:null;};

// Every filesystem/environment read runs on the selected repository's machine.
// No config file is created or rewritten. Errors retain the last valid config.
// A refresh costs one stat while nothing changed; the files are read again only
// when their stamp moved (ADR 0009).
export async function loadLazygitConfig(context, io, previous) {
  const where=`${context.on??""}\n${context.cwd}`;
  if(previous?.stamp&&!previous.stale&&previous.where===where&&await stampOf(io,context,previous.watched)===previous.stamp)return previous;
  let files=[],environment=null,diagnostics=[];
  try {
    const raw=checked(await io.exec("sh",["-c",ENV_SCRIPT],context)),parts=raw.split("\0"),system=parts.shift(),env={};
    for(const key of ENV_KEYS)env[key]=parts.shift()??"";
    const commonGitDir=parts.shift(),worktrees=parts.join("\0");
    const repoPath=worktrees.split("\0").find(s=>s.startsWith("worktree "))?.slice(9)??context.cwd;
    const platform=/Darwin/i.test(system)?"darwin":/MINGW|MSYS|Windows/i.test(system)?"windows":"linux";
    environment={platform,env,repoPath,commonGitDir};
    const probed=[];
    const exists=async path=>{probed.push(path);return (await io.exec("sh",["-c",'test -f "$1"',"sh",path],context)).code===0;};
    files=await resolveConfigPaths(environment,exists);
    const layers=[],contents=[];
    for(const file of files){
      const r=await io.exec("sh",["-c",'test -f "$1" || exit 2; test "$(wc -c < "$1")" -le 524288 || { printf "Config exceeds 512 KiB" >&2; exit 3; }; cat "$1"',"sh",file.path],context);
      file.exists=r.code!==2;
      if(r.code===2&&!file.required)continue;
      const text=checked(r),layer=parseConfigLayer(text,file.path);
      diagnostics.push(...layer.diagnostics);if(layer.diagnostics.some(d=>d.severity==="error"))throw new Error(layer.diagnostics.map(d=>`${d.source??file.path}${d.line?`:${d.line}`:""}: ${d.message}`).join("\n"));
      layers.push(layer.config);contents.push(file.path,text);
    }
    const watched=[...new Set([...probed,...files.map(f=>f.path)])],stamp=await stampOf(io,context,watched);
    const mark=fingerprint(contents.join("\0")),config=previous?.fingerprint===mark?previous.config:mergeConfigLayers(LAZYGIT_DEFAULTS,layers);
    for(const section of Object.values(config.keybinding??{}))for(const[name,value]of Object.entries(section??{})){
      if(name==="jumpToBlock")for(const key of value??[])normalizeKey(key,env.LAZYGIT_KEYBINDING_PLATFORM||platform);else normalizeKey(value,env.LAZYGIT_KEYBINDING_PLATFORM||platform);
    }
    const validate=commands=>{for(const command of commands??[]){normalizeKey(command.key,platform);validate(command.commandMenu);for(const prompt of command.prompts??[])for(const option of prompt.options??[])normalizeKey(option.key,platform);}};
    validate(config.customCommands);
    return {config,
      overrides:previous?.fingerprint===mark?previous.overrides:mergeConfigLayers({},layers),files,fingerprint:mark,diagnostics,environment,stale:false,where,watched,stamp};
  }catch(e){
    return {config:previous?.config??mergeConfigLayers(LAZYGIT_DEFAULTS,[]),files:previous?.files??files,fingerprint:previous?.fingerprint??null,
      overrides:previous?.overrides??{},environment:environment??previous?.environment,diagnostics:e.diagnostics??(diagnostics.some(d=>d.severity==="error")?diagnostics:[{severity:"error",message:e.message??String(e)}]),stale:true};
  }
}
