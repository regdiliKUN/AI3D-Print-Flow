# AI3D Print Flow

把 B 站视频《把AI生成的图片变成真实的3D打印模型！100%免费本地运行工作流分享》里的流程，做成一个 **Windows 本地控制台 + 可一键启动的包**。

目标不是重新实现 3D 模型，而是把官方开源工作流串起来：

```text
Qwen-Image 2.1 文生图
        ↓
TRELLIS.2 / Pixal3D 单图转 3D
        ↓
WTiVo 水密体素重建 + Quad Reconstruct + LODTailor + Fast Merge
        ↓
Blender 删除碎块 / 补洞 / 缩放到目标毫米 / 导出 STL
        ↓
CHITUBOX 加支撑 / 切片 / 光固化打印
```

控制台负责：环境检测、官方安装器下载与启动、**可选的一键部署整条工作流**、实时进度/断点续跑、工作流参数注入、GLB 后处理、STL 水密校验、目录与设置管理、桌面快捷方式，以及**部署后自检/问题诊断**。

> 模型权重不在压缩包里。首次部署时由官方安装器从 Hugging Face / GitHub 下载，基础流程约 35–50 GB；Qwen 图像模型另约 25 GB，作为可选步骤。
>
> **v2.0.1 修好视觉模型的鉴权与解析边界**：新增可选 Bearer API Key（只写不读，页面只看到 `vlmHasKey`）；视觉模型返回 JSON / Markdown 代码块时也能正确拆出主体、风格与细节；显式填写的模型名不再要求出现在 `/models` 列表里；PNG 透明通道改为按块解析，超大图片在解码前拒绝。
>
> **v2.0.0 把「输入」升级为一等公民**：同一页支持文字、图片和一个 `.txt` 提示词文件；提示词会先规范成「单一紧凑主体 + 一体化底座 + 可打印细节」，并解释哪些描述必然翻车；图片导入后立刻给出分辨率、画幅、主体占比、锐度与 0–100 适配度；多张图进入候选池，可随时切换。还新增了**可选的本地视觉模型**——用 Ollama / LM Studio 把图片反推成提示词，形成「图 → 文字 → 图 → 3D」闭环。不配置视觉模型时，其它功能完全不受影响。详见 [docs/多模态输入.md](docs/多模态输入.md)。
>
> **v1.6.0 把「选图 → 生成网格」拆成看得懂的三步**：选中图片后立刻显示缩略图和文件名，未选图时「② 创建水密工作流」按钮保持禁用；工作流创建好后，页面直接列出在 ComfyUI 里打开哪个文件、点哪里 Run、回来点哪个按钮。同名图片重复上传不再覆盖旧文件（自动加短后缀），上传与创建工作流期间有进度提示且不会重复提交。
>
> **v1.5.0 新增原生 Windows 启动器 `AI3D-Print-Flow.exe`**：双击即可启动本地控制台，桌面快捷方式现在直接指向这个 exe，不再指向 `start.cmd`。exe 仍是轻量启动器，内部使用包内 `runtime\node.exe`，所以不是单文件内嵌 Node 的发行版。
>
> **v1.4.0 修复了「安装器提示 ComfyUI-Easy-Install 已存在并退出」的真实问题**：现在只要目录缺少 `ComfyUI\main.py` 或 `python_embeded\python.exe` 中的任意一个，就视为不完整安装，先改名为 `.incomplete-<时间>` 再运行官方安装器。页面新增「部署方式」选择（一键部署 / 手动分步）、精确同名模型复用，以及部署后自检面板。
>
> **v1.2.0 起支持「一键部署」**：自动完成 ComfyUI → PyTorch 2.8 → TRELLIS.2 → 水密节点/模型 → 工作流。已完成的步骤会跳过，失败或取消后再次点击会继续，不需要手动点安装向导。下载和安装都有实时进度条、速度、剩余时间与日志。v1.2.0 的 47 项优化见 [docs/优化记录-v1.2.0.md](docs/优化记录-v1.2.0.md)。
>
> **v1.3.0 做了 25 轮针对性迭代**：修掉「安装动作抛错后任务永久卡住」「上传文件名可逃出工作目录」「同一秒生成的 workflow 互相覆盖」等真实缺陷，补齐历史产物列表、结构化进度、稳定错误码与 9 组回归测试。逐轮记录见 [docs/迭代记录-v1.3.0.md](docs/迭代记录-v1.3.0.md)。


---

## 1. 三分钟上手

### 第一次使用

1. 把 ZIP 解压到磁盘，例如 `D:\AI3D-Print-Flow`。不要直接在 ZIP 里运行。
2. 双击 **`AI3D-Print-Flow.exe`**。这是原生 Windows 启动器，会自动打开浏览器。
3. 浏览器打开 `http://127.0.0.1:17860/`。在「环境部署」顶部选择 **「一键部署」** 或 **「手动分步」**。默认是一键部署；已完成的步骤会自动跳过。
4. 一键部署时，按需勾选「同时下载 Qwen 模型（约 25 GB）」。「自动复用本机同名模型」默认开启，只匹配完全相同的文件名，不会把 Ollama / Hugging Face 聊天模型当成图像或 3D 权重。
5. 点 **「开始一键部署」**，等待进度走到 100%。期间可以展开日志，也可以点「取消部署」；之后再次点击会从断点继续。
6. 结束后会自动运行 **「部署后自检」**。先处理红色阻塞项；没有阻塞项时点「启动 ComfyUI」，再按第 5 节跑第一条龙。

> 想直接进入部署页，也可以双击 `首次部署.cmd`；它等价于从命令行运行 `AI3D-Print-Flow.exe --deploy`。日常启动仍推荐 exe。
>
> 不想用一键部署、想自己控制每一步时，切换到「手动分步」，按 01–05 操作。两种方式的结果相同。
>
> 如果 `ComfyUI-Easy-Install` 文件夹缺少 `ComfyUI\main.py` 或 `python_embeded\python.exe` 中的任意一个，新版本会先把它改名为 `ComfyUI-Easy-Install.incomplete-<时间>`，再运行官方安装器。旧目录不会删除。

### 以后每次使用

#### 选择图片后怎样开始生成水密网格

