// Paths and names travel as positional arguments and NUL-delimited records.
export const ARCHIVE_FOLDER_SCRIPT = `cd -P -- "$1" || exit
{
  printf '%s\\0' "$PWD"
  if find . -mindepth 1 -maxdepth 1 -exec sh -c '
    hidden=$1; shift
    for path do
      name=\${path#./}
      if [ "$hidden" != 1 ]; then case "$name" in .*) continue;; esac; fi
      if [ -d "$path" ]; then kind=D; else kind=F; fi
      printf "%s\\0%s\\0" "$kind" "$name"
    done' sh "$2" {} +; then printf 'END\\0'; else printf 'ERROR\\0'; fi
} | head -c 262144`;

export const ARCHIVE_DESTINATION_SCRIPT = `cd -P -- "$1" || exit
path="$PWD/$2"
if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then
  printf '%s\\n' 'Choose a regular file destination, not a folder or symbolic link.' >&2; exit 1
fi
if [ -f "$path" ]; then
  hash=$(git hash-object --no-filters -- "$path") || exit
  printf 'file\\0%s\\0%s\\0%s\\0' "$PWD" "$path" "$hash"
else printf 'new\\0%s\\0%s\\0\\0' "$PWD" "$path"; fi`;

export const ARCHIVE_PUBLISH_SCRIPT = `if [ -n "$3" ]; then
  if [ -L "$2" ] || [ ! -f "$2" ]; then printf '%s\\n' 'The destination changed; save the archive again.' >&2; exit 1; fi
  hash=$(git hash-object --no-filters -- "$2") || exit
  if [ "$hash" != "$3" ]; then printf '%s\\n' 'The destination changed; save the archive again.' >&2; exit 1; fi
  mv -f -- "$1" "$2"
else
  if [ -e "$2" ] || [ -L "$2" ]; then printf '%s\\n' 'The destination now exists; save the archive again.' >&2; exit 1; fi
  ln -- "$1" "$2" || exit
  if [ -d "$2" ]; then
    rm -f -- "$2/\${1##*/}"
    printf '%s\\n' 'The destination changed into a folder; save the archive again.' >&2; exit 1
  fi
fi`;

export function archiveFileName(name,format,windows=false) {
  if(!name)throw new Error("Enter an archive file name.");
  if(/[\0/]/.test(name)||(windows&&name.includes("\\")))throw new Error("Enter a file name; choose its folder above.");
  if(!name.includes("."))name+=`.${format}`;
  const extension=name.slice(name.lastIndexOf(".")+1).toLowerCase();
  if(!["tar","zip"].includes(extension))throw new Error(`Invalid file extension "*.${extension}". The archive file must have a *.tar or *.zip extension.`);
  return {name,format:extension};
}
export function archiveFolderEntries(raw) {
  const fields=raw.split("\0"),folder=fields.shift(),items=[];let complete=false,error=false;
  if(!folder)throw new Error("The folder could not be read.");
  for(let i=0;i<fields.length-1;){
    const kind=fields[i++];if(kind==="END"){complete=true;break;}if(kind==="ERROR"){error=true;break;}
    const name=fields[i++];if(!["D","F"].includes(kind)||name==null||i>=fields.length)break;
    items.push({name,directory:kind==="D"});
  }
  items.sort((a,b)=>Number(b.directory)-Number(a.directory)||a.name.localeCompare(b.name));
  return {folder,items:items.slice(0,1000),limited:!complete||items.length>1000,error};
}
export function archiveDestination(raw) {
  const [kind,folder,path,hash]=raw.split("\0");
  if(!["new","file"].includes(kind)||!folder||!path||(kind==="file"&&!/^[0-9a-f]{40,64}$/.test(hash)))throw new Error("The archive destination could not be checked.");
  return {folder,path,hash:kind==="file"?hash:null};
}
