// The Files panel's rows: every changed file whose path has all the filter's
// words, flat or as a tree. A folder with nothing but one folder in it shares
// its row ("mods/git"); a filter opens every folder.
export function fileNodes(files, { tree, collapsed, filter, fileSortOrder = "mixed", fileSortCaseSensitive = true }) {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = files; // Status/path filtering happens once, including a rename's old path.
  // An untracked nested repo is listed as "dir/".
  const clean = (p) => p.endsWith("/") ? p.slice(0, -1) : p;
  const base = (p) => clean(p).slice(clean(p).lastIndexOf("/") + 1) + (p.endsWith("/") ? "/" : "");
  if (!tree) return shown.map((f) => ({ key: `f:${f.path}`, file: f, depth: 0, name: base(f.path), where: clean(f.path).slice(0, Math.max(0, clean(f.path).lastIndexOf("/"))) }));
  const make = () => ({ dirs: new Map(), files: [], all: [] });
  const root = make();
  for (const f of shown) {
    let at = root;
    for (const part of clean(f.path).split("/").slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, make());
      at = at.dirs.get(part); at.all.push(f);
    }
    at.files.push(f);
  }
  const out = [];
  const compare=(a,b)=>{const x=fileSortCaseSensitive?a:a.toLowerCase(),y=fileSortCaseSensitive?b:b.toLowerCase();return x<y?-1:x>y?1:0;};
  const walk = (dir, prefix, depth) => {
    const entries=[...[...dir.dirs].map(([name,d])=>({name,d})),...dir.files.map(f=>({name:base(f.path),file:f}))];
    entries.sort((a,b)=>fileSortOrder!=="mixed"&&Boolean(a.d)!==Boolean(b.d)?(a.d?1:-1)*(fileSortOrder==="foldersFirst"?-1:1):compare(a.name,b.name));
    for(const entry of entries){
      if(entry.file){out.push({key:`f:${entry.file.path}`,file:entry.file,depth,name:entry.name,where:""});continue;}
      let {name,d}=entry;
      while(d.dirs.size===1&&!d.files.length){const[next,only]=[...d.dirs][0];name+="/"+next;d=only;}
      const path=prefix+name,open=terms.length>0||!collapsed.has(path);
      out.push({key:`d:${path}`,dir:true,path,name,depth,files:d.all,open});
      if(open)walk(d,path+"/",depth+1);
    }
  };
  walk(root, "", 0);
  return out;
}

// Every file under the given rows, once: a folder row stands for all its files.
export function filesOf(nodes) {
  return [...new Map(nodes.flatMap((n) => n.dir ? n.files : n.file ? [n.file] : [n]).filter(Boolean).map((f) => [f.path, f])).values()];
}
