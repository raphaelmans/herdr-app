// A failed subprocess always waits for acknowledgment. Successful subprocesses
// follow Lazygit's promptToReturnFromSubprocess setting.
export const GIT_SUBPROCESS=String.raw`
wait_for_return=$1; shift
"$@"
code=$?
if [ "$wait_for_return" = true ] || [ "$code" -ne 0 ]; then
  printf '\nPress Enter to return to Git'
  IFS= read -r answer
fi
exit "$code"
`;
