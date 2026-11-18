// node --test mods/pane-reference/reference.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { reference, toastBody } from "./reference.js";

const agent = { address: "t63", title: "✳ Fix login redirect", agent: "claude-code", program: "Claude Code", space: "herdr-updates", tab: 5, core: "abc123" };

test("an agent: tag with its name and place, how to read it and ask it", () => {
  const text = reference(agent);
  assert.match(text, /^<herdr-ref to="t63" name="Fix login redirect" agent="claude-code" where="herdr-updates \/ 5" core="abc123"\/>\n/);
  assert.match(text, /core.id abc123, set target=t63/);
  assert.match(text, /set target=NAME\/t63/);
  assert.match(text, /hc read "\$target" --lines 400/);
  assert.match(text, /hc send "\$target" '<herdr-message from="YOUR_ADDRESS">/);
  assert.match(text, /\$HC_TERMINAL_ID/);
});

test("a shell: only how to read it, nobody to ask", () => {
  const text = reference({ address: "t2g", title: "", agent: null, program: "zsh", space: "plugins", tab: 1, core: "abc123" });
  assert.match(text, /^<herdr-ref to="t2g" agent="zsh" where="plugins \/ 1" core="abc123"\/>/);
  assert.match(text, /^A terminal in Herdr/m);
  assert.doesNotMatch(text, /hc send/);
});

test("an empty title leaves the name out", () => {
  assert.doesNotMatch(reference({ ...agent, title: "✳ " }), /name=/);
});

test("quotes and angle brackets in a title are escaped", () => {
  assert.match(reference({ ...agent, title: `Say "hi" <now> & go` }), /name="Say &quot;hi&quot; &lt;now&gt; &amp; go"/);
});

test("an address on another machine is kept as Herdr gives it, with its machine", () => {
  const text = reference({ ...agent, address: "omarchy/t5", machine: "omarchy" });
  assert.match(text, /to="omarchy\/t5"/);
  assert.match(text, /machine="omarchy"/);
  assert.match(text, /^Another agent in Herdr on omarchy\./m);
  assert.match(text, /set target=t5\./);
  assert.match(text, /set target=NAME\/t5 /);
  assert.doesNotMatch(text, /hc (?:read|send) (?:omarchy\/)?t5 /);
});

test("no machine known: no machine attribute", () => {
  assert.doesNotMatch(reference(agent), /machine=/);
});

test("no place known: no where", () => {
  assert.doesNotMatch(reference({ ...agent, space: null, tab: null }), /where=/);
});

test("the toast hides the title while the curtain is drawn", () => {
  assert.equal(toastBody(agent, false), "t63 · Fix login redirect");
  assert.equal(toastBody(agent, true), "t63");
  assert.equal(toastBody({ address: "t2g", title: "" }, false), "t2g");
});
