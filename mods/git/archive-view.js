import { div } from "gpui-kit";
import { h_flex, v_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";

export function archiveView(owner,c) {
  const job=owner.archive,disabled=job.loading||job.preparing;
  const button=(id,label,run,primary=false,enabled=true)=>h_flex().id(`archive-${id}`).h(30).px(12).items_center().rounded(7)
    .bg(primary?c.solid:c.raised).text_color(primary?c.solid_foreground:enabled?c.foreground:c.dim).opacity(enabled?1:0.45)
    .when(enabled,e=>e.cursor_pointer().hover(e=>e.opacity(0.85))).on_click((_e,cx)=>{cx.stop_propagation();if(enabled&&owner.archiveCurrent(job))run(cx);}).child(label);
  const label=name=>name.replace(/\n/g,"⏎").replace(/\t/g,"⇥");
  return div().id("git-archive-back").absolute().inset_0().bg(c.background+"88").flex().items_center().justify_center()
    .on_mouse_down("left",(_e,cx)=>cx.stop_propagation()).on_mouse_down("right",(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>cx.stop_propagation())
    .child(v_flex().id("git-archive").w(Math.min(720,(owner.size?.width??900)-40)).h(Math.min(540,(owner.size?.height??700)-40)).p(18).gap(12).rounded(10).border_1().border_color(c.border).bg(c.popover).text_size(13)
      .child(h_flex().items_center().gap(12).child(div().flex_1().min_w(0).truncate().font_semibold().text_size(15).child(`Create archive · ${job.target.name}`)).child(div().text_size(11).text_color(c.dim).child("Esc")))
      .child(h_flex().gap(8).items_center()
        .child(button("parent","↑",cx=>owner.loadArchiveFolder(job.folder+"/..",cx),false,!disabled))
        .child(Input.new(owner.archiveFolderInput).flex_1().min_w(0).h(30).px(8).rounded(6).bg(c.surface).text_color(c.foreground))
        .child(button("open-folder","Open",cx=>owner.loadArchiveFolder(job.enteredFolder,cx),false,!disabled)))
      .child(div().id("archive-list").relative().flex_1().min_h(80).border_1().border_color(c.border).rounded(6).overflow_hidden()
        .on_click((event,cx)=>{cx.stop_propagation();const key=job.clicked;job.clicked=null;if(key!=null)owner.selectArchiveEntry(job,key,event.click_count===2,cx);})
        .child(v_virtual_list("archive-entries",job.items.length,28,index=>job.items[index].name,range=>job.items.slice(range.start,range.end).map((entry,offset)=>h_flex().h(28).w_full().px(10).gap(8).items_center().when(range.start+offset===job.at,e=>e.bg(c.selected)).text_color(c.foreground)
          .child(div().w(16).text_color(c.muted).child(entry.directory?"▸":"·")).child(div().flex_1().min_w(0).truncate().child(label(entry.name)))))
          .on_item_click((key,_cx)=>{job.clicked=key;}).track_scroll(owner.archiveScroll).size_full())
        .child(Scrollbar.vertical("archive-entries").viewport_from_layout().absolute().inset_0())
        .when(job.loading,e=>e.child(div().absolute().inset_0().p(12).bg(c.surface+"dd").child(owner.waiting("Reading folder",c))))
        .when(!job.loading&&!job.items.length,e=>e.child(div().absolute().inset_0().p(12).text_color(c.dim).child(job.error?"Folder unavailable":"This folder is empty"))))
      .child(h_flex().items_center().gap(10)
        .child(button("hidden",`${job.hidden?"☑":"☐"} Hidden files`,cx=>{job.hidden=!job.hidden;owner.loadArchiveFolder(job.folder,cx);},false,!disabled))
        .child(div().flex_1().text_size(11).text_color(c.dim).child(job.limited?"Listing limited · Open a narrower folder":job.field==="folder"?"Enter opens folder · Esc leaves field":job.field==="name"?"Enter creates archive · Esc leaves field":"j k move · h parent · enter open")))
      .child(h_flex().items_center().gap(10).child(div().w(72).text_color(c.muted).child("File name"))
        .child(div().id(`archive-name:${job.id}`).on_size_change((_size,cx)=>owner.focusArchiveName(job,cx)).h(32).flex_1().min_w(0).rounded(6).bg(c.surface).px(8).border_1().border_color(job.field==="name"?c.accent:c.border)
          .child(Input.new(owner.archiveNameInput).w_full().h_full().text_color(c.foreground))))
      .child(h_flex().items_center().gap(8).child(div().w(74).text_color(c.muted).child("Format"))
        .children(["tar","zip"].map(format=>button(format,format.toUpperCase(),cx=>owner.setArchiveFormat(format,cx),job.format===format,!job.preparing))))
      .when(Boolean(job.error),e=>e.child(div().text_size(12).text_color(c.red).child(job.error)))
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).when(job.preparing,e=>e.child(owner.waiting("Checking archive destination",c))))
        .child(button("cancel","Cancel",cx=>owner.dismissArchive(cx,true)))
        .child(button("save","Create archive",cx=>owner.saveArchive(cx),true,!disabled&&Boolean(job.name)))));
}
