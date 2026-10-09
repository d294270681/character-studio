# 角色工坊本地模型来源核验

核验日期：2026-10-09。当前 GUI 与管线 CLI 的实际生图、风格编辑、无声视频流程共需 **12 个权重文件，98,185,654,006 字节（约 91.44 GiB）**。清单覆盖主模型、文本/视觉编码器、VAE 和所有现有加速档位。未下载权重、运行安装或触发图像/视频生成。

`docs/evidence/models.json` 是可机器读取的完整证据；`docs/evidence/model-publishers.json` 保存以固定仓库提交为参数取得的 Hugging Face 元数据快照。`models` 中仅 `active: true` 的 12 条应进入默认下载集合。每条同时提供 `path`、`url`、`bytes`、`sha256`、`revision`、许可和来源字段。

## 当前完整工作流

| 阶段 | 组件 | 本地文件名 | 已验证发布源 |
|---|---|---|---|
| 生图 | 主模型 | `qwen_image_2512_fp8_e4m3fn.safetensors` | [Comfy-Org/Qwen-Image_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI) |
| 风格编辑 | 主模型 | `qwen_image_edit_2511_fp8mixed.safetensors` | [Comfy-Org/Qwen-Image-Edit_ComfyUI](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI) |
| 生图、编辑 | 共享文本/视觉编码器 | `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Comfy-Org/Qwen-Image_ComfyUI |
| 生图、编辑 | 共享 VAE | `qwen_image_vae.safetensors` | Comfy-Org/Qwen-Image_ComfyUI |
| 生图 4 步 | Lightning LoRA | `Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors` | [lightx2v/Qwen-Image-2512-Lightning](https://huggingface.co/lightx2v/Qwen-Image-2512-Lightning) |
| 生图 8 步 | Lightning LoRA | `Qwen-Image-2512-Lightning-8steps-V1.0-fp32.safetensors` | lightx2v/Qwen-Image-2512-Lightning |
| 编辑 4 步 | Lightning LoRA | `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) |
| 编辑 8 步 | Lightning LoRA | `Qwen-Image-Edit-2511-Lightning-8steps-V1.0-fp32.safetensors` | lightx2v/Qwen-Image-Edit-2511-Lightning |
| 视频 | FL2VA 主模型 | `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3) |
| 视频 | 文本/视觉编码器 | `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | Comfy-Org/MiniMax-H3 |
| 视频 | Turbo V4 LoRA | `minimax_h3_turbo_4step_ckpt600_V4.safetensors` | [Abiray/MiniMax-H3-Turbo-Lora-Pruned-ComfyUI](https://huggingface.co/Abiray/MiniMax-H3-Turbo-Lora-Pruned-ComfyUI) |
| 视频 | 视频 VAE | `minimax_h3_video_vae_fp16.safetensors` | Comfy-Org/MiniMax-H3 |

Qwen 系列和 Lightning 发布页标注 Apache-2.0。Comfy-Org 是面向 ComfyUI 的重打包发布源；H3 Turbo V4 是 Abiray 的社区重打包，不能标成 MiniMax 或 Comfy 官方 LoRA。Abiray 模型卡注明上游训练者为 larryvrh，并说明了为原生 Comfy 工作流裁剪结构的用途。

12 条 active 文件的 SHA-256 与大小均来自对应固定 revision 的 Hugging Face LFS 元数据。本机 12 个文件大小全部吻合；仅对 H3 Turbo V4 另外进行了完整本机哈希计算，结果为 `166bf9dc6b5d952e0aea384d722b5a8d92146992ee6e007c2d38b65d45c4479a`，与发布值一致。其余文件未做本轮完整磁盘哈希，不能据大小声称内容已验证；复用时仍应由安装器校验。

## 许可处理

H3 发布页采用 `minimax-h3-community-license-agreement`。Hugging Face 的 `gated: false` 仅表示下载接口没有登录门槛。新下载应要求用户显式确认已审阅并有权接受 [MiniMax 官方固定版本许可](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE)，不能由脚本自动代为接受。

该许可包含地区、用途、商业和分发条款；[Comfy 官方教程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) 对本地商用也另有说明。项目应提供链接和明确的人工接受入口，不应笼统宣称可自由商用。本次仅建立许可门控元数据，未接受许可，也未判断用户的地区或商业授权。

Abiray 元数据也声明 H3 社区许可，但其 `license_link: LICENSE` 指向的独立文件未出现在该固定版本仓库中。因此清单记录这一缺口，链接 MiniMax 正式许可及 Abiray 模型卡，不将它标记为宽松许可。H3 接受开关只记录审阅行为，不保证上游第三方链条或具体用途已获得额外授权。代码仓库不包含或再分发任何权重。

## 已安装但不属于当前工作流

- `z_image_turbo_bf16.safetensors`、`qwen_3_4b.safetensors`、`ae.safetensors`：已取得 [Comfy-Org/z_image_turbo](https://huggingface.co/Comfy-Org/z_image_turbo) 固定版本、哈希与大小，记录为 `legacy`、`active: false`。代码仅保留 `z_image_prompt` helper；当前 `generate_candidates` 调用 Qwen，GUI/CLI 没有 Z Image 选择入口。
- H3 `minimax_h3_ref2va_pruned_int8_convrot.safetensors` 和 `minimax_h3_audio_vae_fp32.safetensors`：官方来源已核实，但当前无声 FL2VA 流程没有引用，记录为 `unused`，默认不下载。
- `NSFW_master_ZIT.safetensors`：未发现当前代码引用，来源和许可未核实；只有磁盘清单，不提供下载 URL。
- 8 个 `vae_approx` TAESD/TAESDXL/TAESD3/TAEF1 文件：当前启动参数关闭预览，不是本流程依赖；仅盘点，未核实下载源。
- `qwen_image_2512_fp8_e4m3fn_scaled.safetensors`：模型备份目录中的旧文件，来源未核实，当前代码使用不带 `_scaled` 的发布文件；不纳入下载或发布。

以上覆盖 ComfyUI 模型目录中的 26 个现有 safetensors 文件，以及应用模型备份目录的 1 个旧权重。没有读取生成素材、真实用户配置或密钥。

## 节点与兼容代码

本机 ComfyUI 为 [官方 v0.33.1，commit `72865f4f27eaf5396f8f36370e0a2be3a9a090ee`](https://github.com/Comfy-Org/ComfyUI/commit/72865f4f27eaf5396f8f36370e0a2be3a9a090ee)。普通 Git 状态有大量行尾变化，但 `git diff --ignore-space-at-eol --stat` 为空，未发现未跟踪核心文件。

所有实际节点都是此版本原生节点：模型/CLIP/VAE/LoRA 加载器、Qwen Edit 编码、H3 ImageToVideo/SigmaShift、原生采样器以及 CreateVideo/SaveVideo。完整节点名在 JSON `runtime.required_nodes`。启动器使用 `--disable-all-custom-nodes` 和 `--disable-api-nodes`，没有额外第三方 custom_nodes 依赖。未发现独立 CLIPVision、放大器、ControlNet、人脸或背景去除模型需求。

另检查了本机 `comfy-aimdo 0.4.13`、`comfy-kitchen 0.2.31`、`transformers 5.14.1` 和 `torchaudio 2.11.0+cu130` 安装包共 2,681 个 Python 文件，与 wheel 的 RECORD 校验值全部一致。这说明这些 Python 源文件未发现安装后补丁；本轮未校验包内原生二进制。其余依赖版本、完整安装和 GPU 执行应由环境脚本及后续人工安装验证。

## 已完成的低风险验证

通过 AST 读取 `studio_data.py` 的 `REQUIRED_MODELS` 与 `ACCELERATION_LORAS`，自动断言它们的并集与 12 条 active 清单完全相等，缺失和多余均为零。所有固定仓库 revision 经 API 再次验证；每条远端 `size` 与 LFS `size` 一致。没有下载大模型、运行服务或中断现有环境。

安装器的下载集合见根目录 `models.manifest.json`，默认 12 个 active；`-IncludeLegacy` 仅增加 3 个 Z-Image helper 资源。
