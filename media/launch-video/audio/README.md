# Launch film audio

All audio is synthesized locally (numpy/scipy). No samples, no network, nothing licensed.
Needs a Python with numpy, scipy and soundfile (plus `kokoro_onnx` for narration) and ffmpeg.
Narration reads the Kokoro model from the folder named by `KOKORO_DIR`.

| File | What it does |
|---|---|
| `narrate.py` | `script.json` to one clip per line and `durations.json`. A voice may be a blend: `af_heart:0.5+af_sky:0.5`. |
| `audition.py` | Short audition clips of the first three script lines, in a voice or a blend. |
| `reference_starts.py` | When each narration line starts in the film. The storyboard's events are timed against these. |
| `align-voice.py` | Cuts another voice's clips at sentence pauses and places each sentence on the reference voice's cue; writes the placements and `captions.js`. |
| `make-timeline.py` | The cue sheet: narration placements, sound effects and music sections. Mirrors `storyboard.md`. |
| `synth.py` | The music bed (A minor, sections of energy 0..1 on a beat grid) and thirteen sound effects. |
| `mix.py` | Places narration, renders bed and effects, ducks the music under the voice, normalizes to -16 LUFS, writes wav, mp3, stems and a measurement report. |
| `verify.py` | Numeric checks of a finished mix and of the synthesizer. |
| `timeline-final.json`, `placements-final.json` | The cue sheet and placements of the released film. |

`../build.sh audio` runs the whole chain. The released mix measured: 49.0 s, -16.0 LUFS integrated,
true peak -2.2 dBTP, no clipped samples, voice 18 dB above the music while speaking. Those numbers
are measurements; the film was assembled by agents that cannot hear.
