// Exact row identities from the pinned Lazygit Go parser oracle.
// The ordinary-then-combined case panics upstream and is covered safely below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLineTarget, diffPath } from './editor-diff.js';
const reference = {
  "combined-only": {
    "lines": [
      "diff --cc merge.txt",
      "index aaaaaaa,bbbbbbb..ccccccc",
      "--- a/merge.txt",
      "+++ b/merge.txt",
      "@@@ -1,1 -1,1 +1,1 @@@",
      "- old",
      " +new"
    ],
    "expected": [
      null,
      null,
      null,
      null,
      null,
      null,
      null
    ]
  },
  "deleted-file": {
    "lines": [
      "diff --git a/gone.go b/gone.go",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/gone.go",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-apple",
      "-grape"
    ],
    "expected": [
      {
        "path": "gone.go"
      },
      {
        "path": "gone.go"
      },
      {
        "path": "gone.go"
      },
      {
        "path": "gone.go"
      },
      {
        "path": "gone.go"
      },
      {
        "path": "gone.go",
        "line": 0
      },
      {
        "path": "gone.go",
        "line": 0
      },
      {
        "path": "gone.go",
        "line": 0
      }
    ]
  },
  "hunk-header-position": {
    "lines": [
      "diff --git a/f b/f",
      "--- a/f",
      "+++ b/f",
      "@@ -10,2 +9,3 @@ function",
      " context",
      "+added",
      " after"
    ],
    "expected": [
      {
        "path": "f"
      },
      {
        "path": "f"
      },
      {
        "path": "f"
      },
      {
        "path": "f",
        "line": 9
      },
      {
        "path": "f",
        "line": 9
      },
      {
        "path": "f",
        "line": 10
      },
      {
        "path": "f",
        "line": 11
      }
    ]
  },
  "quoted-renamed-file": {
    "lines": [
      "diff --git \"a/caf\\303\\251 old.go\" \"b/caf\\303\\251 new.go\"",
      "similarity index 62%",
      "rename from \"caf\\303\\251 old.go\"",
      "rename to \"caf\\303\\251 new.go\"",
      "index 1111111..2222222 100644",
      "--- \"a/caf\\303\\251 old.go\"\t",
      "+++ \"b/caf\\303\\251 new.go\"\t",
      "@@ -1,2 +1,2 @@",
      " apple",
      "-grape",
      "+kiwi"
    ],
    "expected": [
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go"
      },
      {
        "path": "café new.go",
        "line": 1
      },
      {
        "path": "café new.go",
        "line": 1
      },
      {
        "path": "café new.go",
        "line": 2
      },
      {
        "path": "café new.go",
        "line": 2
      }
    ]
  },
  "two-file-source-fixture": {
    "lines": [
      "commit 1234567",
      "    message",
      "",
      "diff --git a/file1.go b/file1.go",
      "index 1111111..2222222 100644",
      "--- a/file1.go",
      "+++ b/file1.go",
      "@@ -1,4 +1,2 @@",
      " apple",
      "-grape",
      "-pear",
      " lemon",
      "diff --git a/dir/file2.go b/dir/file2.go",
      "index 3333333..4444444 100644",
      "--- a/dir/file2.go",
      "+++ b/dir/file2.go",
      "@@ -10,2 +9,4 @@ func foo() {",
      " ctx",
      "+added1",
      "+added2",
      " ctx2"
    ],
    "expected": [
      null,
      null,
      null,
      {
        "path": "file1.go"
      },
      {
        "path": "file1.go"
      },
      {
        "path": "file1.go"
      },
      {
        "path": "file1.go"
      },
      {
        "path": "file1.go",
        "line": 1
      },
      {
        "path": "file1.go",
        "line": 1
      },
      {
        "path": "file1.go",
        "line": 2
      },
      {
        "path": "file1.go",
        "line": 2
      },
      {
        "path": "file1.go",
        "line": 2
      },
      {
        "path": "dir/file2.go"
      },
      {
        "path": "dir/file2.go"
      },
      {
        "path": "dir/file2.go"
      },
      {
        "path": "dir/file2.go"
      },
      {
        "path": "dir/file2.go",
        "line": 9
      },
      {
        "path": "dir/file2.go",
        "line": 9
      },
      {
        "path": "dir/file2.go",
        "line": 10
      },
      {
        "path": "dir/file2.go",
        "line": 11
      },
      {
        "path": "dir/file2.go",
        "line": 12
      }
    ]
  }
};
for(const [name,{lines,expected}]of Object.entries(reference))test(`diff line source oracle: ${name}`,()=>{
  for(let i=0;i<lines.length;i++)assert.deepEqual(diffLineTarget(lines,i),expected[i],`row ${i}: ${lines[i]}`);
});

test('diff parser accepts only the last incomplete hunk and rejects mangled bodies',()=>{
  const partial=['diff --git a/f b/f','--- a/f','+++ b/f','@@ -1,2 +1,2 @@',' one'];
  assert.deepEqual(diffLineTarget(partial,4),{path:'f',line:1});
  assert.equal(diffLineTarget([...partial,'diff --git a/g b/g'],4),null);
  assert.equal(diffLineTarget([...partial,'@@ -10 +10 @@',' x'],4),null);
  const mangled=['diff --git a/f b/f','--- a/f','+++ b/f','@@ -1 +1 @@','old |','new |'];
  assert.equal(diffLineTarget(mangled,4),null);
  assert.equal(diffLineTarget(['commit something'],0,'f'),null);
});
test('diff parser handles mnemonic prefixes, copied paths and submodule boundaries',()=>{
  const prefix=['diff --git i/dir/f w/dir/f','--- i/dir/f','+++ w/dir/f','@@ -1 +1 @@','-old','+new'];
  assert.deepEqual(diffLineTarget(prefix,5),{path:'dir/f',line:1});
  assert.deepEqual(diffLineTarget(['diff --git a/old b/copy','copy from old','copy to copy'],0),{path:'copy'});
  const sub=['Submodule modules/test abcdef..123456:', '  > subject', 'rendered decoration'];
  assert.deepEqual(diffLineTarget(sub,1),{path:'modules/test'});assert.equal(diffLineTarget(sub,2),null);
  assert.equal(diffLineTarget(['diff --git a/first b/second','old mode 100644','new mode 100755'],0),null);
});
test('combined diff boundaries never inherit an ordinary file identity',()=>{
  const mixed=['diff --git a/f b/f','--- a/f','+++ b/f','@@ -1 +1 @@','-old','+new','diff --cc other','@@@ -1 -1 +1 @@@','++merged'];
  assert.deepEqual(diffLineTarget(mixed,5),{path:'f',line:1});
  for(let i=6;i<mixed.length;i++)assert.equal(diffLineTarget(mixed,i),null);
});
test('diff paths reject malformed quoting and preserve literal interior tabs',()=>{
  assert.equal(diffPath('"unterminated'),'');assert.equal(diffPath('"bad\\q"'),'');
  assert.equal(diffPath('file\tinside\t'),'file\tinside');
});
