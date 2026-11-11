#!/usr/bin/env python3
"""Extract audio from a Bilibili video link (yt-dlp + FFmpeg) into a TTL-managed
temporary directory.

The URL handling idea is adapted from BiliMusicDownloader (MIT,
https://github.com/c0sc0s/BiliMusicDownloader) whose ``extract.py`` wraps
yt-dlp + FFmpeg for the same purpose.  This version is headless and reuses the
``feiyu-voice-lite`` runtime on the Linux server.

Every extraction creates a task directory under ``<runtime>/tmp/bili`` with a
``task.json`` metadata file.  Files are kept until their TTL expires
(default 6 hours) or the store exceeds its byte/entry budget; ``cleanup`` (also
run automatically after each extraction and at the start of song2cute runs)
removes stale tasks safely.

Examples:
  ~/feiyu-voice-lite/bin/bili-audio extract "https://www.bilibili.com/video/BV1xx411c7mD" --json
  ~/feiyu-voice-lite/bin/bili-audio cleanup --json
  ~/feiyu-voice-lite/bin/bili-audio list
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

from temp_store import TempStore

RUNTIME = Path(
    os.environ.get("BILI_RUNTIME_HOME")
    or os.environ.get("SONG2CUTE_HOME")
    or (Path.home() / "feiyu-voice-lite")
).expanduser().resolve()

MEDIA_FORMATS = ("wav", "mp3", "m4a")
DEFAULT_TTL_HOURS = float(os.environ.get("BILI_TEMP_TTL_HOURS", "6") or 6)
DEFAULT_MAX_GB = float(os.environ.get("BILI_TEMP_MAX_GB", "8") or 8)
DEFAULT_MAX_ENTRIES = int(os.environ.get("BILI_TEMP_MAX_ENTRIES", "200") or 200)

MIB = 1024 * 1024

_LONG_URL_RE = re.compile(
    r"https?://(?:www\.|m\.)?bilibili\.com/video/(?:BV[0-9A-Za-z]+|av\d+)",
    re.IGNORECASE,
)
_SHORT_URL_RE = re.compile(r"https?://b23\.tv/[0-9A-Za-z]+", re.IGNORECASE)


def log(*args) -> None:
    print(*args, flush=True)


def find_bilibili_url(text: str) -> str | None:
    """Return the first Bilibili video URL found in ``text`` (or None)."""
    if not text:
        return None
    text = str(text).strip()
    for pattern in (_LONG_URL_RE, _SHORT_URL_RE):
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None


def is_bilibili_url(text: str) -> bool:
    return find_bilibili_url(text) is not None


def default_temp_root() -> Path:
    override = os.environ.get("BILI_TEMP_DIR")
    if override:
        return Path(override).expanduser().resolve()
    return RUNTIME / "tmp" / "bili"


def get_store(
    *,
    root: Path | str | None = None,
    ttl_hours: float | None = None,
    max_gb: float | None = None,
    max_entries: int | None = None,
) -> TempStore:
    hours = DEFAULT_TTL_HOURS if ttl_hours is None else float(ttl_hours)
    gb = DEFAULT_MAX_GB if max_gb is None else float(max_gb)
    entries = DEFAULT_MAX_ENTRIES if max_entries is None else int(max_entries)
    return TempStore(
        root or default_temp_root(),
        default_ttl_seconds=max(0, int(hours * 3600)),
        max_bytes=max(0, int(gb * 1024**3)),
        max_entries=max(1, entries),
    )


def resolve_ffmpeg() -> str | None:
    """Locate FFmpeg: env override, bundled runtime bin, then PATH."""
    candidates: list[Path] = []
    for env_name in ("FFMPEG_PATH", "BILI_FFMPEG"):
        value = os.environ.get(env_name)
        if value:
            candidates.append(Path(value).expanduser())
    candidates.append(RUNTIME / "bin" / "ffmpeg")
    found = shutil.which("ffmpeg")
    if found:
        candidates.append(Path(found))
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            result = subprocess.run(
                [str(candidate), "-version"],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if result.returncode == 0 and "ffmpeg version" in (result.stdout or ""):
                return str(candidate)
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def _load_ytdlp():
    try:
        import yt_dlp  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on runtime env
        raise RuntimeError(
            "yt-dlp is not installed in this Python environment. "
            "Install it with: uv pip install yt-dlp"
        ) from exc
    return yt_dlp


def _convert(ffmpeg: str, source: Path, target: Path, fmt: str) -> None:
    cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn"]
    if fmt == "wav":
        cmd += ["-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"]
    elif fmt == "mp3":
        cmd += ["-c:a", "libmp3lame", "-b:a", "192k"]
    elif fmt == "m4a":
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    else:  # pragma: no cover - guarded by argparse choices
        raise ValueError(f"unsupported format: {fmt}")
    cmd.append(str(target))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0 or not target.is_file():
        raise RuntimeError(
            f"ffmpeg conversion failed (rc={result.returncode}): "
            f"{(result.stderr or '').strip()[-800:]}"
        )


def _pick_source(task_dir: Path) -> Path:
    candidates = [
        p
        for p in sorted(task_dir.glob("source.*"))
        if p.is_file() and p.suffix.lower() in (".m4a", ".mp3", ".aac", ".opus", ".ogg", ".webm", ".flac", ".wav")
    ]
    if not candidates:
        raise RuntimeError(f"yt-dlp did not produce an audio file under {task_dir}")
    return candidates[0]


def info(url: str) -> dict:
    """Return title/duration/id without downloading."""
    clean = find_bilibili_url(url)
    if not clean:
        raise ValueError(f"not a Bilibili video URL: {url!r}")
    yt_dlp = _load_ytdlp()
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        data = ydl.extract_info(clean, download=False)
    return {
        "ok": True,
        "url": clean,
        "bvid": data.get("id"),
        "title": data.get("title"),
        "durationSeconds": data.get("duration"),
        "uploader": data.get("uploader"),
    }


def extract(
    url: str,
    *,
    fmt: str = "wav",
    ttl_hours: float | None = None,
    root: Path | str | None = None,
    keep_raw: bool = False,
    dry_run: bool = False,
) -> dict:
    """Download the best audio stream and convert it to ``fmt``.

    The result is stored in a fresh TTL-managed task directory.  The directory
    name is opaque; use the returned ``audioPath``.
    """
    if fmt not in MEDIA_FORMATS:
        raise ValueError(f"unsupported format: {fmt!r}")
    clean = find_bilibili_url(url)
    if not clean:
        raise ValueError(f"not a Bilibili video URL: {url!r}")
    yt_dlp = _load_ytdlp()
    ffmpeg = resolve_ffmpeg()
    store = get_store(root=root, ttl_hours=ttl_hours)
    task_id, task_dir, _meta = store.create_task(label=clean)
    started = time.time()
    try:
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": str(task_dir / "source.%(ext)s"),
            "noplaylist": True,
            "restrictfilenames": True,
            "quiet": True,
            "no_warnings": True,
            "noprogress": True,
            "retries": 1,
            "fragment_retries": 1,
            "socket_timeout": 30,
            # B 站对部分视频的 CDN 返回 567：带上来源页与桌面 UA 可显著降低风控概率。
            "referer": "https://www.bilibili.com/",
            "http_headers": {
                "Referer": "https://www.bilibili.com/",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            },
        }
        if ffmpeg:
            ydl_opts["ffmpeg_location"] = ffmpeg
        if dry_run:
            data = yt_dlp.YoutubeDL(ydl_opts).extract_info(clean, download=False)
            store.mark_failed(task_id, "dry-run")
            store.remove_task(task_id)
            return {
                "ok": True,
                "dryRun": True,
                "url": clean,
                "bvid": data.get("id"),
                "title": data.get("title"),
                "durationSeconds": data.get("duration"),
            }
        # B 站 CDN 会对部分请求随机返回 HTTP 567（与请求头无关，换一次 playurl 常常就好）。
        # yt-dlp 内部重试会沿用同一个 CDN 地址，因此这里整轮重试，让它重新解析 playurl。
        data = None
        last_error = None
        for attempt in range(1, 5):
            try:
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    data = ydl.extract_info(clean, download=True)
                last_error = None
                break
            except Exception as error:  # noqa: BLE001 - 交给上层按最终结果报错
                last_error = error
                for stale in task_dir.glob("source*"):
                    try:
                        stale.unlink()
                    except OSError:
                        pass
                if attempt < 4:
                    time.sleep(min(2 * attempt, 8))
        if last_error is not None or data is None:
            raise last_error or RuntimeError("Bilibili download failed")
        source = _pick_source(task_dir)
        target = task_dir / f"audio.{fmt}"
        src_suffix = source.suffix.lower().lstrip(".")
        if src_suffix == fmt:
            os.replace(source, target)
        elif ffmpeg:
            _convert(ffmpeg, source, target, fmt)
            if not keep_raw:
                source.unlink(missing_ok=True)
        else:
            raise RuntimeError(
                f"ffmpeg is required to convert {src_suffix} -> {fmt}. "
                f"Install a static build at {RUNTIME / 'bin' / 'ffmpeg'} or set FFMPEG_PATH."
            )
        bytes_ = target.stat().st_size
        files = [{"path": target.name, "bytes": bytes_, "role": "audio"}]
        extra = {
            "url": clean,
            "bvid": data.get("id"),
            "title": data.get("title"),
            "durationSeconds": data.get("duration"),
            "uploader": data.get("uploader"),
            "format": fmt,
        }
        meta = store.mark_ready(task_id, files, extra=extra, pin=False)
        cleanup = store.cleanup()
        expires_at = int(meta["createdAt"] + int(meta.get("ttlSeconds") or 0))
        return {
            "ok": True,
            "taskId": task_id,
            "dir": str(task_dir),
            "audioPath": str(target),
            "format": fmt,
            "bytes": bytes_,
            "title": data.get("title"),
            "bvid": data.get("id"),
            "url": clean,
            "durationSeconds": data.get("duration"),
            "elapsedSeconds": round(time.time() - started, 2),
            "expiresAt": expires_at,
            "cleanup": cleanup,
        }
    except Exception as exc:
        store.mark_failed(task_id, f"{type(exc).__name__}: {exc}")
        # Failed task directories stay until TTL so the error can be inspected,
        # but an explicit cleanup right now keeps disk usage predictable.
        try:
            store.cleanup()
        except Exception:
            pass
        raise


def cleanup(*, root: Path | str | None = None, ttl_hours: float | None = None) -> dict:
    store = get_store(root=root, ttl_hours=ttl_hours)
    return store.cleanup()


def list_tasks(*, root: Path | str | None = None) -> list[dict]:
    store = get_store(root=root)
    out = []
    for meta in store.list_tasks():
        out.append(
            {
                "taskId": meta.get("taskId"),
                "status": meta.get("status"),
                "label": meta.get("label"),
                "pinned": bool(meta.get("pinned")),
                "createdAt": meta.get("createdAt"),
                "lastAccessAt": meta.get("lastAccessAt"),
                "ttlSeconds": meta.get("ttlSeconds"),
                "totalBytes": meta.get("totalBytes"),
                "files": [f.get("path") for f in (meta.get("files") or [])],
                "title": (meta.get("extra") or {}).get("title"),
                "error": meta.get("error"),
            }
        )
    return out


def _print_json(value) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Extract audio from Bilibili videos with TTL-managed temporary storage."
    )
    ap.add_argument("--version", action="version", version="bili-audio 0.1.0")
    sub = ap.add_subparsers(dest="command")

    p_extract = sub.add_parser("extract", help="download + convert one video")
    p_extract.add_argument("url", help="Bilibili video URL (BV/av/b23.tv)")
    p_extract.add_argument("--format", choices=MEDIA_FORMATS, default="wav")
    p_extract.add_argument("--ttl-hours", type=float, default=None)
    p_extract.add_argument("--root", default=None, help="temporary store root")
    p_extract.add_argument("--keep-raw", action="store_true", help="keep the original download")
    p_extract.add_argument("--dry-run", action="store_true", help="resolve metadata only")
    p_extract.add_argument("--json", action="store_true")

    p_cleanup = sub.add_parser("cleanup", help="remove expired tasks and enforce the store budget")
    p_cleanup.add_argument("--ttl-hours", type=float, default=None)
    p_cleanup.add_argument("--root", default=None)
    p_cleanup.add_argument("--json", action="store_true")

    p_list = sub.add_parser("list", help="list temporary tasks")
    p_list.add_argument("--root", default=None)
    p_list.add_argument("--json", action="store_true")

    p_info = sub.add_parser("info", help="resolve video metadata without downloading")
    p_info.add_argument("url")
    p_info.add_argument("--json", action="store_true")

    args = ap.parse_args(argv)
    if not getattr(args, "command", None):
        ap.print_help()
        return 2

    try:
        if args.command == "extract":
            result = extract(
                args.url,
                fmt=args.format,
                ttl_hours=args.ttl_hours,
                root=args.root,
                keep_raw=args.keep_raw,
                dry_run=args.dry_run,
            )
            if args.json:
                _print_json(result)
            else:
                print(f"task: {result['taskId']}")
                print(f"title: {result.get('title')}")
                print(f"audio: {result['audioPath']} ({result.get('bytes', 0) / MIB:.1f} MiB)")
                if result.get("expiresAt"):
                    print(f"expires: {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(result['expiresAt']))}")
            return 0
        if args.command == "cleanup":
            result = cleanup(root=args.root, ttl_hours=args.ttl_hours)
            if args.json:
                _print_json(result)
            else:
                print(
                    f"removed={result['removed']} freed={result['freedBytes'] / MIB:.1f} MiB "
                    f"kept={result['kept']} total={result['totalBytes'] / MIB:.1f} MiB"
                )
            return 0
        if args.command == "list":
            tasks = list_tasks(root=args.root)
            if args.json:
                _print_json(tasks)
            else:
                for meta in tasks:
                    size = (meta.get("totalBytes") or 0) / MIB
                    print(
                        f"{meta['taskId']}  {meta.get('status')}  {size:8.1f} MiB  "
                        f"{meta.get('title') or meta.get('label') or ''}"
                    )
                if not tasks:
                    print("(empty)")
            return 0
        if args.command == "info":
            result = info(args.url)
            if args.json:
                _print_json(result)
            else:
                print(f"title: {result.get('title')}")
                print(f"bvid: {result.get('bvid')}")
                print(f"duration: {result.get('durationSeconds')}s")
            return 0
    except Exception as exc:
        if getattr(args, "json", False):
            _print_json({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        else:
            print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
