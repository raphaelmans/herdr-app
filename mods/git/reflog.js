// Lazygit 54cc6af pkg/gui/controllers/undo_controller.go: the parser and the
// undo/redo callbacks' counter rules. Input is newest-first HEAD reflog data.
const rebaseFinish = /^rebase (?:-i )?\((?:abort|finish)\)/;
const rebaseStart = /^rebase (?:-i )?\(start\)/;
// RE2's \S is the complement of ASCII [\t\n\f\r ], not JS's Unicode \s.
const checkout = /^checkout: moving from ([^\t\n\f\r ]+) to ([^\t\n\f\r ]+)/;
const commit = /^commit|^reset: moving to|^pull/;

/** Select an upstream undo/redo action without executing or validating Git
 * targets. Empty `from` is intentional for initial/truncated history. Runtime
 * must reject unavailable targets and currentRebase before offering a write.
 * An ordinary history cannot redo; an orphan redo marker can make the counter
 * negative, which the upstream redo callback accepts just like counter 1. */
export function findReflogAction(entries, {redo = false} = {}) {
  if (!Array.isArray(entries)) throw new TypeError('Reflog entries must be a newest-first array');
  let counter = 0, rebaseFinishHash = '';
  for (let at = 0; at < entries.length; at++) {
    const entry = entries[at], previousHash = entries[at + 1]?.hash ?? '';
    let action = null;
    if (rebaseFinishHash === '') {
      if (entry.subject.startsWith('[lazygit undo]')) counter++;
      else if (entry.subject.startsWith('[lazygit redo]')) counter--;
      else if (rebaseFinish.test(entry.subject)) rebaseFinishHash = entry.hash;
      else {
        const match = checkout.exec(entry.subject);
        if (match) action = {kind:'checkout', from:match[1], to:match[2]};
        else if (commit.test(entry.subject)) action = {kind:'commit', from:previousHash, to:entry.hash};
        else if (rebaseStart.test(entry.subject)) action = {kind:'currentRebase', from:previousHash, to:''};
      }
    } else if (rebaseStart.test(entry.subject)) {
      action = {kind:'rebase', from:previousHash, to:rebaseFinishHash};
      rebaseFinishHash = '';
    }
    if (!action || action.kind !== 'currentRebase' && action.from === action.to) continue;
    if (redo) {
      if (counter === 0) return null;
      if (counter <= 1) return action;
    } else if (counter === 0) return action;
    counter--;
  }
  return null;
}
