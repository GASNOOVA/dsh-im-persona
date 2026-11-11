# GPU 声音服务部署指南（可迁移）

本仓库的个人版在 IM 聊天之外还配了两类**本地 GPU 声音能力**。它们都跑在同一台局域网 Linux 服务器上，插件本身只通过 HTTP 调用，不做本地推理：

| 能力 | 服务 | 端口 | 插件接入 | 硬件结论 |
| --- | --- | --- | --- | --- |
| 歌曲换声 / 翻唱 | Demucs + FeiyuVoice-RVC（`tools/song2cute`） | 无端口（离线脚本） | 不接入，手动运行 | GTX 1050 Ti 4GB（Pascal）可跑 |
| 实验性语音克隆 | GPT-SoVITS v2Pro（零样本） | `9850` | 暂未接入（实验记录） | 4GB 显存可跑，约 3.2–3.4 GB 峰值 |
| 官方 feiyu 声音服务 | CosyVoice3-0.5B + RVC（上游 `server/`） | `9880` | `wechatPersonal.voice`（可选语音回复） | 需 CUDA 12.8+ 与非 Pascal GPU，本机不可用 |

> 本文记录的是**实际验证过的环境**（2026-11）：Ubuntu 26.04.1、NVIDIA GTX 1050 Ti 4GB（Pascal sm_61）、驱动 580.178.04、CUDA 12.4 toolkit、Python 3.11.17（uv 用户态）、torch 2.7.1+cu126。换机器时按第 1 节先核对兼容性，再按第 2–4 节安装。

## 1. 硬件与驱动兼容性

### 1.1 NVIDIA（推荐）

