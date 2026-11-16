// Lazygit uses strings.Fields, not a shell parser. Quotes stay literal, NEL is
// whitespace, and the BOM is not (unlike JavaScript's \s).
const FIELDS=/[\t-\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

export function mergeArgs(ref,variant,args="") {
  const extra={regular:[],"fast-forward":["--ff"],"non-fast-forward":["--no-ff"],squash:["--squash","--ff"]}[variant];
  if(!extra)throw new Error("Unknown merge variant");
  return ["merge","--no-edit",...args.split(FIELDS).filter(Boolean),...extra,ref];
}

export function mergeChoices(args,ff,canFastForward,staged) {
  // Preference deliberately follows upstream's substring check and precedence.
  const wantFF=args.includes("--ff")||(!args.includes("--no-ff")&&(ff==="true"||ff==="only"));
  const wantNoFF=!args.includes("--ff")&&(args.includes("--no-ff")||ff==="false");
  const regularFF=!wantNoFF&&(wantFF||canFastForward);
  const ffDisabled=canFastForward?null:"Cannot fast-forward: the current branch is not an ancestor of the selected branch";
  const squashDisabled=staged?"Commit or unstage existing staged changes before squash merging":null;
  return [
    {label:`Regular merge (${regularFF?"fast-forward":"with merge commit"})`,key:"m",variant:"regular",disabled:regularFF?ffDisabled:null},
    {label:`Regular merge (${regularFF?"with merge commit":"fast-forward"})`,key:regularFF?"n":"f",variant:regularFF?"non-fast-forward":"fast-forward",disabled:regularFF?null:ffDisabled},
    {label:"Squash merge and leave uncommitted",key:"s",variant:"squash",commit:false,disabled:squashDisabled},
    {label:"Squash merge and commit",key:"S",variant:"squash",commit:true,disabled:squashDisabled},
  ];
}

export function squashMergeMessage(template,selectedRef,currentBranch) {
  // Literal, one-pass replacement, including the dotted placeholder spelling.
  return template.replace(/\{\{\.?((?:selectedRef)|(?:currentBranch))\}\}/g,(_match,key)=>key==="selectedRef"?selectedRef:currentBranch);
}

// Git creates SQUASH_MSG only after a squash starts. Do not fabricate operation
// state after an early failure. --git-path also covers linked worktrees.
export const WRITE_SQUASH_MESSAGE=[
  'path=$(git rev-parse --path-format=absolute --git-path SQUASH_MSG && printf .) || exit',
  'path=${path%.}; path=${path%?}',
  'if [ -e "$path" ]; then printf \'%s\\n\' "$1" > "$path"; fi',
].join("\n");

export const REBASE_BRANCH=String.raw`
for name in rebase-merge/head-name rebase-apply/head-name; do
  path=$(git rev-parse --git-path "$name") || exit
  if [ -f "$path" ]; then head -c 65536 "$path"; exit; fi
done
`;
