#!/usr/bin/env python3
"""TTL-based temporary store for large media files.

A "task" is one directory under ``root`` with a ``task.json`` metadata file.
Tasks are created before a download/inference starts, marked ready when the
artifacts are written, and removed by :meth:`cleanup` when their TTL expires or
the store exceeds its byte/entry budget.  Pinned tasks are never removed by the
automatic cleanup (they are being used by an interactive request).
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import time
from pathlib import Path

META_NAME = "task.json"
META_VERSION = 1


def _now() -> float:
    return time.time()


def _atomic_write(path: Path, data: dict) -> None:
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def _dir_bytes(path: Path) -> int:
    total = 0
    for child in path.rglob("*"):
        try:
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
        except OSError:
            continue
    return total


class TempStore:
    """Manage TTL-bound task directories under a single root."""

    def __init__(
        self,
        root: Path | str,
        *,
        default_ttl_seconds: int = 6 * 3600,
        max_bytes: int = 8 * 1024**3,
        max_entries: int = 200,
    ) -> None:
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.root, 0o700)
        except OSError:
            pass
        self.default_ttl_seconds = int(default_ttl_seconds)
        self.max_bytes = int(max_bytes)
        self.max_entries = int(max_entries)

    # ---- metadata -------------------------------------------------------
    def task_dir(self, task_id: str) -> Path:
        candidate = (self.root / task_id).resolve()
        if candidate.parent != self.root or not task_id or task_id.startswith("."):
            raise ValueError(f"invalid task id: {task_id!r}")
        return candidate

    def read_meta(self, task_id: str) -> dict | None:
        path = self.task_dir(task_id) / META_NAME
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def write_meta(self, task_id: str, meta: dict) -> None:
        meta["lastAccessAt"] = _now()
        _atomic_write(self.task_dir(task_id) / META_NAME, meta)

    # ---- task lifecycle -------------------------------------------------
    def create_task(self, label: str = "", *, ttl_seconds: int | None = None) -> tuple[str, Path, dict]:
        task_id = f"{int(_now())}-{secrets.token_hex(4)}"
        path = self.task_dir(task_id)
        path.mkdir(mode=0o700)
        now = _now()
        meta = {
            "version": META_VERSION,
            "taskId": task_id,
            "label": label[:200],
            "status": "active",
            "pinned": True,
            "createdAt": now,
            "lastAccessAt": now,
            "ttlSeconds": int(ttl_seconds or self.default_ttl_seconds),
            "files": [],
            "totalBytes": 0,
            "extra": {},
        }
        self.write_meta(task_id, meta)
        return task_id, path, meta

    def touch(self, task_id: str, *, pin: bool | None = None) -> dict | None:
        meta = self.read_meta(task_id)
        if meta is None:
            return None
        if pin is not None:
            meta["pinned"] = bool(pin)
        self.write_meta(task_id, meta)
        return meta

    def mark_ready(
        self,
        task_id: str,
        files: list[dict],
        *,
        extra: dict | None = None,
        pin: bool = False,
    ) -> dict:
        meta = self.read_meta(task_id) or {}
        meta.update(
            {
                "status": "ready",
                "pinned": bool(pin),
                "files": files,
                "totalBytes": sum(int(f.get("bytes") or 0) for f in files),
                "extra": extra or meta.get("extra") or {},
            }
        )
        self.write_meta(task_id, meta)
        return meta

    def mark_failed(self, task_id: str, error: str) -> None:
        meta = self.read_meta(task_id) or {"version": META_VERSION, "taskId": task_id}
        meta.update({"status": "failed", "pinned": False, "error": str(error)[:2000]})
        self.write_meta(task_id, meta)
        if self.read_meta(task_id) is None:
            return
        # A failed download stays for TTL so users can inspect logs; cleanup
        # removes it automatically.

    def remove_task(self, task_id: str) -> bool:
        path = self.task_dir(task_id)
        if not path.exists():
            return False
        shutil.rmtree(path, ignore_errors=True)
        return True

    # ---- inspection -----------------------------------------------------
    def list_tasks(self) -> list[dict]:
        tasks = []
        for child in self.root.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            meta = self.read_meta(child.name)
            if meta is None:
                # Orphan directory (crash before first write): treat as expired.
                meta = {"taskId": child.name, "status": "orphan", "createdAt": 0, "lastAccessAt": 0, "files": [], "totalBytes": 0}
            else:
                meta["totalBytes"] = int(meta.get("totalBytes") or _dir_bytes(child))
            meta["dir"] = str(child)
            tasks.append(meta)
        tasks.sort(key=lambda m: float(m.get("lastAccessAt") or 0))
        return tasks

    def total_bytes(self) -> int:
        return sum(int(m.get("totalBytes") or 0) for m in self.list_tasks())

    def cleanup(self, *, now: float | None = None) -> dict:
        """Remove expired tasks, then enforce the byte/entry budget (LRU)."""
        now = _now() if now is None else now
        removed, freed, errors = 0, 0, []
        tasks = self.list_tasks()

        def expired(meta: dict) -> bool:
            if meta.get("status") == "orphan":
                return True
            ttl = int(meta.get("ttlSeconds") or self.default_ttl_seconds)
            last = float(meta.get("lastAccessAt") or meta.get("createdAt") or 0)
            return (now - last) > ttl

        kept: list[dict] = []
        for meta in tasks:
            if meta.get("pinned"):
                kept.append(meta)
                continue
            if expired(meta):
                size = int(meta.get("totalBytes") or 0)
                try:
                    if self.remove_task(meta["taskId"]):
                        removed += 1
                        freed += size
                except Exception as exc:  # pragma: no cover - defensive
                    errors.append(f"{meta.get('taskId')}: {exc}")
            else:
                kept.append(meta)

        total = sum(int(m.get("totalBytes") or 0) for m in kept)
        # LRU eviction for budget (never pinned, never files that are still active).
        for meta in sorted(kept, key=lambda m: float(m.get("lastAccessAt") or 0)):
            if total <= self.max_bytes and len(kept) <= self.max_entries:
                break
            if meta.get("pinned"):
                continue
            size = int(meta.get("totalBytes") or 0)
            try:
                if self.remove_task(meta["taskId"]):
                    removed += 1
                    freed += size
                    total -= size
                    kept = [m for m in kept if m["taskId"] != meta["taskId"]]
            except Exception as exc:  # pragma: no cover
                errors.append(f"{meta.get('taskId')}: {exc}")

        return {
            "removed": removed,
            "freedBytes": freed,
            "kept": len(kept),
            "totalBytes": total,
            "errors": errors,
        }
