// Lazygit's editor presets are independent defaults for each os.* template.
// Placeholder values are substituted once; filenames never become templates.
export function substituteCommand(template,values) {
  return String(template).replace(/\{\{\.?([A-Za-z]+)\}\}/g,(whole,name)=>Object.hasOwn(values,name)?values[name]:whole);
}
export function commandQuote(value,platform="darwin") {
  const text=String(value);
  if(platform!=="windows")return '"'+text.replace(/[\\"$`]/g,char=>'\\'+char)+'"';
  return '"'+text.replace(/(\\*)"/g,'$1$1\\"').replace(/(\\+)$/,'$1$1')+'"';
}
export function externalShell(command,os={},environment={}) {
  const platform=environment.platform??"darwin",shell=platform==="windows"?"cmd.exe":environment.env?.SHELL||"bash";
  const name=shell.split(/[\\/]/).pop(),file=os.shellFunctionsFile;
  const prefix=file?(name.endsWith("bash")?"shopt -s expand_aliases\n":"")+`${["sh","dash","ash","ksh"].includes(name)?".":"source"} ${commandQuote(file,platform)}\n`:"";
  return platform==="windows"?[shell,"/s","/c",prefix+command]:[shell,"-c",prefix+command];
}
function presetTable(env) {
  const table={};
  const put=(name,edit,line,wait,dir,terminal)=>{table[name]={edit,editAtLine:line,editAtLineAndWait:wait,openDirInEditor:dir,terminal};};
  for(const name of ["vi","vim","nvim","lvim","emacs","nano","kakoune"]){
    const bin=name==="kakoune"?"kak":name;
    put(name,`${bin} -- {{filename}}`,`${bin} +{{line}} -- {{filename}}`,`${bin} +{{line}} -- {{filename}}`,`${bin} -- {{dir}}`,true);
  }
  put("micro","micro {{filename}}","micro +{{line}} {{filename}}","micro +{{line}} {{filename}}","micro {{dir}}",true);
  for(const [name,bin]of [["helix","helix"],["helix (hx)","hx"]])put(name,`${bin} -- {{filename}}`,`${bin} -- {{filename}}:{{line}}`,`${bin} -- {{filename}}:{{line}}`,`${bin} -- {{dir}}`,true);
  put("vscode","code --reuse-window -- {{filename}}","code --reuse-window --goto -- {{filename}}:{{line}}","code --reuse-window --goto --wait -- {{filename}}:{{line}}","code -- {{dir}}",false);
  put("sublime","subl -- {{filename}}","subl -- {{filename}}:{{line}}","subl --wait -- {{filename}}:{{line}}","subl -- {{dir}}",false);
  put("bbedit","bbedit -- {{filename}}","bbedit +{{line}} -- {{filename}}","bbedit +{{line}} --wait -- {{filename}}","bbedit -- {{dir}}",false);
  put("xcode","xed -- {{filename}}","xed --line {{line}} -- {{filename}}","xed --line {{line}} --wait -- {{filename}}","xed -- {{dir}}",false);
  put("zed","zed -- {{filename}}","zed -- {{filename}}:{{line}}","zed --wait -- {{filename}}:{{line}}","zed -- {{dir}}",false);
  put("acme","B {{filename}}","B {{filename}}:{{line}}","E {{filename}}:{{line}}","B {{dir}}",false);
  const shell=env.SHELL||"bash";
  let edit,line,dir;
  if(shell.endsWith("fish")||env.FISH_VERSION){
    edit='begin; if test -z "$NVIM"; nvim -- {{filename}}; else; nvim --server "$NVIM" --remote-send "q"; nvim --server "$NVIM" --remote-tab {{filename}}; end; end';
    line='begin; if test -z "$NVIM"; nvim +{{line}} -- {{filename}}; else; nvim --server "$NVIM" --remote-send "q"; nvim --server "$NVIM" --remote-tab {{filename}}; nvim --server "$NVIM" --remote-send ":{{line}}<CR>"; end; end';
    dir=edit.replaceAll("{{filename}}","{{dir}}");
  }else if(shell.endsWith("nu")||shell.endsWith("nushell")||env.NU_VERSION){
    edit='if ($env | get -i NVIM | is-empty) { nvim -- {{filename}} } else { nvim --server $env.NVIM --remote-send "q"; nvim --server $env.NVIM --remote-tab {{filename}} }';
    line='if ($env | get -i NVIM | is-empty) { nvim +{{line}} -- {{filename}} } else { nvim --server $env.NVIM --remote-send "q"; nvim --server $env.NVIM --remote-tab {{filename}}; nvim --server $env.NVIM --remote-send ":{{line}}<CR>" }';
    dir=edit.replaceAll("{{filename}}","{{dir}}");
  }else{
    edit='[ -z "$NVIM" ] && (nvim -- {{filename}}) || (nvim --server "$NVIM" --remote-send "q" && nvim --server "$NVIM" --remote-tab {{filename}})';
    line='[ -z "$NVIM" ] && (nvim +{{line}} -- {{filename}}) || (nvim --server "$NVIM" --remote-send "q" && nvim --server "$NVIM" --remote-tab {{filename}} && nvim --server "$NVIM" --remote-send ":{{line}}<CR>")';
    dir=edit.replaceAll("{{filename}}","{{dir}}");
  }
  put("nvim-remote",edit,line,"nvim +{{line}} {{filename}}",dir,!Object.hasOwn(env,"NVIM"));
  return table;
}
export function editorCommand(os={},environment={},coreEditor="",{paths=[],line,dir,wait=false}={}) {
  const env=environment.env??{},table=presetTable(env);
  const editor=(coreEditor||env.GIT_EDITOR||env.VISUAL||env.EDITOR||"").split(" ")[0].split(environment.platform==="windows"?/[\\/]/:/\//).pop();
  const aliases={kak:"kakoune",helix:"helix",hx:"helix (hx)",code:"vscode",subl:"sublime",xed:"xcode"};
  const name=os.editPreset||(Object.hasOwn(table,editor)?editor:aliases[editor]),preset=table[name]??table.vim;
  const field=dir!=null?"openDirInEditor":wait?"editAtLineAndWait":line!=null?"editAtLine":"edit";
  const quote=value=>commandQuote(value,environment.platform);
  const command=substituteCommand(os[field]||preset[field],{filename:paths.map(quote).join(" "),line:String(line??1),dir:dir==null?"":quote(dir)});
  return {command,argv:externalShell(command,os,environment),terminal:wait?true:os.editInTerminal??preset.terminal};
}
export function openCommand(os={},environment={},path,link=false) {
  const platform=environment.platform??"darwin",name=link?"link":"filename";
  const defaultTemplate=platform==="windows"?`start "" {{${name}}}`:platform==="linux"?
    environment.wsl?(link?"powershell.exe start '{{link}}' >/dev/null":'powershell.exe start explorer.exe "$(wslpath -w {{filename}})" >/dev/null'):`xdg-open {{${name}}} >/dev/null`:
    link?"open {{link}}":"open -- {{filename}}";
  const command=substituteCommand(os[link?"openLink":"open"]||defaultTemplate,{[name]:commandQuote(path,platform)});
  return {command,argv:externalShell(command,os,environment),terminal:false};
}
export function diffToolArgs({path=".",directory=false,staged=false,from="",to="",reverse=false}={}) {
  return ["git","--literal-pathspecs","difftool","--no-prompt",...(directory?["--dir-diff"]:[]),...(staged?["--cached"]:[]),...(from?[from]:[]),...(to?[to]:[]),...(reverse?["-R"]:[]),"--",path];
}
export function absoluteEditorPath(path,root,platform="darwin") {
  if(path.startsWith("/")||platform==="windows"&&/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path))return path;
  return `${root.replace(platform==="windows"?/[\\/]$/:/\/$/,"")}/${path}`;
}
// Only the editor-related environment is read, on the repository's machine.
export const EDITOR_ENVIRONMENT = 'printf "%s\\0" "$SHELL" "$GIT_EDITOR" "$VISUAL" "$EDITOR" "${NVIM+x}" "${NVIM-}" "$FISH_VERSION" "$NU_VERSION"; wsl=; if test -r /proc/sys/kernel/osrelease && LC_ALL=C grep -q microsoft /proc/sys/kernel/osrelease && test -r /proc/1/cgroup && ! LC_ALL=C grep -Eq "docker|/lxc/" /proc/1/cgroup && test -z "$CONTAINER"; then wsl=1; fi; printf "%s\\0" "$wsl"';
export function editorEnvironment(stdout,base={}) {
  const [SHELL,GIT_EDITOR,VISUAL,EDITOR,nvimSet,NVIM,FISH_VERSION,NU_VERSION,wsl]=stdout.split("\0");
  if(wsl===undefined)throw new Error("Could not read the editor environment");
  return {...base,env:{SHELL,GIT_EDITOR,VISUAL,EDITOR,...(nvimSet?{NVIM}:{}),FISH_VERSION,NU_VERSION},wsl:wsl==="1"};
}
