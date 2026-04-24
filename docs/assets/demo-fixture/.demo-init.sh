# Sourced by vhs before recording starts.
# Mocks `bash` so the tape renders identical output to a real veto-bash run
# without requiring a build, API key, or actually executing dangerous commands.

PS1='$ '
clear

bash() {
  local cmd="$*"
  case "$cmd" in
    *"grep -r TODO"*)
      printf 'src/auth.ts:2:  // TODO: rotate keys\n'
      printf 'src/db.ts:2:   // TODO: add index\n'
      return 0
      ;;
    *"rm -rf"*)
      printf '\033[31m[veto-bash] Recursive delete outside /tmp — ask a human.\033[0m\n' >&2
      printf '\033[2m[veto-bash] rule: no-destructive-rm\033[0m\n' >&2
      return 1
      ;;
    *)
      command bash "$@"
      ;;
  esac
}
