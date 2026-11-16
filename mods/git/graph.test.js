// Run with: node --experimental-vm-modules --test mods/git/graph.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
const kit = new vm.SyntheticModule(['div', 'PathBuilder'], function () {
  this.setExport('div', () => { throw new Error('This fixture only exercises graph geometry'); });
  this.setExport('PathBuilder', {});
}, { context });
const module = new vm.SourceTextModule(readFileSync(new URL('./graph.js', import.meta.url), 'utf8'), { context });
await module.link((name) => {
  assert.equal(name, 'gpui-kit');
  return kit;
});
await module.evaluate();
const { layout, graphWidth, PAD, LANE } = module.namespace;

test('graph references group each configured remote by its longest matching name',()=>{
  const refs=module.namespace.refsOf('HEAD -> refs/heads/topic/x, refs/remotes/team/origin/topic/x, refs/remotes/origin/topic/x, refs/remotes/unknown/topic/x, tag: refs/tags/v1',['origin','team','team/origin']);
  assert.equal(refs[0].name,'topic/x');assert.deepEqual(Array.from(refs[0].remotes),['team/origin','origin']);assert.equal(refs[1].kind,'remote');assert.equal(refs[1].name,'unknown/topic/x');assert.equal(refs[2].kind,'tag');
});
test('inline details carry every outgoing and through lane across the gap exactly once',()=>{
  const graph=layout([{hash:'a',parents:['base']},{hash:'merge',parents:['base','other']},{hash:'other',parents:['base']},{hash:'base',parents:[]}]);
  for(const row of graph.rows){const lanes=module.namespace.graphGapLanes(row),expected=new Set([...row.through.map(edge=>edge.col),...row.outs.map(edge=>edge.to)]);assert.equal(lanes.length,expected.size);assert.ok(lanes.every(([col])=>expected.has(col)));}
});

function assertGeometryFits(commits, expectedLanes) {
  const graph = layout(commits), width = graphWidth(graph.lanes);
  assert.equal(graph.lanes, expectedLanes, 'fixture must keep all lanes alive together');
  for (const row of graph.rows) {
    const center = PAD + row.col * LANE;
    assert.ok(center - 5 >= 0 && center + 5 <= width,
      `commit ${row.commit.hash} is clipped: dot ${center - 5}..${center + 5}, width ${width}`);
    const edgeColumns = [...row.ins.map((edge) => edge.from), ...row.through.map((edge) => edge.col), ...row.outs.map((edge) => edge.to)];
    for (const column of edgeColumns) {
      const edge = PAD + column * LANE;
      assert.ok(edge - 1 >= 0 && edge + 1 <= width,
        `commit ${row.commit.hash} clips an edge in lane ${column}: x ${edge}, width ${width}`);
    }
  }
}

test('wide histories keep every branch vertex and continuing edge inside the graph column', () => {
  for (const count of [1, 14, 15, 20, 64]) {
    const tips = Array.from({ length: count }, (_, i) => ({ hash: `tip-${i}`, parents: [`base-${i}`] }));
    const bases = Array.from({ length: count }, (_, i) => ({ hash: `base-${i}`, parents: [] }));
    assertGeometryFits([...tips, ...bases], count);
  }
});

test('wide merges keep all outgoing and incoming edges inside the graph column', () => {
  const parents = Array.from({ length: 20 }, (_, i) => `parent-${i}`);
  assertGeometryFits([
    { hash: 'merge', parents },
    ...parents.map((hash) => ({ hash, parents: ['base'] })),
    { hash: 'base', parents: [] },
  ], 20);
});
