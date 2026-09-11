#!/usr/bin/env python3
"""Unlock, Home, queue one 4-slide draft, and print job progress."""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from uuid import uuid4

UDID = "00008020-000819CA2203002E"
BASE = "http://127.0.0.1:3000"
ORIGIN = "http://127.0.0.1:3000"
ROOT = Path("/Users/nuzairnuwais/Developer/GitHub/prod-FARM-IOS-Core/generatedPosts/2026-09-09/post_001")
SHOTS = ROOT / "debug" / "try2"
SKIP = (
    "INFO webdriver", "[POST]", "[DELETE]", "[GET]", "DATA {",
    "pointerMove", "pointerDown", "pointerUp", "element-6066",
    "ELEMENT:", "stacktrace:", "NoSuchElementError", "at XCUITest",
    "at process", "at async", "using:",
)


def interesting(logs: list[str]) -> list[str]:
    kept: list[str] = []
    for x in logs or []:
        s = x.strip()
        if not s or any(bit in x for bit in SKIP):
            continue
        if s.startswith(("{", "}", "actions:", "type:", "id:", "parameters:", "]", "script:", "args:",
                          "url:", "duration:", "x:", "y:", "button:", "error:", "message:", "'element", "value:")):
            continue
        kept.append(s)
    return kept


def req(path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: int = 30):
    h = {"Origin": ORIGIN, **(headers or {})}
    request = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=h)
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        return json.loads(resp.read())


def action(kind: str) -> None:
    body = json.dumps({"type": kind}).encode()
    try:
        print("action", kind, req(f"/api/devices/{UDID}/remote/action", "POST", body, {"Content-Type": "application/json"}))
    except Exception as err:  # noqa: BLE001
        print("action failed", kind, err)


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
    return req(
        f"/api/devices/{UDID}/posts",
        "POST",
        b"".join(parts),
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=60,
    )


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    before = req(f"/api/devices/{UDID}/posts/current")
    print("before", before.get("id"), before.get("status"), flush=True)
    action("unlock")
    time.sleep(1)
    action("home")
    time.sleep(1)
    queued = queue_draft()
    print("queued", queued.get("id"), queued.get("status"), flush=True)

    deadline = time.time() + 360
    last = None
    while time.time() < deadline:
        cur = req(f"/api/devices/{UDID}/posts/current")
        if cur.get("id") == before.get("id"):
            time.sleep(2)
            continue
        status = str(cur.get("status") or "")
        lines = interesting(cur.get("logs") or [])
        tail = tuple(lines[-6:])
        if (status, tail) != last:
            print(f"  {str(cur.get('id', ''))[:8]} {status}: {lines[-1] if lines else ''}", flush=True)
            shots = sorted(p.name for p in SHOTS.glob("*.png"))
            if shots:
                print("  shots", shots[-10:], flush=True)
            last = (status, tail)
        if status.lower() in {"succeeded", "success", "failed", "cancelled", "canceled"}:
            print("DONE", status, cur.get("error"), flush=True)
            for line in lines[-15:]:
                print("   ", line)
            if status.lower() not in {"succeeded", "success"}:
                raise SystemExit(1)
            return
        time.sleep(4)
    print("TIMEOUT", flush=True)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