1. 在「图片 → 水密 3D 网格」选择或拖入 PNG / JPG / WebP。导入成功后会显示图片预览、文件名和下一步提示；导入失败会在卡片内显示原因。
2. 选择 1K / 1.5K / 2K 档位，点击「② 创建水密工作流」。这一步准备图片与参数，尚未启动网格计算。
3. 按卡片里新出现的说明打开 ComfyUI，在 Workflows → PixelArtistry 中打开页面列出的具体 JSON 文件，再点击 **Run（运行）**。ComfyUI 未启动时先点「启动 ComfyUI」。
4. 等运行完成并保存 GLB 后，回到本页点「运行完成后：导入最新 GLB」，再运行 Blender 后处理。

重新选择图片或更换档位后，需要重新创建工作流。同名导入会保留原文件并使用新文件名保存。

#### 启动控制台

双击 **`AI3D-Print-Flow.exe`**，或桌面快捷方式。桌面快捷方式的目标就是这个 exe（无参数），不是 `.cmd`。

**请保持启动窗口打开**：关闭窗口会停止本地服务，页面会显示「本地服务连接中断」。图片和模型不会上传到任何服务器。

### 创建桌面快捷方式

双击 **`创建桌面快捷方式.cmd`**，或点页面底部「创建桌面快捷方式」。

生成的快捷方式名为 `AI3D 打印工作流.lnk`。它的目标是包体根目录里的 `AI3D-Print-Flow.exe`，不带参数，图标也从 exe 读取。右键它 → **打开文件所在的位置**，会直接定位到包体根目录。

---

## 1.0 v2.0.0 更新（多模态输入 + 提示词工作台 + 可选视觉模型；含 v2.0.1 补丁）

这次不再只服务「已经有一张图」的人，而是把入口扩成三种：一句话、一张图、
一个 `.txt` 提示词文件。重点不是多加几个输入框，而是让输入在写进 ComfyUI
之前就可判断、可解释、可回退。

- **提示词工作台**
  - 主体 / 风格 / 规避项三段式输入，字符计数与 4000 上限同步服务端。
  - 「检查最终提示词」显示模型真正收到的文本：自动补「单一紧凑主体、正面视角、
    一体化底座」，自动去重，并把规避项并入正向提示词。
  - 解释为什么没有负向提示词：内置 Qwen 工作流 CFG=1，负向提示词不生效。
  - 五类自动提醒：多主体、文字/水印、透明/发光、细长结构、复杂背景；只提醒，
    不拦截。
  - 五个模板、随机种子、`.txt` / `.md` 导入（第一行主体，其余风格）。
- **图片适配度分析**
  - 服务端解析 PNG / JPEG / WebP 真实文件头（扩展名改名也骗不过），读出宽高、
    位深、透明通道。
  - 浏览器用 canvas 抽样 128×128，补主体占比、触边比例、锐度、对比度、透明占比。
  - 输出 0–100 分与 `ok / warn / risk` 分级，每条 finding 都带「原因 + 改法」。
  - 分辨率、画幅、压缩、主体过小/过满、触边、模糊都会分别扣分并说明。
- **候选图池**
  - 一次拖入多张，`Ctrl+V` 直接粘贴截图；默认保留最近 8 张。
  - 同名文件不覆盖，自动追加 6 位后缀；缩略图角标显示适配度。
  - 点缩略图切换当前图片，点 × 只删除 `workspace/input` 里的副本。
- **可选视觉模型（看图写提示词）**
  - 支持 Ollama / LM Studio 等 OpenAI 兼容端点；设置里可填地址、模型名与可选 API Key。
  - 自动从 `/models` 里挑 VL 模型；显式填写的模型名优先，不要求出现在列表中。
  - 识别结果优先按 JSON、其次按「主体 / 风格 / 细节」三段回填，可直接改词再生成。
  - API Key 只写不读，页面和诊断接口只看到 `vlmHasKey`，不会回显明文。
  - 空地址 = 明确关闭，不会后台探测端口。
- **更好用**
  - 常驻「下一步」引导条：环境 → 输入 → 网格 → 后处理 → 打印，只显示当前最该做的一件事。
  - 任务失败卡片：重试 / 复制错误 / 忽略；`Ctrl+Enter` 执行当前下一步。
  - 页面未捕获异常自动写入 `server.log`，复制诊断信息时带上前端现场。
- **更一致**
  - 档位、上传上限、候选池大小收敛到 `app/lib/presets.mjs`，通过 `/api/state`
    下发给页面，前后端不再各写一套数字。
  - 新增 `workspace/text/` 保存导入的提示词原文。
- **可验证**
  - 新增 `test-multimodal.mjs`（38 项）与 `test-image-flow.mjs`，整套回归从 10 组
    增至 12 组。
  - 本机用 Ollama + `qwen2.5vl:7b` 实测「看图写提示词」：一张 1024×1024 角色图
    返回结构化主体/风格/细节，首次加载约 38 秒。
- **v2.0.1 补丁**
  - 视觉模型新增可选 Bearer API Key，只写不读；`/api/state`、`config.save`
    响应和诊断信息都只返回 `vlmHasKey`，不回显明文。
  - 识别结果优先按 JSON / Markdown 代码块解析，再回退三行格式；`subject`、
    `style`、`detail` 中英文字段都认。
  - 显式填写的视觉模型名不再要求出现在 `/models` 列表里，兼容隐藏模型列表的
    推理服务。
  - PNG 透明通道改为按块解析 `tRNS`，不再把 IDAT 压缩数据里的同名字节误判为
    alpha；单边 > 20000 px 或总像素 > 100 MP 的图片在解码前返回
    `E_IMAGE_TOO_LARGE`。
  - 图片分析只读文件头（最多 4 MB），不再把整张 40 MB 原图读进内存。

## 1.1 v1.6.0 更新（图片预览 + 三步引导）

这次补的是首屏最容易卡住的地方——「图选好了，然后呢」。

- **选中图片立即预览**：拖入或点选后直接显示缩略图与文件名，标题同步变成「点击更换图片，或拖入另一张」。格式、大小、空文件不合格时，页面提示和 toast 会同时说明原因。
- **三步引导常驻页面**：
  - ① 选择图片 → 导入成功后显示预览和文件名；
  - ② 选好显存档位，点击「② 创建水密工作流」（未选图或正在导入时按钮禁用，文案随状态切换：正在导入图片… / 正在创建工作流…）；
  - ③ 打开 ComfyUI → 在 Workflows → PixelArtistry 中加载页面给出的那个 JSON → 点 Run（运行）→ 跑完回到本页点「运行完成后：导入最新 GLB」。
