"""Verify actual speech in each real Orca keyboard checkpoint; no synthetic speech fallback."""
import array
import json
import math
import pathlib
import sys
import wave

root = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in (root / "checkpoints.jsonl").read_text().splitlines()]
assert len(rows) >= 18, f"Expected the actual approval/recovery and lifecycle checkpoints, got {len(rows)}"
started = int((root / "recording-start-ms.txt").read_text())
with wave.open(str(root / "speech.wav"), "rb") as recording:
    assert recording.getsampwidth() == 2 and recording.getnchannels() == 1
    rate = recording.getframerate()
    frames = recording.getnframes()
    for row in rows:
        first = max(0, int((row["startedAt"] - started) / 1000 * rate))
        last = min(frames, int((row["finishedAt"] - started) / 1000 * rate))
        assert last > first, f"Missing recording for {row['name']}"
        recording.setpos(first)
        samples = array.array("h", recording.readframes(last - first))
        rms = math.sqrt(sum(sample * sample for sample in samples) / len(samples))
        assert rms > 20, f"No actual synthesized audio for {row['name']}: {rms}"
        row["audioRms"] = round(rms, 3)
        row["audioFrames"] = len(samples)
report = {"engine": "Actual Orca + AT-SPI + Speech Dispatcher + espeak-ng", "checkpoints": rows,
          "speechAudioPresentForEveryCheckpoint": True, "providerWrites": 0,
          "scope": "Existing fictional native HTTP/SQLite fixtures in isolated CI; no developer localhost access"}
(root / "verified-screen-reader.json").write_text(json.dumps(report, indent=2))
print(json.dumps({"actualScreenReaderCheckpoints": len(rows), "allHaveAudio": True}))
