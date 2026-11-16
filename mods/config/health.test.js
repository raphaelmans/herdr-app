import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../health.sh", import.meta.url));
const jq = execFileSync("/bin/sh", ["-c", "command -v jq"], { encoding: "utf8" }).trim();

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "herdr health-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(jq, join(bin, "jq"));
  mkdirSync(join(root, "mods/config"), { recursive: true });
  writeFileSync(join(root, "mods/config/mod.json"), JSON.stringify({ spec: { needs: ["probe"] } }));
  writeFileSync(join(root, "mods/config/requirements.json"), JSON.stringify({
    probe: { name: "Probe", bin: "herdr-health-probe", flag: "--version", owner: "mise" },
  }));
  copyFileSync(script, join(root, "health.sh"));
  const executable = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\nprintf 'probe 1.2.3\\n'\n");
    chmodSync(path, 0o755);
    return path;
  };
  const check = () => {
    const result = spawnSync("/bin/sh", [join(root, "health.sh"), "--json"], {
      encoding: "utf8",
      env: { ...process.env, TOOLCHAIN_HOME: join(root, "no-standard"), PATH: `${bin}:/usr/bin:/bin` },
      timeout: 5000,
    });
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    return JSON.parse(result.stdout).rows[0];
  };
  return { root, bin, executable, check, entry: join(bin, "herdr-health-probe") };
}

test("a personal bin link to a mise installation keeps its PATH entry and passes ownership", (t) => {
  const f = fixture(t);
  const installed = f.executable(join(f.root, "mise/installs/probe/1.2.3/probe"));
  symlinkSync("1.2.3", join(f.root, "mise/installs/probe/latest"));
  symlinkSync(relative(f.bin, join(dirname(dirname(installed)), "latest/probe")), f.entry);
  const row = f.check();
  assert.equal(row.state, "ok");
  assert.equal(row.path, f.entry);
  assert.equal(row.version, "1.2.3");
});

test("an absolute link to a mise installation passes ownership", (t) => {
  const f = fixture(t);
  symlinkSync(f.executable(join(f.root, "mise/installs/probe/1.2.3/probe")), f.entry);
  assert.equal(f.check().state, "ok");
});

test("standalone copies and links to unmanaged copies still report a route mismatch", (t) => {
  const f = fixture(t);
  f.executable(f.entry);
  assert.equal(f.check().state, "route");
  rmSync(f.entry);
  symlinkSync(f.executable(join(f.root, "vendor/probe")), f.entry);
  assert.equal(f.check().state, "route");
});

test("a broken link remains a missing requirement", (t) => {
  const f = fixture(t);
  symlinkSync(join(f.root, "mise/installs/probe/absent/probe"), f.entry);
  assert.equal(f.check().state, "missing");
});
