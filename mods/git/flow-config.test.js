import { GIT_SUBPROCESS } from "./subprocess-script.js";
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {gitFlowPrefixes,gitFlowFinish,GIT_FLOW_STARTS} from './flow-config.js';

test('Git-flow combines local legacy and next prefixes with upstream precedence',()=>{
  const prefixes=gitFlowPrefixes('gitflow.prefix.foo feature\ngitflow.prefix.hotfix hotfix/\ngitflow.prefix.last feature/','gitflow.branch.bar.prefix feature/\ngitflow.branch.release.prefix release\ngitflow.branch.ignored.prefix release/');
  assert.deepEqual([...prefixes],[['feature/','last'],['hotfix/','hotfix'],['release/','release']]);
  assert.deepEqual(gitFlowFinish('feature/audit/nested',prefixes),['git','flow','last','finish','audit/nested']);
});

test('Git-flow skips empty and malformed settings, normalizes whitespace and safely stores unusual names',()=>{
  const prefixes=gitFlowPrefixes('invalid\ngitflow.prefix.empty \ngitflow.prefix.feature \u0085 feature/ \u3000\ngitflow.prefix.__proto__ constructor','gitflow.branch.release.prefix release/\ngitflow.branch.nested.type.prefix wrong/');
  assert.deepEqual([...prefixes],[['feature/','feature'],['constructor/','__proto__'],['release/','release']]);
  assert.deepEqual([...gitFlowPrefixes('','')],[]);
});

test('Git-flow finish requires the first branch component to match a configured prefix',()=>{
  const prefixes=gitFlowPrefixes('gitflow.prefix.feature team/feature/\ngitflow.prefix.hotfix fix/','');
  for(const branch of ['main','/missing','fix/','feature/name','team/feature/name'])assert.throws(()=>gitFlowFinish(branch,prefixes),/Git-flow branch/);
  assert.deepEqual(gitFlowFinish('fix/bug;$(literal)',prefixes),['git','flow','hotfix','finish','bug;$(literal)']);
});

test('Git-flow preserves internal Unicode line separators and carriage returns like Go',()=>{
  for(const separator of ['\u2028','\u2029','\r']){
    const prefix=`topic${separator}flow/`;
    for(const source of [0,1]){
      const text=source===0?`gitflow.prefix.feature ${prefix}`:`gitflow.branch.feature.prefix ${prefix}`;
      const prefixes=gitFlowPrefixes(source===0?text:'',source===1?text:'');
      assert.equal(prefixes.get(prefix),'feature');
      assert.deepEqual(gitFlowFinish(prefix+'review',prefixes),['git','flow','feature','finish','review']);
    }
  }
});

test('Git-flow start choices match upstream types and menu keys',()=>{
  assert.deepEqual(GIT_FLOW_STARTS,[['feature','f'],['hotfix','h'],['bugfix','b'],['release','r']]);
});

test('Git subprocess wrapper preserves argv and waits according to the subprocess setting',()=>{
  const run=(wait,code)=>spawnSync('sh',['-c',GIT_SUBPROCESS,'sh',wait,'sh','-c','printf "%s\\n" "$1"; exit "$2"','sh','space ; $(literal)',String(code)],{input:'\n',encoding:'utf8'});
  for(const[wait,code,prompt]of [['true',0,true],['false',0,false],['true',7,true],['false',7,true]]){
    const result=run(wait,code);assert.equal(result.status,code,result.stderr);assert.match(result.stdout,/^space ; \$\(literal\)/);assert.equal(result.stdout.includes('Press Enter to return to Git'),prompt);
  }
});
