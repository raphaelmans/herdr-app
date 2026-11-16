# Edge auto-scroll for a drag selection in the native Git mod

Ticket: #8 (map #2). Question: can a mod built on gpui-kit keep extending a
mouse-drag range and scroll the list when the pointer reaches the list's top or
bottom edge, the way Lazygit does?

Sources, all read from the live copy in `~/.config/herdr-app` (line numbers are
from that copy on 2026-11-16 and will drift):

- `mods/git/gpui-kit.d.ts`: the type file the app treats as the API contract.
- `herdr.d.ts`, `AGENTS.md`: Herdr's mod model.
- `mods/git/selection.js`, `mods/git/main.js`: the current drag range.
- Lazygit upstream (`jesseduffield/lazygit`, commit `54cc6af`, 2026-11-15):
  `pkg/gui/controllers/helpers/drag_autoscroller.go`,
  `pkg/gui/controllers/list_controller.go`, `pkg/gocui/gui.go`.

## Answer

**Feasible, with one real limit.** Every piece needed exists in the API: pointer
position against the list's bounds, a repeating timer to keep scrolling while
the pointer is held still, a way to read the pointer from inside that timer, and
a scroll call that reveals one more row. What is missing is **pointer capture**:
element mouse events stop once the pointer leaves the element, and there is no
"release outside" event or "is the button held" query. So the scroll zones must
sit **inside** the list's own bounds, and auto-scroll must stop when the pointer
leaves the list. Lazygit's fastest zone ("pointer beyond the view") cannot be
copied.

## What drives it

| Need | API | Source |
| --- | --- | --- |
| Pointer position against the list while dragging | `on_mouse_move(handler)`; `MouseMoveEvent` carries `position` (window), `local_position` (element) and `bounds` | `gpui-kit.d.ts` 473-479, 732-733 |
| Press / release | `on_mouse_down("left", …)`, `on_mouse_up("left", …)`; `MouseButtonEvent` with `local_position?`, `bounds?` | 482-498, 767-783 |
| Pointer leaving the list | `on_hover(hovered => …)`, reports entry and exit | 737-738 |
| Tick while the pointer is held still | `cx.timer.every(ms, cb)` (interval measured from the end of each call, so ticks do not stack) or chained `cx.timer.after(ms, cb)`; returns a `Task` with `cancel()` | 389-390, 20646-20654 |
| Pointer position inside a tick (no event arrives when the mouse is still) | global `window.mouse_position()`, window coordinates; compare with the `bounds` cached from the last move event | 20534-20535, 22751-22753 |
| Scroll by one row | `ScrollHandle.scroll_to_item(index)`: "smallest scroll needed", consumed once after layout. The Git panels already use it in `move()` | 21331-21342; `main.js` 525 |
| Redraw from the tick | the `AsyncContext` handed to the timer callback: `cx.notify()` redraws the owning view | 400-410 |

Not usable for this:

- `frames(list, ms)` and `loop(property, policy)` run natively and never call
  script code (`gpui-kit.d.ts` 1232-1241). They animate a look, they are not a
  clock a mod can hook. There is no `setTimeout` or `requestAnimationFrame`; the
  timer is the clock.
- `ScrollHandle` has no offset getter or setter and no `scroll_by`; only
  `scroll_to_item` and `release` (21331-21340). `VirtualListScrollHandle` adds
  `scroll_to_item(index, "top" | "center")` and `scroll_to_bottom` (21351-21364).
  Neither can scroll by pixels, so edge scrolling advances by whole rows.
- `on_scroll_wheel` only reports wheel input (531-542, 802-809).
- There is no `on_drag`/`on_drag_move` for in-list drags; `drag_paths` and
  `drag_tab` are file and dock drag sources (794-798, 1322-1326).

## What Lazygit does

- A drag is `MouseLeft` + `ModMotion`, bound only where `RangeSelectEnabled()`;
  `MouseRelease` ends it (`list_controller.go` 371-386).
- Each drag event extends the non-sticky range to the row under the pointer,
  then feeds the pointer's viewport Y to a `DragAutoscroller`
  (`list_controller.go` 271-288).
- Zones (`drag_autoscroller.go`, `dragAutoscrollZone`): pointer above or below
  the view scrolls every 50 ms; the outermost row every 100 ms; the row inside
  it every 250 ms; elsewhere nothing. Entering a zone waits 300 ms first, "so
  that merely passing through the zone doesn't scroll".