- **同名上传不再覆盖**：上传同名图片时自动追加 6 位随机后缀，既保留之前的输入，也避开 Windows 对正在使用文件的占用（旧版在「选的就是工作目录里那张图」时会写入失败）。
- **参数变化会清空已准备工作流**：换图片或改档位后，③ 区块自动收起，避免拿旧参数直接去 Run。
- **新增回归测试**：`npm run test:image-flow`（`scripts/test-image-flow.mjs`），覆盖选图后的预览、按钮禁用态与工作流就绪提示。

## 1.2 v1.5.0 更新（原生 exe 启动器）

- 新增 `AI3D-Print-Flow.exe`：双击即可启动本地控制台，不再需要先点 `.cmd`。
- 桌面快捷方式现在直接指向这个 exe，无参数，图标从 exe 读取；重新运行创建脚本会更新旧快捷方式。
- `start.cmd` / `启动 AI3D 打印工作流.cmd` 保留为兼容入口：存在 exe 时优先转调 exe，只有 exe 缺失时才回退到内置 Node。
- 启动器会转发命令行参数，例如 `AI3D-Print-Flow.exe check`、`AI3D-Print-Flow.exe start --deploy`、`AI3D-Print-Flow.exe postprocess ...`。`--deploy` / `--no-open` / `--port` 会自动按 `start` 处理。
- 启动失败时窗口会保留并显示原因；正常关闭窗口仍会停止服务。
- 启动器依赖 .NET Framework 4.x（Windows 10/11 通常自带），并且仍是轻量包装：必须和 `runtime\node.exe`、`app\` 一起分发，不是单文件内嵌 Node。
- 需要重新编译时运行 `powershell -ExecutionPolicy Bypass -File scripts\build-launcher.ps1`，然后重新运行 `scripts\create-shortcut.ps1` 更新快捷方式。
- 打包脚本会先编译 exe，`verify-package.ps1` 会检查 exe 存在且 `--version` 与 `PACKAGE_INFO.json` 一致。

## 1.3 v1.4.0 更新（部署失败修复 + 部署后自检）

这次先修真实故障，再补可选的一键部署和排错闭环。

- **修掉「安装器提示 ComfyUI-Easy-Install folder already exists 并退出」**
  - 根因：旧代码只把缺少 `ComfyUI\main.py` 的目录当成不完整；实际现场是 `main.py` 在，但 `python_embeded\python.exe` 被上次中断或杀毒软件隔离删掉了。官方安装器看到同名目录仍然直接退出。
  - 修复：`ComfyUI-Easy-Install` 只要缺少 `ComfyUI\main.py` 或 `python_embeded\python.exe` 任意一个，就视为不完整。一键部署和「运行安装器」都会先把旧目录改名为 `.incomplete-<时间>`，保留现场再继续。
  - 安装器结束后还会主动检查这两个文件；若 `python.exe` 消失，会提示优先检查火绒 / Windows Defender 的隔离区与白名单，而不是只报一个退出码。
- **一键部署变成可选，而不是替代手动步骤**
  - 「环境部署」顶部新增「一键部署 / 手动分步」选择，默认一键部署，选择会记住。
  - 一键流程仍自动串联 ComfyUI → Torch 2.8 → TRELLIS.2 → 水密节点/模型 → 工作流；可勾选 Qwen，失败或取消后可断点续跑。
- **精确同名模型复用**
  - 默认开启「自动复用本机同名模型」，扫描当前/常见 ComfyUI 模型目录与 Hugging Face 缓存，只接受文件名和大小匹配的权重。
  - 同盘用硬链接，不重复占空间；跨盘或 FAT/exFAT 无法硬链接时会明确警告并给出手动复制目标，不会静默复制几十 GB。
  - Ollama、Hugging Face 聊天模型、旧 Stable Diffusion 检查点都与 Qwen-Image 2.1 / TRELLIS.2 架构不同，不能直接复用；自检会列出本机模型并解释原因。
- **部署后自检 / 问题诊断**
  - 新增「部署后自检」面板，一键检查安装完整性、Torch/CUDA、节点、模型、工作流、Blender/CHITUBOX、磁盘与服务状态。
  - 报告按 `fail / warn / info` 分级，每项带稳定代码、原因和处理方法；可复制为文本报告。
  - 一键部署成功或失败后会自动跑一次；也可以随时点「重新自检」。
- **可验证**
  - 新增 `test-install` 回归测试，覆盖「只有 main.py」「只有 python.exe」「完整目录」「改名后保留文件」等场景。
  - 测试总数从 9 组增加到 10 组，`runtime\node.exe scripts\test-all.mjs` 全部通过。

## 1.4 v1.3.0 更新（25 轮迭代）

本轮不新增功能板块，而是把「能跑通」收紧到「出错时说得清、修得回、验得了」。

- **修掉的真实缺陷**
  - 交互式安装动作（运行安装器 / 切换 Torch / 装 TRELLIS.2 / 装水密节点）抛错时，任务会永久停在 `running`，之后所有安装都会被「任务正在进行中」挡住，只能重启服务。现在失败即落为 `error`，可直接重试。
  - 上传文件名来自客户端，`..` 可以逃出 `workspace/input`；`CON`/`NUL` 等 Windows 保留名与尾部点号会让落盘失败。现在统一清洗并做目录包含校验。
  - 同一秒内生成两个工作流时，第二个会静默覆盖第一个。现在自动加序号。
  - 向 `ComfyUI/input` 注入图片会覆盖同名文件（可能是别的工作流正在用的图）。现在仅在内容相同（同尺寸）时复用，否则改名。
  - 后台刷新会把手填的目标高度、修复模式、设置抽屉里的路径改回旧值。现在手改过的字段不再被覆盖。
  - `--decimate` 传空值会变成 0（等于不减面）并静默通过；现在非法参数直接报错。
- **更好用**
  - 结果卡片新增「最近产物」，列出工作区里的 STL 与报告，可直接下载，不必去资源管理器翻。
  - Blender 后处理改为结构化进度标记（`PROGRESS <百分比> <阶段>`），进度条不再靠中文字符串匹配，阶段变化也不会卡住。
  - Blender 失败时也会写出报告 JSON（含 traceback），界面直接显示真实原因，例如「GLB 里没有可打印的面」。
  - STL 检查新增「单位可疑」提示：最大尺寸不足 1 mm 时直接告诉你怎么改，对应最高频的「切片里模型特别小」。
  - 拖放区可用 Tab 聚焦、Enter / 空格打开文件选择框；焦点描边可见。
- **可诊断**
  - 所有错误响应统一为 `{ ok:false, code, status, error, hint }`，`code` 是稳定值（`E_BUSY` / `E_DISK_FULL` / `E_TOO_LARGE` / …），不再需要靠中文文案判断。
  - `/api/diagnostics` 增加环境检测的分项耗时（GPU / 磁盘 / Git / Torch / Blender），且只返回缓存快照，不会自己触发 10 秒探测。
  - 启动时在 `server.log` 写入版本、端口、PID 与包体路径。
  - 上传中断残留的 `.upload-*.part`、写配置残留的 `config.json.tmp-*` 会在启动时按 24 小时阈值清理。
- **可验证**
  - 新增 `test-util`、`test-stl`、`test-report`、`test-errors`、`test-api` 五组测试，加上原有四组共 9 组，`node scripts/test-all.mjs` 一次跑完。
  - 错误契约单独成测：校验类错误必须是 4xx，`TypeError` 之类引擎级异常必须是 500 + `E_INTERNAL`，Node errno 不会作为错误码泄漏。
  - 版本号收敛到 `package.json` 单一来源，页面底部、`/api/health`、下载 User-Agent 全部读同一处。

## 1.5 v1.2.0 更新（47 项优化）

- **可恢复**：下载连接/流中断自动重试；Range 断点续传与 `.part.json` ETag/URL 校验；416 断点校验；磁盘空间预检；429 `Retry-After`；取消后不会被 `fail()` 覆盖。
- **可诊断**：`/api/health` 返回版本/PID/内存/运行任务数；新增 `/api/diagnostics` 诊断快照；连接横幅可一键复制诊断信息，剪贴板不可用时自动下载 `.txt`；`Failed to fetch` 会附带「检查启动窗口 / 刷新页面 / 看 server.log」的提示。
- **更安全**：配置白名单与原子写入、损坏配置隔离、Host/Origin 校验、仅接受 JSON 操作请求、上传/下载限流与 Range、上传文件头校验、Permissions-Policy/COOP/CSP、日志轮转、优雅关闭。
- **更快**：Git 探测不再依赖 PATH；环境检测的 nvidia-smi/磁盘/Git/Blender/ComfyUI 探测并行；同一时刻的检测请求复用 in-flight Promise。
- **更好用**：任务轮询按页面可见性降频；上传显示真实百分比；设置抽屉焦点陷阱、ARIA 进度和减少动画；CLI 新增 `deploy`；JS/CSS 版本查询串避免覆盖安装后仍加载旧页面。
- **可验证**：新增下载续传、任务取消、配置校验、HTTP 安全 smoke test；打包脚本生成 `PACKAGE_INFO.json`，并有独立的 `verify-package.ps1` 检查诊断接口、安全头、版本一致性和空 workspace。
- 完整清单与未验证项见 [docs/优化记录-v1.2.0.md](docs/优化记录-v1.2.0.md)。

## 1.6 v1.1.0 更新

- 新增「一键部署」：自动串起 ComfyUI、Torch 2.8、TRELLIS.2、水密节点/模型、工作流，可选 Qwen 模型。
- 新增实时进度：阶段、百分比、下载字节/总量、速度、剩余时间；安装器阶段显示不确定进度和已用时间。
- 新增取消与断点续跑：取消不会误报失败；再次点击会跳过已完成步骤。
- 新增连接恢复：请求超时/断网会重试，页面顶部显示「本地服务连接中断」和「重试连接」。
- 新增诊断：`/api/health`、`logs/server.log`、慢请求/500 日志、全局异常保护。
- 新增下载断点续传和重试；Qwen 模型可单独下载。
- 检测到 Git 已安装时，自动跳过官方安装器的 Git 升级步骤，减少 UAC 和等待。
- 检测到不完整的 `ComfyUI-Easy-Install` 目录时自动改名保留，避免重试被卡住。

---

## 2. 这个包能自动做什么

| 环节 | 控制台能做什么 | 仍需人工确认 |
|---|---|---|
| 部署方式 | 顶部选择「一键部署」或「手动分步」，默认一键，选择会记住；手动分步仍保留 01–05 全部按钮 | 首次安装仍需 UAC/杀软放行 |
| 一键部署 | 按 ComfyUI → Torch 2.8 → TRELLIS.2 → 水密节点/模型 → 工作流顺序自动执行；跳过已完成步骤，失败/取消后可断点续跑；可复用本机精确同名模型 | 磁盘空间、网络、杀软拦截 |
| 部署后自检 | 检查安装完整性、Torch/CUDA、节点、模型、工作流、Blender/CHITUBOX、磁盘与服务；按阻塞/注意/提示分级并给出处理步骤 | 自检不能替代实际跑一遍工作流 |
| 实时进度 | 阶段、百分比、已下载字节、总大小、速度、剩余时间、不确定进度动画；任务可取消 | 大文件下载速度取决于网络 |
| 环境检测 | 检测 Windows、NVIDIA 显卡/显存、内存、磁盘、Git、Python/PyTorch/CUDA、ComfyUI、节点、模型、Blender、CHITUBOX | 驱动版本、杀毒软件拦截 |
| 文字输入 | 主体 / 风格 / 规避项三段式，五个模板，随机种子，最终提示词预览与风险解释 | 提示词质量仍取决于描述是否具体 |
| 图片输入 | 拖入、多选、`Ctrl+V` 粘贴；候选池切换；同名不覆盖 | 图片版权与主体完整性 |
| 图片分析 | 文件头解析真实尺寸/格式，canvas 统计主体占比、触边、锐度、对比度；0–100 适配度与改法 | 不能判断悬空结构、过薄特征是否可打印 |
| 文本提示词 | 导入 `.txt` / `.md`，第一行主体、其余风格；原文保存在 `workspace/text` | 一整段提示词需要自己拆分 |
| 视觉模型（可选） | 连 Ollama / LM Studio，把图片反推成主体/风格/细节；不可用时自动隐藏 | 需要本机已有 VL 模型，7B 级会误读排版与文字 |
| 下一步引导 | 常驻引导条按环境 → 输入 → 网格 → 后处理 → 打印推进；`Ctrl+Enter` 执行 | 仍以实际工作流结果为准 |
| ComfyUI | 下载官方 Easy Install ZIP、解压、自动运行安装器；检测到 Git 时跳过安装器里的 Git 升级 | 安装路径、UAC（仅首次装 Git 时） |
| Torch / TRELLIS.2 | 自动查找并运行 Add-ons 脚本，安装后验证 Torch 版本和节点目录 | 网络、脚本内下载 |
| PixelArtistry | 复制官方安装器并设置 `AUTO_DL=Y`，自动补模型；安装后校验必需模型 | 关闭 ComfyUI 后再运行 |
| Qwen 工作流 | 注入提示词、分辨率、CFG、步数、种子、输出前缀 | 在 ComfyUI 里点 Run，挑选图片 |
| 水密工作流 | 注入图片、Blender 路径、1K/1.5K/2K 显存档位、WTiVo 代理点、输出前缀 | 在 ComfyUI 里点 Run，检查正面/背面 |
| GLB 后处理 | 无头 Blender：删碎块、焊接、补洞/体素重建、缩放到 mm、居中、导出 STL、统计水密；阶段进度由脚本主动上报，失败也写报告 | 极端破洞仍需手动修 |
| STL 校验 | 流式统计三角面、尺寸、体积、边界边、非流形边；尺寸不足 1 mm 时提示单位可疑 | 切片软件里的最终检查 |
| 最近产物 | 列出工作区里的 STL 与报告，可直接下载或打开目录 | 长期归档需要自己整理 |
| CHITUBOX | 启动本机 CHITUBOX | 支撑、树脂、曝光、打印 |

---

## 3. 运行环境

### 必须

- Windows 10 21H2+ 或 Windows 11，x64
- NVIDIA RTX 20 系及以上（CUDA）
- 至少 8 GB 显存；推荐 12–16 GB
- 至少 16 GB 内存；2K 工作流推荐 32 GB
- 安装盘至少 45 GB（基础流程建议 80 GB；勾选 Qwen 模型建议 110 GB 以上）
- 最新 NVIDIA 驱动
- `AI3D-Print-Flow.exe` 使用 .NET Framework 4.x（Windows 10 21H2 / Windows 11 通常已自带，无需单独安装）
- 解压后的包体约 90 MB（含 Node 运行时），ZIP 约 33 MB；不要只复制 `app/` 子目录

### 版本硬约束

TRELLIS.2 的 WTiVo 预编译后端是按下面这组版本编译的，不要混用：

```text
Python 3.12
PyTorch 2.8.0 + CUDA 12.8
ComfyUI Easy Install（自带 Python 与 Git）
```

ComfyUI Easy Install 的 Torch 切换脚本会处理 PyTorch。不要自己用系统 Python 3.14 或 PyTorch 2.6 去装节点。

### 推荐但非必须

- Blender 4.2+，推荐 5.x。建议单独干净安装，不加第三方插件。
- CHITUBOX Free（光固化切片）。FDM 用户可以用自己的切片器。
- 7-Zip（解压大 ZIP 更稳）。

---

## 4. 包内目录

```text
AI3D-Print-Flow/
├─ AI3D-Print-Flow.exe        ← 日常启动（推荐，桌面快捷方式指向它）
├─ 首次部署.cmd               ← 第一次部署（可选，等价于 exe --deploy）
├─ 创建桌面快捷方式.cmd
├─ 启动 AI3D 打印工作流.cmd / start.cmd   ← 兼容入口，优先转调 exe
├─ deploy.cmd / create-shortcut.cmd        ← 英文别名
├─ README.md
├─ LICENSE
├─ THIRD_PARTY_NOTICES.md
├─ PACKAGE_INFO.json          ← 版本、构建时间、内置 Node 版本
├─ package.json
├─ launcher/
│  └─ Program.cs              ← 原生启动器源码
├─ app/
│  ├─ server.mjs              ← 本地 HTTP 服务（只监听 127.0.0.1）
│  ├─ cli.mjs                 ← 命令行：check / start / deploy / postprocess / workflow
│  ├─ lib/                    ← config 配置 · checks 检测 · jobs 任务 · installer 安装
│  │                            models 模型复用扫描 · doctor 部署自检 · workflows 注入
│  │                            postprocess 后处理 · stl 分析 · errors 错误码
│  │                            report 终端播报 · util · paths
│  └─ public/                 ← 控制台前端 + icon.ico
├─ blender/
│  └─ postprocess.py          ← 无头 Blender 后处理脚本
├─ config/
│  ├─ default.json            ← 默认配置
│  └─ config.json             ← 本机配置（首次部署生成）
├─ docs/
│  ├─ 视频知识总结.md
│  ├─ 部署指南.md
│  ├─ 参数与排错.md
│  ├─ 多模态输入.md           ← v2.0：三种输入、图片分析、视觉模型
│  ├─ 优化记录-v1.2.0.md
│  └─ 迭代记录-v1.3.0.md      ← v1.3.0 的 25 轮迭代记录
├─ runtime/
│  └─ node.exe                ← 内置 Node.js，无需另装
├─ scripts/
│  ├─ build-launcher.ps1      ← 编译 AI3D-Print-Flow.exe
│  ├─ deploy.ps1
│  ├─ create-shortcut.ps1
│  ├─ make-icon.ps1
│  ├─ package.ps1
│  ├─ verify-package.ps1
│  ├─ test-all.mjs            ← 一次跑完下面 12 组
│  ├─ test-config.mjs
│  ├─ test-jobs.mjs
│  ├─ test-download.mjs
│  ├─ test-util.mjs
│  ├─ test-stl.mjs
│  ├─ test-report.mjs
│  ├─ test-errors.mjs
│  ├─ test-install.mjs        ← 不完整 ComfyUI 目录识别与保留
│  ├─ test-api.mjs
│  ├─ test-image-flow.mjs     ← 选图预览、按钮禁用态、工作流就绪提示
│  ├─ test-multimodal.mjs     ← 文件头、提示词规则、候选池、VLM 降级
│  └─ smoke-test.mjs
├─ vendor/
│  ├─ pixelartistry/          ← 官方 MIT 安装器 + 4 个工作流
│  └─ comfy/                  ← Qwen / TRELLIS.2 官方模板
├─ workflows/                 ← 控制台生成的归档工作流
├─ workspace/
│  ├─ input/                  ← 上传的图片（候选池来源）
│  ├─ glb/                    ← 导入的 GLB
│  ├─ stl/                    ← 导出的 STL
│  ├─ reports/                ← Blender 报告 JSON
│  └─ text/                   ← 导入的 .txt / .md 提示词原文
└─ logs/
   ├─ server.log              ← 服务异常、慢请求、安装任务错误
   └─ 其他任务日志（如有）
