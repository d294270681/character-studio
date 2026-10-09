# 安装、预检与故障恢复

## 入口

`Setup.cmd` 默认 `-Mode Check`，与 `-Mode DryRun` 一样只读。`-Mode Install` 才进行安装。默认覆盖全部 12 个当前工作流权重；`-IncludeLegacy` 可额外覆盖保留的 Z-Image helper 的 3 个资源，但界面没有 Z-Image 入口。

其他参数：`-ReuseModels <目录>` 指定现有模型根目录；在 PowerShell 脚本入口可用字符串数组传多个根目录。`-VerifyExisting` 在预检时做完整 SHA-256；`-ModelsOnly` 仅处理模型和本地路径配置，不安装运行时。模型下载直接使用无需登录的公开链接，不读取 HF token。安装器不处理云端付费生成服务。

模型根目录按配置顺序优先。若第一个同名文件损坏，即使后面目录另有副本也会停止：运行时也会首先找到前者，安装器不能误报可用。请调整本地配置顺序或人工移走错误文件后重试。

## 安装顺序与固定来源

1. 检查架构、Git、NVIDIA 驱动、目录链接、已有文件、磁盘余量和模型许可证。
2. 从 Astral 官方 GitHub release 下载固定 uv ZIP，核对 SHA-256，提取到 `runtime/bootstrap`。
3. 由固定 uv 的官方 catalog 获取 CPython 3.13.14，安装到 `runtime/python`；创建独立 `.venv`，不会修改注册表、用户 PATH 或系统 Python。
4. 使用 `requirements.windows.lock` 的明确 wheel URL、SHA-256、`--no-index` 安装 89 个锁定包并运行依赖检查。禁止源码构建和静默升级。
5. 在 `runtime/ComfyUI` 获取指定官方 Git commit。已有目录若 origin、commit 或代码不匹配即停止，不 reset、不更新现有安装。ComfyUI 的原生节点已覆盖全部工作流，启动禁用自定义节点和云 API 节点。
6. 安装固定 Node ZIP、`npm ci` 和界面构建。所有缓存和依赖保留在仓库的忽略目录内。
7. 复用完整校验通过的权重，顺序下载缺失文件；创建本地路径配置（已有配置保持原样）。安装不启动服务，不触发生成。

`runtime.lock.json` 是简洁运行锁；`docs/evidence/runtime.json` 保留核验方式与限制。Node 的 SHA 来自 nodejs.org，uv/托管 CPython 来自 Astral 官方 release/catalog，模型来自固定 Hugging Face 提交。两项 PyTorch 归档哈希的本地溯源限制见 README；首次安装校验不匹配会停止，不绕过检查。

## 空间与硬件

模型合计 98,185,654,006 bytes（91.44 GiB）。预检按真正缺失的文件、可验证的断点文件、25 GiB 运行时/安装缓存预算和 5 GiB 余量计算空间。既有权重目录只读，不占新副本空间。哈希校验会顺序读取完整文件，通常需要几分钟。

固定 CUDA wheel 为 `cu130`，需要支持 CUDA 13 的 NVIDIA 驱动；按照 [NVIDIA 兼容性表](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)，预检拒绝低于 580 系列的驱动。安装器输出 `nvidia-smi` 的驱动及显存信息，不安装/升级驱动。满足这个最低系列要求不保证所有 GPU/特性兼容；显存和运行内存不足仍可能导致推理失败。本次未做新环境 GPU 推理验证。不能使用 CUDA 的机器应先完成独立兼容验证，再修改整个锁定组合。

## 失败会保留什么

- 网络中断：权重留在 `*.part`，伴随 `.part.json` 绑定下载 URL、大小和哈希；再次执行继续 Range 请求。
- 服务端拒绝 Range、返回不正确的长度/范围：停止并保留断点，不把错误数据追加到文件。
- 完整文件或断点 SHA-256 不符：保留文件并明确报错。请人工确认、移动错误文件及对应 sidecar 后重试；安装器不会覆盖它。
- HTTP 401/403：停止，提示访问或许可问题；不索取、读取或保存 token，也不展示可能包含临时凭证的重定向 URL。
- 已有环境版本不符：停止；不删除或更新该目录。请使用新的克隆目录，或人工备份后调整。
- `.extracting`：保留中断的解包目录。确认没有安装进程后，检查并移走该目录，再重试。
- `.setup-state/bootstrap.lock` 和 `install.lock`：分别保护 Windows 引导入口与 Python 安装阶段，防止同时写入。崩溃留下的锁不会被自动抢占；确认进程已结束后才能删除对应锁文件。
- 原有 `config/runtime.local.json`：永不覆盖；安装结束提示核对路径。完整安装新环境不会自动切换到用户既有外部服务。
- 原有布局首次创建本地配置时：保留既有角色项目和输入/输出目录，不读取其中的项目内容或服务凭据。

不建议在已运行的角色工坊上重新配置环境。执行安装前自行关闭使用该克隆环境的应用；脚本不会停止任何现有服务。

## 不下载的模型

完整磁盘盘点见 `docs/evidence/models.json` 和 [模型清单](MODELS.md)。未被调用的 H3 REF2VA、音频 VAE、预览 TAE、来源未核实的 LoRA 和备份都不属于当前工作流下载集合。没有额外放大、ControlNet、背景去除或独立 CLIPVision 权重需求。
