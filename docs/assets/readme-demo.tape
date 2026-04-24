# Rebuild: vhs docs/assets/readme-demo.tape
# Requires: vhs, ttyd, ffmpeg (brew install vhs)

Output docs/assets/readme-demo.gif

Set Shell         "bash"
Set FontSize      18
Set Width         1000
Set Height        440
Set Theme         "Dracula"
Set TypingSpeed   45ms
Set PlaybackSpeed 1.0

# Setup: cd into fixture and source the bash() mock. Hidden from the recording.
Hide
Type "cd docs/assets/demo-fixture && source .demo-init.sh"
Enter
Sleep 300ms
Show

Sleep 600ms

# 1. One YAML rule — this is what's guarding everything.
Type "cat veto/rules/no-destructive.yml"
Sleep 300ms
Enter
Sleep 1400ms

# 2. Normal agent work — passes through.
Type "bash -c 'grep -r TODO src/'"
Sleep 300ms
Enter
Sleep 1100ms

# 3. Dangerous command — blocked with reason.
Type "bash -c 'rm -rf src/legacy'"
Sleep 400ms
Enter
Sleep 2800ms
