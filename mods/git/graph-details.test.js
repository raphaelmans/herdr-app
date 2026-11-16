import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphComparison, clickGraphCommit, graphDiffArgs, parseGraphFiles, parseGraphCommit, graphFileRows, graphCanDropCommit } from './graph-details.js';

const order=['*','A','B','C'];
test('graph drop follows the loaded descendant chain and rejects roots, forks and merges',()=>{
  const root={hash:'R',parents:[]},a={hash:'A',parents:['R']},b={hash:'B',parents:['A']},wip={hash:'*',parents:['B']};
  assert.equal(graphCanDropCommit([wip,b,a,root],'A','B'),true);
  assert.equal(graphCanDropCommit([b,a,root],'B','B'),true);
  assert.equal(graphCanDropCommit([b,a,root],'R','B'),false);
  assert.equal(graphCanDropCommit([b,a,root],'A','elsewhere'),false);
  assert.equal(graphCanDropCommit([b,{hash:'fork',parents:['A']},a,root],'A','B'),false);
  assert.equal(graphCanDropCommit([{hash:'merge',parents:['B','R']},b,a,root],'A','B'),false);
  assert.equal(graphCanDropCommit([{hash:'M',parents:['A','R']},a,root],'M','M'),false);
  assert.equal(graphCanDropCommit([b],'B','B'),true); // The reference gives an unloaded parent a placeholder vertex.
  assert.equal(graphCanDropCommit([{hash:'A',parents:['B']},{hash:'B',parents:['A']}],'A','B'),false);
});
test('graph details: ordinary and modified clicks match shipped primary/secondary transitions',()=>{
  for(const modifiers of [{control:true},{platform:true},{control:true,platform:true}]){
    let selected=clickGraphCommit(null,'A',modifiers,order);assert.deepEqual(selected,{primary:'A',secondary:null,from:null,to:'A'});
    selected=clickGraphCommit(selected,'B',modifiers,order);assert.deepEqual(selected,{primary:'A',secondary:'B',from:'B',to:'A'});
    selected=clickGraphCommit(selected,'C',modifiers,order);assert.deepEqual(selected,{primary:'A',secondary:'C',from:'C',to:'A'});
    selected=clickGraphCommit(selected,'C',modifiers,order);assert.deepEqual(selected,{primary:'A',secondary:null,from:null,to:'A'});
    assert.equal(clickGraphCommit(selected,'A',modifiers,order),null);
  }
  const selected=clickGraphCommit({primary:'A',secondary:'B'},'B',{},order);assert.deepEqual(selected,{primary:'B',secondary:null,from:null,to:'B'});
});
test('graph details: row order controls orientation in both click directions and after reordering',()=>{
  const selected=clickGraphCommit({primary:'B'},'A',{control:true},order);assert.equal(selected.from,'B');assert.equal(selected.to,'A');
  assert.deepEqual(graphComparison(selected,['*','B','A','C']),{primary:'B',secondary:'A',from:'A',to:'B'});
  assert.deepEqual(graphComparison(selected,['*','B','C']),{primary:'B',secondary:null,from:null,to:'B'});
  assert.equal(graphComparison(selected,['*','A','C']),null);assert.equal(clickGraphCommit(selected,'missing',{},order),selected);
});
test('graph details: WIP comparison uses the working tree instead of passing the sentinel to Git',()=>{
  for(const primary of ['*','B']){const selected=clickGraphCommit({primary},primary==='*'?'B':'*',{platform:true},order);assert.equal(selected.from,'B');assert.equal(selected.to,'*');}
  const args=graphDiffArgs('B','*');assert.ok(args.includes('B'));assert.ok(!args.includes('*'));assert.equal(args.at(-1),'--');assert.ok(graphDiffArgs('B','A',true).includes('--numstat'));
});
test('graph details: NUL rename and numstat records preserve literal tabs, newlines and binary counts',()=>{
  const old='old\tname\n中文',next='new\tname\n中文';
  const files=parseGraphFiles(`R100\0${old}\0${next}\0M\0binary\0D\0gone\0`,['0\t0\t',old,next,'-\t-\tbinary','0\t4\tgone',''].join('\0'));
  assert.deepEqual(files,[{type:'R',oldFilePath:old,newFilePath:next,additions:0,deletions:0},{type:'M',oldFilePath:'binary',newFilePath:'binary',additions:null,deletions:null},{type:'D',oldFilePath:'gone',newFilePath:'gone',additions:0,deletions:4}]);
  assert.equal(parseGraphFiles('R100\0old\0','').length,0);
});
test('graph details: metadata retains full messages and both author and committer identities',()=>{
  assert.deepEqual(parseGraphCommit(['hash','p1 p2','Author','a@example.invalid','100','Committer','c@example.invalid','200','Subject\n\nBody\n\n'].join('\0')),{hash:'hash',parents:['p1','p2'],author:'Author',authorEmail:'a@example.invalid',authorTime:100,committer:'Committer',committerEmail:'c@example.invalid',commitTime:200,body:'Subject\n\nBody'});
  assert.throws(()=>parseGraphCommit('hash\0'),/incomplete/);
});
test('graph details: compact file trees keep full target identities and collapse only their descendants',()=>{
  const files=['src/deep/a','src/deep/b','root'].map(newFilePath=>({type:'M',oldFilePath:newFilePath,newFilePath,additions:1,deletions:0}));
  const rows=graphFileRows(files,true);assert.deepEqual(rows.map(row=>[row.name,row.depth]),[['src / deep',0],['a',1],['b',1],['root',0]]);assert.equal(rows[1].file,files[0]);assert.deepEqual(graphFileRows(files,true,new Set(['src/deep'])).map(row=>row.key),['directory:src/deep','file:root']);
  assert.deepEqual(graphFileRows(files,false).map(row=>row.name),['src/deep/a','src/deep/b','root']);
  assert.deepEqual(graphFileRows(files.slice().reverse(),false,new Set(['src/deep'])).map(row=>row.name),['src/deep/a','src/deep/b','root']);
});
