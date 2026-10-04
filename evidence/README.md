# Loop evidence — harness-side guard captures

Captured 2026-10-03 by [zimuhuan-code](https://github.com/zimuhuan-code) on a 2× RTX 3060
machine running **Strata 0.1.37** (commit `db4f91a`, built from source) with
**Qwen3.8-Flash-Next GSQ-RCO IQ3_S**.

Offered in reply to the maintainer's request in
[Niko1221/Strata#602](https://github.com/Niko1221/Strata/issues/602) — *"please add the logs to
#75 if you have them"*.

## Scope — and a correction to what we said in #602

We originally collected **eight** guard captures. Before publishing we checked **every one of them
against the session it came from** — the `model` field recorded in that session log, cross-checked
against the engine's own start-up segments and systemd timestamps. Result:

- **five of the eight came from a session running a hosted API model**
  (`provider: deepseek-official`, `model: deepseek-flash`) — **not Strata** — and have been
  **removed**;
- **three** captures can be attributed to Strata, and they are what this package contains.

⚠️ Consequently the *"local reproduction of #75"* language we used in #602 was **wrong for the
text-loop part**: those captures — and the two observations that went with them ("a stop message
does not end the loop"; "the next turn loops again on the same check") — came from the **hosted
API** session. **We withdraw both claims for Strata.** What survives, verified by source, is below.

| | |
|---|---|
| Engine | Strata **0.1.37**, commit `db4f91a`, built from source |
| Model | Qwen3.8-Flash-Next GSQ-RCO **IQ3_S** — the provider's `model` id still reads `qwen3.8-flash-next-q2_0`, a label we never renamed; the quantisation was confirmed from the engine's own start-up segment for that run (`about 55 GB` / 3579 expert slots, first loaded 13:33 on 2026-10-03) |
| When | 2026-10-03 **14:10 / 14:11 / 14:57** local |
| Hardware | 2× RTX 3060 12 GB, layer split, 524,288-token context |
| Harness | DSH agent runtime with our own guard plugin |

Everything here is **harness-side**. We have no visibility inside the model or the engine.

## Context: both captures come from the *same kind of task*

Both sessions were **reviewing a draft issue report about this engine** — the reviewer's job was to
re-check claims against local measurement notes, one fact at a time. In both cases the loop
happened while the reviewer was **re-checking a single fact**: whether a long-context section of a
local note contained an IQ3_S entry.

- **Session A** (13:06 → 14:19): produced a 17-item review, then looped — two captures, at 14:10
  and 14:11, on the same re-check.
- **Session B** (14:50 →): a fresh review of the same draft; it looped at 14:57 and **never
  produced a review at all**. The harness injected its repeated-call warning twice
  (`consecutive_calls: 5`); the operator then stopped the session by hand.

This is the pattern our #602 write-up tried to describe — *self-verification that never reaches a
stop condition* — but here with artifacts we can actually attribute to this engine.

## Contents

| file | what it is |
|---|---|
| `samples/*.json` | 3 artifacts written **at the moment the guard detected the loop**, before it acted |
| `cancels.log` | the guard's cancellation log for these two sessions (2 lines) |
| `activity.log` | every guard line for those two sessions (25 lines) |

## What the captures show

Three `repeat-call` captures from two sessions:

- the **same `bash` call with identical arguments issued six times in a row** (`consecutive: 6`,
  `limit: 6`, one stable `fingerprint` per session);
- the repeated command is a two-part `grep`/`awk` re-check of one local note, ending in an `echo`
  that only prints a reminder of what an empty result would mean — **no branch of it produces a
  terminal "confirmed" state**;
- our guard then **aborted the turn** (a hard `Agent.cancel()`, not a message to the model).

The `arguments` field is kept so the shape of the repeated call is visible; internal file names are
replaced with `<internal-path>`.

## What we are *not* claiming

- **Not a rate, not a minimal reproducer, not a mechanism.** Three captures, two sessions, one
  machine, one quantisation (IQ3_S), text-only prompts, no images.
- **We no longer claim** that (a) a stop *message* fails to end the loop, or (b) the model re-issues
  the same call in the *next* turn — both came from the removed API-model session. With these three
  captures we can only say: the repeated identical tool call occurs on this engine, under a
  verification-style prompt, and ending it required aborting the turn.
- Nothing here is engine-internal: no sampler data, no engine logs, no visibility inside the model.

## Sanitisation

Session ids are truncated to their first 8 hex characters, local absolute paths are replaced with
`<path>` / `<internal-path>`, and user/host names are replaced. The guard's own test fixtures
(`s-abort`, `s-once`) were removed from the cancellation log. Nothing else is edited.
