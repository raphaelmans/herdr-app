import { parsePatch } from "./patch.js";

function quotePath(path) {
  if(path.includes("\0"))throw new Error("Invalid patch filename");
  if(!/[\s"\\\x00-\x1f\x7f]/.test(path))return path;
  return '"'+path.replace(/["\\\x00-\x1f\x7f]/g,char=>char==='"'||char==="\\"?"\\"+char:"\\"+char.charCodeAt(0).toString(8).padStart(3,"0"))+'"';
}
function formatHunks(hunks,path) {
  const out=[`--- ${quotePath("a/"+path)}`,`+++ ${quotePath("b/"+path)}`];let delta=0,changed=false;
  for(const hunk of hunks){
    const body=hunk.lines.map(line=>line.text),oldCount=body.filter(line=>/^[ -]/.test(line)).length,newCount=body.filter(line=>/^[ +]/.test(line)).length;
    const next=hunk.old+delta+(oldCount===0?1:0)-(newCount===0?1:0);delta+=newCount-oldCount;
    if(!body.some(line=>/^[+-]/.test(line)))continue;
    changed=true;out.push(`@@ -${hunk.old},${oldCount} +${next}${newCount===1?"":","+newCount} @@${hunk.suffix}`,...body);
  }
  return changed?out.join("\n")+"\n":"";
}
export function patchLineIdentity(patch,row) {
  for(const hunk of patch.hunks){
    let old=hunk.old,next=hunk.next;
    for(const line of hunk.lines){
      const kind=line.text[0];
      if(line.row===row&&(kind==="-"||kind==="+"))return {lineNumber:kind==="-"?old:next,isDeletion:kind==="-"};
      if(kind===" "||kind==="-")old++;
      if(kind===" "||kind==="+")next++;
    }
  }
  return null;
}
export function prepareEditableHunk(raw,path,identity) {
  const patch=parsePatch(raw);if(patch.binary)throw new Error("Binary changes cannot be edited as a hunk");
  for(const hunk of patch.hunks)for(const line of hunk.lines){
    const here=patchLineIdentity(patch,line.row);
    if(here&&here.lineNumber===identity.lineNumber&&here.isDeletion===identity.isDeletion)
      return {text:formatHunks([hunk],path),editorLine:line.row-hunk.row+3};
  }
  throw new Error("The selected diff line is no longer present; refresh and select it again");
}
export function normalizeEditedHunk(raw,path) {
  if(raw.includes("\0")||/(^|\n)(Binary files |GIT binary patch)/.test(raw))throw new Error("The edited patch must be a text diff");
  let inHunk=false;
  for(const line of raw.replace(/\n$/,"").split("\n")){
    if(line.startsWith("@@")){
      if(!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@.*$/.test(line))throw new Error("Invalid edited hunk header");
      inHunk=true;continue;
    }
    if(line.startsWith("diff --git ")){inHunk=false;continue;}
    if(inHunk&&!/^[ +\\-]/.test(line))throw new Error("Invalid edited hunk body; prefix context with a space");
    if(inHunk&&line.startsWith("\\")&&line!=="\\ No newline at end of file")throw new Error("Invalid edited patch newline marker");
  }
  return formatHunks(parsePatch(raw).hunks,path);
}
