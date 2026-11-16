import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ARCHIVE_FOLDER_SCRIPT, archiveFileName, archiveFolderEntries } from './archive-data.js';

test('archive formats match the reference extensions, preserving literal file names',()=>{
  for(const [name,format]of [['release.tar','tar'],['release.ZIP','zip'],["quote ' café `id` $(id).TaR",'tar']])assert.deepEqual(archiveFileName(name,'zip'),{name,format});
  assert.deepEqual(archiveFileName('release','zip'),{name:'release.zip',format:'zip'});
  for(const name of ['release.tgz','release.tar.gz','release.','.hidden'])assert.throws(()=>archiveFileName(name,'tar'),/file extension/);
  for(const name of ['', '../outside.tar','bad\0.tar'])assert.throws(()=>archiveFileName(name,'tar'));
  assert.throws(()=>archiveFileName('dir\\name.tar','tar',true),/file name/);
  assert.equal(archiveFileName('back\\slash.tar','tar').name,'back\\slash.tar');
});

test('archive folder reading keeps Unicode, whitespace, newlines and symlink folders without reading file bodies',()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'herdr-archive-folder-')));
  try{
    const names=["quote ' café",'line\nname.zip','tab\tname.tar','$(touch nope).tar'];
    for(const name of names)fs.writeFileSync(join(dir,name),'bytes that are not a listing');
    fs.mkdirSync(join(dir,'directory'));fs.symlinkSync('directory',join(dir,'linked directory'));fs.writeFileSync(join(dir,'.hidden'),'hidden');
    const read=hidden=>archiveFolderEntries(execFileSync('sh',['-c',ARCHIVE_FOLDER_SCRIPT,'sh',dir,hidden?'1':'0'],{cwd:dir,encoding:'utf8'}));
    const result=read(false);assert.equal(result.folder,dir);assert.equal(result.limited,false);assert.equal(result.error,false);
    for(const name of names)assert.ok(result.items.some(item=>item.name===name&&!item.directory));
    assert.deepEqual(result.items.filter(item=>item.directory).map(item=>item.name),['directory','linked directory']);
    assert.ok(!result.items.some(item=>item.name==='.hidden'));assert.ok(read(true).items.some(item=>item.name==='.hidden'));
    assert.equal(fs.existsSync(join(dir,'nope')),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('archive directory parsing reports bounded or failed listings and discards partial records',()=>{
  const raw='/folder\0D\0complete\0F\0partial';assert.deepEqual(archiveFolderEntries(raw),{folder:'/folder',items:[{name:'complete',directory:true}],limited:true,error:false});
  assert.equal(archiveFolderEntries('/folder\0ERROR\0').error,true);
  const many='/folder\0'+Array.from({length:1001},(_,i)=>`F\0file${i}\0`).join('')+'END\0';
  const result=archiveFolderEntries(many);assert.equal(result.items.length,1000);assert.equal(result.limited,true);
});
