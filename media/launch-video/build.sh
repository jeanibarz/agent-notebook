#!/usr/bin/env bash
# Rebuilds the launch film: narration -> aligned narration -> mix -> frames -> videos -> contact sheets.
# usage: ./build.sh [all|audio|frames|video|vertical|sheet]   (default all)
# Environment, all optional (defaults in brackets):
#   PY      a Python with numpy, scipy, soundfile and kokoro_onnx [python3]
#   SHARDS  parallel frame-render processes [6]
# Narration needs KOKORO_DIR (the folder with the Kokoro model files, see audio/narrate.py).
# The picture is timed against a reference voice (am_michael at 1.08); the film is narrated by a blend
# (af_heart:0.5+af_sky:0.5 at 1.0) whose sentences are placed on the reference voice's cues.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-python3}
SHARDS=${SHARDS:-6}
FPS=30
DUR=49
step=${1:-all}

audio() {
  [ -f out/vo/durations.json ] || "$PY" audio/narrate.py script.json out/vo am_michael 1.08
  [ -f out/vo-blend50/durations.json ] || "$PY" audio/narrate.py script.json out/vo-blend50 af_heart:0.5+af_sky:0.5 1.0
  "$PY" audio/align-voice.py script.json out/vo out/vo-blend50 out/vo-final audio/placements-final.json captions.js
  "$PY" audio/make-timeline.py audio/placements-final.json audio/timeline-final.json
  "$PY" audio/mix.py audio/timeline-final.json out/vo-final out/mix-final
}

render() {  # render <page> <outDir> [SIZE]
  local page=$1 out=$2 size=${3:-1920x1080} i from to failed=0 pids=()
  mkdir -p "$out"
  find "$out" -name 'f*.png' -delete
  for i in $(seq 0 $((SHARDS - 1))); do
    from=$("$PY" -c "print(round($DUR*$i/$SHARDS*$FPS)/$FPS)")
    to=$("$PY" -c "print(round($DUR*($i+1)/$SHARDS*$FPS)/$FPS)")
    SIZE=$size node render.mjs "$page" "$out" "$FPS" "$from" "$to" > "$out.$i.log" 2>&1 &
    pids+=($!)
  done
  for i in "${pids[@]}"; do wait "$i" || failed=1; done
  if [ "$failed" -ne 0 ]; then cat "$out".*.log >&2; echo "render: a shard failed" >&2; return 1; fi
  echo "render: $(find "$out" -name 'f*.png' | wc -l | tr -d ' ') frames in $out"
}

encode() {  # encode <framesDir> <out.mp4>
  ffmpeg -y -loglevel error -framerate "$FPS" -start_number 0 -i "$1/f%05d.png" -i out/mix-final.wav \
    -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart -c:a aac -b:a 192k -shortest "$2"
  ffprobe -v error -show_entries format=duration,size:stream=codec_name,width,height -of compact "$2"
}

frames() { render film.html out/frames; }
video() { mkdir -p out/release; encode out/frames out/release/agent-notebook-launch-16x9.mp4; }
vertical() { render vertical.html out/frames-v 1080x1920; mkdir -p out/release; encode out/frames-v out/release/agent-notebook-launch-9x16.mp4; }

sheet() {  # one still per second, 24 per sheet, each stamped with its time
  local total per=24 sheets i first last
  total=0
  if [ -d out/frames ]; then total=$(find out/frames -name 'f*.png' | wc -l | tr -d ' '); fi
  if [ "$total" -eq 0 ]; then echo "sheet: no frames in out/frames; run ./build.sh frames first" >&2; return 1; fi
  sheets=$(( (total + per * FPS - 1) / (per * FPS) ))
  for i in $(seq 1 "$sheets"); do
    first=$(( (i - 1) * per * FPS )); last=$(( i * per * FPS ))
    ffmpeg -y -loglevel error -framerate "$FPS" -start_number 0 -i out/frames/f%05d.png \
      -vf "select='not(mod(n\,$FPS))*gte(n\,$first)*lt(n\,$last)',scale=640:-1,drawtext=text='%{eif\:t\:d}s':x=12:y=12:fontsize=28:fontcolor=white:box=1:boxcolor=black@0.7,tile=6x4" \
      -frames:v 1 "$(printf 'out/contact-sheet-%02d.png' "$i")"
  done
}

case "$step" in
  all) audio; frames; video; vertical; sheet ;;
  audio|frames|video|vertical|sheet) "$step" ;;
  *) echo "unknown step $step"; exit 2 ;;
esac
