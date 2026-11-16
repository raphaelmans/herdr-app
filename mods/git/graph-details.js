// Git Graph owns its expanded commit independently of Lazygit's side panes.
// Visual row order, not timestamps or click order, determines diff direction.
export function graphComparison(selection,hashes) {
  if(!selection||!hashes.includes(selection.primary))return null;
  const {primary,secondary}=selection;
  if(!secondary||!hashes.includes(secondary))return {primary,secondary:null,from:null,to:primary};
  return {primary,secondary,from:hashes.indexOf(primary)>hashes.indexOf(secondary)?primary:secondary,
    to:hashes.indexOf(primary)<hashes.indexOf(secondary)?primary:secondary};
}

export function clickGraphCommit(selection,hash,modifiers,hashes) {
  if(!hashes.includes(hash))return selection;
  const current=graphComparison(selection,hashes);
  if(current?.primary===hash)return null;
  if(current&&(modifiers?.control||modifiers?.platform))return graphComparison({primary:current.primary,secondary:current.secondary===hash?null:hash},hashes);
  return graphComparison({primary:hash,secondary:null},hashes);
}

export function graphDiffArgs(from,to,stats=false) {
  return ["diff",stats?"--numstat":"--name-status","--no-ext-diff","--no-textconv","--find-renames","--diff-filter=AMDR","-z",from,...(to==="*"?[]:[to]),"--"];
}

// Git Graph permits drop only on a non-root, non-branching loaded chain
// reaching HEAD. Merges anywhere along that descendant chain disallow it.
export function graphCanDropCommit(commits,hash,head) {
  const byHash=new Map(commits.map(commit=>[commit.hash,commit])),children=new Map();
  for(const commit of commits)for(const parent of commit.parents){if(!children.has(parent))children.set(parent,[]);children.get(parent).push(commit.hash);}
  let commit=byHash.get(hash),foundHead=false;const seen=new Set();
  if(!commit?.parents.length)return false;
  while(commit){
    if(seen.has(commit.hash)||commit.parents.length>1)return false;seen.add(commit.hash);
    const descendants=children.get(commit.hash)??[];if(descendants.length>1)return false;
    foundHead||=commit.hash===head;if(!descendants.length)return foundHead;
    commit=byHash.get(descendants[0]);
  }
  return false;
}

export function parseGraphFiles(names,stats) {
  const fields=names.split("\0"),files=[],counts=new Map(),numbers=stats.split("\0");
  for(let i=0;i<numbers.length;){
    const row=numbers[i++],first=row.indexOf("\t"),second=row.indexOf("\t",first+1);if(first<0||second<0)continue;
    const a=row.slice(0,first),d=row.slice(first+1,second);let path=row.slice(second+1);
    if(!path){i++;path=numbers[i++];}
    if(path)counts.set(path,{additions:a==="-"?null:Number(a),deletions:d==="-"?null:Number(d)});
  }
  for(let i=0;i<fields.length;){
    const status=fields[i++],oldFilePath=fields[i++];if(!status||!oldFilePath)break;
    const newFilePath=/^[RC]/.test(status)?fields[i++]:oldFilePath;if(!newFilePath)break;
    files.push({type:status[0],oldFilePath,newFilePath,...(counts.get(newFilePath)??{additions:null,deletions:null})});
  }
  return files;
}

export function parseGraphCommit(raw) {
  const [hash,parentText,author,authorEmail,authorTime,committer,committerEmail,commitTime,...body]=raw.replace(/\n$/,"").split("\0");
  if(!hash||body.length===0)throw new Error("Commit details were incomplete");
  return {hash,parents:parentText?parentText.split(" "):[],author,authorEmail,authorTime:Number(authorTime),committer,committerEmail,commitTime:Number(commitTime),body:body.join("\0").trimEnd()};
}

export function graphFileRows(files,tree,collapsed=new Set(),compact=true) {
  const root={children:new Map(),files:[]};
  for(const file of files){
    const parts=file.newFilePath.split("/");let node=root,path="";
    for(const part of parts.slice(0,-1)){path=path?`${path}/${part}`:part;if(!node.children.has(part))node.children.set(part,{path,name:part,children:new Map(),files:[]});node=node.children.get(part);}
    node.files.push(file);
  }
  const rows=[],walk=(node,depth)=>{
    for(let child of [...node.children.values()].sort((a,b)=>a.name.localeCompare(b.name))){
      let name=child.name;
      while(compact&&!child.files.length&&child.children.size===1){child=[...child.children.values()][0];name+=" / "+child.name;}
      if(tree)rows.push({key:`directory:${child.path}`,name,path:child.path,depth,directory:true,collapsed:collapsed.has(child.path)});
      if(!tree||!collapsed.has(child.path))walk(child,tree?depth+1:0);
    }
    for(const file of node.files.slice().sort((a,b)=>a.newFilePath.localeCompare(b.newFilePath)))rows.push({key:`file:${file.newFilePath}`,name:tree?file.newFilePath.split("/").at(-1):file.newFilePath,depth,file});
  };walk(root,0);return rows;
}
