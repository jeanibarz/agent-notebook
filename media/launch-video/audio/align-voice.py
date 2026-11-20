#!/usr/bin/env python
"""Place a second voice's narration on the picture cues the reference voice was timed to.

The picture was timed against one narrator (the reference). Another voice speaks at its own pace,
so its sentences would drift off the picture's events. This cuts each of the new voice's clips at
its sentence pauses and places every sentence so that it STARTS when the reference voice's
sentence starts.

usage: align-voice.py <script.json> <referenceDir> <newVoiceDir> <outDir> <placements.json> <captions.js>
  referenceDir, newVoiceDir   folders of <id>.wav from narrate.py
  outDir                      receives one clip per sentence: <id>a.wav, <id>b.wav, ...
  placements.json             [{"id", "start"}] for make-timeline.py
  captions.js                 the caption track rebuilt from the placements
Line start times are read from audio/make-timeline.py's REFERENCE_STARTS.
"""
import json
import os
import re
import sys

import numpy as np
import soundfile as sf

script_path, ref_dir, new_dir, out_dir, placements_path, captions_path = sys.argv[1:7]
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from reference_starts import REFERENCE_STARTS  # noqa: E402  ({line id: film seconds})


def pauses(path, min_len=0.10):
    """Silent runs inside a clip, longest first: [(start, end)] in seconds, edges excluded."""
    x, sr = sf.read(path)
    if x.ndim > 1:
        x = x.mean(axis=1)
    hop = int(sr * 0.005)
    frames = len(x) // hop
    rms = np.sqrt(np.mean(x[: frames * hop].reshape(frames, hop) ** 2, axis=1) + 1e-12)
    quiet = 20 * np.log10(rms / rms.max()) < -38
    runs, i = [], 0
    while i < frames:
        if quiet[i]:
            j = i
            while j < frames and quiet[j]:
                j += 1
            if i > 0 and j < frames and (j - i) * 0.005 >= min_len:
                runs.append((i * 0.005, j * 0.005))
            i = j
        else:
            i += 1
    return sorted(runs, key=lambda r: r[0] - r[1]), x, sr


def lead_trail(x, sr):
    """Seconds of silence at the head and tail of a clip."""
    loud = np.where(np.abs(x) > 10 ** (-38 / 20) * np.abs(x).max())[0]
    return loud[0] / sr, (len(x) - 1 - loud[-1]) / sr


os.makedirs(out_dir, exist_ok=True)
placements, captions, report = [], [], []
for line in json.load(open(script_path))["lines"]:
    lid, text = line["id"], line["text"]
    sentences = [s.strip() for s in re.split(r"(?<=[.?!])\s+", text) if s.strip()]
    n = len(sentences)
    ref_runs, ref_x, ref_sr = pauses(os.path.join(ref_dir, lid + ".wav"))
    new_runs, new_x, new_sr = pauses(os.path.join(new_dir, lid + ".wav"))
    # A voice may run two short sentences together ("Tuesday. Same trap."). Cut only at the pauses
    # both voices make, longest first; a line with fewer cuts than sentence breaks keeps one caption.
    cuts = min(n - 1, len(ref_runs), len(new_runs))
    ref_cuts = sorted(ref_runs[:cuts])
    new_cuts = sorted(new_runs[:cuts])
    if cuts < n - 1:
        sentences = [text] if cuts == 0 else None
    ref_lead, _ = lead_trail(ref_x, ref_sr)
    # where each sentence of the reference voice starts, in film seconds
    ref_onsets = [REFERENCE_STARTS[lid] + ref_lead] + [REFERENCE_STARTS[lid] + end for _, end in ref_cuts]
    # cut the new voice in the middle of each pause
    edges = [0.0] + [(a + b) / 2 for a, b in new_cuts] + [len(new_x) / new_sr]
    whole_line = sentences is None            # cuts exist, but do not map one-to-one onto sentences
    line_first = len(captions)
    for k in range(cuts + 1):
        sentence = text if whole_line else sentences[k]
        seg = new_x[int(edges[k] * new_sr): int(edges[k + 1] * new_sr)].copy()
        # keep only 30 ms of silence around the speech, so neighbouring clips never overlap
        lead, trail = lead_trail(seg, new_sr)
        keep = 0.03
        seg = seg[max(0, int((lead - keep) * new_sr)): len(seg) - max(0, int((trail - keep) * new_sr))]
        fade = int(0.008 * new_sr)
        seg[:fade] *= np.linspace(0, 1, fade)
        seg[-fade:] *= np.linspace(1, 0, fade)
        lead, trail = lead_trail(seg, new_sr)
        seg_id = lid + "abcdef"[k]
        sf.write(os.path.join(out_dir, seg_id + ".wav"), seg, new_sr)
        start = round(ref_onsets[k] - lead, 3)
        dur = len(seg) / new_sr
        placements.append({"id": seg_id, "start": start, "gain_db": 0})
        captions.append((round(ref_onsets[k], 2), round(start + dur - trail + 0.05, 2), sentence))
        report.append((seg_id, ref_onsets[k], start, start + dur, sentence))
    if whole_line:                            # one caption for the whole line
        t0, t1 = captions[line_first][0], captions[-1][1]
        del captions[line_first:]
        captions.append((t0, t1, text))

for a, b in zip(report, report[1:]):
    if a[3] > b[2]:
        sys.exit(f"{a[0]} (ends {a[3]:.2f}) overlaps {b[0]} (starts {b[2]:.2f})")
json.dump(placements, open(placements_path, "w"), indent=1)

# Captions: consecutive short sentences of one line are shown together when they sit close.
merged = []
for t0, t1, text in captions:
    if merged and t0 - merged[-1][1] < 0.45 and len(merged[-1][2]) + len(text) < 60:
        merged[-1] = (merged[-1][0], t1, merged[-1][2] + " " + text)
    else:
        merged.append((t0, t1, text))
with open(captions_path, "w") as f:
    f.write("/* Verbatim narration captions, shown under the picture (never inside it).\n"
            " * Generated by audio/align-voice.py from the narration placements: do not edit by hand. */\n"
            "FILM.captions = [\n")
    for t0, t1, text in merged:
        f.write(f"  {{ t0: {t0:.2f}, t1: {t1:.2f}, text: {json.dumps(text, ensure_ascii=False)} }},\n")
    f.write("];\n")
for seg_id, onset, start, end, sentence in report:
    print(f"{seg_id}  speech starts {onset:6.2f}  clip {start:6.2f}-{end:6.2f}  {sentence}")
print(f"{len(placements)} clips, {len(merged)} captions")
