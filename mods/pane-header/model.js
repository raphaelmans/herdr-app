// The model an agent CLI is running, whichever provider it comes from.
//
// Herdr doesn't know it, so this reads it, in order:
//   1. the terminal's label `agent.model` (any CLI or wrapper can set it:
//      `hc label $HC_TERMINAL_ID agent.model=gpt-5-codex`), else
//   2. the last line in the terminal's history where a CLI says which model
//      it uses (its banner, a /model switch, a status bar).
// Conversation text is skipped: only lines shaped like those CLIs' own UI
// count, and bare model ids only in the screen's bottom lines (status bars).

// Lines anywhere in the history. The last one that matches wins, so a
// /model switch beats the banner above it.
const SAID = [
  /Set model to\s+`?([^`\n]+?)`?(?:\s+and saved|\s*\(|\s*$)/, // Claude Code /model
  /^[\s▐▛▜▝▘▌█▀▄▙▟*]+((?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)*(?:\s*\[1m\])?)(?:\s+with\s+(\w+)\s+effort)?\s+·/, // Claude Code banner
  /Using\s+((?:Opus|Sonnet|Haiku|Fable|Mythos)\s+\d+(?:\.\d+)*)\s+\(from/, // Claude Code settings note
  /[│|]\s*model:\s+(\S+(?:\s+(?:minimal|low|medium|high|xhigh))?)/, // Codex header box
  /Model changed to\s+(\S+(?:\s+(?:minimal|low|medium|high|xhigh))?)/, // Codex /model
  /^\s*Main model:\s+(\S+)/, // Aider
  /([\w./-]*gemini-[\w.-]+)\s*\(\d+% context/, // Gemini CLI footer
  /[─│]\s*(Grok\s+\d+(?:\.\d+)*(?:\s+[A-Z][\w-]*)*)(?:\s+\((\w+)\))?\s+·/, // Grok prompt box
];

// A bare model id, trusted only in the last few lines of the screen.
const ID = /\b((?:[\w-]+\/)?(?:claude-[\w.-]+|gpt-[\w.-]+|o[134](?:-mini|-pro)?|gemini-[\w.-]+|grok-[\w.-]+|kimi-[\w.-]+|qwen[\w.-]*|deepseek-[\w.-]+|glm-[\w.-]+|mistral-[\w.-]+|codestral[\w.-]*|llama-?[\w.-]+))\b/i;
const FOOTER = 4;

// "anthropic/claude-sonnet-4" -> "claude-sonnet-4": the provider is left out.
export function tidy(model) {
  return model.trim().replace(/^[\w-]+\//, "").replace(/[).,:;]+$/, "");
}

export function fromLabel(labels) {
  const v = labels?.["agent.model"];
  return v ? tidy(v) : "";
}

// The model in a terminal's text (history and screen), or "".
export function fromText(text) {
  const lines = text.replace(/\s+$/, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const re of SAID) {
      const m = lines[i].match(re);
      if (m) return tidy(m[2] ? `${m[1]} ${m[2]}` : m[1]);
    }
    if (i >= lines.length - FOOTER) {
      const m = lines[i].match(ID);
      if (m) return tidy(m[1]);
    }
  }
  return "";
}
