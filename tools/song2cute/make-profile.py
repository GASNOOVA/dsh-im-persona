#!/usr/bin/env python3
"""Generate a Pascal-friendly feiyu RVC runtime profile for song2cute.

The upstream CUDA profile pins torch 2.11.0+cu128, which no longer ships
Pascal (sm_61) kernels.  This helper writes the profile we validated on a
GTX 1050 Ti with torch 2.7.1+cu126.

Usage (inside the runtime directory, after installing server/ and source/):

    python3 make-profile.py --runtime-home ~/feiyu-voice-lite

It reads the exact RVC source hashes from
``server/runtime_compat/source_sha256.json`` and writes ``profile.json``.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runtime-home", default="~/feiyu-voice-lite", help="runtime root containing server/ and source/")
    ap.add_argument("--python", default=None, help="python path (default: <runtime>/.venv/bin/python)")
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    ap.add_argument("--precision", default="float32")
    ap.add_argument("--output", default=None, help="profile path (default: <runtime>/profile.json)")
    args = ap.parse_args(argv)

    root = Path(args.runtime_home).expanduser().resolve()
    server = root / "server"
    source = root / "source"
    py = Path(args.python).expanduser().resolve() if args.python else root / ".venv" / "bin" / "python"
    hashes_path = server / "runtime_compat" / "source_sha256.json"
    if not hashes_path.is_file():
        raise SystemExit(f"missing {hashes_path}; copy server/ from astrbot_plugin_feiyu_voice first")
    if not source.is_dir():
        raise SystemExit(f"missing {source}; clone Applio and apply runtime_compat/Applio first")
    if not py.is_file():
        raise SystemExit(f"missing python: {py}")

    profile = {
        "schema": "feiyu-runtime-v1",
        "engine": "rvc",
        "backend": args.device,
        "distribution": "Ubuntu-26.04",
        "python": str(py),
        "repo": str(source),
        "commit": "67a38f6abab3e90a55efa534ea3185a222c102f0",
        "torch_version": "2.7.1+cu126",
        "torchaudio_version": "2.7.1+cu126",
        "precision": args.precision,
        "host": "wsl",
        "f0_device": "cpu",
        "onnx_provider": "CPUExecutionProvider",
        "source_sha256": json.loads(hashes_path.read_text(encoding="utf-8")),
        "hardware_validation": "Pascal-compatible fallback profile; see docs/GPU声音服务部署.md",
        "settings": {
            "model_author": None,
            "precision": "fp16",
            "discord_presence": False,
            "rmvpe_high_register": {"enabled": False, "mode": "true_pitch", "f0_ceil": 1250},
        },
    }
    out = Path(args.output).expanduser().resolve() if args.output else root / "profile.json"
    out.write_text(json.dumps(profile, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
