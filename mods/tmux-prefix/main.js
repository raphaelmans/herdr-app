import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, closeOverlay, focused, hc, nextCommand, notify, openOverlay, panes, props, run, theme } from "herdr";

// Edit these two things to make the example yours. Only repeatable actions
// start a timer: the first key after Ctrl+A can take as long as you like.
const REPEAT_MS = 500;
const BINDINGS = [
  ["c", "New tab", "tab.new"],
  ["v", "Split right", "pane.split", { direction: "right" }],
  ["-", "Split down", "pane.split", { direction: "down" }],
  ["x", "Close pane", "pane.close"],
  ["X", "Close tab", "tab.close"],
  ["T", "Rename tab", "tab.rename"],
  ["n", "Next tab", "tab.next"],
  ["p", "Previous tab", "tab.prev"],
  ["a", "Next agent", "agent.next"],
  ["A", "Previous agent", "agent.prev"],
  ["h", "Focus left", "pane.go", { direction: "left" }],
  ["j", "Focus down", "pane.go", { direction: "down" }],
  ["k", "Focus up", "pane.go", { direction: "up" }],
  ["l", "Focus right", "pane.go", { direction: "right" }],
  ["left", "Focus left", "pane.go", { direction: "left" }, true],
  ["down", "Focus down", "pane.go", { direction: "down" }, true],
  ["up", "Focus up", "pane.go", { direction: "up" }, true],
  ["right", "Focus right", "pane.go", { direction: "right" }, true],
  ["J", "Next space", "space.next", {}, true],
  ["K", "Previous space", "space.prev", {}, true],
  ["z", "Zoom pane", "pane.zoom"],
  ["[", "Copy mode", "copy-mode"],
  ["y", "Copy pane title", "copy-title"],
  ["N", "New space", "space.new"],
  ["W", "Rename space", "space.rename"],
  ["D", "Close space", "space.close"],
  ["G", "New worktree", "worktree"],
  ["w", "Picker", "mod.open", { name: "picker" }],
  ["g", "Go to", "mod.open", { name: "picker" }],
  ["b", "Toggle sidebar", "layout.toggle", { id: "sidebar" }],
  ["e", "Toggle Neovim", "mod.open", { name: "herdr-nvim" }],
  ["s", "Settings", "app.settings"],
  ["q", "Minimize window", "window.minimize"],
  ["?", "Help", "app.help"],
  ...Array.from({ length: 10 }, (_, i) => [String(i), `Tab ${i === 0 ? 10 : i}`, "tab.select", { index: i === 0 ? 10 : i }]),
];

// The worktree dialog and copy mode are mods, not commands: open them as overlays.
// Leading status glyphs agents put in titles: spinners (braille), ✳, ●, emoji.
const TITLE_NOISE = /^[\u2800-\u28FF\u2700-\u27BF\u2600-\u26FF\u25A0-\u25FF\u2022\u00B7*\p{Extended_Pictographic}\uFE0F\s]+/u;

function act(command, args, cx) {
  if (command === "copy-title") {
    const pane = focused()?.pane;
    const title = (panes().find((p) => p.pane === pane)?.title ?? "").replace(TITLE_NOISE, "").trim();
    if (!title) return notify({ title: "This pane has no title", level: "warning", timeout: 1500 });
    cx.write_to_clipboard(title);
    notify({ title: "Copied pane title", body: title, level: "success", timeout: 1500 });
    return;
  }
  if (command === "copy-mode") {
    const terminal = focused()?.terminal;
    if (terminal) openOverlay({ mod: "copy-mode", kind: "window", width: 0.92, height: 0.88, props: { terminal } });
    return;
  }
  if (command !== "worktree") return run(command, args);
  const f = focused();
  if (f) openOverlay({ mod: "worktree", kind: "dialog", width: 460, height: 280, props: { space: f.space, folder: f.cwd, action: "new" } });
}

function forwardKey(e, key) {
  if (["enter", "tab", "backspace", "left", "right", "up", "down", "space"].includes(e.key)) return e.key;
  if (key === " ") return "space";
  if (/^[A-Z]$/.test(key)) return `shift+${key.toLowerCase()}`;
  if (key.length === 1 && "abcdefghijklmnopqrstuvwxyz0123456789`\\[],=-.';/".includes(key)) return key === "\\" ? "backslash" : key;
  return null;
}

export default class TmuxPrefix extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.repeat = false;
    this.generation = 0;
    // The mod-specific key binding beats the global opener while we're open.
    cx.spawn(async (cx) => {
      for (;;) {
        await nextCommand();
        this.sendPrefix(cx);
      }
    });
  }

  dismiss() {
    closeOverlay(props().overlay);
  }

  send(key, cx) {
    this.generation++;
    const terminal = focused()?.terminal;
    if (!terminal) return this.dismiss();
    // hc starts its subprocess at the call, before closing cancels this view's tasks.
    const pending = hc(["keys", terminal, key]);
    cx.spawn(async () => {
      const result = await pending;
      if (result.code !== 0) console.log(`tmux-prefix: ${result.stderr}`);
    });
    this.dismiss();
  }

  sendPrefix(cx) {
    this.send("ctrl+a", cx);
  }

  key(e, cx) {
    cx.stop_propagation();
    const m = e.modifiers;
    if (e.key === "escape") return this.dismiss();
    if (m.control && e.key === "a") return this.sendPrefix(cx);
    if (m.alt && !m.control && !m.platform && /^[1-9]$/.test(e.key)) {
      const agent = agents()[Number(e.key) - 1];
      this.dismiss();
      if (agent) run("agent.focus", { terminal: agent.address });
      return;
    }
    const plain = !m.control && !m.alt && !m.platform;
    const key = plain ? (e.key_char ?? (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key)) : e.key;
    const binding = plain && BINDINGS.find((b) => b[0] === key);
    if (!binding) {
      const forwarded = this.repeat && plain && forwardKey(e, key);
      if (forwarded) return this.send(forwarded, cx);
      return this.dismiss();
    }
    const [, , command, args = {}, repeatable = false] = binding;
    if (!repeatable) this.dismiss();
    act(command, args, cx);
    if (repeatable) {
      this.repeat = true;
      const generation = ++this.generation;
      cx.timer.after(REPEAT_MS, () => {
        if (this.generation === generation) this.dismiss();
      });
      cx.notify();
    }
  }

  render() {
    const t = theme();
    const rows = BINDINGS.filter(([key]) => !["left", "right", "up", "down"].includes(key) && !/^\d$/.test(key));
    const half = Math.ceil(rows.length / 2);
    return v_flex().id("tmux-prefix").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().justify_between().child(div().font_semibold().child(this.repeat ? `Repeat · ${REPEAT_MS} ms` : "Ctrl+A · waiting for a key"))
        .child(div().text_color(t.muted).child("Esc cancel · ^A send prefix")))
      .child(h_flex().h(280).min_h(0).items_start().gap(20).children([rows.slice(0, half), rows.slice(half)].map((column) =>
        v_flex().flex_1().min_w(0).children(column.map(([key, label, , , repeatable]) =>
          h_flex().h(20).flex_none().items_center().gap(8).child(div().w(24).text_color(t.accent).child(key))
            .child(div().flex_1().child(label)).child(div().text_color(t.dim).child(repeatable ? "repeat" : "")))))))
      .child(div().text_color(t.muted).child("0–9 tabs (0 = 10) · arrows focus · Alt+1–9 agents"));
  }
}
