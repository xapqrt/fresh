#!/bin/bash
# Autonomous Dawn Client improvement loop (no human input needed).
# Runs rounds back-to-back: drive opencode -> validate -> commit -> push -> next.
set -u
cd /Users/xapqrt/Documents/code/dawn-fresh || exit 1

LOG=/tmp/dawn-autoloop.log
ROUND=4
MAX_ROUNDS=12

log(){ echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

# Standing hard rules prepended to every round prompt.
RULES="HARD CONSTRAINTS (never violate): Do NOT add or enable --disable-frame-rate-limit, --disable-gpu-vsync, or --in-process-gpu (the latter is only allowed inside the existing 'if (in_process_gpu)' gate which stays default-off). Do NOT reintroduce setFrameRate(). Do NOT run npm build/start. Make minimal justified changes, report a diff-style list, and run node -c on any modified .js files."

# Queue of round topics (research + safe improvements). Each entry is the prompt.
topics=(
"$RULES Round 5 for Dawn Client (Electron kirka.io wrapper, M4, 240Hz goal, EXACTLY 240fps capped already). Tasks:
1. MAIN PROCESS PRIORITY: in src/main.js, after app ready, call require('os').setPriority(process.pid, -10) so the main/compositor process is not starved by background macOS tasks during gameplay. Verify safe. Report.
2. SAFE FEATURE FLAGS: add to --disable-features (append, keep existing members): 'CrossOriginOpenerPolicy' ONLY if it could interfere with kirka.io cross-origin asset/socket loading; if unsure, do NOT add and explain.
3. Confirm the game's own requestAnimationFrame loop is not throttled (anti-backgrounding flags already present). Nothing to change unless you find a setInterval/pollInterval driving logic. Report.
4. Keep force-color-profile=srgb. Do NOT add HDR unless clearly safe. Report.
5. node -c all modified files. Diff-style report. Do not commit."

"$RULES Round 6 for Dawn Client. Tasks:
1. INPUT: in src/windows/game.js webPreferences, set 'scrollBounce'=false and 'pinchZoom'=false if present to reduce compositor work. Report.
2. Inspect src/util/dawn-patch.js protocol handler: ensure 'dawn://' uses async fs and caches; convert any sync read. Report findings.
3. Add --disable-features=Translate,OptimizationHints,MediaRouter to cut background services that can steal main-thread time. Safe. Report.
4. node -c modified files. Diff. Do not commit."

"$RULES Round 7 for Dawn Client. Tasks:
1. MEMORY: audit src/preload/game/*.js for per-frame closures/arrays in any rAF; hoist them. Report.
2. Add --js-flags='--max-old-space-size=512' to bound renderer GC heap (prevents long GC at high fps). Note risk. Report.
3. Add --disable-features=BackForwardCache (game SPA, frees memory) if safe. Report.
4. node -c. Diff. Do not commit."

"$RULES Round 8 for Dawn Client. Tasks:
1. GPU: ensure out-of-process GPU (no unconditional --in-process-gpu). Do NOT add --disable-gpu-sandbox (security). Report.
2. --use-angle=metal already present; if '--enable-features=MetalOnlyGraphics' exists and is safe, add it to force Metal path. Report if applied.
3. Audit window show logic in src/windows/game.js for 'ready-to-show' race / black-flash; ensure removeMenu before show. Report.
4. node -c. Diff. Do not commit."
)

while [ "$ROUND" -lt "$MAX_ROUNDS" ] && [ "${#topics[@]}" -gt 0 ]; do
  ROUND=$((ROUND+1))
  topic="${topics[0]}"
  topics=("${topics[@]:1}")

  log "===== STARTING ROUND $ROUND ====="
  log "PROMPT: ${topic:0:80}..."

  out=$(opencode run "$topic" --auto 2>&1)
  rc=$?
  if [ $rc -ne 0 ]; then
    log "opencode exited non-zero ($rc). Aborting round to avoid bad state."
    echo "$out" | tail -20 >> "$LOG"
    git checkout -- src/ 2>/dev/null
    break
  fi

  # Validate: block UNCONDITIONAL forbidden flags. The gated
  # 'if (in_process_gpu) appendSwitch("in-process-gpu")' is allowed (default off).
  bad=""
  # disable-frame-rate-limit / disable-gpu-vsync should never appear at all
  frl=$(grep -rnE 'appendSwitch\("(disable-frame-rate-limit|disable-gpu-vsync)"\)' src/ || true)
  if [ -n "$frl" ]; then bad="$bad$frl\n"; fi
  # in-process-gpu only forbidden if UNCONDITIONAL (not inside 'if (in_process_gpu)')
  ipg_lines=$(grep -rnE 'appendSwitch\("in-process-gpu"\)' src/ || true)
  if [ -n "$ipg_lines" ]; then
    while IFS= read -r ln; do
      [ -z "$ln" ] && continue
      file=${ln%%:*}
      # show 2 lines before the match to detect an 'if (in_process_gpu)' gate
      ctx=$(grep -nB2 "appendSwitch(\"in-process-gpu\")" "$file" | grep -E "if \(in_process_gpu\)" || true)
      if [ -z "$ctx" ]; then
        bad="$bad UNCONDITIONAL in-process-gpu: $ln\n"
      fi
    done <<< "$ipg_lines"
  fi
  if [ -n "$bad" ]; then
    log "BLOCKED: forbidden flag in src/: $(echo -e "$bad") -> reverted, not committed."
    git checkout -- src/
    continue
  fi
  if grep -rqn "setFrameRate" src/; then
    log "BLOCKED: setFrameRate reintroduced -> reverted, not committed."
    git checkout -- src/
    continue
  fi

  # Syntax check changed .js files
  changed=$(git diff --name-only -- 'src/**/*.js')
  syntax_ok=1
  for f in $changed; do
    if ! node -c "$f" 2>>"$LOG"; then syntax_ok=0; fi
  done
  if [ "$syntax_ok" -ne 1 ]; then
    log "BLOCKED: node -c failed. Reverted, not committed."
    git checkout -- src/
    continue
  fi

  git add -A
  if git diff --cached --quiet; then
    log "Round $ROUND: no file changes. Skipping commit."
  else
    git commit -m "perf: autonomous round $ROUND (driven by aionui loop)" >>"$LOG" 2>&1
    git push >>"$LOG" 2>&1
    log "Round $ROUND committed + pushed."
  fi
done

log "===== AUTO LOOP DONE (rounds up to $ROUND) ====="
