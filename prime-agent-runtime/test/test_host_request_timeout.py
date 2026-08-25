from __future__ import annotations

import asyncio
import importlib
import unittest
from unittest.mock import patch


rlm_module = importlib.import_module("rlm")


class _SilentComm:
    """A comm the host never answers — the case that used to hang the cell forever."""

    def __init__(self, *args, **kwargs) -> None:
        self._handler = None

    def on_msg(self, handler) -> None:
        self._handler = handler

    def open(self, data=None) -> None:
        pass

    def close(self) -> None:
        pass


class _AnsweringComm(_SilentComm):
    """A healthy host: replies on the next loop turn."""

    def open(self, data=None) -> None:
        asyncio.get_running_loop().call_soon(
            self._handler, {"content": {"data": {"status": "ok", "subagents": []}}}
        )


class HostRequestTimeoutTest(unittest.IsolatedAsyncioTestCase):
    async def test_times_out_instead_of_hanging_when_the_host_never_replies(self) -> None:
        # The host can fail to reply at all: sending the comm reply throws when the kernel
        # channel is not connected, and the error-reply fallback throws for the same reason.
        # Unbounded, that hangs the cell forever and the kernel reads as dead.
        with (
            patch.object(rlm_module, "Comm", _SilentComm),
            patch.object(rlm_module, "_install_control_comm_handlers", lambda: None),
        ):
            with self.assertRaises(TimeoutError) as caught:
                await rlm_module.host_request("rlm.list_subagents", timeout=0.05)

        self.assertIn("rlm.list_subagents", str(caught.exception))

    async def test_timeout_none_reproduces_the_old_unbounded_wait(self) -> None:
        # Pins the behaviour the default now prevents: with no bound the call never returns,
        # so the only way to observe it is to impose a bound from outside.
        with (
            patch.object(rlm_module, "Comm", _SilentComm),
            patch.object(rlm_module, "_install_control_comm_handlers", lambda: None),
        ):
            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(
                    rlm_module.host_request("rlm.list_subagents", timeout=None), 0.05
                )

    async def test_still_returns_the_reply_when_the_host_answers(self) -> None:
        with (
            patch.object(rlm_module, "Comm", _AnsweringComm),
            patch.object(rlm_module, "_install_control_comm_handlers", lambda: None),
        ):
            reply = await rlm_module.host_request("rlm.list_subagents", timeout=5)

        self.assertEqual(reply, {"subagents": []})


if __name__ == "__main__":
    unittest.main()
