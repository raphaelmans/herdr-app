import { View, div } from "gpui-kit";
import { Button, h_flex, v_flex, h_resizable, resizable_panel, ScrollHandle, VirtualListScrollHandle, v_virtual_list, Scrollbar, TextView } from "gpui-base";
import { graphFileRows } from "./graph-details.js";

const markdown=text=>String(text).replace(/([\\`*_{}\[\]()#+.!<>|~-])/g,"\\$1").replace(/\n/g,"  \n");
const diffAvailable=file=>file.type==="U"||(file.additions!=null&&file.deletions!=null);

// Deferred graph rows only mount entities. Each child owns ordinary handlers
// in its normal render, outside the virtual list's layout callback.
export class GraphLabels extends View {
  init(props) {this.owner=props.owner;this.hash=props.hash;}
  render() {
    const owner=this.owner,row=owner.graphRowsByHash.get(this.hash);if(!row)return div();
    const c=owner.colors(),rootCx=owner.graphRootCx,groups=owner.graphReferenceGroups(row.commit);
    const palette=[c.ansi4,c.ansi5,c.ansi2,c.ansi3,c.ansi6,c.ansi1,c.ansi12,c.ansi13,c.ansi10,c.ansi11,c.ansi14,c.ansi9],color=row.color<0?c.dim:palette[row.color%palette.length];
    const segment=(target,index)=>Button.new(`graph-ref:${target.ref}`).flex_none().h(20).px(5).text_size(10.5).text_color(index?c.muted:c.foreground)
      .when(!index,e=>e.bg(color+"33")).when(index>0,e=>e.border_l(1).border_color(color)).when(target.current,e=>e.font_bold())
      .accessibility_label(`${target.kind}: ${target.name}`).child(target.caption??target.name)
      .on_click((event,cx)=>{cx.stop_propagation();owner.graphClick=null;if(!owner.graphActionReady(target,rootCx))return;if(event.click_count===2)owner.checkoutGraphReference(target,rootCx);else rootCx.notify();})
      .on_mouse_down("right",(_event,cx)=>{cx.stop_propagation();owner.graphClick=null;owner.graphReferenceMenu(target,rootCx);});
    return h_flex().gap(4).min_w(0).children(groups.slice(0,4).map(group=>h_flex().flex_none().rounded(4).overflow_hidden().border_1().border_color(color).children(group.map(segment))))
      .when(groups.length>4,e=>e.child(Button.new(`graph-more-refs:${this.hash}`).h(20).px(4).text_size(10.5).text_color(c.muted).child(`+${groups.length-4}`)
        .accessibility_label("More references").on_click((_event,cx)=>{cx.stop_propagation();owner.graphClick=null;if(owner.graphActionReady(groups[0][0],rootCx))owner.menuItems("References",groups.flat().map(ref=>[ref.name,ref.kind,cx=>owner.graphReferenceMenu(ref,cx)]),rootCx);})));
  }
}

export class GraphDetails extends View {
  init(props,cx) {this.owner=props.owner;this.summaryScroll=ScrollHandle.new();this.filesScroll=VirtualListScrollHandle.new();this.handle=cx.focus_handle();this.width=0;}
  render() {
    const owner=this.owner,job=owner.graphInspection,c=owner.colors();if(!job)return div();
    const rootCx=owner.graphRootCx,data=job.data,rows=graphFileRows(data?.files??[],owner.graphFileTree,owner.graphCollapsed),byKey=new Map(rows.map((row,index)=>[row.key,{row,index}]));
    const at=Math.max(0,Math.min(owner.graphFileAt,rows.length-1));
    const activate=row=>{
      if(!row||job.loading||!owner.graphReadCurrent(job))return;
      if(row.directory){if(owner.graphCollapsed.has(row.path))owner.graphCollapsed.delete(row.path);else owner.graphCollapsed.add(row.path);owner.notifyGraph(rootCx);}
      else if(diffAvailable(row.file))owner.openGraphFile(row.file,rootCx);
    };
    const command=(id,label,text,run)=>Button.new(`graph-details:${id}`).w(30).h(28).text_size(12).text_color(c.foreground).hover(e=>e.bg(c.hover)).accessibility_label(label).child(text)
      .on_click((_event,cx)=>{cx.stop_propagation();if(owner.graphReadCurrent(job))run(rootCx);});
    const summary=v_flex().id("graph-summary").h_full().min_w(0).p(12).gap(6).overflow_y_scrollbar().track_scroll(this.summaryScroll)
      .when(job.loading&&Boolean(data),e=>e.child(owner.waiting(job.label,c)));
    if(data?.commit){
      const commit=data.commit,field=(label,value)=>h_flex().items_start().gap(6).child(div().w(74).flex_none().text_color(c.muted).child(label))
        .child(TextView.markdown(`graph-meta:${label}`,markdown(value)).selectable(true).scrollable(false).flex_1().min_w(0));
      summary.child(field("Commit",commit.hash));
      summary.child(h_flex().items_start().gap(6).child(div().w(74).flex_none().text_color(c.muted).child("Parents")).child(v_flex().flex_1().min_w(0).children(commit.parents.length?commit.parents.map(hash=>owner.graphRowsByHash.has(hash)?Button.new(`graph-parent:${hash}`).text_color(c.accent).child(hash).on_click((_e,cx)=>{cx.stop_propagation();if(owner.graphReadCurrent(job))owner.inspectGraphCommit(hash,{},rootCx);}):div().child(hash)):[div().child("None")])));
      summary.child(field("Author",`${commit.author} <${commit.authorEmail}>`));
      if(commit.authorTime!==commit.commitTime)summary.child(field("Author date",new Date(commit.authorTime*1000).toLocaleString()));
      summary.child(field("Committer",`${commit.committer} <${commit.committerEmail}>`));
      summary.child(field(commit.authorTime===commit.commitTime?"Date":"Committer date",new Date(commit.commitTime*1000).toLocaleString()));
      summary.child(TextView.markdown("graph-message",markdown(commit.body)).selectable(true).scrollable(false).mt(8));
    }else summary.child(job.secondary?`Displaying all changes from ${job.from} to ${job.to==="*"?"Uncommitted changes":job.to}.`:"Displaying all uncommitted changes.");
    const files=div().id("graph-detail-files").size_full().min_w(0).relative().track_focus(this.handle).key_context("GitMod")
      .on_action("git-escape",(_event,cx)=>{cx.stop_propagation();if(owner.graphReadCurrent(job)){owner.closeGraphInspection(rootCx);owner.handle.focus();}})
      .on_key_down((event,cx)=>{
        if(!owner.graphReadCurrent(job)){cx.stop_propagation();return;}
        const key=event.key_char??(event.modifiers?.shift?event.key.toUpperCase():event.key);
        if(["j","k","up","down","home","end","g","G","enter","escape"].includes(key)){
          cx.stop_propagation();if(key==="enter")return activate(rows[at]);if(key==="escape"){owner.closeGraphInspection(rootCx);owner.handle.focus();return;}
          owner.graphFileAt=Math.max(0,Math.min(rows.length-1,["home","g"].includes(key)?0:["end","G"].includes(key)?rows.length-1:at+(["j","down"].includes(key)?1:-1)));this.filesScroll.scroll_to_item(owner.graphFileAt);owner.notifyGraph(rootCx);
        }
      })
      .child(v_virtual_list("graph-files",rows.length,24,index=>rows[index].key,range=>rows.slice(range.start,range.end).map((row,offset)=>{
        const index=range.start+offset,file=row.file,selected=index===at;
        return h_flex().w_full().h(24).px(8).gap(6).pl(8+row.depth*16).items_center().text_size(12).text_color(c.foreground).when(selected,e=>e.bg(c.selected)).hover(e=>e.bg(selected?c.selected:c.hover))
          .child(div().w(16).flex_none().text_color(file?.type==="D"?c.red:["A","U"].includes(file?.type)?c.green:c.muted).child(row.directory?(row.collapsed?"▸":"▾"):file.type))
          .child(div().flex_1().min_w(0).truncate().child(row.name))
          .when(file&&owner.graphLastFile===file.newFilePath,e=>e.child(div().text_size(10).text_color(c.dim).child("Viewed")))
          .when(file&&["M","R"].includes(file.type)&&file.additions!=null,e=>e.child(div().flex_none().text_size(10).text_color(c.dim).child(`(+${file.additions}|−${file.deletions})`)));
      })).on_item_click((key,cx)=>{cx.stop_propagation();if(!owner.graphReadCurrent(job))return;const entry=byKey.get(key);if(entry){owner.graphFileAt=entry.index;this.handle.focus();activate(entry.row);owner.notifyGraph(rootCx);}}).track_scroll(this.filesScroll).size_full())
      .child(Scrollbar.vertical("graph-files").viewport_from_layout().absolute().inset_0())
      .when(!rows.length,e=>e.child(div().p(12).text_color(c.dim).child("No changed files")));
    const width=Math.max(100,(this.width||Math.max(240,(owner.size?.width??1200)*0.5))-32),minimum=width*0.2;
    return h_flex().id("graph-details").h_full().min_h(0).w_full().bg(c.background).border_y(1).border_color(c.border).text_size(12)
      .on_click((_e,cx)=>{owner.graphClick=null;cx.stop_propagation();}).on_mouse_down("right",(_e,cx)=>cx.stop_propagation())
      .on_size_change((size,cx)=>{if(this.width!==size.width){this.width=size.width;cx.notify();}})
      .child(job.loading&&!data?div().flex_1().p(12).child(owner.waiting(job.label,c)):h_resizable(`graph-details-split:${job.repo}`).flex_1().min_h(0).h_full()
        .on_resize((sizes,_cx)=>{if(!owner.graphReadCurrent(job))return;owner.graphDivider=Math.max(0.2,Math.min(0.8,sizes[0]/(sizes[0]+sizes[1])));owner.saveGraphPrefs();})
        .child(resizable_panel().size(width*owner.graphDivider).size_range(minimum,width*0.8).child(summary))
        .child(resizable_panel().size_range(minimum,width*0.8).child(files)))
      .child(v_flex().w(32).flex_none().h_full().border_l(1).border_color(c.border).items_center()
        .child(command("close","Close details","×",cx=>owner.closeGraphInspection(cx)))
        .when(!job.loading,e=>e.child(command("files",owner.graphFileTree?"Show file list":"Show file tree",owner.graphFileTree?"☷":"▸",cx=>{owner.graphFileTree=!owner.graphFileTree;owner.graphFileAt=0;owner.saveGraphPrefs();owner.notifyGraph(cx);}))));
  }
}
