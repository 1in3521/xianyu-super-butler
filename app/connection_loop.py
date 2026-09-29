"""Run account operations on the event loop that owns their HTTP session."""

import asyncio


async def run_on_connection_loop(instance, coroutine):
    session = getattr(instance, "session", None)
    owner_loop = getattr(session, "_loop", None)
    if owner_loop is None or owner_loop is asyncio.get_running_loop():
        return await coroutine
    if not owner_loop.is_running():
        coroutine.close()
        raise RuntimeError("账号连接已停止，请重新启动账号")
    future = asyncio.run_coroutine_threadsafe(coroutine, owner_loop)
    return await asyncio.wrap_future(future)
