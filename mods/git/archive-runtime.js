import { InputState, VirtualListScrollHandle } from "gpui-base";
import { checking, exec } from "herdr";
import { GitReferences } from "./ref-actions.js";
import { ARCHIVE_FOLDER_SCRIPT, ARCHIVE_DESTINATION_SCRIPT, ARCHIVE_PUBLISH_SCRIPT, archiveFileName, archiveFolderEntries, archiveDestination } from "./archive-data.js";
import { archiveView } from "./archive-view.js";

const checked=result=>{if(result.code)throw new Error((result.stderr||result.stdout).trim().slice(-1800)||`Command exited ${result.code}`);return result.stdout;};

export class GitArchive extends GitReferences {
  initArchive() {
    this.archive=null;this.archiveSequence=0;this.archiveScroll=VirtualListScrollHandle.new();
    this.archiveFolderInput=InputState.new({placeholder:"Folder"});this.archiveNameInput=InputState.new({placeholder:"Archive file name"});
    for(const [field,input]of [["folder",this.archiveFolderInput],["name",this.archiveNameInput]]){
      input.on("change",(_e,cx)=>{const job=this.archive,property=field==="folder"?"enteredFolder":"name";if(job&&job[property]!==input.value()){
        job[property]=input.value();job.error=null;
        if(job.preparing){job.preparing=false;job.saveToken++;}
        if(field==="folder"&&job.loading){job.loading=false;job.request++;}
        cx.notify();
      }});
      input.on("focus",(_e,cx)=>{if(this.archive){this.archive.field=field;this.archive.focusPending=false;this.typing=true;cx.notify();}});
      input.on("blur",(_e,cx)=>{if(this.archive?.field===field){this.archive.field=null;this.typing=false;cx.notify();}});
      input.on("submit",(_e,cx)=>{if(field==="folder")this.loadArchiveFolder(input.value(),cx);else this.saveArchive(cx);cx.stop_propagation();});
    }
  }
  openGraphArchive(target,cx,draft={}) {
    if(!this.graphActionReady(target,cx)||!["local","remote","tag"].includes(target.kind)||target.detached)return;
    const folder=draft.folder??target.root;
    this.archive={id:++this.archiveSequence,target,folder,enteredFolder:folder,name:draft.name??"",format:draft.format??"tar",hidden:draft.hidden??false,items:[],at:0,request:0,saveToken:0,focusPending:true};
    this.archiveFolderInput.set_value(folder);this.archiveNameInput.set_value(this.archive.name);
    this.loadArchiveFolder(folder,cx);
  }
  archiveCurrent(job) {return !this.closed&&this.archive===job&&job.target.repo===this.repoKey&&job.target.root===this.root&&job.target.on===this.on;}
  focusArchiveName(job,cx) {if(this.archiveCurrent(job)&&job.focusPending){job.focusPending=false;this.archiveNameInput.focus();cx.notify();}}
  dismissArchive(cx,cancelled=false) {
    if(!this.archive)return;this.archive.loading=false;this.archive.preparing=false;this.archive.request++;this.archive.saveToken++;this.archive=null;this.typing=false;
    if(cx){this.handle.focus();if(cancelled)this.note="No file name was provided for the archive.";cx.notify();}
  }
  loadArchiveFolder(folder,cx) {
    const job=this.archive;if(!job||job.preparing||!this.archiveCurrent(job))return;
    if(!job.focusPending){this.handle.focus();this.typing=false;job.field=null;}
    const request=++job.request;job.loading=true;job.error=null;job.clicked=null;cx.notify();
    if(checking()){job.loading=false;return;}
    cx.spawn(async cx=>{
      try{
        const result=await exec("sh",["-c",ARCHIVE_FOLDER_SCRIPT,"sh",folder,job.hidden?"1":"0"],{cwd:job.folder,on:job.target.on});
        if(!this.archiveCurrent(job)||request!==job.request)return;
        const listing=archiveFolderEntries(checked(result));
        job.folder=listing.folder;job.enteredFolder=listing.folder;job.items=listing.items;job.at=0;job.limited=listing.limited;
        job.error=listing.error?(result.stderr.trim()||"Some entries could not be read."):null;
        this.archiveFolderInput.set_value(job.folder);this.archiveScroll.scroll_to_item(0);
      }catch(e){if(this.archiveCurrent(job)&&request===job.request)job.error=e.message??String(e);}
      finally{if(this.archive===job&&!this.archiveCurrent(job))this.dismissArchive(cx);else if(this.archiveCurrent(job)&&request===job.request){job.loading=false;cx.notify();}}
    });
  }
  selectArchiveEntry(job,key,open,cx) {
    if(!this.archiveCurrent(job)||job.loading||job.preparing)return;
    const at=job.items.findIndex(item=>item.name===key);if(at<0)return;
    job.at=at;const item=job.items[at];this.handle.focus();this.typing=false;job.focusPending=false;
    if(item.directory){if(open)this.loadArchiveFolder(job.folder.replace(/\/$/,"")+"/"+item.name,cx);}
    else{job.name=item.name;this.archiveNameInput.set_value(item.name);if(open)this.saveArchive(cx);}
    cx.notify();
  }
  setArchiveFormat(format,cx) {
    const job=this.archive;if(!job||job.preparing)return;
    job.format=format;if(job.name){job.name=/\.(tar|zip)$/i.test(job.name)?job.name.replace(/\.(tar|zip)$/i,`.${format}`):job.name;this.archiveNameInput.set_value(job.name);}cx.notify();
  }
  saveArchive(cx) {
    const job=this.archive;if(!job||job.loading||job.preparing||!this.archiveCurrent(job))return;
    let file;try{file=archiveFileName(job.name,job.format,/^[a-z]:[\\/]|^\\\\/i.test(job.folder));}catch(e){job.error=e.message;cx.notify();return;}
    const token=job.saveToken=(job.saveToken??0)+1;
    job.name=file.name;job.format=file.format;this.archiveNameInput.set_value(file.name);job.preparing=true;job.error=null;job.focusPending=false;this.handle.focus();this.typing=false;cx.notify();
    cx.spawn(async cx=>{
      try{
        const destination=archiveDestination(checked(await exec("sh",["-c",ARCHIVE_DESTINATION_SCRIPT,"sh",job.enteredFolder,file.name],{cwd:job.folder,on:job.target.on})));
        if(!this.archiveCurrent(job)||job.saveToken!==token)return;
        const draft={folder:destination.folder,name:file.name,format:file.format,hidden:job.hidden};
        this.dismissArchive(cx);
        const write=cx=>this.writeArchive(job.target,destination,file.format,cx);
        if(destination.hash){
          this.ask("Replace archive",`“${destination.path}” already exists. Replace it with an archive of ${job.target.name}?`,write,cx);
          this.pending.onCancel=()=>this.openGraphArchive(job.target,cx,draft);
        }else write(cx);
      }catch(e){if(this.archiveCurrent(job)&&job.saveToken===token)job.error=e.message??String(e);}
      finally{if(this.archive===job&&!this.archiveCurrent(job))this.dismissArchive(cx);else if(this.archiveCurrent(job)&&job.saveToken===token){job.preparing=false;cx.notify();}}
    });
  }
  writeArchive(target,destination,format,cx) {
    this.graphReferenceAction("Creating archive",target,async(git,context)=>{
      let temporary;
      try{
        temporary=checked(await exec("sh",["-c",'mktemp "$1/.herdr-archive.XXXXXX"',"sh",destination.folder],context)).replace(/\n$/,"");
        if(!temporary)throw new Error("Cannot create a temporary archive.");
        await git(["archive",`--format=${format}`,"-o",temporary,target.hash]);
        checked(await exec("sh",["-c",ARCHIVE_PUBLISH_SCRIPT,"sh",temporary,destination.path,destination.hash??""],context));
      }finally{if(temporary)checked(await exec("sh",["-c",'rm -f -- "$1"',"sh",temporary],context));}
    },cx,{done:`Archive created: ${destination.path}`,timeout:600000});
  }
  archiveKeys(event,cx) {
    const job=this.archive,key=event.key_char??event.key;if(!job)return;
    if(event.key==="escape"){
      if(this.typing){job.focusPending=false;job.field=null;this.typing=false;this.handle.focus();cx.notify();}
      else this.dismissArchive(cx,true);
      return cx.stop_propagation();
    }
    if(this.typing){if(event.key==="enter"&&(event.modifiers?.platform||event.modifiers?.control)){this.saveArchive(cx);cx.stop_propagation();}return;}
    cx.stop_propagation();if(job.loading||job.preparing)return;
    if(["j","k","up","down","g","G","home","end"].includes(key)){
      job.at=Math.max(0,Math.min(job.items.length-1,["g","home"].includes(key)?0:["G","end"].includes(key)?job.items.length-1:job.at+(["j","down"].includes(key)?1:-1)));
      this.archiveScroll.scroll_to_item(job.at);cx.notify();
    }else if(["h","left"].includes(key))this.loadArchiveFolder(job.folder+"/..",cx);
    else if(["l","right","enter"].includes(key)){const item=job.items[job.at];if(item)this.selectArchiveEntry(job,item.name,true,cx);else if(key==="enter")this.saveArchive(cx);}
    else if(key==="i"||key==="tab")this.archiveNameInput.focus();
  }
  archiveView(c) {return archiveView(this,c);}
}
