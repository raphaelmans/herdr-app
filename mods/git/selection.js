import { GitExternal } from "./external.js";

const modified = (event) => Object.values(event.modifiers ?? {}).some(Boolean);

// A list range has a fixed anchor and a moving end. Lazygit's v range survives
// ordinary movement; a Shift-arrow or mouse-drag range does not.
export class GitSelection extends GitExternal {
  rangeEnabled(panel = this.panel) { return ["files", "branches", "commits", "stash"].includes(panel); }
  cancelRange(panel = this.panel) {
    const key = this.viewKey(panel);
    this.rangeAnchors[key] = null;
    delete this.rangeModes[key];
  }
  clampRange(panel = this.panel, items = this.list(panel)) {
    const clamp = (n) => items.length ? Math.max(0, Math.min(n ?? 0, items.length - 1)) : -1, key = this.viewKey(panel);
    this.sel[panel] = clamp(this.sel[panel]);
    if (this.rangeAnchors[key] != null) this.rangeAnchors[key] = clamp(this.rangeAnchors[key]);
  }
  selectedItems(panel = this.panel) {
    const items = this.list(panel), anchor = this.rangeAnchors[this.viewKey(panel)], at = this.sel[panel];
    return anchor == null ? [items[at]].filter(Boolean) : items.slice(Math.min(anchor, at), Math.max(anchor, at) + 1);
  }
  inRange(panel, n) {
    const anchor = this.rangeAnchors[this.viewKey(panel)], at = this.sel[panel];
    return anchor != null && n >= Math.min(anchor, at) && n <= Math.max(anchor, at);
  }
  multipleSelected(panel = this.panel) { return this.selectedItems(panel).length > 1; }
  guardListActions(items, allowed) {
    if(!this.multipleSelected())return items;
    return items.map(item=>!item||allowed.includes(item[1])||item[5]?item:[...item.slice(0,5),...Array(Math.max(0,5-item.length)).fill(null),"This action requires a single selected item"]);
  }
  listRangeKeys(key, ch, modifiers, cx) {
    if (this.main || !this.rangeEnabled()) return false;
    const name = this.viewKey();
    if (ch === "v") {
      if (this.rangeAnchors[name] != null) this.cancelRange();
      else if (this.list().length) { this.rangeAnchors[name] = this.sel[this.panel]; this.rangeModes[name] = "sticky"; }
      this.reload(cx); return true;
    }
    if (modifiers.shift && ["up", "down"].includes(key)) {
      if (this.list().length) {
        this.rangeAnchors[name] ??= this.sel[this.panel]; this.rangeModes[name] = "nonsticky";
        this.move(this.sel[this.panel] + (key === "up" ? -1 : 1), cx, true);
      }
      return true;
    }
    if (key === "escape" && this.rangeAnchors[name] != null) { this.cancelRange(); this.reload(cx); return true; }
    return false;
  }
  beginListPointer(panel, at, event, cx) {
    this.listPointer = null;
    if (modified(event)) return;
    const focused = this.panel === panel && !this.main;
    this.cancelRange(panel); this.handle.focus(); this.panel = panel; this.main = false; this.move(at, cx);
    this.listPointer = { panel, key: this.viewKey(panel), anchor: at, focused, moved: false, released: false };
  }
  extendListPointer(panel, at, event, cx) {
    const pointer = this.listPointer;
    if (!pointer || pointer.released || pointer.panel !== panel || pointer.key !== this.viewKey(panel) || modified(event) || at === this.sel[panel]) return;
    if (!this.rangeEnabled(panel)) return;
    this.rangeAnchors[pointer.key] = pointer.anchor; this.rangeModes[pointer.key] = "nonsticky"; pointer.moved = true;
    this.move(at, cx, true);
  }
  clickListRow(panel, at, event, cx) {
    const pointer = this.listPointer; this.listPointer = null;
    if (modified(event) || pointer?.moved) return;
    const focused = pointer?.focused ?? (this.panel === panel && !this.main);
    this.cancelRange(panel); this.handle.focus(); this.panel = panel; this.main = false; this.move(at, cx);
    if (event.click_count === 2 && focused) this.activateItem(cx);
  }
  selectedFiles() {
    // Tree rows include their visible descendants. A range can also include
    // those same descendants as rows, so every path must be acted on once.
    return [...new Map(this.selectedItems("files").flatMap(node => node.dir ? node.files : [node.file]).filter(Boolean).map(file => [file.path, file])).values()];
  }
  toggleSelectedFiles(cx) {
    const nodes = this.selectedItems("files");
    if (nodes.length === 1) return this.toggleFile(nodes[0], cx);
    this.toggleFiles(this.selectedFiles(), false, cx);
  }
}
