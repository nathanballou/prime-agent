---
name: lane-refill
description: Keep lanes busy while a serial step runs. Use when coordinating several workers, when work has dependencies, or when the machine sits idle because a coordinator dispatched one worker and waited for it.
---

# Lane Refill

**Dispatch never blocked. The parent already wakes on every child completion. The idle time
comes from refilling nothing on those wakes.**

Measured on a real research run: 63% of wall-clock in gaps, nearly every gap starting the
moment a worker was dispatched, while eighteen sealed artifacts sat unreviewed and five lanes
idled — one for over an hour holding loaded context nobody used.

## The three calls

```python
from lane_refill import seal, ready, refill

seal("artifacts/stats.json")          # final: record digest, then chmod a-w
tasks, blocked = ready()              # what could run now, and what is waiting on what
report = await refill()               # dispatch everything free capacity allows
print(report)                         # dispatched 3; ready-waiting 1; blocked 2; ...
```

## Queue entries

One JSON file per task in `queue/<id>.json`. A task is ready when **every** dependency has a
seal whose digest still matches the artifact's bytes.

```json
{"id": "review-stats", "deps": ["artifacts/stats.json"], "brief": "Attack this for...",
 "lane": "stats-reviewer", "model": "optional"}
```

Mark completion by touching `done/<id>`. A worker that discovers follow-up work writes its own
`queue/<newid>.json` — **the graph grows without a coordinator turn at all.**

## Rules that make this work

1. **Never seal an artifact a worker still holds.** Seal on reported completion. Sealing
   mid-write is what makes recorded hashes and on-disk bytes diverge, with no record of why.
2. **Seal before you dispatch readers.** A reviewer reading a moving target produces a verdict
   bound to nothing.
3. **Call `refill()` before ending a turn**, and end when it reports `dispatched 0`.
4. **Workers should not reply.** Write the artifact, seal it, touch `done/<id>`, say nothing.
   A reply pushes the worker's full text into the coordinator's context; silence gets a short
   notice. The coordinator reads verdicts from artifacts, not conversations.

## Wire the heartbeat, so refill fires without being remembered

Two triggers exist and neither depends on discipline. The child-completion notice already says
a slot is free. Add a floor:

```python
await rlm_heartbeat.create(
    "Continue: run refill() and dispatch every ready task, then report what dispatched.",
    interval="5m",
    delivery_mode="follow_up",
)
```

The instruction **must open with a continuation verb**. A heartbeat that only asks for status
produces a report-and-halt loop that looks healthy from outside.

## What this deliberately does not do

It does not decide *what* work exists — you declare that. It does not raise concurrency above
what the machine has: at or above the core count it admits nothing, because past that point the
daemon control plane degrades while work underneath keeps running, which reads as health.

It prefers **messaging an idle lane** over spawning a fresh child, because a new child always
gets a new session directory and cannot reach a lane that already holds the context this task
needs.
