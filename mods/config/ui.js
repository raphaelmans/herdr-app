// What the pages draw alike.
import { div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { home } from "herdr";

// A wait: one spinner, turned natively, and what is being waited for.
export const waiting = (t, label) => h_flex().gap(6).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)).child(label);

export const heading = (t, label, note) => h_flex().flex_none().px(4).gap(8).items_end().text_size(11)
  .child(div().flex_none().font_semibold().text_color(t.muted).child(label))
  .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(note ?? ""));

export const box = (t, on) => div().flex_none().size(15).rounded(4).border_1().border_color(on ? t.accent : t.input)
  .when(on, (el) => el.bg(t.accent))
  .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : "");

export const chip = (t, text, color) => div().flex_none().px(6).h(17).flex().items_center().rounded(4).bg(t.raised).text_size(11).text_color(color).child(text);

export const toggle = (t, on) => h_flex().flex_none().w(32).h(18).px(2).rounded_full().items_center()
  .bg(on ? t.accent : t.input).when(on, (el) => el.justify_end())
  .child(div().size(14).rounded_full().bg(on ? t.accent_foreground : t.muted));

// The agent shortlist: the agent keys this machine offers; absent or empty, all.
export const SHORTLIST = "agents.shortlist";

// A path with the home folder written as ~.
export const tildify = (p) => (p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
