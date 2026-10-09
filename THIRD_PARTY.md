# 来源与授权范围

本仓库发布应用源代码、工作流构建器和配置脚本，不打包模型权重、Python/Node/Electron/ComfyUI 二进制或依赖目录。

- [ComfyUI](https://github.com/Comfy-Org/ComfyUI)：GPL-3.0；安装时拉取固定官方 commit。它的许可证保留在下载的源目录中。
- [uv / Python Build Standalone](https://github.com/astral-sh/uv)：官方发行与各自许可证；来源和哈希见运行时证据。
- [CPython](https://www.python.org/psf/license/)、[Node.js](https://github.com/nodejs/node/blob/main/LICENSE)、[Electron](https://github.com/electron/electron/blob/main/LICENSE)：运行时各自授权；npm/PyPI 的各包许可证随安装保留。
- Qwen 和 Lightning：上游模型卡标明 Apache-2.0；下载页面、固定 revision、文件哈希在模型清单中。
- MiniMax H3：使用社区许可证。下载需要显式确认，不保证所有地区、用途或商业规模均适用。
- H3 Turbo V4：Abiray 的第三方 Comfy 重打包；模型卡标明 H3 社区许可，但指向的独立 LICENSE 文件缺失。README 和模型证据明确保留这项来源限制；本仓不再分发该权重，也不声称另获授权。

`pipeline/` 复制自角色工坊现有的本地管线代码，移除了对外部游戏目录和私有素材的依赖。没有 vendoring ComfyUI 或第三方 custom nodes。

`studio.png` 和 `studio.ico` 为已有应用中的小型界面图标。原项目没有记录其独立来源；本次没有重新标注为第三方商标或添加新的版权许可。项目现有用户代码没有单独 LICENSE，本次没有擅自选择 MIT/Apache/GPL 等软件授权。
