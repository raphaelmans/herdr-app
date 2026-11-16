// How notifications look. Anything can post one with notify({ title, body,
// level, icon, action }); replace this mod to restyle them all. Click to
// run its action (e.g. go to the agent) and dismiss it.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, panes, props, closeOverlay, run, spaces, terminals, theme, shared } from "herdr";

// A clone of Herdr's `toast` that follows the curtain (mods/curtain): while it
// is drawn, a notification that carries a program's icon or goes to an agent,
// pane, terminal, tab or space when clicked (Herdr's "finished" and "needs
// you") closes at once, unseen. Plain notices from mods still show.
const about = (p) => Boolean(p.icon) || /^(agent|pane|terminal|tab|space)\./.test(p.action?.name ?? "");

// Attention to deferred work stays out of the window. Resolve the explicit
// action target, including an unkept child's parent; never use current focus
// or a matching title, which could suppress an unrelated notice.
function aboutHidden(p) {
  const hidden = new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
  if (!hidden.size) return false;
  const action = p.action ?? {}, args = action.args ?? {};
  const kind = (action.name ?? "").split(".")[0];
  if (!["agent", "pane", "terminal", "tab", "space"].includes(kind)) return false;
  const space = args.space ?? (kind === "space" ? args.id : null);
  if (space && hidden.has(space)) return true;
  const tab = args.tab ?? (kind === "tab" ? args.id : null)
    ?? (args.pane ? panes().find((x) => x.pane === args.pane)?.tab : null);
  if (tab && spaces().some((s) => hidden.has(s.id) && s.tabs.some((t) => t.id === tab))) return true;
  let address = args.terminal;
  if (!address) return false;
  const owners = new Map(agents().map((a) => [a.address, a.space]));
  const all = new Map(terminals().map((t) => [t.address, t]));
  const seen = new Set();
  while (address && !seen.has(address)) {
    seen.add(address);
    if (owners.has(address)) return hidden.has(owners.get(address));
    const t = all.get(address), id = t?.labels?.["herdr.space"];
    if (id) return hidden.has(address.slice(0, address.lastIndexOf("/") + 1) + id);
    address = t?.parent;
  }
  return false;
}

const DOT = { error: "blocked", warning: "working", success: "done", info: "accent" };

export default class Toast extends View {
  render(cx) {
    const t = theme();
    const p = props() ?? {};
    if ((shared("curtain")?.on && about(p)) || aboutHidden(p)) { closeOverlay(p.overlay); return div(); }
    const login = /^([a-z0-9][a-z0-9_.-]{0,31}) needs login; run hc machine login \1$/.exec(p.body ?? "");
    const command = login ? `hc machine login ${login[1]}` : null;
    return h_flex()
      .id("toast")
      .size_full()
      .px(18)
      .gap(12)
      .items_center()
      .bg(t.popover)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => {
        if (p.action?.name) run(p.action.name, p.action.args ?? {});
        closeOverlay(p.overlay);
      })
      .child(p.icon ? image(p.icon).w(18).h(18).flex_none() : div().size(8).rounded(4).flex_none().bg(t[DOT[p.level] ?? "accent"]))
      .child(
        v_flex()
          .flex_1()
          .overflow_hidden()
          .child(div().truncate().font_semibold().text_size(13).text_color(t.foreground).child(login ? `${login[1]} needs a login: run` : p.title ?? ""))
          .when(!login && Boolean(p.body), (el) => el.child(div().truncate().text_size(12).text_color(t.muted).child(p.body ?? "")))
          .when(Boolean(login), (el) => el.child(h_flex().gap(8).items_center()
            .child(div().flex_1().min_w(0).truncate().tooltip(command).text_size(12).text_color(t.muted).child(command))
            .child(div().id("toast-login-copy").flex_none().px(6).py(3).rounded(4).bg(t.raised)
              .text_size(12).text_color(t.foreground).cursor_pointer().hover(s => s.bg(t.hover))
              .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(command); this.copied = true; cx.notify(); })
              .child(this.copied ? "Copied" : "Copy")))),
      );
  }
}
