// Run with: node --test mods/git/templates.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, splitCommandArgs, TemplateError } from './templates.js';

const quote = (text) => '"' + text.replace(/[\\"$`]/g, (char) => '\\' + char) + '"';
const data = Object.freeze({
  SelectedFile:Object.freeze({Name:"new file ' ü.txt", HasStagedChanges:true, HasUnstagedChanges:false}),
  SelectedLocalCommit:Object.freeze({Hash:'abcdef0123456789'}),
  SelectedCommit:Object.freeze({Hash:'abcdef0123456789', Name:'Fix toolbar'}),
  SelectedCommitRange:Object.freeze({From:'1111111', To:'9999999'}),
  SelectedRemote:Object.freeze({Name:'origin'}),
  CheckedOutBranch:Object.freeze({Name:'feature/ABC-123'}),
  Form:Object.freeze({BranchType:'feature/', BranchName:'native git', Method:'prefix'}),
  PromptResponses:Object.freeze(['feature/', 'native git']),
});

test('official custom-command fields, conditions, quoting and range values render', async () => {
  assert.equal(await renderTemplate('git show {{.SelectedLocalCommit.Hash}}', data), 'git show abcdef0123456789');
  assert.equal(await renderTemplate('git {{if .SelectedFile.HasUnstagedChanges}}add{{else}}reset{{end}} -- {{.SelectedFile.Name | quote}}', data, {quote}), 'git reset -- ' + quote(data.SelectedFile.Name));
  assert.equal(await renderTemplate('git checkout -b {{printf "%s%s" .Form.BranchType .Form.BranchName | quote}}', data, {quote}), 'git checkout -b "feature/native git"');
  assert.equal(await renderTemplate('git format-patch {{.SelectedCommitRange.From}}^..{{.SelectedCommitRange.To}}', data), 'git format-patch 1111111^..9999999');
});

test('legacy PromptResponses and nested index lookups work without mutating input', async () => {
  assert.equal(await renderTemplate('{{index .PromptResponses 0}}{{index .PromptResponses 1}}', data), 'feature/native git');
  const nested = Object.freeze({rows:Object.freeze([Object.freeze({'branch name':'main'})])});
  assert.equal(await renderTemplate('{{index .rows 0 "branch name"}}', nested), 'main');
  assert.equal(await renderTemplate('{{(index .rows 0).branch}}', {rows:[{branch:'main'}]}), 'main');
  assert.equal(JSON.stringify(data.Form), '{"BranchType":"feature/","BranchName":"native git","Method":"prefix"}');
});

test('async quote and runCommand are injected and called in pipeline order', async () => {
  const calls = [];
  const result = await renderTemplate('username/{{runCommand "date +%Y/%-m" | printf "%s/branch" | quote}}', data, {
    runCommand:async (command) => { calls.push(command); return '2026/11\n'; },
    quote:async (text) => { calls.push(text); return quote(text); },
  });
  assert.equal(result, 'username/"2026/11/branch"');
  assert.deepEqual(calls, ['date +%Y/%-m', '2026/11/branch']);
});

test('runCommand preserves upstream trailing-newline and embedded-CRLF behavior', async () => {
  assert.equal(await renderTemplate('{{runCommand "read"}}', {}, {runCommand:()=>'value\r\n\n'}), 'value');
  assert.equal(await renderTemplate('{{runCommand "read"}}', {}, {runCommand:()=>'a\nb\n'}), 'a\nb');
  await assert.rejects(renderTemplate('{{runCommand "read"}}', {}, {runCommand:()=>'a\r\nb\n'}), /output contains newlines/);
});

test('nested if, else if, with, and root variables preserve dot semantics', async () => {
  const source = '{{with .SelectedFile}}{{if .HasUnstagedChanges}}unstaged{{else if .HasStagedChanges}}{{$.CheckedOutBranch.Name}}:{{.Name}}{{else}}clean{{end}}{{else}}absent{{end}}';
  assert.equal(await renderTemplate(source, data), `feature/ABC-123:${data.SelectedFile.Name}`);
  assert.equal(await renderTemplate('{{with .a}}a{{else with .b}}{{.name}}{{else}}none{{end}}', {a:null, b:{name:'B'}}), 'B');
  assert.equal(await renderTemplate('{{if .ok}}{{with .missing}}unreachable{{end}}{{else}}{{.name}}{{end}}', {ok:false, name:'root'}), 'root');
});

test('range uses element for one variable, key/value for two, and sorted map keys', async () => {
  assert.equal(await renderTemplate('{{range $name := .names}}{{$name}}:{{.}};{{end}}', {names:['Ada', '李']}), 'Ada:Ada;李:李;');
  assert.equal(await renderTemplate('{{range $i, $name := .names}}{{$i}}={{$name}}/{{$.title}};{{end}}', {names:['Ada', '李'], title:'team'}), '0=Ada/team;1=李/team;');
  assert.equal(await renderTemplate('{{range $key, $value := .names}}{{$key}}={{$value}};{{end}}', {names:{z:2, a:1}}), 'a=1;z=2;');
  assert.equal(await renderTemplate('{{range .items}}{{.}}{{else}}{{.title}}{{end}}', {items:[], title:'empty'}), 'empty');
  assert.equal(await renderTemplate('{{range 3}}{{.}}{{end}}', {}), '012');
  assert.equal(await renderTemplate('{{range -2}}yes{{else}}empty{{end}}', {}), 'empty');
  const names = new Map([['𐀀', 'supplementary'], ['\ue000', 'bmp']]);
  assert.equal(await renderTemplate('{{range $key, $value := .}}{{$value}};{{end}}', names), 'bmp;supplementary;');
});

test('template variables shadow, assign, and obey control-block scopes', async () => {
  const source = '{{$name := "outer"}}{{with .SelectedCommit}}{{$name := .Name}}{{$name}}{{end}}/{{$name}}{{range .PromptResponses}}{{$name = .}}{{end}}/{{$name}}';
  assert.equal(await renderTemplate(source, data), 'Fix toolbar/outer/native git');
  assert.equal(await renderTemplate('{{if $name := .Name}}{{$name}}{{else}}{{$name}}{{end}}', {Name:'Ada'}), 'Ada');
  assert.equal(await renderTemplate('{{$key := "x"}}{{$value := "none"}}{{range $key, $value = .}}{{$key}}={{$value}};{{end}}{{$key}}/{{$value}}', {b:'B', a:'A'}), 'a=A;b=B;b/B');
  await assert.rejects(renderTemplate('{{if true}}{{$x := 1}}{{end}}{{$x}}', {}), /Undefined variable \$x/);
  await assert.rejects(renderTemplate('{{$x = 1}}', {}), /Undefined variable \$x/);
});

test('and/or are lazy, return operands, and preserve the implicit final pipeline argument', async () => {
  const calls = [], runCommand = async (command) => { calls.push(command); return command; };
  assert.equal(await renderTemplate('{{and false (runCommand "skip")}}/{{or "kept" (runCommand "skip")}}', {}, {runCommand}), 'false/kept');
  assert.deepEqual(calls, []);
  assert.equal(await renderTemplate('{{and .File .File.Name}}', {File:null}), '<no value>');
  assert.equal(await renderTemplate('{{"last" | and "first"}}/{{"last" | or "first"}}', {}), 'last/first');
  assert.equal(await renderTemplate('{{and (runCommand "one") (runCommand "two")}}', {}, {runCommand}), 'two');
  assert.deepEqual(calls, ['one', 'two']);
});

test('pipes append the prior result after explicit arguments and parentheses isolate pipelines', async () => {
  assert.equal(await renderTemplate('{{"tail" | printf "%s/%s" "head"}}', {}), 'head/tail');
  assert.equal(await renderTemplate('{{printf "%s/%s" (print "a" "b") (print "c" "d")}}', {}), 'ab/cd');
  assert.equal(await renderTemplate('{{eq .Form.Method "prefix"}}/{{not (eq .Form.Method "simple")}}', data), 'true/true');
});

test('whitespace trim and comments do not mistake quoted delimiters for action endings', async () => {
  const source = 'before \n {{- /* a }} comment */ -}}\n {{printf "%s" "}}"}} after';
  assert.equal(await renderTemplate(source, {}), 'before}} after');
  assert.equal(await renderTemplate('a {{-3}} b', {}), 'a -3 b');
  assert.equal(await renderTemplate('a\n{{/* explanation */}}\nb', {}), 'a\n\nb');
  assert.equal(await renderTemplate('{{`line one\r\n{{.literal}}`}}', {}), 'line one\n{{.literal}}');
});

test('Unicode literals, Go escapes, rune values, byte lengths and string indexing match Go', async () => {
  assert.equal(await renderTemplate('{{len "é🎉"}}/{{index "é🎉" 1}}/{{printf "%c" \'🎉\'}}', {}), '6/169/🎉');
  assert.equal(await renderTemplate('{{"\\u00e9\\U0001f389"}}/{{"\\xc3\\xa9"}}/{{"\\141"}}', {}), 'é🎉/é/a');
  assert.equal(await renderTemplate('{{.名前}}', {'名前':'李'}), '李');
  assert.equal(await renderTemplate('{{"line\\nquote\\\"\\tend"}}', {}), 'line\nquote"\tend');
  await assert.rejects(renderTemplate('{{"\\xff"}}', {}), /Non-UTF-8/);
  await assert.rejects(renderTemplate("{{'ab'}}", {}), /one character/);
});

test('literals and comparisons support numbers, booleans and variadic equality', async () => {
  const source = '{{0xff}}/{{0b101}}/{{0o17}}/{{077}}/{{-1.5e2}}/{{eq 2 1 2}}/{{ne "a" "b"}}/{{lt 1 2}}/{{le 2 2}}/{{gt "b" "a"}}/{{ge 2 2}}';
  assert.equal(await renderTemplate(source, {}), '255/5/15/63/-150/true/true/true/true/true/true');
  await assert.rejects(renderTemplate('{{eq 1 "1"}}', {}), /different types/);
  await assert.rejects(renderTemplate('{{lt false true}}', {}), /Ordered comparison/);
  await assert.rejects(renderTemplate('{{eq .a .b}}', {a:[], b:[]}), /Comparing arrays/);
});

test('print/println preserve Go spacing and printf supports command-oriented scalar formats', async () => {
  assert.equal(await renderTemplate('{{print "a" 1 2 "b"}}/{{println "a" 1 2 "b"}}', {}), 'a1 2b/a 1 2 b\n');
  assert.equal(await renderTemplate('{{printf "%.3s %04d %#08x %t %q" "é🎉abc" 7 42 true "x\\nü"}}', {}), 'é🎉a 0007 0x0000002a true "x\\nü"');
  assert.equal(await renderTemplate('{{printf "%[2]s/%[1]s" "first" "second"}}', {}), 'second/first');
  assert.equal(await renderTemplate('{{printf "%*.*f" 8 2 1.25}}', {}), '    1.25');
  assert.equal(await renderTemplate('{{printf "%x/%X" "é" 255}}', {}), 'c3a9/FF');
  assert.equal(await renderTemplate('{{printf "%e" 123.0}}', {}), '1.230000e+02');
  assert.equal(await renderTemplate('{{printf "%v" .}}', {z:2, a:1}), 'map[a:1 z:2]');
});

test('Go-oracle regressions cover variadic eq, nested declarations, integer range, and printf flags', async () => {
  assert.equal(await renderTemplate('{{eq 2 2 "2"}}', {}), 'true');
  assert.equal(await renderTemplate('{{($x := "hi")}}/{{$x}}', {}), 'hi/hi');
  assert.equal(await renderTemplate('{{printf "%g/%g/%g" 1.23 10000000.0 0.0000001}}', {}), '1.23/1e+07/1e-07');
  assert.equal(await renderTemplate('{{printf "%[3]*.[2]*[1]f" 1.25 2 8}}', {}), '    1.25');
  assert.equal(await renderTemplate('{{printf "%#q/%#.0f/%#.3g" "abc" 1.0 1.0}}', {}), '`abc`/1./1.00');
  assert.equal(await renderTemplate('{{printf "%.0d/%#o" 0 0}}', {}), '/0');
  assert.equal(await renderTemplate('{{printf "%#.8x/%#08b/%#08o" 42 42 42}}', {}), '0x0000002a/0b00101010/00000052');
  await assert.rejects(renderTemplate('{{nil}}', {}), /nil is not a command/);
  await assert.rejects(renderTemplate('{{if nil}}yes{{else}}no{{end}}', {}), /nil is not a command/);
  await assert.rejects(renderTemplate('{{08}}', {}), /Invalid octal/);
  assert.equal(await renderTemplate('{{1_000}}/{{0x_FF}}', {}), '1000/255');
  await assert.rejects(renderTemplate('{{1_.5}}', {}), /Invalid numeric separator/);
  await assert.rejects(renderTemplate('{{1_e2}}', {}), /Invalid numeric separator/);
  await assert.rejects(renderTemplate('{{range $i,$v := 3}}{{$i}}{{end}}', {}), /only one variable/);
});

test('colors are available only when injected and cannot replace builtins', async () => {
  assert.equal(await renderTemplate('{{.branch | green | bold}}', {branch:'main'}, {colors:{green:async (s)=>`<g>${s}</g>`, bold:(s)=>`<b>${s}</b>`}}), '<b><g>main</g></b>');
  await assert.rejects(renderTemplate('{{.branch | green}}', {branch:'main'}), /Unsupported template function green/);
  assert.equal(await renderTemplate('{{print "unchanged"}}', {}, {colors:{print:()=> 'wrong'}}), 'unchanged');
});

test('missing fields and nil traversal fail, while builtin index retains Go map-zero behavior', async () => {
  await assert.rejects(renderTemplate('{{.Missing.Name}}', {}), /Missing field or map key Missing/);
  await assert.rejects(renderTemplate('{{.SelectedFile.Name}}', {SelectedFile:null}), /Cannot read Name from nil/);
  await assert.rejects(renderTemplate('{{index .PromptResponses 5}}', data), /outside/);
  assert.equal(await renderTemplate('{{index .Form "absent"}}', data), '<no value>');
  assert.equal(await renderTemplate('{{if index .Form "absent"}}yes{{else}}no{{end}}', data), 'no');
  await assert.rejects(renderTemplate('{{.PromptResponses.length}}', data), /Cannot read field/);
});

test('syntax and variable errors are found before any command runs', async () => {
  let calls = 0; const runCommand = () => { calls++; return 'called'; };
  for (const source of ['{{runCommand "one"}}{{unknown .}}', '{{runCommand "one"}}{{if true}}unclosed', '{{runCommand "one"}}{{$missing}}', '{{if false}}{{.x | unknown}}{{end}}']) {
    await assert.rejects(renderTemplate(source, {}, {runCommand}), TemplateError);
  }
  assert.equal(calls, 0);
});

test('errors include stable offsets and Unicode-aware line/column positions', async () => {
  const source = 'header\n🎉 {{.Missing}}';
  await assert.rejects(renderTemplate(source, {}), (error) => {
    assert.ok(error instanceof TemplateError); assert.equal(error.offset, source.indexOf('.Missing'));
    assert.equal(error.line, 2); assert.equal(error.column, 5); assert.match(error.message, /line 2, column 5/); return true;
  });
});

test('unsupported constructs fail explicitly rather than being evaluated as JavaScript', async () => {
  for (const source of ['{{define "x"}}hi{{end}}', '{{template "x" .}}', '{{range .Items}}{{break}}{{end}}', '{{.x + 1}}', '{{.x[0]}}', '{{call .Function}}', '{{printf "%T" .}}']) {
    await assert.rejects(renderTemplate(source, {Items:[1], x:[1], Function:()=> 'bad'}), TemplateError);
  }
  await assert.rejects(renderTemplate('{{.constructor}}', {}), /Missing field/);
  let getterCalls = 0; const object = Object.defineProperty({}, 'value', {get(){ getterCalls++; return 'bad'; }});
  await assert.rejects(renderTemplate('{{.value}}', object), /Accessor/); assert.equal(getterCalls, 0);
});

test('injected function failures and unexpected return types retain template positions', async () => {
  await assert.rejects(renderTemplate('{{"name" | quote}}', {}), /requires an injected implementation/);
  await assert.rejects(renderTemplate('{{runCommand "false"}}', {}, {runCommand:()=>{throw new Error('exit 1');}}), /runCommand failed: exit 1 at line 1/);
  await assert.rejects(renderTemplate('{{runCommand "pwd"}}', {}, {runCommand:()=>({stdout:'folder'})}), /must return text/);
  await assert.rejects(renderTemplate('{{quote 42}}', {}, {quote}), /needs a string/);
});

test('concurrent async evaluations have independent variable scopes', async () => {
  const source = '{{$value := runCommand .}}{{with .}}{{$value}}{{end}}';
  const values = await Promise.all(['one','two'].map((value) => renderTemplate(source, value, {runCommand:async (command)=> command.toUpperCase()})));
  assert.deepEqual(values, ['ONE', 'TWO']);
});

test('direct argv parsing matches upstream quotes, concatenation, empty arguments, and escapes', () => {
  assert.deepEqual(splitCommandArgs('git show "my branch" -- \'file name\' empty="" a\\ b'), ['git','show','my branch','--','file name','empty=','a b']);
  assert.deepEqual(splitCommandArgs('cmd "" \'\' pre"mid"post'), ['cmd','','','premidpost']);
  assert.deepEqual(splitCommandArgs('cmd \'a\\ b\' "x\'y"'), ['cmd','a b',"x'y"]);
  assert.deepEqual(splitCommandArgs('cmd $HOME *.txt | cat && echo\nnext'), ['cmd','$HOME','*.txt','|','cat','&&','echo\nnext']);
  assert.deepEqual(splitCommandArgs('  \t '), []);
  assert.deepEqual(splitCommandArgs('cmd "中文 🎉" é'), ['cmd','中文 🎉','é']);
});

test('direct argv parsing has explicit Windows behavior and location-bearing errors', () => {
  assert.deepEqual(splitCommandArgs('cmd C:\\work\\file "C:\\with space\\file" tail\\', {platform:'windows'}), ['cmd','C:\\work\\file','C:\\with space\\file','tail\\']);
  assert.throws(() => splitCommandArgs('cmd tail\\'), /Escape character at end/);
  assert.throws(() => splitCommandArgs('cmd "unfinished'), (error) => error instanceof TemplateError && error.offset === 4);
});
