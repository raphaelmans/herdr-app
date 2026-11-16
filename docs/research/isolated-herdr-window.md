# Can a second, isolated Herdr window run live acceptance?

Ticket: #9 (map #2). Answered from documentation and type files only, with no second instance started and no input sent. Versions read: herdr-app 0.1.16, hc 0.1.21.

Sources (cited as **[name]** below):

- **[help]** `herdr-app --help`
- **[skill]** `herdr-app --skill`
- **[cmds]** `herdr-app commands`
- **[agents]** `~/.config/herdr-app/AGENTS.md` (Herdr's generated guide)
- **[dts]** `~/.config/herdr-app/herdr.d.ts`
- **[kit]** `mods/git/gpui-kit.d.ts`
- **[hc]** `hc --help` and `hc --skill`
- **[bin]** printable strings in the installed app and core binaries (`strings`). Weak evidence: it shows which names exist, not how they are used.

## Short answer

Partly yes. A disposable `HERDR_APP_HOME` is a documented, supported way to select a separate window. To keep it away from the person's spaces and terminals, it also needs its own herdr-core session (`HC_SESSION` plus scratch XDG paths). The docs don't say the app passes those through to its core, so an experiment has to confirm it.

There is **no app-level command for raw keystrokes or pointer input**. App-level input stops at three things:

- app commands (`herdr-app do …`)
- mod commands (`<mod>.<command>` to `nextCommand()`)
- named actions dispatched from inside a mod (`window.dispatch_action`)

Real key presses, clicks and drags can only come from OS events. On macOS those go to the key window and the real pointer, which is exactly what this ticket wants to avoid.

So the isolated window can cover **state, layout, rendering and command-driven flows**, and can be checked with `shot` and `status`. It can't safely cover **drag selection, pointer hover or key routing through focus**. Those still need the person's permission or a separate OS session.

## 1. Can a separate instance run against a disposable `HERDR_APP_HOME`?

Documented:

- "Home: ~/.config/herdr-app (HERDR_APP_HOME picks another)." **[help]** "Home defaults to `~/.config/herdr-app`; `HERDR_APP_HOME` selects another." **[skill]**
- `status` and `shot` are scoped per window by home: "`HERDR_APP_HOME` selects the window, as for `status`" **[skill]**, and "selects which running window to ask" **[agents]**. That wording assumes more than one running window can be told apart by home.
- Everything per screen lives in the home: `view.json` (selected space, tab, pane, zoom, settled tabs), `shared.json`, `window.json`, layouts, keys, settings and mods **[agents, "The files"]**. `appHome()` returns `$HERDR_APP_HOME` to mods **[dts]**.
- Herdr's own advice for isolation is Linux-only and for app development: "When developing the app on Linux, its `scripts/sandbox` provides an isolated home, core and display" **[skill]**. That script ships in Herdr's source, not with the macOS app installed here. Even Herdr isolates home, core **and display** together.

Not documented:

- Whether launching a second process on macOS opens a second window or hands off to the running app. The binary contains an "already running" string **[bin]**. Start it by running the executable directly, or with `open -n`. Bare `herdr-app` "opens or raises the window" **[skill]**, and Finder or plain `open` would raise the person's instance.

## 2. Would it share herdr-core and terminals with the person's session?

**By default, yes. That's the main hazard.**

- "Each machine keeps its spaces, tabs and splits in its core's `herdr-app` document. Connected screens share that layout and live terminals, not their focus, zoom or attention." **[agents, "The model"]**
- "Every layout shows the same world" **[agents]**. Structural commands write that shared document, and "the newest accepted document wins (no merging)" **[agents]**.

So a second window with only a new `HERDR_APP_HOME` but the same core would show the person's spaces and terminals. A `space.new`, `tab.close` or `pane.split` it ran would change the person's real window. A separate home isolates focus, zoom, layout choice, keys and mod state. It doesn't isolate the world.

Isolating the core:

- hc supports separate sessions. `HC_SESSION` / `--session` picks "the hc session to reach" **[hc]**. The sockets are per session (`HC_SOCKET`, `holder.sock`, "use a shorter HC_SESSION") **[bin]**. State and config follow `XDG_STATE_HOME` / `XDG_CONFIG_HOME` **[bin]**.
- hc's own rule: "Never `hc server stop` or restart the user's core unless asked… Tests need their own `HC_SESSION` and scratch XDG paths." **[hc --skill]**
- Not documented: whether the **app** respects `HC_SESSION` when it connects to or starts its core. The app binary has no `HC_SESSION` string, but it does mention `XDG_CONFIG_HOME`, a launchd `job.plist` / `bootstrap` / `kickstart`, and `HERDR_CORE_DIRS` **[bin]**. Most likely the app runs `hc`/herdr-core as a child process that inherits the environment, but a fixed launchd job label could still reach the person's core. **The experiment in section 6 has to settle this before the isolated window runs any structural command.**

## 3. How can input be injected without reaching the person's window or pointer?

App-level paths, all scoped to one window by `HERDR_APP_HOME`:

| Path | What it reaches | Limits |
|---|---|---|
| `herdr-app do <command> [args]` **[help, cmds]** | Every app command: spaces, tabs, panes, `pane.go`/`pane.focus`, `mod.open`, `overlay.close`, `layout.*`, terminal selection and scroll, `window.minimize` | Commands only, no key events. Agent-invoked commands never open a missing-argument dialog **[agents]** |
| `<mod>.<command>` to the mod's `nextCommand()` **[dts `run`, agents keys section]** | A mod's own command loop. "`<mod>.<command>` reaches shown copies only" **[agents]** | The mod has to implement the commands. `mods/git/main.js` has no `nextCommand()` loop today. Docs show this path from `run()` and keys.json. Whether `herdr-app do git.<cmd>` routes there too is **unconfirmed** |
| `window.dispatch_action(action)` from inside a mod **[kit]** | "Dispatches an action down this window's focus path, reaching the same handlers a bound chord would" | Only `on_action` handlers, not `on_key_down`. Runs inside the app, so a test-only mod in the disposable home would have to call it. The Git mod mostly uses `on_key_down` |
| `hc keys` / `hc send` **[hc]** | The **program in a terminal**, through the core | Not app UI. Safe only against the scratch core |

**There's no app command for keystrokes, clicks, hover or drags.** `herdr-app commands` lists none **[cmds]**, and neither `herdr.d.ts` nor `gpui-kit.d.ts` exposes synthetic input or a test hook **[dts, kit]**. GPUI's Rust test contexts (`simulate_keystrokes` and similar) aren't reachable from JS mods.

The rest is OS events: macOS CGEvent and accessibility tools such as agent-desktop. Keyboard events go to the key window. Mouse events, drags included, move the **real pointer**. Herdr's own rule: "Never experiment with pointer/key automation on the person's real display." **[skill]** Posting keyboard events to one process ID (`CGEventPostToPid`) might reach a background GPUI window without taking focus, but nothing documents that, it needs Accessibility permission, and it doesn't cover drags.

## 4. What can be observed?

| Want | How | Covered? |
|---|---|---|
| Pixels: layout, dialogs, overlays, floats, spinners | `HERDR_APP_HOME=… herdr-app shot f.png`: the app's own rendering, "even when the window is covered or minimized", no screen-recording permission **[skill, agents]** | Yes. The test window can stay minimized, out of the person's way |
| Focus, layout, overlays, zoom, errors | `herdr-app status`: `space`, `tab`, `focused_pane`, `layout`, `agent`, `floats`, `overlays`, `errors` (keys seen on this machine's window) | Pane-level focus only. No element tree, so it can't tell which list row or field inside a mod has the keyboard |
| Structure | `herdr-app ls`, plus `view.json` in the disposable home **[agents]** | Yes |
| Mod state | `shared.json` / `data/` in the disposable home, or files a test mod writes **[agents]** | Yes, if the mod writes it |
| Terminal output | `hc read` on the scratch core **[hc]** | Yes |
| Drags | Only as before and after shots of a drag something else performed | Not injectable without the real pointer. Floats report `dragging` **[dts]**, but nothing app-level starts a drag |
| Large-history scrolling and remount | `shot` after commands that change data. Wheel scroll needs OS input. `terminal.scroll` exists only for terminals | Partly |

## 5. Recommended way to run live acceptance

1. **Scripted tests stay the main evidence** for logic (`node --test mods/git/*.test.js`) and `herdr-app check mods/git` for load and first render.
2. **An isolated window for render and flow acceptance**, once section 6 passes:
   - a disposable home (copy of `layouts/mine.json`, `mods/git`, keys and settings) plus its own `HC_SESSION` and scratch `XDG_STATE_HOME` / `XDG_CONFIG_HOME`
   - started in the background (`open -g -n --env …` or the executable directly) and then `window.minimize`d
   - driven only by `HERDR_APP_HOME=… herdr-app do …` against a throwaway git repo
   - checked with `shot` and `status`
   - To drive Git mod flows this way, add a small `nextCommand()` command surface to the Git mod (for example "select row N", "run action X"). That's a design decision for a later ticket. Without it, the isolated window can only open the mod and screenshot its first state.
3. **Real keys, pointer and drags** (drag selection, hover, Escape and focus routing) still need the person's permission each time. Better still, run them in a place with its own display: a second macOS user session or a VM, or Herdr's Linux `scripts/sandbox` if that source is ever available. Never on the person's display.

## 6. Experiments needed (only with the person's permission)

E1: is the core isolated? This one decides whether the isolated window is safe to drive.

```sh
T=$(mktemp -d); mkdir -p "$T/app" "$T/state" "$T/config"
cp -R ~/.config/herdr-app/{layouts,mods,keys.json,settings.json} "$T/app/"
export HERDR_APP_HOME="$T/app" HC_SESSION=accept-$$ XDG_STATE_HOME="$T/state" XDG_CONFIG_HOME="$T/config"
hc server start && hc ls            # expect: empty, a different core
open -g -n --env HERDR_APP_HOME="$HERDR_APP_HOME" --env HC_SESSION="$HC_SESSION" \
  --env XDG_STATE_HOME="$XDG_STATE_HOME" --env XDG_CONFIG_HOME="$XDG_CONFIG_HOME" /Applications/Herdr.app
herdr-app ls                        # (scoped) expect: no person spaces
herdr-app do space.new --name probe --focus false
hc ls                               # expect: probe's terminal here
env -u HERDR_APP_HOME -u HC_SESSION -u XDG_STATE_HOME -u XDG_CONFIG_HOME herdr-app ls   # person's: no "probe"
```

Pass means: a second window appears without taking key focus from the person, its `ls` is empty, and the person's `ls` never shows `probe`. If `probe` turns up in the person's window, close it with `space.close --confirmed true` right away. That would mean the app ignores `HC_SESSION`, and the isolated window can't run structural commands.

Cleanup: `HERDR_APP_HOME=… herdr-app do app.quit`, then `hc server stop` **with the scratch `HC_SESSION` set** (never without it), then `rm -rf "$T"`.

E2: run `HERDR_APP_HOME=… herdr-app do git.<cmd>` with a stub `nextCommand()` loop in a scratch copy of a mod. Does it arrive?

E3 (optional): does `CGEventPostToPid` keyboard input reach the minimized or background isolated window without activating it? Only if key-routing acceptance is worth the Accessibility grant.
