import { parsePatch } from "./patch.js";

// Interpret original unified-diff lines, never the expanded/clipped display.
export function diffPath(text) {
  if(text.endsWith("\t"))text=text.slice(0,-1);
  if(!text.startsWith('"'))return text;
  if(!text.endsWith('"'))return "";
  let result="";
  for(let i=1;i<text.length-1;i++){
    const char=text[i];if(char==='"'||char==='\n'||char==='\r')return "";
    if(char!=="\\"){result+=char;continue;}
    if(i+1>=text.length-1)return "";
    const octal=/^(?:\\[0-7]{3})+/.exec(text.slice(i));
    if(octal){
      const bytes=octal[0].match(/[0-7]{3}/g).map(n=>parseInt(n,8));
      if(bytes.some(n=>n>255))return "";
      try{result+=decodeURIComponent(bytes.map(n=>"%"+n.toString(16).padStart(2,"0")).join(""));}
      catch{result+=bytes.map(n=>String.fromCharCode(n)).join("");}
      i+=octal[0].length-1;continue;
    }
    const escaped=text[++i],simple={t:"\t",n:"\n",r:"\r",b:"\b",f:"\f",v:"\v",a:"\x07",'"':'"',"\\":"\\"};
    if(Object.hasOwn(simple,escaped)){result+=simple[escaped];continue;}
    const digits={x:2,u:4,U:8}[escaped];if(!digits)return "";
    const hex=text.slice(i+1,i+1+digits);if(hex.length!==digits||!/^[\da-f]+$/i.test(hex))return "";
    const point=parseInt(hex,16);if(point>0x10ffff||point>=0xd800&&point<=0xdfff)return "";
    result+=String.fromCodePoint(point);i+=digits;
  }
  return result;
}
const submodulePath=line=>line.startsWith("Submodule ")?/^Submodule (.+) (?:contains (?:untracked|modified) content|[0-9a-f]+\.{2,3}[0-9a-f]+(?: \(.*\))?:?)$/.exec(line)?.[1]:null;
const startsSection=line=>/^diff --(?:git|cc|combined) /.test(line)||Boolean(submodulePath(line));
const headerPath=text=>{const path=diffPath(text),slash=path.indexOf("/");return path==="/dev/null"?path:slash<0?"":path.slice(slash+1);};
function sectionPath(lines,start,end) {
  const submodule=submodulePath(lines[start]);if(submodule)return submodule;
  let oldPath,newPath,renamed;
  for(let i=start;i<end&&!lines[i].startsWith("@@");i++){
    const text=lines[i];
    if(text.startsWith("--- "))oldPath=headerPath(text.slice(4));
    if(text.startsWith("+++ "))newPath=headerPath(text.slice(4));
    if(text.startsWith("rename to "))renamed=diffPath(text.slice(10));
    if(text.startsWith("copy to "))renamed=diffPath(text.slice(8));
  }
  if(newPath&&newPath!=="/dev/null")return newPath;
  if(oldPath&&oldPath!=="/dev/null")return oldPath;
  if(renamed)return renamed;
  const header=lines[start].slice(11);
  for(let i=0;i<header.length;i++)if(header[i]===" "){
    const path=headerPath(header.slice(i+1));if(path&&path===headerPath(header.slice(0,i)))return path;
  }
  return null;
}
export function diffLineTarget(lines,index) {
  if(index<0||index>=lines.length)return null;
  let start=-1,end=lines.length;
  for(let i=0;i<=index;i++)if(startsSection(lines[i]))start=i;
  if(start<0||/^diff --(?:cc|combined) /.test(lines[start]))return null;
  if(submodulePath(lines[start])){
    end=start+1;while(end<lines.length&&/^  [<>] /.test(lines[end]))end++;
    return index<end?{path:submodulePath(lines[start])}:null;
  }
  for(let i=start+1;i<lines.length;i++)if(startsSection(lines[i])){end=i;break;}
  const path=sectionPath(lines,start,end);if(!path)return null;
  // A clipped last hunk may be incomplete. Every earlier hunk must agree
  // with its declared lengths, just as upstream's raw-buffer parser does.
  let target=null,hunk=null;
  const valid=partial=>!hunk||(partial?hunk.old<=hunk.oldLength&&hunk.next<=hunk.newLength:hunk.old===hunk.oldLength&&hunk.next===hunk.newLength);
  for(let i=start;i<end;i++){
    const line=lines[i];
    if(i===end-1&&line==="")break; // patch.Parse removes one trailing newline.
    if(line.startsWith("@@")){
      const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if(!header||!valid(false))return null;
      hunk={oldLength:Number(header[2]??1),newLength:Number(header[4]??1),newStart:Number(header[3]),old:0,next:0};
      if(i===index)target={path,line:hunk.newStart};
    }else if(hunk){
      if(i===index)target={path,line:hunk.newStart+hunk.next};
      if(line[0]!=="\\"){
        if(line[0]!=="+")hunk.old++;
        if(line[0]!=="-")hunk.next++;
      }
    }else if(i===index)target={path};
  }
  return valid(end===lines.length)?target:null;
}
// Map a line in the index/historical blob to its current worktree position.
export function adjustEditorLine(raw,line) {
  let adjusted=line;
  for(const hunk of parsePatch(raw).hunks){
    const oldCount=hunk.lines.filter(l=>/^[ -]/.test(l.text)).length,newCount=hunk.lines.filter(l=>/^[ +]/.test(l.text)).length;
    if(hunk.old>=line)break;
    if(hunk.old+oldCount>line)return hunk.next;
    adjusted+=newCount-oldCount;
  }
  return adjusted;
}