```

---

## 5. 完整使用流程

### 5.1 首次部署

打开控制台后，先选择部署方式：

- **一键部署（默认，推荐）**：自动串完整条流程，适合第一次使用。
- **手动分步**：自己控制 01–05 的每个安装器，适合自定义路径或排查安装问题。

一键部署步骤：

1. 确认安装盘在「设置」里指向空间足够的目录（默认 `D:\AI3D`）。
2. 需要本地文生图就勾选「同时下载 Qwen 模型（约 25 GB）」；只用 TRELLIS.2 可以不勾。
3. 保持「自动复用本机同名模型」勾选（默认）。它只复用文件名和大小匹配的权重，同盘硬链接，不重复下载。
4. 点「开始一键部署」，等待进度条走完。阶段依次是：
   - ComfyUI Easy Install（下载 ZIP、解压、自动运行安装器）；
   - PyTorch 2.8.0 + CUDA 12.8（检测到已就绪会跳过）；
   - TRELLIS.2 + Pixal3D 节点；
   - PixelArtistry 水密节点与基础模型（自动补缺失模型）；
   - 4 个 PixelArtistry 工作流；
   - Qwen 模型（仅勾选时）。
5. 中途失败或取消，处理日志里的提示后再次点同一个按钮即可断点续跑；已完成的步骤会跳过。
6. 结束后会自动运行「部署后自检」：先处理红色阻塞项，再点「启动 ComfyUI」。

手动方式：按页面「环境部署」的 01–05 顺序操作，步骤见 [docs/部署指南.md](docs/部署指南.md)。

> 一键部署会检测 ComfyUI 是否在运行；安装 Torch/节点前如果 ComfyUI 开着，会提示先关闭。
>
> 检测到不完整安装目录时，会先改名为 `ComfyUI-Easy-Install.incomplete-<时间>`，不会直接删除，便于从隔离区恢复或排查。新版同时检查 `ComfyUI\main.py` 和 `python_embeded\python.exe`，不再漏掉「缺 python.exe」的半成品目录。

### 5.2 生成图片

1. 在「Qwen Image 2.1 文生图」里填写主体描述和风格提示词。
2. 选择 1K / 1.5K / 2K。
3. 点「生成提示词并写入工作流」。
4. 点「打开 ComfyUI」→ 左侧 **Workflows → PixelArtistry** → 打开刚生成的 `AI3D_Qwen_*.json`。
5. 点 Run。图片默认保存到 `ComfyUI/output/AI3D/Qwen_*`。
6. 选一张主体完整、背景干净、细节清楚的图。也可以用自己的图。

### 5.3 图片转水密网格

1. 把图片拖到「图片 → 水密 3D 网格」区域。
2. 选择 1K / 1.5K / 2K 预设。
3. 点「注入图片并生成水密工作流」。
4. 在 ComfyUI 的 **Workflows → PixelArtistry** 打开 `AI3D_*.json`。
5. 确认紫色 **Blender path** 节点是 `...\blender.exe`，路径不要带首尾双引号。
6. 点 Run。单图约 10–12 分钟，2K 可能更久。
7. 在 3D 预览里检查正面、背面、底部；有破洞就换种子重跑。

### 5.4 Blender 后处理

1. 点「导入 ComfyUI 最新 GLB」，或把 GLB 拖进页面。
2. 设置目标高度（默认 80 mm）、修复模式、减面比例。
3. 点「运行 Blender 后处理」。
4. 看结果卡片：水密、尺寸、三角面、体积、边界边、非流形边。
5. 下载 STL 或打开 `workspace/stl`。

### 5.5 CHITUBOX

1. 启动 CHITUBOX，导入 STL。
2. 如果模型仍然很小，把比例 `100` 改成 `10000`；本控制台通常已按 80 mm 缩放，不需要再改。
3. 抬高 2–3 mm，避免底面直接粘平台。
4. 加 Light 支撑，支撑类型可选 Cross/Branch；底座高度 2.0 mm。
5. 关闭「平台接触形状」，避免多出额外几何体。
6. 切片，检查每层岛，发送到打印机。
7. 打印后清洗、拆支撑、UV 固化。

---

## 6. 命令行

日常命令可以直接用启动器（推荐），在包根目录执行：

```bat
AI3D-Print-Flow.exe check
AI3D-Print-Flow.exe start --deploy
AI3D-Print-Flow.exe deploy --qwen
AI3D-Print-Flow.exe postprocess --input "D:\AI3D\dragon.glb" --height 80 --repair auto
AI3D-Print-Flow.exe workflow pixel --image "D:\AI3D\dragon.png" --preset 1.5k
AI3D-Print-Flow.exe workflow qwen --prompt "一条盘踞在圆形底座上的东方龙" --preset 2k
AI3D-Print-Flow.exe config
AI3D-Print-Flow.exe paths
```

启动器无参数时等价于 `start`；`--deploy` / `--no-open` / `--port` 等服务器参数也会自动补上 `start`。排错时仍可直接调用内置 Node，效果相同：

```bat
runtime\node.exe app\cli.mjs check
runtime\node.exe app\cli.mjs start --deploy
runtime\node.exe app\cli.mjs deploy --qwen
runtime\node.exe app\cli.mjs postprocess --input "D:\AI3D\dragon.glb" --height 80 --repair auto
runtime\node.exe app\cli.mjs workflow pixel --image "D:\AI3D\dragon.png" --preset 1.5k
runtime\node.exe app\cli.mjs workflow qwen --prompt "一条盘踞在圆形底座上的东方龙" --preset 2k
runtime\node.exe app\cli.mjs config
runtime\node.exe app\cli.mjs paths
```

如果系统已安装 Node 20+，也可以把 `runtime\node.exe` 换成 `node`。

本机回归测试（不会下载大模型，也不会改动本机真实配置）：

```bat
runtime\node.exe scripts\test-all.mjs
```

单组运行：

```bat
runtime\node.exe scripts\test-config.mjs    配置白名单、错误路径与原子写入
runtime\node.exe scripts\test-jobs.mjs      任务队列、取消与断点状态
runtime\node.exe scripts\test-download.mjs  断点续传、重试与 416
runtime\node.exe scripts\test-util.mjs      工具函数与文件名清洗
runtime\node.exe scripts\test-stl.mjs       STL 格式判定与单位提示
runtime\node.exe scripts\test-report.mjs    CLI 日志播报去重
runtime\node.exe scripts\test-errors.mjs    错误码契约（4xx / 5xx 分流）
runtime\node.exe scripts\test-install.mjs   不完整 ComfyUI 目录识别与保留
runtime\node.exe scripts\test-api.mjs       HTTP 接口与错误码
runtime\node.exe scripts\test-image-flow.mjs 选图预览、按钮禁用态与工作流提示
runtime\node.exe scripts\test-multimodal.mjs 文件头、提示词规则、候选池与 VLM 降级
runtime\node.exe scripts\smoke-test.mjs     安全头、上传、Range、静态缓存
```

`test-api` 与 `smoke-test` 会在临时目录里另起一份服务，配置指向空的安装目录，所以不会读写你本机的 `D:\AI3D`。

---

## 7. 配置

配置文件：`config/config.json`。删除它可恢复默认值。保存时会先写临时文件并原子替换，同时保留 `config.json.bak`；如果 JSON 损坏，会自动改名为 `config.json.corrupt-<时间>`，不会静默覆盖安装路径。

| 键 | 默认 | 说明 |
|---|---|---|
| `installRoot` | 空（自动选 `D:\AI3D` 或 `C:\AI3D`） | ComfyUI 安装根目录 |
| `comfyuiRoot` | `<installRoot>\ComfyUI-Easy-Install` | 含 `ComfyUI\main.py` 与 `python_embeded` 的目录 |
| `blenderPath` | 空（自动检测） | `blender.exe` 完整路径，不要带引号 |
| `chituboxPath` | `C:\Program Files\CHITUBOX\CHITUBOX.exe` | CHITUBOX 可执行文件 |
| `workspaceDir` | 空（包内 `workspace`） | 自定义工作目录 |
| `preset` | `1.5k` | 默认显存档位 |
| `targetHeightMm` | `80` | Blender 后处理目标最大高度 |
| `repairMode` | `auto` | `auto` / `fill` / `voxel` / `none` |
| `decimateRatio` | `0` | 0–1，0 表示不减面 |
| `port` | `17860` | 控制台端口；被占用会自动 +1 |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `vlmUrl` | `http://127.0.0.1:11434/v1` | 可选视觉模型的 OpenAI 兼容地址；留空即关闭 |
| `vlmModel` | 空 | 视觉模型名；留空自动从 `/models` 里挑 VL 模型；显式填写时不要求出现在列表 |
| `vlmApiKey` | 空 | 可选 Bearer 密钥；只写不读，页面只显示 `vlmHasKey` |

