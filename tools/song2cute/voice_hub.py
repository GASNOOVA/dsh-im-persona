#!/usr/bin/env python3
"""voice-hub: tiny LAN gateway for the IM bot's voice replies and song covers.

Two APIs are exposed on one port (default 9860), protected by a Bearer token:

1. feiyu-compatible TTS (so the dsh-im-persona plugin needs no provider change)
   POST /v1/speech {voice:"feiyu", text, style} -> 202 {id}
   GET  /v1/jobs/{id}                            -> {state, ...}
   GET  /v1/jobs/{id}/audio                      -> WAV bytes
   The hub proxies to the local GPT-SoVITS api_v2.py (port 9850) and serialises
   all GPU work in a single worker thread.

2. Song cover from a Bilibili link (uses tools/song2cute on this machine)
   POST /v1/cover {url, mix:false, name?, prompt?} -> 202 {id}
   GET  /v1/jobs/{id}                            -> {state, kind:"cover", ...}
   GET  /v1/jobs/{id}/audio                      -> MP3 bytes (default vocals)

Cover jobs run `song2cute.py` (Demucs + RVC).  They pause the GPT-SoVITS API to
free VRAM and restart it when done; the single-worker queue guarantees TTS and
cover jobs never compete for the 4 GB GPU.

Artifacts live in a TTL-managed temporary directory (temp_store.py), default
2 hours / 20 GiB, and are cleaned on startup and periodically.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.security.utils import get_authorization_scheme_param

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bili_audio  # noqa: E402
from temp_store import TempStore  # noqa: E402

LOG = logging.getLogger("voice-hub")
RUNTIME = Path(
    os.environ.get("VOICE_HUB_HOME")
    or os.environ.get("BILI_RUNTIME_HOME")
    or os.environ.get("SONG2CUTE_HOME")
    or (Path.home() / "feiyu-voice-lite")
).expanduser().resolve()

DEFAULT_CONFIG = {
    "version": 1,
    "host": "0.0.0.0",
    "port": 9860,
    "apiKeyFile": str(RUNTIME / "voice-hub-api-key"),
    "dataDir": str(RUNTIME / "tmp" / "voice-hub"),
    "ttlHours": 2,
    "maxGb": 20,
    "gptSovits": {
        "url": "http://127.0.0.1:9850",
        "refAudio": str(Path.home() / "gpt-sovits" / "ref-official-repeat.wav"),
        "promptText": "我已经准备好了，我们开始吧。我已经准备好了，我们开始吧。",
        "promptLang": "zh",
        "textLang": "zh",
        "speedFactor": 1.0,
        "timeoutSeconds": 300,
    },
    "cover": {
        "enabled": True,
        "maxDurationMinutes": 8,
        "maxPromptChars": 300,
        "timeoutSeconds": 1800,
    },
}

TERMINAL_STATES = {"success", "failed", "interrupted"}
MAX_TTS_CHARS = 1000
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
EXECUTOR: ThreadPoolExecutor | None = None
STORE: TempStore | None = None
CONFIG: dict = {}
KEY: str = ""


def load_config(path: Path | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if path and path.is_file():
        data = json.loads(path.read_text(encoding="utf-8"))
        for key, value in data.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    return cfg


def ensure_key(config: dict, key_file: str | None) -> str:
    env_key = os.environ.get("VOICE_HUB_API_KEY", "").strip()
    if env_key:
        return env_key
    path = Path(key_file or config.get("apiKeyFile") or (RUNTIME / "voice-hub-api-key")).expanduser()
    try:
        if path.is_file():
            value = path.read_text(encoding="utf-8").strip()
            if value:
                return value
        path.parent.mkdir(parents=True, exist_ok=True)
        value = secrets.token_urlsafe(32)
        path.write_text(value + "\n", encoding="utf-8")
        os.chmod(path, 0o600)
        LOG.info("generated API key at %s", path)
        return value
    except OSError as exc:
        raise SystemExit(f"cannot read/create API key file {path}: {exc}") from exc


def _store() -> TempStore:
    assert STORE is not None
    return STORE


def _new_job(kind: str, **fields) -> dict:
    job_id = uuid.uuid4().hex[:16]
    job = {
        "id": job_id,
        "kind": kind,
        "state": "queued",
        "createdAt": time.time(),
        "updatedAt": time.time(),
        **fields,
    }
    with JOBS_LOCK:
        JOBS[job_id] = job
    return job


def _update_job(job_id: str, **fields) -> None:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job.update(fields)
        job["updatedAt"] = time.time()


def _run_tts(job_id: str, text: str, style: str) -> None:
    store = _store()
    task_id, task_dir, _meta = store.create_task(label="tts")
    _update_job(job_id, state="running", taskId=task_id)
    try:
        gpt = CONFIG.get("gptSovits") or {}
        body = {
            "text": text,
            "text_lang": gpt.get("textLang", "zh"),
            "ref_audio_path": gpt.get("refAudio"),
            "prompt_text": gpt.get("promptText", ""),
            "prompt_lang": gpt.get("promptLang", "zh"),
            "speed_factor": float(gpt.get("speedFactor", 1.0)),
            "text_split_method": "cut5",
            "batch_size": 1,
            "media_type": "wav",
            "streaming_mode": False,
        }
        timeout = float(gpt.get("timeoutSeconds", 300))
        url = str(gpt.get("url") or "http://127.0.0.1:9850").rstrip("/") + "/tts"
        data = b""
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                with httpx.Client(timeout=timeout) as client:
                    resp = client.post(url, json=body)
                if resp.status_code == 200 and len(resp.content) > 1024:
                    data = resp.content
                    break
                last_error = RuntimeError(f"GPT-SoVITS returned {resp.status_code}: {resp.text[:300]}")
            except Exception as exc:  # network / timeout
                last_error = exc
            time.sleep(1.5 * (attempt + 1))
        if not data:
            raise RuntimeError(f"GPT-SoVITS synthesis failed: {last_error}")
        audio = task_dir / "audio.wav"
        audio.write_bytes(data)
        files = [{"path": audio.name, "bytes": audio.stat().st_size, "role": "audio"}]
        store.mark_ready(task_id, files, extra={"kind": "tts", "style": style})
        _update_job(
            job_id,
            state="success",
            audioPath=str(audio),
            bytes=audio.stat().st_size,
            format="wav",
            audioUrl=f"/v1/jobs/{job_id}/audio",
        )
    except Exception as exc:
        LOG.exception("tts job %s failed", job_id)
        store.mark_failed(task_id, f"{type(exc).__name__}: {exc}")
        _update_job(job_id, state="failed", error={"code": "tts-failed", "message": str(exc)})
    finally:
        try:
            store.cleanup()
        except Exception:
            pass


def _ffmpeg() -> str | None:
    return bili_audio.resolve_ffmpeg()


def _probe_duration(path: Path) -> float | None:
    ffprobe = Path(_ffmpeg() or "").parent / "ffprobe" if _ffmpeg() else None
    if not ffprobe or not ffprobe.is_file():
        return None
    try:
        out = subprocess.run(
            [str(ffprobe), "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
        ).stdout.strip()
        return float(out) if out else None
    except Exception:
        return None


def _to_mp3(source: Path, target: Path) -> None:
    ffmpeg = _ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to encode cover audio")
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn", "-c:a", "libmp3lame", "-b:a", "192k", str(target)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0 or not target.is_file():
        raise RuntimeError(f"ffmpeg cover encode failed: {(result.stderr or '').strip()[-500:]}")


def _cover_style_args(prompt: str) -> list[str]:
    """把翻唱提示词里的简单要求映射成 song2cute 参数（能力有限，只做保守解释）。"""
    text = str(prompt or "").lower()
    args: list[str] = []
    if any(word in text for word in ("升调", "高音", "高一点", "高一些")):
        args += ["--pitch", "2"]
    elif any(word in text for word in ("降调", "低音", "低一点", "低一些")):
        args += ["--pitch", "-2"]
    if any(word in text for word in ("温柔", "轻柔", "轻一点", "轻一些")):
        args += ["--protect", "0.25", "--volume-envelope", "0.3"]
    if any(word in text for word in ("清晰", "清亮", "亮一点", "亮一些")):
        args += ["--index-rate", "0.65"]
    return args


def _run_cover(job_id: str, url: str, mix: bool, name: str | None, prompt: str | None = None) -> None:
    store = _store()
    task_id, task_dir, _meta = store.create_task(label="cover")
    _update_job(job_id, state="running", taskId=task_id)
    try:
        cover_cfg = CONFIG.get("cover") or {}
        if not cover_cfg.get("enabled", True):
            raise RuntimeError("cover service is disabled")
        info = bili_audio.info(url)
        duration = info.get("durationSeconds")
        max_minutes = float(cover_cfg.get("maxDurationMinutes") or 8)
        if isinstance(duration, (int, float)) and duration > max_minutes * 60:
            raise RuntimeError(f"video is too long ({duration:.0f}s > {max_minutes * 60:.0f}s limit)")
        out_dir = task_dir / "out"
        out_dir.mkdir(parents=True, exist_ok=True)
        name = "".join(ch for ch in (name or info.get("bvid") or "cover") if ch.isalnum() or ch in "-_")[:60] or "cover"
        venv_python = RUNTIME / ".venv" / "bin" / "python"
        script = RUNTIME / "song2cute.py"
        if not venv_python.is_file() or not script.is_file():
            raise RuntimeError(f"song2cute runtime missing under {RUNTIME}")
        env = dict(os.environ)
        env["PATH"] = f"{RUNTIME / 'bin'}{os.pathsep}{env.get('PATH', '')}"
        env["SONG2CUTE_HOME"] = str(RUNTIME)
        cmd = [
            str(venv_python),
            str(script),
            url,
            "-o",
            str(out_dir),
            "--mode",
            "cover" if mix else "vocals",
            "--name",
            name,
            *_cover_style_args(str(prompt or "")),
            "--pause-voice-api",
        ]
        timeout = float(cover_cfg.get("timeoutSeconds") or 1800)
        log_path = task_dir / "song2cute.log"
        with log_path.open("w", encoding="utf-8") as log:
            proc = subprocess.run(cmd, cwd=str(RUNTIME), env=env, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        if proc.returncode != 0:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-800:]
            raise RuntimeError(f"song2cute failed (rc={proc.returncode}): {tail}")
        candidates = [
            out_dir / f"{name}-cover.wav" if mix else out_dir / f"{name}-vocals-cute.wav",
            out_dir / f"{name}-cover.mp3" if mix else out_dir / f"{name}-vocals-cute.mp3",
        ]
        source = next((p for p in candidates if p.is_file()), None)
        if source is None:
            found = sorted(out_dir.glob("*.wav"))
            source = next((p for p in found if (p.name.endswith("-cover.wav") if mix else p.name.endswith("-vocals-cute.wav"))), None)
        if source is None:
            raise RuntimeError("song2cute finished without a cover/vocals output")
        audio = task_dir / "audio.mp3"
        if source.suffix.lower() == ".mp3":
            shutil.copy2(source, audio)
        else:
            _to_mp3(source, audio)
        seconds = _probe_duration(audio)
        files = [{"path": audio.name, "bytes": audio.stat().st_size, "role": "audio"}]
        store.mark_ready(
            task_id,
            files,
            extra={
                "kind": "cover",
                "title": info.get("title"),
                "bvid": info.get("bvid"),
                "url": url,
                "prompt": str(prompt or "")[:300],
                "mix": bool(mix),
                "durationSeconds": seconds or duration,
            },
        )
        _update_job(
            job_id,
            state="success",
            title=info.get("title"),
            bvid=info.get("bvid"),
            url=url,
            prompt=str(prompt or "")[:300],
            mix=bool(mix),
            durationSeconds=seconds or duration,
            audioPath=str(audio),
            bytes=audio.stat().st_size,
            format="mp3",
            audioUrl=f"/v1/jobs/{job_id}/audio",
        )
    except Exception as exc:
        LOG.exception("cover job %s failed", job_id)
        store.mark_failed(task_id, f"{type(exc).__name__}: {exc}")
        _update_job(job_id, state="failed", error={"code": "cover-failed", "message": str(exc)})
    finally:
        try:
            store.cleanup()
        except Exception:
            pass


def _cleanup_loop(stop: threading.Event) -> None:
    while not stop.wait(600):
        try:
            _store().cleanup()
            now = time.time()
            with JOBS_LOCK:
                for job_id, job in list(JOBS.items()):
                    if job.get("state") in TERMINAL_STATES and now - job.get("createdAt", now) > 24 * 3600:
                        JOBS.pop(job_id, None)
        except Exception:
            LOG.exception("cleanup failed")


def _check_auth(request: Request) -> None:
    if not KEY:
        return
    scheme, param = get_authorization_scheme_param(request.headers.get("Authorization", ""))
    if scheme.lower() != "bearer" or not secrets.compare_digest(param, KEY):
        raise HTTPException(status_code=401, detail="unauthorized")


def build_app() -> FastAPI:
    app = FastAPI(title="dsh-im-persona voice hub", version="0.1.0")

    @app.get("/health")
    async def health():
        gpt = CONFIG.get("gptSovits") or {}
        try:
            with httpx.Client(timeout=3) as client:
                gpt_up = client.get(str(gpt.get("url") or "").rstrip("/") + "/docs").status_code < 500
        except Exception:
            gpt_up = False
        with JOBS_LOCK:
            queued = sum(1 for j in JOBS.values() if j.get("state") == "queued")
            running = sum(1 for j in JOBS.values() if j.get("state") == "running")
        return {"status": "ok", "gptSovits": bool(gpt_up), "queued": queued, "running": running}

    @app.get("/v1/capabilities")
    async def capabilities():
        return {
            "speech": True,
            "cover": bool((CONFIG.get("cover") or {}).get("enabled", True)),
            "voice": "feiyu-cute",
            "formats": {"speech": "wav", "cover": "mp3"},
        }

    @app.post("/v1/speech")
    async def speech(request: Request):
        _check_auth(request)
        payload = await request.json()
        text = str(payload.get("text") or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="text is required")
        if len(text) > MAX_TTS_CHARS:
            raise HTTPException(status_code=400, detail=f"text must be <= {MAX_TTS_CHARS} chars")
        style = "gentle" if payload.get("style") == "gentle" else "cute"
        job = _new_job("tts", text=text[:40], style=style)
        assert EXECUTOR is not None
        EXECUTOR.submit(_run_tts, job["id"], text, style)
        return JSONResponse(status_code=202, content={"id": job["id"], "state": "queued"})

    @app.post("/v1/cover")
    async def cover(request: Request):
        _check_auth(request)
        payload = await request.json()
        url = bili_audio.find_bilibili_url(str(payload.get("url") or ""))
        if not url:
            raise HTTPException(status_code=400, detail="a Bilibili video URL is required")
        mix = bool(payload.get("mix", False))
        name = payload.get("name")
        prompt = str(payload.get("prompt") or "")[:300]
        job = _new_job("cover", url=url, mix=mix, prompt=prompt)
        assert EXECUTOR is not None
        EXECUTOR.submit(_run_cover, job["id"], url, mix, name, prompt)
        return JSONResponse(status_code=202, content={"id": job["id"], "state": "queued", "kind": "cover"})

    @app.get("/v1/jobs/{job_id}")
    async def get_job(job_id: str, request: Request):
        _check_auth(request)
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        if not job:
            raise HTTPException(status_code=404, detail="unknown job")
        return job

    @app.get("/v1/jobs/{job_id}/audio")
    async def get_audio(job_id: str, request: Request):
        _check_auth(request)
        with JOBS_LOCK:
            job = dict(JOBS.get(job_id) or {})
        if not job:
            raise HTTPException(status_code=404, detail="unknown job")
        if job.get("state") != "success" or not job.get("audioPath"):
            raise HTTPException(status_code=409, detail="job is not ready")
        path = Path(job["audioPath"])
        if not path.is_file():
            raise HTTPException(status_code=410, detail="audio has expired")
        return Response(
            content=path.read_bytes(),
            media_type="audio/mpeg" if job.get("format") == "mp3" else "audio/wav",
            headers={"Content-Disposition": f'inline; filename="{path.name}"'},
        )

    @app.on_event("startup")
    async def startup():
        LOG.info("voice-hub ready config=%s", CONFIG.get("dataDir"))

    return app


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="voice-hub: TTS + Bilibili cover gateway for IM bots")
    ap.add_argument("--config", default=str(RUNTIME / "voice_hub.json"))
    ap.add_argument("--host", default=None)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--key-file", default=None)
    ap.add_argument("--print-key", action="store_true")
    args = ap.parse_args(argv)

    global CONFIG, KEY, EXECUTOR, STORE
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    CONFIG = load_config(Path(args.config).expanduser())
    KEY = ensure_key(CONFIG, args.key_file)
    if args.print_key:
        print(KEY)
        return 0
    host = args.host or CONFIG.get("host") or "0.0.0.0"
    port = args.port or int(CONFIG.get("port") or 9860)
    STORE = TempStore(
        Path(CONFIG.get("dataDir") or (RUNTIME / "tmp" / "voice-hub")),
        default_ttl_seconds=int(float(CONFIG.get("ttlHours") or 2) * 3600),
        max_bytes=int(float(CONFIG.get("maxGb") or 20) * 1024**3),
        max_entries=500,
    )
    STORE.cleanup()
    EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="voice-hub")
    stop = threading.Event()
    threading.Thread(target=_cleanup_loop, args=(stop,), daemon=True, name="voice-hub-cleanup").start()
    try:
        import uvicorn

        uvicorn.run(build_app(), host=host, port=port, log_level="info")
    finally:
        stop.set()
        EXECUTOR.shutdown(wait=False, cancel_futures=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
