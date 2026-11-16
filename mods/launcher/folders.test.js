// node --test mods/launcher/folders.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, access } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { FOLDER_LIMIT, folderSuggestions } from "./folders.js";

const execute = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { cwd: options.cwd, timeout: options.timeout, encoding: "utf8" }, (error, stdout, stderr) => {
    if (error && typeof error.code !== "number") reject(error);
    else resolve({ code: error?.code ?? 0, stdout, stderr });
  });
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "herdr-folders-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const suggest = value => folderSuggestions(value, execute, { cwd: root });
  return { root, suggest, values: async value => (await suggest(value)).items.map(item => item.value) };
}

test("completes directories and symlinks, with hidden entries only on a dot prefix", async t => {
  const { root, values } = await fixture(t);
  await mkdir(join(root, "docs")); await mkdir(join(root, "downloads")); await mkdir(join(root, ".config"));
  await writeFile(join(root, "document.txt"), "file");
  await symlink(join(root, "docs"), join(root, "doc-link"));
  assert.deepEqual(await values("do"), ["doc-link/", "docs/", "downloads/"]);
  assert.deepEqual(await values(".c"), [".config/"]);
  assert.ok(!(await values("")).includes(".config/"));
  assert.deepEqual(await values("missing"), []);
});

test("keeps relative, absolute, parent and home path spelling", async t => {
  const { root, values } = await fixture(t);
  await mkdir(join(root, "project", "src"), { recursive: true });
  assert.deepEqual(await values("project/s"), ["project/src/"]);
  assert.deepEqual(await values("./project/s"), ["./project/src/"]);
  assert.deepEqual(await values("project/../pro"), ["project/../project/"]);
  assert.deepEqual(await values(`${root}/pro`), [`${root}/project/`]);
  const tilde = `~/${relative(homedir(), root)}/pro`;
  assert.deepEqual(await values(tilde), [tilde + "ject/"]);
  for (const value of ["~", ".", ".."]) assert.deepEqual(await values(value), [value + "/"]);
});

test("directory names stay literal, including spaces, Unicode and shell syntax", async t => {
  const { root, values } = await fixture(t);
  const names = ["My Projects", "O'Brien", "文档😀", "[abc]*?", "$(touch sentinel)", "`touch sentinel`", "a\nb", "-dash"];
  for (const name of names) {
    await mkdir(join(root, name, "child"), { recursive: true });
    assert.deepEqual(await values(name), [`${name}/`]);
    assert.deepEqual(await values(`${name}/ch`), [`${name}/child/`]);
  }
  await assert.rejects(access(join(root, "sentinel")));
});

test("bounds large listings and reports inaccessible parents", async t => {
  const { root, suggest, values } = await fixture(t);
  for (let i = 0; i < FOLDER_LIMIT + 5; i++) await mkdir(join(root, `dir-${String(i).padStart(3, "0")}`));
  const result = await suggest("dir-");
  assert.equal(result.items.length, FOLDER_LIMIT);
  assert.equal(result.more, true);
  assert.deepEqual(await values("dir-104"), ["dir-104/"]);
  await assert.rejects(suggest("missing/child"), /Could not read this folder/);
});

test("uses the requested machine and cwd without interpolating the path", async () => {
  const value = "~/A 'folder/$(touch sentinel)";
  const result = await folderSuggestions(value, async (command, args, options) => {
    assert.equal(command, "sh");
    assert.equal(options.on, "remote"); assert.equal(options.cwd, "/repo");
    assert.equal(args[3], "~/A 'folder/"); assert.equal(args[4], "$(touch sentinel)");
    assert.ok(!args[1].includes("sentinel"));
    return { code: 0, stdout: "$(touch sentinel) dir\0", stderr: "" };
  }, { on: "remote", cwd: "/repo" });
  assert.equal(result.items[0].value, value + " dir/");
});