- Each tick scrolls one line, then re-extends the range to the row now under the
  remembered pointer Y. It stops when the direction changes (a generation
  counter drops stale ticks), the view can no longer scroll, no range is being
  selected, the button is released, or focus is lost.
- gocui **captures the mouse** on press: "While the mouse is captured, all mouse
  events go to the view" until release, and a captured drag can report
  positions outside the view (`gui.go` 733-749, 1834-1930). That capture is
  what makes the "beyond the view" zone and release-anywhere work.
- Herdr's own terminal selection behaves the same way natively ("Dragging a
  text selection past the terminal's top or bottom scrolls while held;
  releasing stops it", `AGENTS.md` 655-658), but that is host code, not a mod
  API.

## How it would fit the Git mod

The current drag (`selection.js` `beginListPointer` / `extendListPointer`,
`main.js` `rowsIn` 856-869) already has the right shape: a `listPointer` with
an anchor, row `on_mouse_move` calling `move(at, cx, true)`, `on_mouse_up` on
the list wrapper marking `released`, and `on_hover(false)` dropping the pointer.

A sketch, all inside the existing wrapper:

1. Add `on_mouse_move` on the `rowsIn` wrapper (not only per row) and keep
   `event.bounds` and `event.local_position.y` on `listPointer`. Rows are
   28 px with `py(4)`, so the edge zones are the first and last row heights of
   the wrapper's own bounds, mirroring Lazygit's two inner zones (100 ms and
   250 ms).
2. Entering a zone arms `cx.timer.after(300, tick)` (Lazygit's initial delay);
   store the `Task` and a generation number on `listPointer`.
3. `tick(cx)`: drop it if the generation changed, `listPointer` is gone or
   `released`, or the range end is already at the first/last item. Otherwise
   read `window.mouse_position()`, compare to the cached `bounds`; if the
   pointer has left the zone (or the list), stop. Else move the range end one
   row (`move(sel ± 1, cx, true)`, which already calls `scroll_to_item`), and
   chain the next `after(interval)`.
4. Cancel the task on release, on `on_hover(false)`, on `cancelRange`, on panel
   change and in `close()`.

Because `scroll_to_item` scrolls only as much as needed to reveal a child, moving
the end row one past the visible edge scrolls exactly one row, which is
Lazygit's one-line-per-tick behaviour without needing to read the offset.

## Limits and risks

- **No capture.** `on_mouse_move` is "delivered while this element is hovered"
  (732). Once the pointer leaves the list, moves and the release are not seen,
  so the existing code already drops `listPointer` on hover-out. Keep that: a
  tick that kept running after the pointer left could not know the button was
  released. Consequence: no "beyond the edge" fast zone, and a fast flick past
  the edge ends the drag instead of scrolling. A mod-wide wrapper with its own
  `on_mouse_move`/`on_mouse_up` could widen the area (pointer over the panel
  title or the next panel), but still stops at the mod's pane boundary.
- **No button state.** `MouseMoveEvent` has no pressed-buttons field (473-479)
  and there is no global query, so a missed `on_mouse_up` cannot be detected
  from a tick. Stopping at hover-out is the safety net.
- **Stale bounds.** The tick compares `window.mouse_position()` with bounds
  cached from the last move event. A pane resize mid-drag would make them stale;
  refresh them on every move and stop on any layout change.
- **Load per step.** `move()` spawns `this.load(cx)` (the detail pane) on every
  call (`main.js` 526). At 100 ms ticks that is up to ten loads a second; the
  same happens with a held arrow key today, but a drag-scroll over a long list
  may want the detail load deferred until the drag ends.
- **Commits paging.** `move()` pages more commits near the end of the list
  (`main.js` 521-524); a tick that reaches the loaded end should wait for the
  page rather than stop.
- **Verification.** Only what the types promise was checked; nothing ran in the
  live window. In particular, whether `window.mouse_position()` is legal from a
  timer callback is inferred from "legal from `render`, like every measurement
  below it" (20523-20531) and timer callbacks receiving an `AsyncContext`; a
  short scripted test should confirm it before building on it. If it is not,
  the fallback is to scroll only while move events arrive (no scroll while the
  pointer is perfectly still), which is weaker but still useful.
