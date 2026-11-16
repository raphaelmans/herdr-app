import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, closeOverlay, exec, focused, hc, nextCommand, notify, openOverlay, panes, props, run, setShared, shared, theme } from "herdr";

// Only repeatable actions start a timer: the first key after Ctrl+A can take as long as you like.
const REPEAT_MS = 500;
const BINDINGS = [
  ["c", "New tab…", "launcher"],
  ["v", "Split right…", "launcher", { place: "right" }],
  ["-", "Split down…", "launcher", { place: "down" }],
  ["x", "Close pane", "pane.close"],
  ["X", "Close tab", "tab.close"],
  ["T", "Rename tab", "tab.rename"],
  ["r", "Renumber tabs", "tab-sequence.renumber"],
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
  ["t", "Move pane to tab…", "mod.open", { name: "pane-move" }],
  ["!", "Break pane to new tab", "pane-break"],
  ["[", "Copy mode", "copy-mode"],
  ["y", "Copy pane title", "copy-title"],
  ["N", "New space…", "launcher", { place: "space" }],
  ["W", "Rename space", "space.rename"],
  ["D", "Close space", "space.close"],
  ["G", "New worktree", "worktree"],
  ["w", "Go to", "mod.open", { name: "go-to" }],
  ["g", "Git", "mod.open", { name: "git" }],
  ["b", "Toggle sidebar", "layout.toggle", { id: "sidebar" }],
  ["e", "Toggle Neovim", "nvim-pane.toggle"],
  ["i", "Send box", "mod.open", { name: "send-box" }],
  ["m", "Agent hub", "mod.open", { name: "agent-hub" }],
  ["L", "Lific", "mod.open", { name: "lific" }],
  ["I", "Lific request…", "mod.open", { name: "lific-request" }],
  ["P", "Pull requests", "mod.open", { name: "pull-requests" }],
  ["B", "Jira", "mod.open", { name: "jira" }],
  ["f", "Fork agent session", "mod.open", { name: "agent-fork" }],
  ["M", "Config", "mod.open", { name: "config" }],
  ["o", "Open vault in Obsidian", "vault-open"],
  ["Y", "Copy vault path", "vault-copy"],
  ["O", "Vaults…", "vault-config"],
  ["s", "Settings", "app.settings"],
  ["q", "Minimize window", "window.minimize"],
  ["?", "Help", "app.help"],
  ...Array.from({ length: 10 }, (_, i) => [String(i), `Tab ${i === 0 ? 10 : i}`, "tab.select", { index: i === 0 ? 10 : i }]),
];

// While the curtain (mods/curtain) is drawn, the actions that show agents are
// neither listed nor run, and the space keys pass over spaces it leaves out.
const veiled = () => Boolean(shared("curtain")?.on);
const hiddenSpaces = () => new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
const showsAgents = (command, args) => command.startsWith("agent.") || (command === "mod.open" && ["agent-hub", "agent-fork", "go-to", "lific-request"].includes(args?.name));

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
  // The connected vault is chosen on the Vaults page of Config (shared "vault");
  // with none connected, both vault keys open that page instead.
  if (command.startsWith("vault-")) {
    const vault = shared("vault");
    if (command === "vault-config" || !vault?.path) {
      if (command !== "vault-config") notify({ title: "No connected vault", body: "Connect one on the Vaults page", level: "warning", timeout: 2500 });
      setShared("config.page", "vaults");
      return run("mod.open", { name: "config" });
    }
    if (command === "vault-copy") {
      cx.write_to_clipboard(vault.path);
      notify({ title: "Copied vault path", body: vault.path, level: "success", timeout: 1500 });
      return;
    }
    // Obsidian's own link: starts Obsidian when it is not running. The process
    // starts at the call, before closing cancels this view's tasks.
    exec("open", [`obsidian://open?path=${encodeURIComponent(vault.path)}`]).catch(() => {});
    return;
  }
  // The launcher picks what runs: a new tab, or a split or space when given a place.
  if (command === "launcher") {
    openOverlay({ mod: "launcher", kind: "dialog", width: 500, height: 680, frame: "none", props: args });
    return;
  }
  // Invisible: it moves the focused pane to a tab of its own and closes itself.
  if (command === "pane-break") {
    openOverlay({ mod: "pane-move", kind: "popup", at: { x: 0, y: 0 }, width: 1, height: 1, frame: "none", props: { to: "new" } });
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
      const hidden = hiddenSpaces();
      const agent = veiled() ? null : agents().filter((a) => !hidden.has(a.space))[Number(e.key) - 1];
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
    if (veiled() && showsAgents(command, args)) return this.dismiss();
    if (!repeatable) this.dismiss();
    if (shared("layout") === "mine" && /^(space|agent)\.(next|prev)$/.test(command)) run(`curtain.${command.replace(".", "-")}`);
    else act(command, args, cx);
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
    const rows = BINDINGS.filter(([key, , command, args]) => !["left", "right", "up", "down"].includes(key) && !/^\d$/.test(key) && !(veiled() && showsAgents(command, args)));
    // Three columns of equal length; the list takes the height left between the
    // title and the footer, and scrolls if the bindings outgrow the popup.
    const per = Math.ceil(rows.length / 3);
    const columns = [0, 1, 2].map((i) => rows.slice(i * per, (i + 1) * per));
    return v_flex().id("tmux-prefix").track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(14).gap(8).bg(t.popover).text_color(t.foreground).text_size(12)
      .child(h_flex().justify_between().child(div().font_semibold().child(this.repeat ? `Repeat · ${REPEAT_MS} ms` : "Ctrl+A · waiting for a key"))
        .child(div().text_color(t.muted).child("Esc cancel · ^A send prefix")))
      .child(div().id("bindings").flex_1().min_h(0).overflow_y_scroll().child(h_flex().items_start().gap(20).children(columns.map((column) =>
        v_flex().flex_1().min_w(0).children(column.map(([key, label, , , repeatable]) =>
          h_flex().h(20).flex_none().items_center().gap(8).child(div().flex_none().w(20).text_color(t.accent).child(key))
            .child(div().flex_1().min_w(0).truncate().child(label)).child(div().flex_none().text_color(t.dim).child(repeatable ? "repeat" : ""))))))))
      .child(div().flex_none().text_color(t.muted).child(veiled() ? "0–9 tabs (0 = 10) · arrows focus" : "0–9 tabs (0 = 10) · arrows focus · Alt+1–9 agents"));
  }
}
