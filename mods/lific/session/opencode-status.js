// OpenCode's event hook for this profile. It exposes no tools. Its server
// worker's stdout can be a pipe, so send Herdr reports to the controlling TTY.
import { writeFileSync } from "node:fs";

export default async function lificStatus() {
  let last;
  function report(state) {
    if (state === last) return;
    writeFileSync("/dev/tty", `\x1b]7501;state=${state}:app=opencode\x07`);
    last = state;
  }
  report("idle");
  return {
    async event({ event }) {
      switch (event.type) {
        case "session.status":
          if (event.properties.status.type !== "idle") report("working");
          else if (last !== "error") report("idle");
          break;
        case "session.error": report("error"); break;
        case "permission.asked":
        case "question.asked": report("blocked"); break;
        case "permission.replied":
        case "question.replied":
        case "question.rejected": report("working"); break;
      }
    },
  };
}