- 驱动：支持 CUDA 12.x runtime，实测 580.178.04。
- 显存：RVC 约 2.6 GB；GPT-SoVITS v2Pro 约 3.2–3.4 GB；两者**不要同时跑**（4GB 卡会 OOM）。
- **Pascal（GTX 10 系）限制**：PyTorch 2.8+ 的 cu128 构建移除了 Maxwell/Pascal/Volta kernel（[pytorch#157517](https://github.com/pytorch/pytorch/issues/157517)），因此：
  - `torch 2.7.1+cu126` 是当前可用的最后一档（同时满足 `transformers>=4.51` 的 CVE-2025-32434 检查，要求 torch≥2.6）；
  - 上游 feiyu 服务固定的 `torch 2.11.0+cu128` 在 Pascal 上不可用；
  - 4GB 显存也跑不动 CosyVoice3-0.5B 主网络（6.94 GB 权重）。
- Ampere/Ada/Blackwell 新卡：可直接走上游 `torch 2.11+cu128` 与官方 feiyu 服务（见 [语音回复](语音回复.md)）。

### 1.2 AMD（不推荐）

- 官方 ROCm Linux 支持列表不含 RDNA2 消费卡（RX 6600 XT / gfx1032 ❌，仅 PRO W6800 gfx1030 ✅）；
- Windows HIP SDK 同样明确不支持 RX 6600 XT；
- 非官方方案（`HSA_OVERRIDE_GFX_VERSION=10.3.0`、WSL 内 ROCm）与上游严格的 torch 版本校验冲突，不建议作为部署路线。

### 1.3 资源估算

| 组件 | 磁盘 |
| --- | --- |
| `~/feiyu-voice-lite/.venv`（torch 2.7.1+cu126 + demucs + librosa 等） | ~6.0 G |
| `~/feiyu-voice-lite/source`（Applio + RVC 资产） | ~577 M |
| `~/feiyu-voice-lite/package`（FeiyuVoice-RVC） | ~84 M |
| `~/gpt-sovits`（代码 + venv + 模型，可选） | ~7.4 G |
| Demucs 权重缓存（`~/.cache/torch`，首次运行下载） | ~300 M |

系统内存建议 ≥16 GB；无需 sudo（除可选的 `apt-get install ffmpeg libsndfile1`）。

## 2. 公共基础环境

```sh
# uv + Python 3.11（用户态）
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env"
uv python install 3.11.17
```

> **不要使用系统 Python 3.14**：torch 2.7.1 没有 cp314 wheel；也不要 sudo 改系统 Python。

系统依赖（可选，但建议）：

```sh
sudo apt-get install -y ffmpeg libsndfile1 libsox-dev build-essential python3-dev
```

没有 sudo 时：`soundfile` 的 wheel 自带 libsndfile，可正常工作；`ffmpeg` 只在需要 mp3/m4a 等输入时才用到（wav 不需要）。

## 3. 服务 A：song2cute（Demucs + RVC，离线）

完整安装与用法见 **[tools/song2cute/README.md](../tools/song2cute/README.md)**。要点：

```sh
cd ~/feiyu-voice-lite
uv venv --python 3.11.17 .venv
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cu126 \
  torch==2.7.1+cu126 torchaudio==2.7.1+cu126
uv pip install --python .venv/bin/python "demucs==4.0.1"

# 从仓库复制 server/、source/（Applio + overlay + 资产）、package/、profile、工具本体
# 并运行：
python3 make-profile.py --runtime-home ~/feiyu-voice-lite
```

验证：

```sh
~/feiyu-voice-lite/bin/song2cute /path/to/song.wav -o /tmp/s2c --mode both
```

## 4. 服务 B：GPT-SoVITS 语音克隆（实验性，未接入插件）

用于“用大肥鱼 cute 参考音零样本克隆说话/近似唱腔”的实验。**注意**：当前插件语音回复配置的是 feiyu 兼容 API（`/v1/speech`），而 GPT-SoVITS 的 `api_v2.py` 是 `/tts` 同步接口，尚未实现适配层，所以目前只在服务器上手动使用（也可作为后续接入的实验基础）。

### 4.1 安装

```sh
cd ~
git clone https://github.com/RVC-Boss/GPT-SoVITS.git gpt-sovits
cd gpt-sovits
uv venv --python 3.11.17 .venv
uv pip install --python .venv/bin/python --index-url https://download.pytorch.org/whl/cu126 \
  torch==2.7.1+cu126 torchaudio==2.7.1+cu126
uv pip install --python .venv/bin/python -r requirements.txt
# 补一个 requirements 漏掉的运行期依赖（否则 RVC 前端会报 _resampy_gpu_filter）
uv pip install --python .venv/bin/python resampy
.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

### 4.2 下载模型（约 1.4 GB）

来自 HF `lj1995/GPT-SoVITS`，放到 `GPT_SoVITS/pretrained_models/`，保持子目录结构：

| 文件 | 大小 |
| --- | --- |
| `s1v3.ckpt` | 155 MB |
| `v2Pro/s2Gv2Pro.pth` | 162 MB |
| `chinese-hubert-base/pytorch_model.bin` | 189 MB |
| `chinese-hubert-base/config.json` / `preprocessor_config.json` | 小 |
| `chinese-roberta-wwm-ext-large/pytorch_model.bin` | 651 MB |
| `chinese-roberta-wwm-ext-large/config.json` / `tokenizer.json` | 小 |
| `sv/pretrained_eres2netv2w24s4ep4.ckpt` | 108 MB |

```sh
cd ~/gpt-sovits
.venv/bin/python - <<'PY'
from huggingface_hub import hf_hub_download
files = [
  "s1v3.ckpt", "v2Pro/s2Gv2Pro.pth",
  "chinese-hubert-base/pytorch_model.bin", "chinese-hubert-base/config.json",
  "chinese-hubert-base/preprocessor_config.json",
  "chinese-roberta-wwm-ext-large/pytorch_model.bin",
  "chinese-roberta-wwm-ext-large/config.json",
  "chinese-roberta-wwm-ext-large/tokenizer.json",
  "sv/pretrained_eres2netv2w24s4ep4.ckpt",
]
for f in files:
    hf_hub_download("lj1995/GPT-SoVITS", f, local_dir="GPT_SoVITS/pretrained_models")
PY
```

首次推理还可能自动下载 `fast_langdetect/lid.176.bin`（约 131 MB），保持网络可用即可。

### 4.3 配置与参考音

新建 `tts_infer_v2pro_cuda.yaml`（或复制 `GPT_SoVITS/configs/tts_infer.yaml` 后修改 `custom` 段）：

```yaml
custom:
  bert_base_path: GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large
  cnhuhbert_base_path: GPT_SoVITS/pretrained_models/chinese-hubert-base
  device: cuda
  is_half: false
  t2s_weights_path: GPT_SoVITS/pretrained_models/s1v3.ckpt
  version: v2Pro
  vits_weights_path: GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth
```

参考音要求：

- 3–10 秒、单人自然说话、无 BGM/混响/他人抢话；
- 准备**逐字稿**（`prompt_text`），必须与参考音内容一致，否则模型会复述参考音；
- 可用 `faster-whisper` 转录：`uv pip install --python .venv/bin/python faster-whisper`，选 `small` 模型，中文；
- 也可直接用官方示例参考音：HF `Esmerubphire/FeiyuVoice-CosyVoice3` 的 `references/cute_N01.wav`（2.74 s，需补齐到 3 s 以上）。

### 4.4 启动与验证

```sh
cd ~/gpt-sovits
nohup .venv/bin/python api_v2.py -a 0.0.0.0 -p 9850 -c tts_infer_v2pro_cuda.yaml >> api.log 2>&1 &
curl -s http://127.0.0.1:9850/docs -o /dev/null -w '%{http_code}\n'   # 200
```

实测（GTX 1050 Ti 4GB、v2Pro、fp32）：

- 模型加载 ~5.9 s；峰值显存 3.2–3.4 GB；
- 首请求约 10–18 s（含 CUDA graph 编译），预热后 12 字约 4.4 s、28 字约 9.3 s；
- 只支持 TTS（说话），不能按旋律唱歌；真正唱歌需要 SVS 模型，Pascal 卡跑不动。

> 该服务与 RVC 共享显存：跑 `song2cute` 前用 `--pause-voice-api`，或先 `pkill -f api_v2.py`。

## 5. 服务 C：官方 feiyu 声音服务（CosyVoice3）

仓库上游 `astrbot_plugin_feiyu_voice/server` 使用 CosyVoice3-0.5B（6.94 GB 权重）+ RVC，配置固定 `torch 2.11.0+cu128`：

- 需要 CUDA 12.8 运行时（驱动 ≥570）与非 Pascal GPU（Ampere/Ada/Blackwell），显存 ≥8 GB 更稳；
- 本机 GTX 1050 Ti 既无 sm_61 kernel、显存也不足，**不可运行**；
- 若未来换卡，按上游 `server/INSTALL_AGENT.md` 的 CUDA 路线安装，然后按 [语音回复](语音回复.md) 在插件里配置 `wechatPersonal.voice`（服务地址、API Key 路径、声线、字数上限）。
- API Key 在服务端 `.runtime/voice-service/api_key.txt`（0600），复制到 DSH 主机的私有路径（建议 `$HOME/.dsh/integrations/dsh-im/wechat-personal/feiyu-api-key`，0600）。

## 6. 端口、显存与开机自启

| 服务 | 端口 | 启动方式 |
| --- | --- | --- |
| GPT-SoVITS | 9850 | `nohup ... api_v2.py ...` 或 systemd user unit |
| 官方 feiyu 服务 | 9880（默认） | 见 [语音回复](语音回复.md) |
| agent-wechat daemon（IM 桥接） | 16175 | 由插件自动拉起并绑定生命周期（见 [群聊大脑](群聊大脑.md)） |

建议用 systemd user unit 管理常驻服务（无需 sudo）：

```ini
# ~/.config/systemd/user/gpt-sovits.service
[Unit]
Description=GPT-SoVITS experimental API
After=network-online.target

[Service]
WorkingDirectory=%h/gpt-sovits
ExecStart=%h/gpt-sovits/.venv/bin/python api_v2.py -a 0.0.0.0 -p 9850 -c %h/gpt-sovits/tts_infer_v2pro_cuda.yaml
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now gpt-sovits
loginctl enable-linger "$USER"   # 注销后仍保持
```

安全：这些 HTTP 服务只在局域网使用；façade 服务默认无 TLS。建议用防火墙只放行 DSH 主机（例如 `ufw allow from 192.168.2.112 to any port 9850 proto tcp`），不要映射到公网。

## 7. 验证清单（换机器后逐项检查）

```sh
# 1) GPU / 驱动
nvidia-smi
# 2) Python 与 torch
~/feiyu-voice-lite/.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# 3) Demucs
~/feiyu-voice-lite/.venv/bin/python -m demucs --help >/dev/null && echo demucs-ok
# 4) RVC 源与包完整性（简版：直接跑一次短转换）
~/feiyu-voice-lite/bin/song2cute /path/to/short.wav -o /tmp/s2c --mode vocals
# 5) GPT-SoVITS（若安装）
curl -s http://127.0.0.1:9850/docs -o /dev/null -w '%{http_code}\n'
# 6) 插件语音（若使用官方 feiyu 服务）
# 设置 → IM机器人 → 通用 → 群聊大脑 → 微信个人号 → 语音回复 → 测试
```

## 8. 迁移与恢复（可迁移性清单）

- **可以复制**：`server/`、`source/`（含资产）、`package/`、`profile.json`（需改路径）、模型目录、`song2cute.py`、`bin/song2cute`、歌曲输出目录。
- **不能复制**：`.venv`（绝对路径 + 平台相关），必须在新机器按第 2–4 节重建；`~/.cache/torch` 的 Demucs 权重可重下。
- **新机器路径变化**：重新运行 `python3 make-profile.py --runtime-home <新根目录>`，并重新打 `rvc.py` 的 `FEIYU_RVC_PARAMS` 覆盖补丁（若复制的是已打补丁版本则跳过）。
- **插件侧**：
  - song2cute 与插件无关；
  - feiyu 语音回复：更新 `wechatPersonal.voice.serviceUrl` 与新机器 IP/端口、`apiKeyPath`；
  - agent-wechat daemon 由插件自动拉起，`wechatPersonal.tokenPath` 指向新机器上的 token 文件。
- **环境变量**（song2cute）：`SONG2CUTE_HOME`（运行时根目录，默认 `~/feiyu-voice-lite`）、`SONG2CUTE_VOICE_API_DIR`、`SONG2CUTE_VOICE_API_YAML`、`SONG2CUTE_VOICE_API_PORT`。
- **记录**：换机后对比 `nvidia-smi`、torch 版本、首次转换耗时，异常时优先怀疑驱动/版本（Pascal 必须 ≤2.7.x、CUDA 12.6 wheel）。

## 9. 常见问题

| 现象 | 原因 / 处理 |
| --- | --- |
| `CUDA out of memory` | GPT-SoVITS / RVC 同时占用；先停另一个，song2cute 用 `--pause-voice-api` |
| `no kernel image is available` | torch 版本过新（cu128 无 Pascal kernel）；换 2.7.1+cu126 |
| `transformers ... require ... torch>=2.6` | 装回 torch 2.7.1+cu126 |
| `_resampy_gpu_filter` not found | `uv pip install resampy` |
| `FileNotFoundError: sv/pretrained_eres2netv2w24s4ep4.ckpt` | 补下 SV 模型（见 4.2） |
| RVC `Package integrity check failed` | 改动了 `package/` 或 `source/`；不要编辑包内文件，重新下载 |
| GPT-SoVITS 合成出参考音内容 | 参考音与 `prompt_text` 不一致；重新转录/对齐 |
| 显存 4GB 卡首条语音很慢 | v2Pro 首次含 CUDA graph 编译；预热即可 |

## 10. 许可与使用边界

- 本仓库代码 MIT；FeiyuVoice / Applio / ContentVec / RMVPE / GPT-SoVITS 模型与代码各有独立许可，见各自仓库与模型包 `NOTICE.md`、`COPYRIGHT.md`。
- 只用于个人、本地、非商业用途；克隆/翻唱他人声音与歌曲前，请自行确认授权与当地法律要求。
