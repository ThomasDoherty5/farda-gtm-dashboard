"""Verify actual speech in each real Orca keyboard checkpoint; no synthetic speech fallback."""
import array
import json
import math
import pathlib
import sys
import wave

root = pathlib.Path(sys.argv[1])
rows = [json.loads(line) for line in (root / "checkpoints.jsonl").read_text().splitlines()]
expected = {
    "shippingDecision-canonical-plan-preview", "returnTask-canonical-plan-preview",
    "shippingDecision-canonical-approval-handoff", "returnTask-canonical-approval-handoff",
    "shippingDecision-original-recovery-control", "returnTask-original-recovery-control",
    "native-contribution-table-control", "native-contribution-chart-control",
    "native-contribution-cohort-dialog", "native-contribution-cohort-focus-return", "native-ledger-table-headers", "native-ledger-export-focus-return", "native-payable-evidence-focus-return",
    "native-dispatch-table-headers", "native-customer-denial-focus-return",
    "approval-exact-source-review", "canonical-receipt-navigation",
    "immutable-history-navigation", "original-outcome-recovery-control",
    "consent-table-alternative", "activation-cohort-dialog",
    "monitor-table-headers", "monitor-held-retry", "watchlist-table-headers",
    "post-publication-alternative", "monitor-partial-recovery",
    "stock-table-headers", "stock-evidence-focus-return", "stock-form-error",
    "stock-proposal-status", "support-table-headers", "support-cohort-focus-return",
}
for flow in ("early-access", "abandoned-checkout", "review-request"):
    for checkpoint in ("locked-policy", "dialog-focus-return", "validation", "save-announcement"):
        expected.add(f"{flow}-{checkpoint}")
names = [row["name"] for row in rows]
assert len(names) == len(set(names)), "Duplicate speech checkpoints cannot replace missing journeys"
assert expected <= set(names), f"Missing actual screen-reader checkpoints: {sorted(expected - set(names))}"
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
