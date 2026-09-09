#!/usr/bin/env python3
"""Wait for WDA, then keep queueing 4-slide drafts until several succeed."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from uuid import uuid4

UDID = "00008020-000819CA2203002E"
BASE = "http://127.0.0.1:3000"
ORIGIN = "http://127.0.0.1:3000"
ROOT = Path("/Users/nuzairnuwais/Developer/GitHub/prod-FARM-IOS-Core/generatedPosts/2026-09-09/post")
SHOTS = ROOT / "debug" / "run7"
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


def curl_wda() -> str:
    result = subprocess.run(
        ["curl", "-sS", "-m", "5", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:8100/status"],
        capture_output=True, text=True,
    )
    return (result.stdout or "000").strip()


def connection() -> dict:
    req = urllib.request.Request(f"{BASE}/api/devices/{UDID}/connection", headers={"Origin": ORIGIN})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def action(kind: str) -> None:
    body = json.dumps({"type": kind}).encode()
    req = urllib.request.Request(
        f"{BASE}/api/devices/{UDID}/remote/action",
        data=body, method="POST",
        headers={"Origin": ORIGIN, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            print("action", kind, resp.read().decode(), flush=True)
    except Exception as err:  # noqa: BLE001
        print("action failed", kind, err, flush=True)


def wait_wda(timeout: int = 600) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        code = curl_wda()
        try:
            phase = connection().get("wda")
        except Exception:
            phase = "?"
        print(f"wda http={code} phase={phase}", flush=True)
        if code == "200":
            return True
        time.sleep(5)
    return False


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
    req = urllib.request.Request(
        f"{BASE}/api/devices/{UDID}/posts",
        data=b"".join(parts), method="POST",
        headers={"Origin": ORIGIN, "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def wait_job(timeout: int = 240) -> tuple[str, list[str], str | None]:
    deadline = time.time() + timeout
    last = None
    status = ""
    lines: list[str] = []
    error = None
    while time.time() < deadline:
        cur = json.loads(urllib.request.urlopen(f"{BASE}/api/devices/{UDID}/posts/current", timeout=30).read())
        status = str(cur.get("status") or "")
        error = cur.get("error")
        lines = interesting(cur.get("logs") or [])
        tail = tuple(lines[-5:])
        if (status, tail) != last:
            print(f"  {status}: {lines[-1] if lines else ''}", flush=True)
            shots = sorted(SHOTS.glob("*.png"))
            if shots:
                print("  shots", [p.name for p in shots[-8:]], flush=True)
            last = (status, tail)
        if status.lower() in {"succeeded", "success", "failed", "cancelled", "canceled"}:
            return status, lines, error
        time.sleep(4)
    return "timeout", lines, error


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    successes: list[str] = []
    failures = 0
    target = 3
    overall = time.time() + 12 * 60
    while len(successes) < target and failures < 8 and time.time() < overall:
        print(f"\n===== drafting successes={len(successes)} failures={failures} =====", flush=True)
        if not wait_wda(timeout=120):
            print("still waiting for WDA", flush=True)
            continue
        action("unlock")
        time.sleep(1)
        try:
            queued = queue_draft()
        except urllib.error.HTTPError as err:
            print("queue failed", err.code, err.read().decode()[:400], flush=True)
            failures += 1
            time.sleep(8)
            continue
        print("queued", queued.get("id"), flush=True)
        status, lines, error = wait_job()
        saved = any("TikTok draft saved" in line for line in lines)
        if saved or status.lower() in {"succeeded", "success"}:
            exec_id = json.loads(urllib.request.urlopen(f"{BASE}/api/devices/{UDID}/posts/current").read()).get("id")
            successes.append(str(exec_id))
            print("SUCCESS", exec_id, flush=True)
        else:
            failures += 1
            print("FAIL", status, error, flush=True)
            for line in lines[-10:]:
                print("   ", line, flush=True)
        time.sleep(4)
    print("DONE successes", successes, "failures", failures, flush=True)
    if len(successes) < 2:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
