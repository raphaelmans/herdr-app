import { exec } from "herdr";
import { GitCommands } from "./command-runtime.js";

const checked=r=>{if(r.code!==0)throw new Error((r.stderr||r.stdout).trim()||`Git exited ${r.code}`);return r.stdout;};
const SEQUENCE='sh -c \'printf "%s" "$HERDR_GIT_TODO" > "$1"\' sh';

// Lazygit's commit.go: keep consecutive co-author lines together, otherwise
// separate the new trailer from the existing description with a blank line.
export function addCoAuthor(description,author) {
  const body=description.replace(/\n+$/,"");
  return body+(body?(body.split("\n").at(-1).startsWith("Co-authored-by:")?"\n":"\n\n"):"")+`Co-authored-by: ${author}`;
}
export function coAuthorMessage(message,author) {
  const newline=message.indexOf("\n"),subject=newline<0?message:message.slice(0,newline),body=newline<0?"":message.slice(newline+1);
  return subject.trim()+"\n\n"+addCoAuthor(body.trim(),author);
}

export class GitAuthors extends GitCommands {
  commitCoAuthor(cx) {
    const prompt=this.prompt;if(prompt?.kind!=="commit")return;
    const summary=this.message,restore=cx=>this.openPrompt(prompt,summary,cx);
    this.promptValue("Add co-author (Name <Email>)","",(author,cx)=>{
      if(/[\r\n\0]/.test(author)){restore(cx);return this.say("Enter one author on a single line",cx);}
      this.commitBody=addCoAuthor(this.commitBody??"",author);this.bodyInput.set_value(this.commitBody);restore(cx);
    },cx,{onCancel:restore});
  }
  authorMenu(cm,cx) {
    if(this.busy||!this.root)return;
    const selected=(this.main?[cm]:this.selectedItems()).filter(Boolean);
    if(!selected.length||selected.some(it=>it.todo||!it.hash||it.hash==="*"))return this.say("Select local commits to amend",cx);
    const captured={context:{cwd:this.root,on:this.on},repoKey:this.repoKey,head:this.head,branch:this.branches.find(branch=>branch.current)?.ref??null,hashes:selected.map(it=>it.hash)};
    const run=(kind,value,cx)=>this.ask("Amend commit attribute",`Rewrite ${captured.hashes.length===1?captured.hashes[0].slice(0,7):`${captured.hashes.length} commits`}${kind==="reset"?" using your configured author":kind==="set"?` with author ${value}`:` adding co-author ${value}`}?`,cx=>this.amendAuthor(captured,kind,value,cx),cx);
    const prompt=(kind,cx)=>this.perform("Reading authors",async(git,_context,cx)=>{
      const result=await this.boundedGit(["log","-1000","--format=%aN <%aE>"]);
      const suggestions=[...new Set(checked(result).split("\n").filter(Boolean))];
      if(this.closed||this.repoKey!==captured.repoKey)return;
      this.promptValue(kind==="set"?"Set author (Name <Email>)":"Add co-author (Name <Email>)","",(value,cx)=>{
        if(/[\r\n\0]/.test(value))return this.say("Enter one author on a single line",cx);
        run(kind,value,cx);
      },cx,{suggestions});
    },cx,{reads:true});
    const entries=[{label:"Reset author",name:"resetAuthor",defaults:"a",run:cx=>run("reset",null,cx)},
      {label:"Set author…",name:"setAuthor",defaults:"A",run:cx=>prompt("set",cx)},
      {label:"Add co-author…",name:"addCoAuthor",defaults:"c",run:cx=>prompt("coauthor",cx)}];
    this.openMenu({title:"Amend commit attribute",items:entries.map(it=>{const keys=this.configuredBindingKeys({section:"amendAttribute",...it});return {...it,keys,hint:keys.join(" / ")};})},cx);
  }
  amendAuthor(captured,kind,value,cx) {
    if(this.root!==captured.context.cwd||this.on!==captured.context.on||this.repoKey!==captured.repoKey)return this.say("The repository changed; select the commits again",cx);
    this.perform("Amend commit attribute",async(git,context)=>{
      if((await git(["rev-parse","HEAD"])).trim()!==captured.head)throw new Error("HEAD changed; select the commits again");
      const branch=await exec("git",["symbolic-ref","--quiet","HEAD"],context);
      if((branch.code===0?branch.stdout.trim():null)!==captured.branch)throw new Error("The checked-out branch changed; select the commits again");
      const amend=async()=>{
        const args=["commit","--amend","--only","--allow-empty","--allow-empty-message"];
        if(kind==="coauthor"){
          const message=await git(["log","-1","--format=%B"]);
          args.push("-m",coAuthorMessage(message,value));
        }else args.push("--no-edit",kind==="reset"?"--reset-author":`--author=${value}`);
        await git(args);
      };
      if(captured.hashes.length===1&&captured.hashes[0]===captured.head){await amend();return;}
      if(this.operation)throw new Error("Finish the current Git operation before rewriting earlier commits");
      await this.clean(git);
      const selected=new Set(captured.hashes),oldest=captured.hashes.at(-1);
      for(const hash of selected)await git(["merge-base","--is-ancestor",hash,captured.head]);
      const parents=(await git(["rev-list","--parents","-n","1",oldest])).trim().split(" "),base=parents[1];
      const raw=await git(["log","--reverse","--topo-order","-501","--format=%H %P",base?`${base}..${captured.head}`:captured.head,"--"]);
      const rows=raw.trim().split("\n").filter(Boolean).map(line=>line.split(" "));
      if(rows.length>500)throw new Error("Select a range of at most 500 commits");
      if(rows.some(row=>row.filter(Boolean).length>2))throw new Error("This range contains merge commits; its topology must be preserved before editing authors");
      const targets=rows.filter(([hash])=>selected.has(hash));
      if(targets.length!==selected.size)throw new Error("The selected commits are not one local history range");
      const todo=rows.map(([hash])=>`${selected.has(hash)?"edit":"pick"} ${hash}`).join("\n")+"\n";
      const invoke=async args=>checked(await exec("env",["GIT_EDITOR=true",`HERDR_GIT_TODO=${todo}`,`GIT_SEQUENCE_EDITOR=${SEQUENCE}`,"git",...args],context));
      this.startedOperation="rebase";
      await invoke(["rebase","-i",...(base?[base]:["--root"])]);
      for(const [hash] of targets){
        const stopped=(await git(["rev-parse","REBASE_HEAD"])).trim();
        if(stopped!==hash)throw new Error("Rebase stopped at a different commit; inspect the operation before continuing");
        await amend();await invoke(["rebase","--continue"]);
      }
    },cx);
  }
}
