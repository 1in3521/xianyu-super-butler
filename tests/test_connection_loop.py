import asyncio
import threading
import unittest
from types import SimpleNamespace

from app.connection_loop import run_on_connection_loop


class ConnectionLoopTests(unittest.TestCase):
    def test_account_operation_runs_on_the_session_owner_loop(self):
        owner_loop = asyncio.new_event_loop()
        thread = threading.Thread(target=owner_loop.run_forever, daemon=True)
        thread.start()
        instance = SimpleNamespace(session=SimpleNamespace(_loop=owner_loop))

        async def current_loop():
            return asyncio.get_running_loop()

        try:
            self.assertIs(
                asyncio.run(run_on_connection_loop(instance, current_loop())),
                owner_loop,
            )
        finally:
            owner_loop.call_soon_threadsafe(owner_loop.stop)
            thread.join(timeout=5)
            owner_loop.close()

    def test_same_loop_operation_runs_directly(self):
        async def check():
            loop = asyncio.get_running_loop()
            instance = SimpleNamespace(session=SimpleNamespace(_loop=loop))
            return await run_on_connection_loop(instance, asyncio.sleep(0, result=loop))

        self.assertIsInstance(asyncio.run(check()), asyncio.AbstractEventLoop)

    def test_stopped_account_loop_rejects_operation(self):
        owner_loop = asyncio.new_event_loop()
        instance = SimpleNamespace(session=SimpleNamespace(_loop=owner_loop))
        coroutine = asyncio.sleep(0)
        try:
            with self.assertRaisesRegex(RuntimeError, "账号连接已停止"):
                asyncio.run(run_on_connection_loop(instance, coroutine))
        finally:
            owner_loop.close()


if __name__ == "__main__":
    unittest.main()