设置也可以直接在页面右上角「设置」里改。

---

## 8. 显存档位

| 预设 | 分辨率 | WTiVo 代理点 | 显存 | 说明 |
|---|---|---|---|---|
| 1K | 1024 | 8,000,000 | 6–8 GB | 低显存；细节最少 |
| 1.5K | 1536 | 12,000,000 | 8–16 GB | 视频作者推荐；速度/细节平衡 |
| 2K | 2048 | 25,000,000 | 16 GB+，内存 32 GB+ | 绕过 Quad Reconstruct；网格可达 4300 万面 |

2K 不是简单把 1.5K 放大。官方仓库明确说明：2K 下 Quad Reconstruct 的 2048 输出会让 WTiVo 网格膨胀到约 8500 万面（约 17 GB 内存），LODTailor 也无法在不破坏网格的情况下减面，所以 2K 工作流把该节点设为 bypass，直接用 25M 代理点得到约 4300 万面的水密网格。

---

## 9. 常见问题（先看这九条）

1. **控制台能打开，但 ComfyUI 一直「未找到」**：确认 `comfyuiRoot` 指向 `...\ComfyUI-Easy-Install`，并且该目录下同时有 `ComfyUI\main.py` 和 `python_embeded\python.exe`。缺任意一个都算不完整；点「部署后自检」可以直接看到缺哪个文件。
2. **WTiVo 报后端/CUDA 错误**：Python、PyTorch、CUDA 必须是 3.12 / 2.8.0 / 12.8。用 Easy Install 的 Torch 2.8 脚本切换，不要用系统 Python。
3. **STL 在 CHITUBOX 里很小**：Blender 的 1 单位没有毫米语义。视频里在 CHITUBOX 把比例 `100` 改成 `10000`；本控制台按 80 mm 自动缩放，若仍小，先检查后处理报告里的尺寸。
4. **点「重新检查」提示 `Failed to fetch`**：说明浏览器连不上本地服务，通常不是检测逻辑坏了。先确认启动窗口还开着；如果已关闭，双击 `AI3D-Print-Flow.exe` 或桌面快捷方式，然后刷新页面。连接横幅里的「复制诊断信息」会打包版本、路径、最近任务和日志尾部；剪贴板不可用时会自动下载诊断文件。仍然失败时看 `logs/server.log` 和浏览器 Console（F12）。
5. **一键部署失败/卡住**：展开一键部署日志，或点「打开服务日志」。结束后「部署后自检」会自动运行；红色项给的就是下一步。常见原因是网络中断、磁盘不足、ComfyUI 没关、安装器需要 UAC、杀软隔离了 `python.exe`。处理后再次点「继续部署（断点续跑）」，已完成的阶段会自动跳过。
6. **页面提示「任务正在进行中」（错误码 `E_BUSY`）**：说明已有同类任务在跑。等它结束，或先在任务栏点「取消」再重试。安装类任务彼此互斥（安装器 / Torch / TRELLIS.2 / 水密节点共用一把锁），避免两个安装器同时改同一个 ComfyUI。
7. **提示「文件内容与扩展名不匹配」**：上传会校验文件头（PNG / JPEG / WebP / GLB），把改过后缀的其它文件拦住。用原始导出的图片或 GLB 重试。
8. **本机已有 Ollama / Hugging Face / Stable Diffusion 模型，能直接复用吗？**：不能直接拿来跑这条工作流。Ollama 的 GGUF、HF 聊天模型和 SD 检查点与 Qwen-Image 2.1 扩散模型、TRELLIS.2 三维权重不是同一种架构。新版只在**文件名和大小精确匹配**时硬链接复用；自检的「本机模型复用检查」会列出本机模型并说明原因。Qwen 约 25 GB 和 TRELLIS.2 基础权重仍需单独下载/安装。
9. **安装器提示 `ComfyUI-Easy-Install folder already exists` 并退出**：这是旧版把「只有 `main.py`、缺 `python_embeded\python.exe`」的半成品目录当成完整安装导致的。v1.4.0 会先改名为 `.incomplete-<时间>` 再运行官方安装器。若改名也失败，关闭 ComfyUI / `python.exe`、资源管理器窗口，并检查火绒 / Windows Defender 隔离区；把 `D:\AI3D` 加入白名单后重试。升级后请重启一次本地服务（双击 `AI3D-Print-Flow.exe`），确认页面底部版本为 `2.0.1`。
10. **图片适配度多少才该继续？**：`ok`（通常 80 分以上）可以直接转；`warn` 可以继续，但先看 finding 里的改法；`risk`（低于 60 分或短边不足 256 px）建议换图。评分只覆盖能确定的事实，悬空结构、过薄特征仍要人看。
11. **视觉模型一定要装吗？**：不用。它只负责「看图写提示词」，不装时图片分析、候选池、工作流生成全部照常。要启用就装 Ollama 并 `ollama pull qwen2.5vl:7b`，在设置里填 `http://127.0.0.1:11434/v1`，点「检测连接」。地址留空表示关闭。
12. **导入 `.txt` 后提示词被拆成两段？**：这是设计行为：第一行作为主体，其余行作为风格与细节。若原文是一整段，建议先手动分成「主体一句 + 风格一句」再导入，生成效果更稳定。

