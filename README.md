# 角色工坊 · Character Studio

Windows 本地角色资源工作台：人物原始图 → 风格化 → 无声动画视频 → 透明精灵图。界面使用 Electron/React，任务由 Python 和本地 ComfyUI 执行。可选 Kimi 助手需要用户自行配置；环境安装不安装助手、不配置云端付费模型，也不读取或保存 API 密钥。

本仓库只包含应用代码、配置模板、模型及运行时锁定清单、安装和验证脚本。权重、运行时、依赖、个人项目、参考图片和生成结果均不入库。

## Windows 快速开始

需要 Windows x64、Git for Windows、兼容 CUDA 13 的 NVIDIA 驱动。现有环境为 RTX 3090 24 GiB；这只是已核实的本地配置，不是所有分辨率和显卡的兼容承诺。首次完整下载的 12 个模型共 **91.44 GiB**；另预留约 25 GiB 安装/缓存和 5 GiB 余量。已有模型可以直接复用。

先双击 `Setup.cmd` 或在仓库根目录执行：

```powershell
.\Setup.cmd -Mode DryRun
```

默认入口是只读预检：不联网、不安装、不生成文件。若机器没有 Python 3.10+，会显示基础摘要和缺少详细检查工具的提示；安装模式会在项目内引导固定版本 Python。

阅读 [模型清单及许可证](docs/MODELS.md)，并确认自己符合 MiniMax H3 社区许可后，执行一次完整配置：

```powershell
.\Setup.cmd -Mode Install -AcceptLicense minimax-h3-community-license-agreement
.\Start.cmd
```

该参数是运行者的明确许可确认，不是脚本替用户同意。没有确认时，缺失的 H3 权重不会下载。全套默认覆盖全部 12 个当前生图/图像编辑/视频模型文件，以及所有 4 步/8 步加速档位。未使用的旧模型不会占用首次下载空间。

复用已有 ComfyUI 模型目录（将示例路径换成自己的目录）：

```powershell
.\Setup.cmd -Mode DryRun -ReuseModels 'D:\AI\ComfyUI\models'
.\Setup.cmd -Mode Install -ReuseModels 'D:\AI\ComfyUI\models'
```

安装时会完整校验已有文件的大小与 SHA-256，复用目录只读，不复制权重、不创建链接。已有 H3 文件通过校验时不会要求接受一次新的下载。若仍缺 H3 文件，命令会列出需要的许可参数。`-VerifyExisting` 可让预检也执行完整哈希检查；普通预检只报告文件大小匹配，不能视为完整验证。

## 配置与目录

安装器将 Python、Node、ComfyUI 和缓存放在项目中，不改变全局 PATH、不安装全局软件、不重启服务。Python 包使用 89 个精确 wheel URL 和哈希；ComfyUI 固定官方提交；Electron 依赖使用已有 `package-lock.json`。

| 路径 | 用途 | 入库 |
|---|---|---|
| `electron/`、`studio_*.py`、`pipeline/` | 应用与本地工作流代码 | 是 |
| `models.manifest.json`、`runtime.lock.json`、`requirements.windows.lock` | 来源、版本、大小、哈希 | 是 |
| `config/runtime.example.json` | 无密钥配置模板 | 是 |
| `config/runtime.local.json` | 用户自己的本地路径 | 否 |
| `runtime/`、`.venv/`、`models/`、`cache/` | 自动安装环境和权重 | 否 |
| `data/`、`exports/` | 项目记录、输入输出、导出包 | 否 |

独立克隆无需原来的游戏项目。精灵图可导出独立 Godot 预览工程；无需安装 Godot 就能完成前三个阶段。原有布局兼容回退保留，但独立导出默认不写入任何旧游戏。

## 可复现范围与验证

固定环境：Python **3.13.14**、Node **24.18.0**、ComfyUI **v0.33.1**、PyTorch **2.13.0+cu130**。详细来源及兼容检查见 [安装与故障说明](docs/SETUP.md)、[运行时证据](docs/evidence/runtime.json)。锁定清单的全部 100 条启用依赖约束已核对，无冲突。

模型的 SHA-256 来自固定版本的 Hugging Face LFS 元数据。87 个 Python wheel 哈希经官方元数据独立验证；`torch` 和 `torchvision` 两个归档哈希来自现有 portable 安装的 `direct_url` 记录，官方地址和依赖元数据已核实，但没有独立取得官方归档哈希。该来源限制保留在证据中。

已用小型本地 HTTP fixture 验证续传、断线重试、错误 Range、校验失败、已有文件保护和路径越界；路径适配测试禁止调用模型或启动服务。**未实跑全新安装、约 91 GiB 下载或真实生成**，不能将静态兼容核验视为 GPU 端到端验证。

```powershell
python -B -m unittest discover -s tests -p 'test_*.py'
python -B scripts/audit_release.py
```

发布检查会检查 Git 暂存内容和全部可达历史，拒绝权重、真实配置、私人目录、链接、大文件和疑似秘密。CI 仅进行代码/fixture/构建检查。

现有用户代码与图标未附单独开源许可证；公开仓库不替代软件授权声明。第三方代码、运行时和模型保留各自许可证，详见 [第三方说明](THIRD_PARTY.md)。
