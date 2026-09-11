#!/usr/bin/env python3
"""Queue the 4-slide draft and screenshot Nu Work whenever the farm log advances."""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

UDID = "00008020-000819CA2203002E"
BASE = "http://127.0.0.1:3000"
ORIGIN = "http://127.0.0.1:3000"
ROOT = Path("/Users/nuzairnuwais/Developer/GitHub/prod-FARM-IOS-Core/generatedPosts/2026-09-09/post_001")
OUT = ROOT / "debug" / "run4"
SKIP = (
    "INFO webdriver",
    "[POST]",
    "[DELETE]",
    "[GET]",
    "DATA {",
    "pointerMove",
    "pointerDown",
    "pointerUp",
    "element-6066",
    "ELEMENT:",
    "stacktrace:",
    "NoSuchElementError",
    "at XCUITest",
    "at process",
    "at async",
    "using:",
)


def interesting(lines: list[str]) -> list[str]:
    kept: list[str] = []
    for x in lines:
        s = x.strip()
        if not s:
            continue
        if any(bit in x for bit in SKIP):
            continue
        if s.startswith(
            (
                "{",
                "}",
                "actions:",
                "type:",
                "id:",
                "parameters:",
                "]",
                "script:",
                "args:",
                "url:",
                "duration:",
                "x:",
                "y:",
                "button:",
                "error:",
                "message:",
                "'element",
                "value:",
            )
        ):
            continue
        kept.append(s)
    return kept


def slug(text: str) -> str:
    text = re.sub(r"[^A-Za-z0-9]+", "-", text)[:70].strip("-")
    return text or "log"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"Origin": ORIGIN})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def screenshot(name: str) -> bool:
    try:
        data = get(f"{BASE}/api/devices/{UDID}/remote/screenshot")
    except Exception as err:  # noqa: BLE001
        print(f"shot skipped ({name}): {err}", flush=True)
        return False
    path = OUT / name
    path.write_bytes(data)
    print(f"shot {path.name} ({len(data)} bytes)", flush=True)
    return True


def current() -> dict:
    return json.loads(get(f"{BASE}/api/devices/{UDID}/posts/current"))


def queue_draft() -> dict:
    boundary = f"----farm-{uuid4().hex}"
    parts: list[bytes] = []

    def field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
        )

    def file_field(path: Path) -> None:
        body = path.read_bytes()
        header = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="media"; filename="{path.name}"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode()
        parts.append(header + body + b"\r\n")

    field("destination", "draft")
    field("account", "@pixl.robotics")
    field("musicUrl", "https://www.tiktok.com/music/som-original-7649903858499734279")
    field("timing", '{"kind":"now"}')
    field("caption", (ROOT / "caption.txt").read_text())
    for name in ("slide-1.jpg", "slide-2.jpg", "slide-3.jpg", "slide-4.jpg"):
        file_field(ROOT / name)
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    req = urllib.request.Request(
        f"{BASE}/api/devices/{UDID}/posts",
        data=body,
        method="POST",
        headers={
            "Origin": ORIGIN,
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as err:
        detail = err.read().decode("utf-8", "replace")
        raise SystemExit(f"POST failed {err.code}: {detail}") from err


def main() -> None:
    import sys

    OUT.mkdir(parents=True, exist_ok=True)
    watch_only = "--watch" in sys.argv
    if watch_only:
        print("watch-only; not queueing a new draft", flush=True)
    else:
        screenshot("00-before.png")
        queued = queue_draft()
        (OUT / "queued.json").write_text(json.dumps(queued, indent=2))
        print("queued", queued.get("id") or queued, flush=True)

    last = ""
    n = 10 if watch_only else 1
    last_shot = time.time()
    deadline = time.time() + 8 * 60
    terminal = {"succeeded", "success", "failed", "cancelled", "canceled"}
    while time.time() < deadline:
        try:
            data = current()
        except Exception as err:  # noqa: BLE001
            print("poll error", err, flush=True)
            time.sleep(2)
            continue
        status = str(data.get("status") or "")
        logs = interesting(data.get("logs") or [])
        line = logs[-1] if logs else status or "queued"
        now = time.time()
        if line != last or (now - last_shot) >= 20:
            safe = slug(line)
            if screenshot(f"{n:02d}-{status or 'queued'}-{safe}.png"):
                last_shot = now
                n += 1
            (OUT / "logs.txt").write_text("\n".join(logs) + "\n")
            print(f"{status}: {line}", flush=True)
            last = line
        if status.lower() in terminal:
            screenshot(f"99-final-{status}.png")
            print("done", status, data.get("error"), data.get("exitCode"), flush=True)
            return
        time.sleep(1.5)
    screenshot("99-timeout.png")
    print("timeout", flush=True)


if __name__ == "__main__":
    main()
