import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mergeArgs,mergeChoices,squashMergeMessage} from './merge-config.js';

test('merge choices follow ancestry and the exact upstream preference order',()=>{
  for(const [args,ff,canFF,labels,keys,disabled] of [
    ['', '',true,['fast-forward','with merge commit'],['m','n'],[false,false]],
    ['', '',false,['with merge commit','fast-forward'],['m','f'],[false,true]],
    ['', 'true',false,['fast-forward','with merge commit'],['m','n'],[true,false]],
    ['', 'only',false,['fast-forward','with merge commit'],['m','n'],[true,false]],
    ['', 'false',true,['with merge commit','fast-forward'],['m','f'],[false,false]],
    ['', 'True',false,['with merge commit','fast-forward'],['m','f'],[false,true]],
    ['--no-ff','true',true,['with merge commit','fast-forward'],['m','f'],[false,false]],
    ['--ff-only','false',false,['fast-forward','with merge commit'],['m','n'],[true,false]],
    ['--ff --no-ff','false',true,['fast-forward','with merge commit'],['m','n'],[false,false]],
    ['--message=literal--ff','false',true,['fast-forward','with merge commit'],['m','n'],[false,false]],
  ]){
    const items=mergeChoices(args,ff,canFF,false).slice(0,2);
    assert.deepEqual(items.map(it=>it.label),labels.map(label=>`Regular merge (${label})`),JSON.stringify({args,ff,canFF}));
    assert.deepEqual(items.map(it=>it.key),keys);assert.deepEqual(items.map(it=>Boolean(it.disabled)),disabled);
  }
});

test('squash variants are both disabled for staged changes',()=>{
  for(const staged of [false,true]){
    const items=mergeChoices('','',true,staged).slice(2);
    assert.deepEqual(items.map(it=>[it.key,it.variant,it.commit,Boolean(it.disabled)]),[['s','squash',false,staged],['S','squash',true,staged]]);
  }
});

test('merge variant flags come last and FAST_FORWARD uses --ff',()=>{
  const before=['merge','--no-edit','--ff-only','--no-ff'];
  for(const [variant,extra]of [['regular',[]],['fast-forward',['--ff']],['non-fast-forward',['--no-ff']],['squash',['--squash','--ff']]])
    assert.deepEqual(mergeArgs('refs/heads/topic',variant,'--ff-only --no-ff'),[...before,...extra,'refs/heads/topic']);
});

test('merge arguments use Go fields whitespace without evaluating quotes or substitutions',()=>{
  assert.deepEqual(mergeArgs('topic','regular','\u0085--no-ff\u3000--no-commit\u2028\ufeffliteral\n'),['merge','--no-edit','--no-ff','--no-commit','\ufeffliteral','topic']);
  assert.deepEqual(mergeArgs('topic','regular','-m "two words" $(literal);'),['merge','--no-edit','-m','"two','words"','$(literal);','topic']);
});

test('squash messages replace dotted and plain placeholders once without template evaluation',()=>{
  const source='{{selectedRef}} / {{.selectedRef}} → {{currentBranch}} / {{.currentBranch}}\n{{ unknown }} {{ selectedRef }} {{other}}';
  assert.equal(squashMergeMessage(source,'topic/{{currentBranch}}','$&main'), 'topic/{{currentBranch}} / topic/{{currentBranch}} → $&main / $&main\n{{ unknown }} {{ selectedRef }} {{other}}');
});
