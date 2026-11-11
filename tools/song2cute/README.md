# song2cute — 把任意歌曲的人声换成「大肥鱼 cute」音色

`tools/song2cute` 是在 GPU 服务器上运行的离线工具链：

1. **Demucs v4 (`htdemucs`)** 分离歌曲 → 纯人声 + 伴奏；
2. **FeiyuVoice-RVC-v1** 把纯人声换成大肥鱼 cute 音色（保留原唱旋律、节奏与演唱表情）；
3. 可选**混音**：换声后人声 + 原伴奏，输出可直接播放的 cover。

它是 dsh-im-persona 的配套工具，不参与 IM 机器人运行；机器人语音回复请见 [语音回复](../../docs/语音回复.md)。

## 快速使用（运行时已安装）

```sh
# 仅换声（输出 <name>-vocals.wav / <name>-instrumental.wav / <name>-vocals-cute.wav）
~/feiyu-voice-lite/bin/song2cute song.wav -o ~/feiyu-voice-lite/out --mode vocals --name demo

# 换声 + 混音（额外输出 <name>-cover.wav）
~/feiyu-voice-lite/bin/song2cute song.wav -o ~/feiyu-voice-lite/out --mode both --name demo
```

参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-o, --out-dir` | 必填 | 输出目录 |
| `--mode` | `both` | `vocals`（只做换声，不生成混音）/ `cover` 或 `both`（额外生成 `<name>-cover.wav`） |
| `--name` | 输入文件名 | 输出文件前缀 |
| `--pitch` | `0` | RVC 变调半音数 |
| `--index-rate` | `0.5` | RVC 索引混合比例 |
| `--protect` | `0.25` | 保护清辅音/气声 |
| `--volume-envelope` | `0.3` | RVC 音量包络混合 |
| `--chunk` / `--overlap` | `40` / `2` | 分块秒数与交叉淡化秒数 |
| `--device` | `cuda` | Demucs 设备（`cuda` / `cpu`） |
| `--vocal-gain-db` | `0` | 混音时人声增益 |
| `--pause-voice-api` | 关 | 转换前停掉 GPT-SoVITS voice API，转换后重启（4GB 显存必备） |
| `--keep-work` | 关 | 保留中间文件 |

输出：`<name>-vocals.wav`（分离人声）、`<name>-instrumental.wav`（伴奏）、`<name>-vocals-cute.wav`（换声人声，40 kHz）、`<name>-cover.wav`（混音，44.1 kHz 立体声）。

> 换声质量取决于 RVC 目标模型与参数；`--pitch 0 --index-rate 0.5 --protect 0.25 --volume-envelope 0.3` 是当前 1050 Ti 上验证过、与原版 F0/亮度最接近的一组默认值。

## 安装（可迁移部署指南）

本工具依赖一个 **NVIDIA GPU + Python 3.11 + PyTorch 2.7.1+cu126** 的运行时目录。下面的步骤在 Ubuntu 26.04 + GTX 1050 Ti 4GB（驱动 580.178.04）上完整验证过，**不需要 sudo、不修改系统 Python**。完整的 GPU 服务部署说明（含 GPT-SoVITS 等可选服务、迁移清单、故障排查）见 [docs/GPU声音服务部署.md](../../docs/GPU声音服务部署.md)。

### 0. 目录约定

```text
~/feiyu-voice-lite/            # 运行时根目录（可用 SONG2CUTE_HOME 覆盖）
├── .venv/                     # Python 3.11 虚拟环境（torch / demucs / librosa ...）
├── server/                    # 从 astrbot_plugin_feiyu_voice/server 复制
├── source/                    # Applio 源码（固定 commit + compat overlay + RVC 资产）
├── package/                   # FeiyuVoice-RVC 模型包
├── profile.json               # RVC 运行时配置（make-profile.py 生成）
├── song2cute.py               # 本工具（从本仓库复制）
└── bin/song2cute              # wrapper
```

### 1. 安装 uv 与 Python 3.11（用户态）

```sh
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env"
uv python install 3.11.17
mkdir -p ~/feiyu-voice-lite && cd ~/feiyu-voice-lite
uv venv --python 3.11.17 .venv
```

### 2. 安装 PyTorch 与 Demucs

> **为什么是 torch 2.7.1+cu126**：GTX 1050 Ti 是 Pascal（sm_61）。PyTorch 2.8 之后的 cu128 构建已移除 Pascal/Volta kernel；同时 `transformers>=4.51`（RVC 的 ContentVec 依赖）在 torch<2.6 上会拒绝加载（CVE-2025-32434）。2.7.1+cu126 是同时满足两者的最后版本之一。

```sh
cd ~/feiyu-voice-lite
uv pip install --python .venv/bin/python \
  --index-url https://download.pytorch.org/whl/cu126 \
  torch==2.7.1+cu126 torchaudio==2.7.1+cu126
uv pip install --python .venv/bin/python "demucs==4.0.1"
.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

### 3. 准备 server/（RVC 运行时）与 source/

```sh
# 取得声音服务仓库（含 Feiyu 的 RVC 适配层与 Applio 兼容补丁）。
# 可以 rsync 你本机已有的 astrbot_plugin_feiyu_voice 仓库：
#   rsync -a /path/to/astrbot_plugin_feiyu_voice/ <server>:/tmp/feiyu-src/
# 也可以用 git clone <你的 fork 或上游发布仓库> /tmp/feiyu-src
cp -a /tmp/feiyu-src/server ~/feiyu-voice-lite/server

# Applio 源码（固定 commit），并应用 runtime_compat 兼容补丁
git clone https://github.com/IAHispano/Applio.git ~/feiyu-voice-lite/source
git -C ~/feiyu-voice-lite/source checkout 67a38f6abab3e90a55efa534ea3185a222c102f0
cp -a ~/feiyu-voice-lite/server/runtime_compat/Applio/. ~/feiyu-voice-lite/source/
```

