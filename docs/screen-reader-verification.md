# Actual screen-reader verification

The isolated Linux CI job runs the existing native approval/recovery and lifecycle journeys with headed Chromium, Orca, AT-SPI, Speech Dispatcher and espeak-ng. It uses the existing fictional HTTP/SQLite/J04 fixtures. It never reads a developer's localhost service, changes developer accessibility preferences, connects a provider or sends a real message.

Orca supports Chromium and its debug output records what was spoken. Its **Where Am I** command uses the desktop keypad Enter key. References: [GNOME introduction](https://teams.pages.gitlab.gnome.org/websites/help.gnome.org/orca/introduction.html), [debugging](https://orca.gnome.org/debugging), [Where Am I](https://gnome.pages.gitlab.gnome.org/orca/help/commands_where_am_i.html).

`screenReaderCheckpoint` activates the page’s titled Chromium window, focuses an existing control, allows its AT-SPI focus event to arrive, sends an actual X11 keyboard event and requires the expected spoken output from the new checkpoint interval. It does not manufacture an accessibility tree or substitute a text-to-speech call. Most checkpoints use Where Am I; the activation checkpoint opens the actual cohort dialog with Return and checks its spoken context and focus restoration. Existing browser assertions still verify the actual service result, locked policies, role/scope boundaries and exact original-outcome recovery.

The runner records the actual synthesized audio to its ephemeral PulseAudio sink. Every checkpoint must have its expected Orca utterances and non-silent audio in the corresponding recording window. Missing speech, an unavailable synthesizer or absent checkpoints fail verification. No log-only fallback is accepted as a pass.

The headed Linux browser hides its scrollbar gutter to retain the existing headless capture geometry. The original exact-width, overflow, keyboard scrolling and axe assertions remain unchanged.

Evidence contains the browser log, Orca spoken-output transcript, checkpoint intervals, software versions and WAV recording. Review these actual observations alongside the existing keyboard/focus, axe, full-source visual comparisons and service tests. This is a scripted real-screen-reader journey with reviewed output, not a claim of a human participant usability study or real provider qualification. The exact CI revision and findings belong in the owning issue's release evidence.

Run only in the existing ephemeral Linux CI environment with:

```sh
dbus-run-session -- xvfb-run -a -s '-screen 0 1600x1200x24' bash scripts/run-screen-reader-ci.sh
```

The script deliberately refuses to run outside GitHub Actions on Linux. Normal native browser tests keep their original behavior unless the explicitly configured screen-reader environment is present.
