"""Readiness must be a fact on disk, not a hope. These probe the parts that can silently lie."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lane_refill import ready, seal, verify_seal  # noqa: E402


class SealTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self._cleanup)

    def _cleanup(self) -> None:
        for path in self.root.rglob("*"):
            if path.is_file():
                path.chmod(0o644)
        self.tmp.cleanup()

    def _artifact(self, name: str, body: str = "payload") -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        return path

    def test_seal_records_digest_and_revokes_write(self) -> None:
        path = self._artifact("a.json")
        digest = seal(path)
        self.assertEqual(len(digest), 64)
        self.assertTrue(verify_seal(path))
        # The chmod is the point: a seal alone leaves a window to rewrite what a reader was
        # dispatched against, which is exactly how recorded hashes and bytes diverged before.
        self.assertFalse(os.access(path, os.W_OK))

    def test_tampered_bytes_fail_verification(self) -> None:
        path = self._artifact("a.json")
        seal(path)
        path.chmod(0o644)
        path.write_text("different")
        self.assertFalse(verify_seal(path))

    def test_unsealed_and_missing_are_not_ready(self) -> None:
        self.assertFalse(verify_seal(self._artifact("loose.json")))
        self.assertFalse(verify_seal(self.root / "absent.json"))

    def test_corrupt_seal_file_is_not_ready(self) -> None:
        path = self._artifact("a.json")
        seal(path)
        path.with_name(path.name + ".seal").write_text("{not json")
        self.assertFalse(verify_seal(path))

    def test_seal_rejects_a_directory(self) -> None:
        (self.root / "adir").mkdir()
        with self.assertRaises(FileNotFoundError):
            seal(self.root / "adir")


class ReadinessTests(SealTests):
    def _task(self, task_id: str, deps: list[str]) -> None:
        queue = self.root / "queue"
        queue.mkdir(exist_ok=True)
        (queue / f"{task_id}.json").write_text(json.dumps({"id": task_id, "deps": deps, "brief": "x"}))

    def test_task_is_blocked_until_every_dep_is_sealed(self) -> None:
        self._artifact("artifacts/one.json")
        self._artifact("artifacts/two.json")
        self._task("t", ["artifacts/one.json", "artifacts/two.json"])

        tasks, blocked = ready(self.root)
        self.assertEqual(tasks, [])
        self.assertEqual(sorted(blocked["t"]), ["artifacts/one.json", "artifacts/two.json"])

        seal(self.root / "artifacts/one.json")
        tasks, blocked = ready(self.root)
        self.assertEqual(tasks, [], "one sealed dep out of two must not be ready")
        self.assertEqual(blocked["t"], ["artifacts/two.json"])

        seal(self.root / "artifacts/two.json")
        tasks, blocked = ready(self.root)
        self.assertEqual([t["id"] for t in tasks], ["t"])
        self.assertEqual(blocked, {})

    def test_dep_tampered_after_sealing_blocks_again(self) -> None:
        artifact = self._artifact("artifacts/one.json")
        self._task("t", ["artifacts/one.json"])
        seal(artifact)
        self.assertEqual([t["id"] for t in ready(self.root)[0]], ["t"])

        artifact.chmod(0o644)
        artifact.write_text("rewritten")
        tasks, blocked = ready(self.root)
        self.assertEqual(tasks, [], "a rewritten dependency must stop being ready")
        self.assertEqual(blocked["t"], ["artifacts/one.json"])

    def test_done_tasks_are_not_offered_again(self) -> None:
        self._task("t", [])
        self.assertEqual([t["id"] for t in ready(self.root)[0]], ["t"])
        done = self.root / "done"
        done.mkdir()
        (done / "t").touch()
        self.assertEqual(ready(self.root)[0], [])

    def test_no_deps_means_ready(self) -> None:
        self._task("t", [])
        self.assertEqual([t["id"] for t in ready(self.root)[0]], ["t"])

    def test_unreadable_queue_entry_is_skipped_not_fatal(self) -> None:
        queue = self.root / "queue"
        queue.mkdir()
        (queue / "broken.json").write_text("{not json")
        self._task("good", [])
        self.assertEqual([t["id"] for t in ready(self.root)[0]], ["good"])

    def test_missing_queue_dir_is_empty_not_an_error(self) -> None:
        self.assertEqual(ready(self.root), ([], {}))


if __name__ == "__main__":
    unittest.main()
