// Pinned Lazygit config.go / flow.go: legacy prefixes take precedence over
// git-flow-next, and finish splits the branch name at its first slash.
const space="[\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const trim=value=>value.replace(new RegExp(`^${space}+|${space}+$`,"g"),"");
const legacy=/gitflow\.prefix\.([^\t\n\f\r ]+)[\t\n\f\r ]+([^\n]*)/;
const next=/gitflow\.branch\.([^.]+)\.prefix[\t\n\f\r ]+([^\n]*)/;

export function gitFlowPrefixes(legacyText,nextText) {
  const result=new Map();
  for(const [text,pattern,overwrite]of [[legacyText,legacy,true],[nextText,next,false]])for(const line of text.split("\n")){
    const match=pattern.exec(trim(line));if(!match)continue;
    let prefix=trim(match[2]);if(!prefix)continue;
    if(!prefix.endsWith("/"))prefix+="/";
    if(overwrite||!result.has(prefix))result.set(prefix,match[1]);
  }
  return result;
}
export function gitFlowFinish(branch,prefixes) {
  const at=branch.indexOf("/"),prefix=branch.slice(0,at+1),suffix=branch.slice(at+1),type=prefixes.get(prefix);
  if(at<=0||!suffix||!type)throw new Error("This does not seem to be a Git-flow branch");
  return ["git","flow",type,"finish",suffix];
}
export const GIT_FLOW_STARTS=[["feature","f"],["hotfix","h"],["bugfix","b"],["release","r"]];

