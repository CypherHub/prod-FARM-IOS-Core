#!/usr/bin/env python3
"""Save drafts on @my_sane_tea for post_002 … post_006."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.request
from pathlib import Path

UDID = "00008020-000819CA2203002E"
BASE = "http://127.0.0.1:3000"
ORIGIN = "http://127.0.0.1:3000"
REPO = Path("/Users/nuzairnuwais/Developer/GitHub/prod-FARM-IOS-Core")
POSTS = ["post_002", "post_003", "post_004", "post_005", "post_006"]


def farm(path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, timeout: int = 20):
    h = {"Origin": ORIGIN, **(headers or {})}
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read())


def wait_idle(timeout: int = 300) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        cur = farm(f"/api/devices/{UDID}/posts/current")
        status = str(cur.get("status") or "")
        print(f"current {cur.get('id')} {status}", flush=True)
        if status.lower() not in {"running", "queued", "active"}:
            return
        time.sleep(5)
    raise SystemExit("device still busy")


def action(kind: str) -> None:
    body = json.dumps({"type": kind}).encode()
    try:
        print("action", kind, farm(f"/api/devices/{UDID}/remote/action", "POST", body, {"Content-Type": "application/json"}))
    except Exception as err:  # noqa: BLE001
        print("action failed", kind, err)


def write_manifest(name: str) -> Path:
    root = REPO / "generatedPosts" / "2026-09-09" / name
    out = root / "debug"
    out.mkdir(parents=True, exist_ok=True)
    manifest = {
        "device": {"udid": UDID, "name": "Nu Work"},
        "files": [
            {"path": str(root / f"slide-{i}.jpg"), "name": f"slide-{i}.jpg", "mimeType": "image/jpeg"}
            for i in range(1, 5)
        ],
        "destination": "draft",
        "account": "@my_sane_tea",
        "caption": (root / "caption.txt").read_text(),
        "musicUrl": (root / "music.txt").read_text().strip(),
    }
    path = out / "manifest.json"
    path.write_text(json.dumps(manifest, indent=2))
    return path


def run_post(name: str) -> int:
    root = REPO / "generatedPosts" / "2026-09-09" / name
    manifest = write_manifest(name)
    shots = root / "debug"
    env = {
        **dict(**{k: v for k, v in __import__("os").environ.items()}),
        "DEBUG_SHOT_DIR": str(shots),
        "WDA_URL": "http://127.0.0.1:8100",
    }
    print(f"=== {name} ===", flush=True)
    action("unlock")
    time.sleep(1)
    action("home")
    time.sleep(2)
    result = subprocess.run(
        ["node", "--env-file-if-exists=.env", "--import", "tsx", "src/tiktok/post.ts", str(manifest)],
        cwd=REPO,
        env=env,
    )
    print(f"{name} exit {result.returncode}", flush=True)
    return result.returncode


def main() -> None:
    wait_idle()
    failed: list[str] = []
    for name in POSTS:
        wait_idle(120)
        code = run_post(name)
        if code != 0:
            failed.append(name)
        time.sleep(3)
    if failed:
        raise SystemExit(f"failed: {', '.join(failed)}")
    print("all drafts saved", flush=True)


if __name__ == "__main__":
    main()
