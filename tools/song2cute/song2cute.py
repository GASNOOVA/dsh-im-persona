#!/usr/bin/env python3
"""song2cute: separated vocal -> RVC timbre conversion -> optional cover mix.

Pipeline (all on the local server):
  1. Demucs htdemucs --two-stems=vocals
  2. FeiyuVoice-RVC-v1 conversion of the isolated vocal stem
  3. optional remix: converted vocal + separated instrumental

The runtime directory defaults to ~/feiyu-voice-lite and can be overridden
with SONG2CUTE_HOME.  The optional GPT-SoVITS voice service directory / config
can be overridden with SONG2CUTE_VOICE_API_DIR / SONG2CUTE_VOICE_API_YAML /
SONG2CUTE_VOICE_API_PORT.  See tools/song2cute/README.md for setup.

Run with the feiyu-voice-lite venv, e.g.:
  ~/feiyu-voice-lite/bin/song2cute song.wav -o out --mode both
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf

BASE = Path(os.environ.get("SONG2CUTE_HOME") or (Path.home() / "feiyu-voice-lite")).expanduser().resolve()
VENV_PY = BASE / ".venv" / "bin" / "python"
RVC_SERVER = BASE / "server"
RVC_PACKAGE = BASE / "package"
RVC_PROFILE = BASE / "profile.json"
SR = 40000                 # RVC native output rate
MIX_SR = 44100             # mix / deliver rate
RPC_YAML = Path(os.environ.get("SONG2CUTE_VOICE_API_YAML") or (Path.home() / "gpt-sovits" / "tts_infer_v2pro_cuda.yaml")).expanduser()
VOICE_API_DIR = Path(os.environ.get("SONG2CUTE_VOICE_API_DIR") or (Path.home() / "gpt-sovits")).expanduser()
VOICE_API_PORT = os.environ.get("SONG2CUTE_VOICE_API_PORT", "9850")
VOICE_API_CMD = [
    "bash", "-lc",
    f"cd {VOICE_API_DIR} && nohup .venv/bin/python api_v2.py -a 0.0.0.0 -p {VOICE_API_PORT} "
    f"-c {RPC_YAML} >> api.log 2>&1 &",
]


def log(*args):
    print(*args, flush=True)


def run(cmd: list[str], cwd: Path | None = None, env: dict | None = None, quiet: bool = True):
    log("$", " ".join(str(c) for c in cmd))
    r = subprocess.run(cmd, cwd=str(cwd) if cwd else None, env=env,
                       capture_output=True, text=True)
    if r.stdout.strip():
        log(r.stdout.strip()[-1200:])
    if r.stderr.strip():
        log(r.stderr.strip()[-1200:])
    if r.returncode != 0:
        raise SystemExit(f"command failed (rc={r.returncode}): {' '.join(str(c) for c in cmd)}")
    return r


def pause_voice_api() -> bool:
    """Stop a running GPT-SoVITS api_v2.py so the GPU is free; returns True if stopped."""
    try:
        out = subprocess.run(["pgrep", "-f", "api_v2.py"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return False
    pids = [p for p in out.split() if p.strip().isdigit() and int(p) != os.getpid()]
    if not pids:
        log("voice api not running; GPU left as is")
        return False
    for pid in pids:
        try:
            os.kill(int(pid), signal.SIGTERM)
            log(f"stopped voice api pid={pid}")
        except ProcessLookupError:
            pass
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            used = subprocess.run(
                ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True).stdout.strip().splitlines()
            if not used or int(used[0]) < 800:
                return True
        except Exception:
            return True
        time.sleep(1)
    return True


def restart_voice_api():
    log("restarting GPT-SoVITS voice api ...")
    subprocess.Popen(
        VOICE_API_CMD,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(2)


def load_mono(path: Path, sr: int) -> np.ndarray:
    y, _ = librosa.load(str(path), sr=sr, mono=True)
    return np.asarray(y, dtype=np.float32)


def trim_silence(y: np.ndarray) -> np.ndarray:
    t, _ = librosa.effects.trim(y, top_db=30)
    return t if len(t) else y


def fade(y: np.ndarray, sr: int, sec: float = 0.012) -> np.ndarray:
    n = min(int(sec * sr), len(y) // 4)
    if n <= 0:
        return y
    y = y.copy()
    y[:n] *= np.linspace(0, 1, n)
    y[-n:] *= np.linspace(1, 0, n)
    return y


def concat_with_gaps(parts, sr, gap=0.06):
    out = []
    for i, p in enumerate(parts):
        if i:
            out.append(np.zeros(int(gap * sr), dtype=np.float32))
        out.append(p)
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


def prepare_demucs_input(src: Path, work: Path) -> Path:
    """Demucs 4.0.1 crashes on mono input; always hand it a stereo 44.1 kHz WAV."""
    dst = work / "input-stereo.wav"
    try:
        y, sr = sf.read(str(src), always_2d=True, dtype="float32")
    except Exception:
        y, sr = librosa.load(str(src), sr=None, mono=False)
        y = np.asarray(y).T if np.asarray(y).ndim > 1 else np.asarray(y)
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        y = np.stack([y, y], axis=1)
    elif y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    elif y.shape[1] > 2:
        y = y[:, :2]
    if sr != 44100:
        y = librosa.resample(y.T, orig_sr=sr, target_sr=44100).T
        sr = 44100
    sf.write(str(dst), y, sr, subtype="PCM_16")
    log(f"prepared demucs input: stereo {sr} Hz -> {dst}")
    return dst


def demucs_separate(input_path: Path, work: Path, device: str) -> tuple[Path, Path]:
    demucs_out = work / "demucs"
    demucs_out.mkdir(parents=True, exist_ok=True)
    run([str(VENV_PY), "-m", "demucs", "--two-stems=vocals",
         f"--device={device}", "--out", str(demucs_out), str(input_path)], cwd=BASE)
    stem_dir = demucs_out / "htdemucs" / input_path.stem
    vocals = stem_dir / "vocals.wav"
    inst = stem_dir / "no_vocals.wav"
    if not vocals.exists() or not inst.exists():
        raise SystemExit(f"demucs outputs missing under {stem_dir}")
    return vocals, inst


def rvc_convert(vocals: Path, work: Path, pitch: int, index_rate: float,
                protect: float, volume_envelope: float, chunk_sec: float,
                overlap_sec: float) -> Path:
    y = load_mono(vocals, SR)
    dur = len(y) / SR
    step = max(1.0, chunk_sec - overlap_sec)
    starts = []
    a = 0.0
    while a < dur:
        b = min(dur, a + chunk_sec)
        starts.append((a, b))
        if b >= dur:
            break
        a += step
    if not starts:
        starts = [(0.0, dur)]
    chunk_dir = work / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["FEIYU_RVC_PARAMS"] = json.dumps({
        "pitch_shift": int(pitch),
        "index_rate": float(index_rate),
        "protect": float(protect),
        "volume_envelope": float(volume_envelope),
    })
    env["PYTHONPATH"] = "."
    segs = []
    for i, (a, b) in enumerate(starts):
        p = chunk_dir / f"chunk{i}.wav"
        sf.write(p, y[int(a * SR):int(b * SR)], SR, subtype="PCM_16")
        od = chunk_dir / f"out{i}"
        log(f"[rvc] chunk {i + 1}/{len(starts)}  {a:.1f}-{b:.1f}s")
        run([str(VENV_PY), "-m", "feiyu_runtime.worker", "--kind", "rvc",
             "--package", str(RVC_PACKAGE), "--profile", str(RVC_PROFILE),
             "--input", str(p), "--output-dir", str(od)],
            cwd=RVC_SERVER, env=env)
        seg = load_mono(od / "rvc_native.wav", SR)
        segs.append(seg)
    if not segs:
        raise SystemExit("RVC produced no audio")
    if len(segs) == 1:
        out = segs[0]
    else:
        fade_n = int(max(0.0, overlap_sec) * SR)
        out = segs[0].copy()
        for seg in segs[1:]:
            n = min(fade_n, len(out) // 4, len(seg) // 4)
            if n <= 0:
                out = np.concatenate([out, seg])
                continue
            w = np.linspace(0, 1, n, dtype=np.float32)
            out = np.concatenate([out[:-n], out[-n:] * (1 - w) + seg[:n] * w, seg[n:]])
    final = work / "vocals-cute.wav"
    sf.write(final, out, SR, subtype="PCM_16")
    return final


def rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)) + 1e-12))


def cover_mix(vocals: Path, inst: Path, cute: Path, out_path: Path,
              vocal_gain_db: float = 0.0) -> Path:
    iv, _ = librosa.load(str(inst), sr=MIX_SR, mono=False)  # (channels, n) or (n,)
    inst_st = np.atleast_2d(iv)
    if inst_st.shape[0] == 1:
        inst_st = np.vstack([inst_st, inst_st])
    ref_voc = load_mono(vocals, MIX_SR)
    cute_v = load_mono(cute, MIX_SR)
    n = inst_st.shape[1]
    if len(cute_v) < n:
        cute_v = np.pad(cute_v, (0, n - len(cute_v)))
    else:
        cute_v = cute_v[:n]
    if len(ref_voc) < n:
        ref_voc = np.pad(ref_voc, (0, n - len(ref_voc)))
    else:
        ref_voc = ref_voc[:n]
    target = rms(ref_voc)
    if rms(cute_v) > 1e-9:
        cute_v = cute_v * (target / rms(cute_v))
    gain = 10 ** (vocal_gain_db / 20.0)
    mix = inst_st + (cute_v * gain)[None, :]
    peak = float(np.max(np.abs(mix)))
    if peak > 0.98:
        mix = mix * (0.98 / peak)
    sf.write(out_path, mix.T, MIX_SR, subtype="PCM_16")
    return out_path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Separate a song, convert the vocal to the 大肥鱼 cute timbre, optionally mix a cover.")
    ap.add_argument("input", help="input audio (wav/flac/mp3/...)")
    ap.add_argument("-o", "--out-dir", required=True, help="output directory")
    ap.add_argument("--mode", choices=["vocals", "cover", "both"], default="both")
    ap.add_argument("--name", default=None, help="output basename (default: input stem)")
    ap.add_argument("--pitch", type=int, default=0, help="RVC transpose in semitones (default 0)")
    ap.add_argument("--index-rate", type=float, default=0.5)
    ap.add_argument("--protect", type=float, default=0.25)
    ap.add_argument("--volume-envelope", type=float, default=0.3)
    ap.add_argument("--chunk", type=float, default=40.0, help="RVC chunk seconds")
    ap.add_argument("--overlap", type=float, default=2.0, help="chunk crossfade seconds")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"], help="demucs device")
    ap.add_argument("--vocal-gain-db", type=float, default=0.0, help="vocal gain in final mix")
    ap.add_argument("--pause-voice-api", action="store_true", help="stop GPT-SoVITS api_v2.py to free VRAM (restarted afterwards)")
    ap.add_argument("--keep-work", action="store_true", help="keep intermediate chunks")
    args = ap.parse_args(argv)

    runtime_missing = [str(p) for p in (VENV_PY, RVC_SERVER, RVC_PACKAGE, RVC_PROFILE) if not p.exists()]
    if runtime_missing:
        raise SystemExit(
            "song2cute runtime is not installed under "
            f"{BASE} (missing: {', '.join(runtime_missing)}).\n"
            "See tools/song2cute/README.md (or SONG2CUTE_HOME) for the installation guide."
        )

    src = Path(args.input).expanduser().resolve()
    if not src.exists():
        raise SystemExit(f"input not found: {src}")
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    name = args.name or src.stem
    work = out_dir / "work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)

    paused = False
    try:
        if args.pause_voice_api:
            paused = pause_voice_api()

        # deterministic demucs stem dir name
        demucs_input = prepare_demucs_input(src, work)
        vocals, inst = demucs_separate(demucs_input, work, args.device)
        vocals_dst = out_dir / f"{name}-vocals.wav"
        inst_dst = out_dir / f"{name}-instrumental.wav"
        shutil.copy2(vocals, vocals_dst)
        shutil.copy2(inst, inst_dst)
        log(f"[ok] vocals      -> {vocals_dst}")
        log(f"[ok] instrumental-> {inst_dst}")

        cute = rvc_convert(vocals, work, args.pitch, args.index_rate,
                           args.protect, args.volume_envelope, args.chunk, args.overlap)
        cute_dst = out_dir / f"{name}-vocals-cute.wav"
        shutil.copy2(cute, cute_dst)
        log(f"[ok] vocals-cute -> {cute_dst}")

        if args.mode in ("cover", "both"):
            cover = out_dir / f"{name}-cover.wav"
            cover_mix(vocals, inst, cute, cover, args.vocal_gain_db)
            log(f"[ok] cover       -> {cover}")
    finally:
        if paused:
            restart_voice_api()
        if not args.keep_work and work.exists():
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