下载 SHA 校验过的 ContentVec / RMVPE 资产（脚本读取 `server/runtime_compat/upstream_assets.json`）：

```sh
cd ~/feiyu-voice-lite
.venv/bin/python - <<'PY'
import hashlib, json, urllib.request
from pathlib import Path
assets = json.loads(Path("server/runtime_compat/upstream_assets.json").read_text())
for item in assets:
    dest = Path("source") / item["destination"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    print("download", item["url"])
    urllib.request.urlretrieve(item["url"], dest)
    got = hashlib.sha256(dest.read_bytes()).hexdigest()
    assert got == item["sha256"], f"sha mismatch: {dest}"
print("assets verified")
PY
```

> 不要用编辑器批量改写 `server/runtime_compat/Applio/`：RVC 兼容源码与模型包绑定原始字节 SHA（含换行符）。

### 4. 下载 FeiyuVoice-RVC 模型包

```sh
cd ~/feiyu-voice-lite
# 任选一种：Hugging Face CLI / 直接用 python 下载
uv pip install --python .venv/bin/python "huggingface_hub[cli]"
.venv/bin/python - <<'PY'
from huggingface_hub import snapshot_download
snapshot_download("Esmerubphire/FeiyuVoice-RVC", local_dir="package")
PY
# 或：huggingface-cli download Esmerubphire/FeiyuVoice-RVC --local-dir package
ls package/FeiyuVoice-RVC-v1.pth package/FeiyuVoice-RVC-v1.index package/files_sha256.json
```

### 5. 生成 profile.json 并加参数覆盖补丁

```sh
cd ~/feiyu-voice-lite
cp /path/to/dsh-im-persona/tools/song2cute/make-profile.py .
.venv/bin/python make-profile.py --runtime-home ~/feiyu-voice-lite
```

`profile.json` 里的 `source_sha256` 直接取自 `server/runtime_compat/source_sha256.json`；`python`/`repo` 写成本机绝对路径。

让 `--pitch/--index-rate/...` 生效需要在 `server/feiyu_runtime/rvc.py` 中加一个环境变量覆盖（该文件不属于 SHA 锁定范围）：

```sh
.venv/bin/python - <<'PY'
from pathlib import Path
p = Path("server/feiyu_runtime/rvc.py")
s = p.read_text()
needle = '    params = manifest["inference"]\n'
patch = needle + (
    '    _override = os.environ.get("FEIYU_RVC_PARAMS")\n'
    '    if _override:\n'
    '        params = {**params, **json.loads(_override)}\n'
)
assert needle in s
if "_override = os.environ.get" not in s:
    p.write_text(s.replace(needle, patch, 1))
print("rvc.py patched")
PY
```

（`os`、`json` 在该文件顶部已经 import；重复执行不会重复插入。）

### 6. 放工具本体

```sh
cp /path/to/dsh-im-persona/tools/song2cute/song2cute.py ~/feiyu-voice-lite/song2cute.py
mkdir -p ~/feiyu-voice-lite/bin
cp /path/to/dsh-im-persona/tools/song2cute/bin/song2cute ~/feiyu-voice-lite/bin/song2cute
chmod +x ~/feiyu-voice-lite/bin/song2cute
```

### 7. 验证

```sh
cd ~/feiyu-voice-lite
~/feiyu-voice-lite/bin/song2cute /path/to/any-song.wav -o /tmp/s2c-test --mode both --name test
ls -l /tmp/s2c-test
```

预期：`test-vocals.wav`、`test-instrumental.wav`、`test-vocals-cute.wav`、`test-cover.wav`；首次运行会下载 Demucs 权重（约 300 MB，缓存在 `~/.cache/torch`）。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `CUDA out of memory` | 停掉 GPT-SoVITS / 其他占卡进程；加 `--pause-voice-api`；仍不够就把 `--chunk` 降到 20 |
| `Package integrity check failed` / `Unexpected RVC model` | 不要改 `package/` 与 `source/`；重新按步骤 3/4 下载，校验不变 |
| `transformers ... torch>=2.6` | 重新安装 torch 2.7.1+cu126（第 2 步） |
| `libsndfile` / soundfile 报错 | `sudo apt-get install -y libsndfile1`（或使用带 libsndfile 的 conda 环境） |
| Demucs 很慢/显存不足 | `--device cpu`（慢但稳），或降低 `--chunk` |

## 迁移到新机器

1. 新机器装驱动（NVIDIA，支持 CUDA 12.x runtime；Pascal 可用，但需要 torch≤2.7.x）；。
2. **不要直接复制 `.venv`**（内部记录绝对路径），按第 1–2 步重建环境；`server/`、`source/`、`package/`、`profile.json`、`song2cute.py` 可以直接复制。
3. 新机器上重新执行 `make-profile.py`（更新 `python` / `repo` 绝对路径）与第 5 步补丁（若复制的是打过补丁的 `server/` 则跳过）。
4. 用第 7 步验证；首次运行会重新下载 Demucs 权重。

## 许可与使用边界

- 工具代码随本仓库（MIT）。
- FeiyuVoice-RVC 模型包、ContentVec、RMVPE、Applio 各有自己的许可与使用条款，见模型包内 `NOTICE.md` / `COPYRIGHT.md` / `Applio_CODE_LICENSE.txt`；仅供个人、本地、非商业用途。
- 歌曲人声与伴奏的使用需自行确保授权；本工具不下载受版权保护的歌曲。