更多问题见 [docs/参数与排错.md](docs/参数与排错.md)。

---

## 10. 已知缺失与不确定信息

- **完整安装链路尚未在目标机器跑完**：本机已验证控制台、下载续传、安全策略、任务状态、错误码契约，以及 **Blender 无头后处理整链**（用一个合成的立方体 GLB 跑通：导入 → 焊接 → 水密判定 → 缩放到 80 mm → 导出 STL → 分析，结果 12 三角面 / 512 cm³ / 水密）。ComfyUI / Torch 2.8 / TRELLIS.2 / PixelArtistry 的真实下载与安装仍需在目标网络和磁盘环境验证。
- **视觉模型只验证了 Ollama + qwen2.5vl:7b**：返回结构与降级路径已实测；LM Studio、远程 OpenAI 兼容端点、其它 VL 模型尚未逐家验证。7B 级模型会误读排版、文字和小道具，识别结果应视为可编辑草稿。
- **图片适配度是启发式评分**：分辨率、画幅、压缩、主体占比、锐度、对比度可以量化；「这个造型能不能打印」不能。悬空结构、薄壁、封闭空腔仍需人工检查。
- **`AI3D-Print-Flow.exe` 是轻量启动器，不是单文件应用**：它依赖 .NET Framework 4.x、同目录的 `runtime\node.exe` 和 `app\`。移动包体时要整体移动；只复制 exe 不能运行。首次运行若被 SmartScreen 拦截，点「更多信息 → 仍要运行」；若被杀软隔离，检查隔离区并把包体目录加入白名单。
- **真实 TRELLIS.2 输出尚未跑过**：后处理链路用合成几何验证，几十万面、带纹理、多松散块的真实 GLB 表现仍需现场确认。
- **Qwen 约 25 GB 模型尚未实际下载完**：下载器已通过本地断流、续传、416 场景测试，但大文件真实网络表现需现场确认。
- 视频没有给出完整提示词原文，只给了「紧凑单一主体 + 一体化底座 + 可打印细节」的公式；本包内置的是按该公式组合的默认提示词。
- 视频转写里 Qwen 2K 生成时间写成「473 秒」，结合 RTX 5080 的实际表现，可能是「47.3 秒」的口误/转写误差，文档中已标注不确定。
- 视频没有给出打印机型号、树脂型号、曝光时间、层厚等参数；CHITUBOX 部分只能给通用起点。
- 视频提到的多视图工作流不在 PixelArtistry 官方仓库的 4 个工作流里，本包未内置；单视图主流程不受影响。
- 视频转写是本地 whisper.cpp 自动转写，专有名词有误差（如「Q关Image」「Trailers 2」「Gitubox」），文档已按官方名称校正。
- **工作区不会自动清理**：STL 与报告会一直累积（`workspace/stl`、`workspace/reports`）。「最近产物」只列出最新 10 条，长期归档需要自己整理。

完整时间戳、参数和注意事项见 [docs/视频知识总结.md](docs/视频知识总结.md)。

---

## 11. 许可与致谢

- 本包的控制台、脚本、文档：MIT，见 [LICENSE](LICENSE)。
- PixelArtistry 安装器与工作流：MIT，见 `vendor/pixelartistry/LICENSE`。
- ComfyUI 官方工作流模板：MIT。
- Node.js：MIT。
- ComfyUI、TRELLIS.2、Pixal3D、WTiVo、Quad Reconstruct、LODTailor、Fast Merge、Blender、CHITUBOX 等按各自许可证分发；本包不附带模型权重。详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

感谢视频作者 **设计门外憨** 的搬运与讲解，以及 **PixelArtistry / Philipp Sieben**、**Mostafa Awad (WTiVo)**、**visualbruno (ComfyUI-Trellis2)**、**Comfy Org**、**Tencent ARC**、**Microsoft** 等上游作者。
