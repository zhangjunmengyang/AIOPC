"""Run a local Automation through the desktop's permission-limited launcher."""

import asyncio
import json
import os
import signal
from contextlib import suppress
from pathlib import Path

OUTPUT_LIMIT = 16000
RUNTIME_LIMIT = 600


async def run_local_routine(launcher: Path, project: Path, routine: dict, role_prompt: str) -> str:
    args = ["run", "--format", "json", f'--title={routine["name"]}']
    if model := routine["model"]:
        args.append(f'--model={model["providerId"]}/{model["modelId"]}')
        if model.get("variant"):
            args.append(f'--variant={model["variant"]}')
    prompt = routine["instructions"]
    if role_prompt:
        prompt = f"角色 {routine['agent']} 的工作说明：\n{role_prompt}\n\n本次例行任务：\n{prompt}"
    process = await asyncio.create_subprocess_exec(
        str(launcher), *args, cwd=project, stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={key: value for key, value in os.environ.items() if key not in {"AIOPC_TOKEN", "AIOPC_RUNTIME_CONTEXT_FILE"}},
        start_new_session=True,
    )
    result = ""
    error = None
    line = b""
    try:
        async with asyncio.timeout(RUNTIME_LIMIT):
            process.stdin.write(prompt.encode("utf-8"))
            await process.stdin.drain()
            process.stdin.close()
            while chunk := await process.stdout.read(65536):
                lines = (line + chunk).split(b"\n")
                # Keep just enough buffered text for even a large JSON line.
                line = lines.pop()[-1048576:]
                for raw in lines:
                    try:
                        event = json.loads(raw)
                    except (ValueError, UnicodeError):
                        continue
                    if not isinstance(event, dict):
                        continue
                    if event.get("type") == "text" and isinstance(part := event.get("part"), dict):
                        text = part.get("text")
                        if isinstance(text, str):
                            result = (result + ("\n" if result else "") + text)[:OUTPUT_LIMIT]
                    if event.get("type") == "error" and isinstance(details := event.get("error"), dict):
                        data = details.get("data")
                        error = data.get("message") if isinstance(data, dict) else None
                        if not isinstance(error, str) or not error.strip():
                            error = "模型返回运行错误"
            status = await process.wait()
    except BaseException:
        with suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()
        raise
    if error:
        raise ValueError(error[:2000])
    if status:
        raise ValueError(f"本地任务进程已退出（{status}）")
    return result
