"""Dependency-ready dispatch for a coordinator that fans work out to lanes.

A coordinator that dispatches one worker and then waits for it leaves the machine idle.
Measured on a real research run: 63% of wall-clock sat in gaps, nearly every one starting
the moment a worker was dispatched, while eighteen sealed artifacts sat unreviewed and five
lanes idled. Dispatch was never blocking and the parent woke on every completion; what was
missing is that nothing refilled on those wakes.

This is that refill. Readiness is a fact on disk - a task is ready when every dependency it
declared has a seal file whose recorded digest matches the artifact's current bytes - so no
model judgement decides what runs, and a half-written dependency cannot look ready.

Queue entries live in <root>/queue/<id>.json:

    {"id": "review-stats", "deps": ["artifacts/stats.json"], "brief": "...",
     "lane": "stats-reviewer", "model": "..."}

Seal an artifact when it is final, never while a worker still holds the pen:

    seal("artifacts/stats.json")   # writes artifacts/stats.json.seal, then chmod a-w
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

__all__ = ["seal", "verify_seal", "ready", "refill", "RefillReport"]

_SEAL_SUFFIX = ".seal"


def _digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def seal(artifact: str | Path) -> str:
    """Mark an artifact final: record its digest, then make it read-only.

    The chmod is the part that matters. A seal alone leaves a window where a worker can still
    rewrite the bytes a reader was dispatched against - that window is what produced a real
    provenance break, where recorded hashes and on-disk bytes diverged with no record of why.

    Return: the recorded sha256.
    """
    path = Path(artifact)
    if not path.is_file():
        raise FileNotFoundError(f"cannot seal a path that is not a file: {path}")
    digest = _digest(path)
    seal_path = path.with_name(path.name + _SEAL_SUFFIX)
    tmp = seal_path.with_name(seal_path.name + ".tmp")
    tmp.write_text(json.dumps({"sha256": digest, "bytes": path.stat().st_size}, sort_keys=True) + "\n")
    os.replace(tmp, seal_path)
    path.chmod(0o444)
    return digest


def verify_seal(artifact: str | Path) -> bool:
    """Whether an artifact is sealed and its bytes still match the recorded digest."""
    path = Path(artifact)
    seal_path = path.with_name(path.name + _SEAL_SUFFIX)
    if not path.is_file() or not seal_path.is_file():
        return False
    try:
        recorded = json.loads(seal_path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(recorded, dict) and recorded.get("sha256") == _digest(path)


@dataclass(frozen=True)
class RefillReport:
    """What one refill actually did, so a caller can log it rather than guess."""

    dispatched: list[str]
    ready_not_dispatched: list[str]
    blocked: dict[str, list[str]]
    running: int
    capacity: int
    load: float

    def __str__(self) -> str:
        return (
            f"dispatched {len(self.dispatched)}; ready-waiting {len(self.ready_not_dispatched)}; "
            f"blocked {len(self.blocked)}; running {self.running}; capacity {self.capacity}; "
            f"load {self.load:.2f}"
        )


def _load_queue(root: Path) -> list[dict[str, Any]]:
    queue_dir = root / "queue"
    if not queue_dir.is_dir():
        return []
    tasks: list[dict[str, Any]] = []
    for entry in sorted(queue_dir.glob("*.json")):
        try:
            task = json.loads(entry.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(task, dict) and isinstance(task.get("id"), str):
            task.setdefault("deps", [])
            tasks.append(task)
    return tasks


def _done(root: Path, task_id: str) -> bool:
    return (root / "done" / task_id).exists()


def ready(root: str | Path = ".") -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    """Split the queue into tasks whose dependencies all verify, and those still blocked.

    Args:
    root: Directory holding queue/ and done/.
    Return: (ready tasks, {task id: unmet dependency paths}).
    """
    base = Path(root)
    ready_tasks: list[dict[str, Any]] = []
    blocked: dict[str, list[str]] = {}
    for task in _load_queue(base):
        if _done(base, task["id"]):
            continue
        unmet = [dep for dep in task["deps"] if not verify_seal(base / dep)]
        if unmet:
            blocked[task["id"]] = unmet
        else:
            ready_tasks.append(task)
    return ready_tasks, blocked


async def refill(root: str | Path = ".", *, cores: int | None = None) -> RefillReport:
    """Dispatch every ready task that free capacity allows, then return what happened.

    Capacity is the machine's, not a guess: occupancy comes from the live subagent registry
    and the ceiling from load average against core count. At or above the core count nothing
    new is admitted, because past that point the daemon control plane degrades while work
    underneath keeps running - which looks like health, not overload.

    An idle lane is reused by message rather than replaced by a fresh child. A new child always
    gets a new session directory, so it cannot reach a lane that already holds the loaded
    context this task needs; only a message can.

    Args:
    root: Directory holding queue/ and done/.
    cores: Override the detected core count.
    Return: RefillReport describing dispatches, waiting work, and capacity.
    """
    import rlm

    base = Path(root)
    ready_tasks, blocked = ready(base)

    subagents = await rlm.list_subagents()
    running_names = {agent.session_name for agent in subagents if agent.status == "running"}
    idle_names = {agent.session_name for agent in subagents if agent.status != "running"}

    limit = cores if cores is not None else (os.cpu_count() or 1)
    load = os.getloadavg()[0]
    capacity = 0 if load >= limit else max(0, limit - len(running_names))

    dispatched: list[str] = []
    waiting: list[str] = []
    for task in ready_tasks:
        lane = task.get("lane") or task["id"]
        if lane in running_names:
            waiting.append(task["id"])
            continue
        if len(dispatched) >= capacity:
            waiting.append(task["id"])
            continue
        brief = task.get("brief", "")
        if lane in idle_names:
            import agent_message

            await agent_message.send(brief, receiver_role="child", receiver_name=lane)
        else:
            kwargs: dict[str, Any] = {"name": lane}
            if task.get("model"):
                kwargs["model"] = task["model"]
            await rlm(brief, **kwargs)
        dispatched.append(task["id"])

    return RefillReport(
        dispatched=dispatched,
        ready_not_dispatched=waiting,
        blocked=blocked,
        running=len(running_names),
        capacity=capacity,
        load=load,
    )
