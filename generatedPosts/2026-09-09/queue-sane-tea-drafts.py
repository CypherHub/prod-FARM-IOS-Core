#!/usr/bin/env python3
"""Queue 4-slide TikTok drafts for @my_sane_tea on Nu Work."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

UDID = "00008020-000819CA2203002E"
BASE = "http://127.0.0.1:3000"
ORIGIN = "http://127.0.0.1:3000"
ACCOUNT = "@my_sane_tea"
DAY = Path("/Users/nuzairnuwais/Developer/GitHub/prod-FARM-IOS-Core/generatedPosts/2026-09-09")
POSTS = [f"post_{n:03d}" for n in range(2, 7)]
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
        req(f"/api/devices/{UDID}/remote/action", "POST", body, {"Content-Type": "application/json"})
        print(f"action {kind}", flush=True)
    except Exception as err:  # noqa: BLE001
        print(f"action failed {kind}: {err}", flush=True)


def queue_draft(root: Path) -> dict:
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
    field("account", ACCOUNT)
    field("musicUrl", (root / "music.txt").read_text().strip())
    field("timing", '{"kind":"now"}')
    field("caption", (root / "caption.txt").read_text())
    for name in ("slide-1.jpg", "slide-2.jpg", "slide-3.jpg", "slide-4.jpg"):
        file_field(root / name)
    parts.append(f"--{boundary}--\r\n".encode())
    return req(
        f"/api/devices/{UDID}/posts",
        "POST",
        b"".join(parts),
        {"Content-Type": f"multipart/form-data; boundary={boundary}"},
        timeout=120,
    )


def wait_job(before_id: str | None, timeout: int = 420) -> tuple[str, list[str], str | None]:
    deadline = time.time() + timeout
    last = None
    status = ""
    lines: list[str] = []
    error = None
    while time.time() < deadline:
        cur = req(f"/api/devices/{UDID}/posts/current")
        cur_id = str(cur.get("id") or "")
        if before_id and cur_id == before_id:
            time.sleep(2)
            continue
        status = str(cur.get("status") or "")
        error = cur.get("error")
        lines = interesting(cur.get("logs") or [])
        tail = tuple(lines[-4:])
        if (status, tail) != last:
            print(f"  {cur_id[:8]} {status}: {lines[-1] if lines else ''}", flush=True)
            last = (status, tail)
        if status.lower() in {"succeeded", "success", "failed", "cancelled", "canceled"}:
            return status, lines, error
        time.sleep(4)
    return "timeout", lines, error


def main() -> None:
    successes: list[str] = []
    failures: list[str] = []
    for post_id in POSTS:
        root = DAY / post_id
        print(f"\n===== {post_id} -> {ACCOUNT} =====", flush=True)
        before = req(f"/api/devices/{UDID}/posts/current")
        before_id = str(before.get("id") or "")
        action("unlock")
        time.sleep(1)
        action("home")
        time.sleep(1)
        try:
            queued = queue_draft(root)
        except urllib.error.HTTPError as err:
            print(f"queue failed {post_id}: {err.code} {err.read().decode()[:400]}", flush=True)
            failures.append(post_id)
            continue
        print(f"queued {post_id} schedule={queued.get('id')}", flush=True)
        status, lines, error = wait_job(before_id)
        saved = any("TikTok draft saved" in line for line in lines)
        if saved or status.lower() in {"succeeded", "success"}:
            exec_id = req(f"/api/devices/{UDID}/posts/current").get("id")
            successes.append(post_id)
            print(f"SUCCESS {post_id} exec={exec_id}", flush=True)
        else:
            failures.append(post_id)
            print(f"FAIL {post_id} status={status} error={error}", flush=True)
            for line in lines[-10:]:
                print(f"   {line}", flush=True)
        time.sleep(3)

    print("\nDONE", flush=True)
    print("successes:", successes, flush=True)
    print("failures:", failures, flush=True)
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
