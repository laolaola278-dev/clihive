# clihive

一个面向 CLI Agent 的工作区多路复用器。一个窗口容纳多个小型 CLI 窗格。
右侧可隐藏的调度窗口同时与所有窗格对话并协调它们的工作。每条消息都会落地到
任何窗格都能读取的共享记录中，每次传递都会被追踪，所以你总能回答：
*那个窗格真的收到了吗？*

在终端之上，clihive 运行**托管 Agent**：codex、claude 和 opencode
通过它们的结构化 CLI 接口驱动（非键盘模拟），在持久化任务上工作，具有权限边界、
持久消息队列和操作员审核门。两种模式，一个窗口：你的原生终端窗格保持手动；
托管 Agent 窗格被编排。

```
┌─────────────────────────── titlebar 36px ────────────────────────────┐
├──────────┬───────────────────────────────────┬───────────────────────┤
│          │  toolbar: + pane · mode · ⌘K · ⟳  │ Fleet · 3             │
│  sidebar │                                   │  ● p1 cli-1  working →│
│  240px   │   ┌─────────┐   ┌─────────┐       │  ● p2 cli-2  idle    →│
│ workspaces  │  cli-1   │   │  cli-2   │       │  ● p3 cli-3  2 unread→│
│          │   ├─────────┤   ├─────────┤       ├───────────────────────┤
│          │   │  cli-3   │   │  cli-4   │       │ Orchestrator          │
│          │   └─────────┘   └─────────┘       │ (chat|shared|trace)   │
│          │        hero terminal grid          ├───────────────────────┤
│          │                                   │ composer → all panes  │
├──────────┴───────────────────────────────────┴───────────────────────┤
│  activity trace drawer (Ctrl+Shift+T)                                │
└──────────────────────────────────────────────────────────────────────┘
```

## 功能特性

- **CLI 窗格网格。** 每个窗格是一个真实的 PTY（你的 shell，或像 `claude` / `codex` 这样的 Agent CLI）。
  窗格平铺；聚焦的窗格有琥珀色边框。
- **按 CLI 适配。** hive 识别每个窗格运行的 CLI——codex、claude、gemini、qwen、aider、opencode、
  cline、amp、goose、dsh、shells、node、python——通过其命令行（`src/server/cli-profiles.js`）。
  窗格穿戴该 CLI 的徽章和强调色，并为其选择安全的传递默认值：将 stdin 作为提示读取的程序
  可以选择 `stdin` 传递（输入的行以 CR 结尾，这样 Windows ConPTY 实际上会将它们释放给子进程）；
  shell 和未知工具获得非破坏性的 `display` 绘制。全屏 TUI（如交互式 codex/claude 会话）
  永远不会被喂入模拟按键——将它们编排为*托管 Agent*（见下文）。
- **托管 Agent（双模式）。** 注册 codex 或 claude Agent；它通过其结构化 CLI 无头运行
  （`codex exec --json`、`claude -p --output-format stream-json`），一次一个任务，在权限边界内。
  任务跨重启持久化，结果以验证过的 JSON 返回，"完成"仅意味着*等待审核*，操作员带证据批准。
  参见[托管协作](#托管协作)。
- **关键字段高亮。** 共享记录高亮 `from` / `to` 并为消息类型添加徽章；追踪行将每个字段渲染为
  暗色键 + 亮色值，承载重要信息的字段（paneId、target、channel、ok、held、reason）发光，
  使滚动的传递链保持可扫描。
- **可隐藏的调度器。** 右侧窗口（Ctrl/Cmd+J）寻址一个窗格或整个 hive。在手动模式下它转发你输入的内容。
  将其指向 OpenAI 兼容端点，模型会代替协调。
- **窗格间对话。** 在任何窗格内，`hive send --to all "..."` 或 `--to p3`。每个窗格看到共享记录，
  所以子 Agent 可以跟随彼此的工作。
- **传递追踪。** 发送 → 扇出 → 传递 → 确认，记录为 JSONL 并流式传输到追踪视图。追踪是可观测性契约：
  它命名通道、目标，以及是否落地。

## 窗口布局

布局将终端作为主角，将装饰推到边缘：

- **标题栏（36px）。** 工作区名称、实时状态（`N 运行中`、`N 需要你`——仅在非零时显示，点击跳转到窗格）
  和连接状态。
- **侧边栏（240px）。** 仅工作区。工作区是英雄网格上的*视图过滤器*：切换仅显示该工作区的窗格，
  你生成的窗格落在活动工作区中。工作区行上的红点表示其中的窗格正在等待你。可用 Ctrl/Cmd+B 折叠；
  轨道按钮将其带回。
- **英雄区。** 窗格网格。聚焦的窗格带有钢蓝色顶部边缘和发光，这样你无需阅读标签就能找到它。
  窗格响应式平铺。
- **任务控制面板（右侧，326px）。** 顶部标签页。**Fleet** 名单位于调度器线程上方：每个窗格一行，
  带有状态点（琥珀色 = 工作中，绿色 = 空闲，灰色 = 已退出，红色 = 需要你），单色活动行和 `→` 跳转功能。
  需要注意的行排序到顶部。Fleet 始终跨越**每个**工作区——需要输入的窗格永远不会被过滤器隐藏；
  其行标记有其工作区，点击它首先切换到那里。其他标签：共享记录和活动追踪（可过滤）。
- **命令面板（Ctrl/Cmd+K）。** 命令和窗格的模糊搜索：生成窗格、切换主题、切换面板、跳转到窗格。
- **追踪抽屉（Ctrl/Cmd+Shift+T）。** 底部的完整事件流。

### 颜色语法

仅两个强调色，这样状态一目了然：**琥珀色**表示活跃/动作/需要注意（运行点、主按钮、光标、未读计数）；
**钢蓝色**表示导航/聚焦（聚焦窗格边缘、活动标签、链接、聚焦环）。其他一切都是温暖的石墨色。
一个故意的例外是*身份*：每个识别的 CLI 用其自己的品牌强调色绘制其窗格徽章和 ID（codex 绿色、
claude 珊瑚色、gemini 蓝色、qwen 紫色……）。身份永远不编码状态——状态保持琥珀色/蓝色。

### 外观

标题栏中的 ⚙ 按钮（或面板中的 `Appearance settings`）打开设置弹出窗口。选择持久化在 `localStorage` 中
并在重新加载后保留：

| 设置 | 选项 |
|------|------|
| **主题** | `Amber graphite`（默认温暖中性）· `Matrix`（荧光绿 `#00FF41` + 青色）· `Void`（无色近黑）· `Neon`（赛博朋克——热品红 `#FF2E9A` + 电青色在深紫上，渐变聚焦环，脉冲主按钮） |
| **背景图片** | 导入任何最大 8 MB 的图片；存储为数据 URL。面板变为半透明以便透视。 |
| **图片适应** | `Fill`（覆盖，裁剪到窗口）· `Fit whole image`（信箱式——用于 16:9 壁纸）· `Stretch` |
| **图片强度** | 图片透过 UI 显示的程度（0–70%） |
| **CRT 扫描线** | 整个窗口的 1px 扫描线覆盖 |
| **发光效果** | 运行点、聚焦窗格边缘上的轻微光晕，以及（在 Matrix 中）缓慢的 CRT 闪烁；尊重 `prefers-reduced-motion` |

切换主题实时重新绘制每个打开终端的调色板——无需窗格重启。

## 传递：消息如何实际到达窗格

这是重要的部分，所以它是明确的。窗格有两种模式之一，在创建时选择——或由其识别的 CLI 风格*为其*选择：
Agent CLI（codex、claude、gemini……）默认为 `stdin`，因为那是它们的提示所在；shell、解释器和未知工具
默认为 `display`，因为 stdin 上的任何内容都会被执行。

| 模式 | 发生什么 | 何时使用 |
|------|----------|----------|
| `display` *（shell 和未知的默认值）* | 消息被**绘制到窗格的视口中**。子进程永远不会被触及，所以普通 shell 不会尝试执行文本。 | shell、REPL、任何将 stdin 视为命令的东西 |
| `stdin` *（识别的 Agent 的默认值）* | 消息被**输入到进程的 stdin**，以平台的 Enter 结尾——Windows 上是 CR（ConPTY 缓冲输入直到看到 CR；裸 LF 永远不会到达子进程），POSIX 上是 LF。 | 将 stdin 作为提示读取的程序 |

要与 codex/claude 进行*结构化*对话，根本不要输入到它们的 TUI——将它们注册为[托管 Agent](#托管协作)，
让 hive 用持久队列和回执驱动它们的无头 CLI 接口。

两种模式也将消息排队供**拉取**：窗格内的 `hive inbox` 返回消息并确认它。该拉取是确认——
它证明 Agent 确实读取了消息，即使它在推送落地时正处于回合中。

### 没有东西会绘制在全屏应用上

`display` 消息被绘制到窗格的视口中。这对 shell 是安全的，但全屏 TUI（codex、claude、vim、less）
拥有屏幕并通过绝对光标位置重新绘制，仅重绘它改变的单元格。写入其缓冲区的外来文本因此作为垃圾
留在屏幕上，编织在其自己的框架中——工具的上下文似乎与自己重叠。

所以 hive 追踪每个窗格输出流已打开的终端模式（`src/server/output-modes.js`），并在备用屏幕活动时
**持有** `display` 消息，在应用交还屏幕的那一刻绘制它。窗格头部显示 `◈ N held`，而有任何东西在等待时，
传递追踪记录 `held: true` 和 `reason: "alternate-screen"`。同时没有东西丢失：消息在共享记录中、在面板中，
并可用 `hive inbox` 拉取。

模式状态从字节流重建而不是从浏览器的终端对象读取，因为在 Windows 上 PTY 通过 ConPTY 运行，
ConPTY 自己消耗子进程的 `?1049h` 并渲染 TUI——所以客户端缓冲区类型永远不会报告"备用"。

### 每个字节恰好绘制一次

窗格的输出通过两条路径到达窗口：实时广播，和回答订阅的滚动回放。没有共享坐标系，
它们会绘制相同的字节两次——shell 显示加倍的行，TUI 将一帧涂抹在另一帧上。因此每一帧
在其自己的字符流中携带其 `[from,to)` 范围，窗口绘制每个字节一次，回放**重置并重新绘制**
从窗口而不是追加。当应用在窗口启动之前进入备用屏幕时，回放也带有模式前缀，
这样查看器永远不会留在正常缓冲区上而绝对定位的帧到达。

窗格以网格实际显示它们的大小生成，所以 TUI 不会为一个几何绘制其开场帧然后为另一个重新绘制。

## 托管协作

双模式核心：上面的终端窗格保持手动；**托管 Agent** 运行真实工作，具有终端无法提供的保证。
Agent 是 hive 通过其结构化 CLI 驱动的无头 codex/claude 进程——永远不会按键到 TUI。

- **适配器，针对真实 CLI 验证。** 仅 codex、claude 和 opencode 被*适配*；每个其他 CLI 仅被*识别*
  用于样式（窗格徽章/颜色/默认传递模式），不能被托管：
  - `codex-cli 0.160.0` — `codex exec --json --skip-git-repo-check -C <cwd> --sandbox <profile>
    --output-schema <file>`，提示在 stdin，通过 `codex exec resume <SESSION_ID> -` 恢复会话。
  - `claude 2.1.287 (Claude Code)` — `claude -p --verbose --output-format stream-json --json-schema <inline>`，
    `--permission-mode plan` 用于只读 / `acceptEdits` + 显式 `--allowedTools` 用于工作区写入，
    `--add-dir <cwd>`，`--resume <id>`。
  - `opencode 1.18.34` — `opencode run --pure --format json --agent plan|build --dir <cwd> [-m provider/model]
    [-s <session>]`，提示在 stdin。opencode **没有结构化输出标志**，所以结果契约在提示中，
    适配器从最终消息中提取 JSON 对象（裸、围栏或被散文包围）；服务器重新验证形状。
    权限由 opencode 自己通过 `OPENCODE_CONFIG_CONTENT` 强制执行（只读：edit/bash/webfetch 拒绝；
    工作区写入：edit/bash 允许；`external_directory` 始终拒绝；`--auto` 从不传递）。
    用 `hive agents add opencode --model provider/model` 注册：opencode 的内置默认模型在某些机器上被拒绝，
    所以选择对你有效的模型。注意：在工作区写入中 opencode 的 bash 工具不是路径限制的
    （与 claude 的 Bash 相同信任级别）。
  - 硬规则：仅通过 stdin 提示，无 shell 解释，无 danger/bypass/approve-for-me 标志，
    未知权限配置文件降级为只读。codex 和 claude 通过了真实的端到端验收运行
    （2026-10-07，`docs/acceptance-real-2026-10-07.md`）；opencode 通过了自己的验收
    （`docs/acceptance-opencode-2026-10-07.md`），其中陈述了限制。
  - **未适配：** cline（3.0.62 安装在此，但其无头运行需要在此机器上重新认证，
    所以无法验证任何东西；其 `--json` / `-p` / `--id` / `--auto-approve` 标志存在但在此未证明）
    和 zcode（未安装，接口未知）。两者仅被识别为窗格（cline）或未知 CLI（zcode）。
- **权限边界。** 有效权限 = Agent 配置文件和运行配置文件的交集，默认只读。模型生成的任务
  永远不能提升它。拒绝作为 `permission_denied` 事件浮出水面，Agent 必须报告自己被阻止。
- **持久化状态。** Agent/运行/任务/消息/回执照活在 `~/.clihive/collab` 下的校验和 JSONL 日志中
  （每次写入的 CAS）。重启将进行中的任务恢复为 `uncertain`；重试需要操作员确认前一个进程已停止
  并审查了副作用。
- **审核门。** 报告 `done` 的任务落在 `awaiting_review`——永远不会 `completed`。操作员带证据批准
  或带原因拒绝。对等消息是持久的（至少一次）并搭载在接收者的下一个回合；消息回合由服务自动审核。
- **预算。** 每运行限制：并发、决策、Agent 回合、任务/运行超时、交接深度、每回合消息。
  耗尽用 `budget-exhausted:<limit>` 问题暂停运行而不是继续燃烧。
- **操作员。** 右侧面板的 **⚙ collab** 标签（注册 Agent、启动运行、暂停/取消、批准/拒绝任务、
  回答被阻止的问题、实时 Agent 事件流）和下面的 `hive` CLI。可选的规划器（需要模型端点）
  将目标转换为 ≤12 个任务，具有可观察的验收标准和独立的验证任务。

## 运行它

```bash
npm install
npm start
```

然后打开打印的 URL（`http://127.0.0.1:7420/?token=…`）。用 **+ CLI pane** 按钮生成窗格。
追踪文件位于 `~/.clihive/trace.jsonl`。

### `hive` CLI（在窗格内）

每个窗格生成时带有 `CLIHIVE_URL`、`CLIHIVE_TOKEN`、`CLIHIVE_PANE_ID` 和 `PATH` 上的 `hive`，
所以窗格内不需要设置：

```bash
hive whoami                      # 我是哪个窗格
hive panes                       # 窗口中还有谁
hive send --to all "build green" # 广播到每个其他窗格
hive send --to p2 "take the API" # 一个窗格
hive ask "who is free?"          # 与调度器对话
hive inbox                       # 读取 + 确认发送给我的内容
hive read                        # 此窗口的共享记录
hive trace --message msg_xxx     # 消息实际如何传递
hive trace --prefix msg.         # 消息生命周期，实时
```

协作命令（托管 Agent——从任何地方使用令牌工作）：

```bash
hive capabilities                        # 此机器真正有哪些托管 CLI
hive agents                              # 列出托管 Agent + 状态
hive agents add codex --label review --cwd C:\repo --permission read-only
hive agents add opencode --model openrouter/deepseek/deepseek-chat --cwd C:\repo
hive run "audit the auth module" --agents agt_x,agt_y --plan --criteria "no secrets logged"
hive run "fix issue 42" --agents agt_x --tasks-file tasks.json
hive runs                                # 列出；还有：pause|resume|cancel <runId>|respond <runId> <text>
hive tasks --run run_x                   # 列出；还有：show <id>
hive tasks review <id> --approve --evidence "tests green, diff reviewed"
hive tasks review <id> --reject --reason "missed the edge case in X"
hive tasks cancel <id> --reason "obsolete"
hive tasks retry <id> --reason "process confirmed stopped" --stopped --reviewed
```

## 调度器

调度器在两种模式之一中运行：

- **manual**（默认）：你输入的任何内容都被转发到寻址的窗格。零设置。
- **model**：在启动前设置 `CLIHIVE_BASE_URL`、`CLIHIVE_API_KEY`、`CLIHIVE_MODEL`。
  模型看到窗格名册和共享记录，并用 `{"say": "...", "actions": [{"to": "p2", "kind": "task", "text": "..."}]}`
  回复，这些被分发到窗格。

## 键盘

| 按键 | 动作 |
|------|------|
| Ctrl/Cmd + K | 命令面板（命令 + 跳转到窗格） |
| Ctrl/Cmd + J | 切换调度器窗口 |
| Ctrl/Cmd + B | 切换工作区侧边栏 |
| Ctrl/Cmd + Shift + T | 切换活动追踪抽屉 |
| Enter（在编辑器中） | 发送 |
| Shift + Enter | 换行 |
| Esc | 关闭面板 / 设置弹出窗口 |

## HTTP API

每个路由仅环回并需要启动令牌（`Authorization: Bearer`、`?token=` 或 `x-clihive-token`）。
`hive` CLI 是这些的薄包装器。

| 路由 | 方法 | 目的 |
|------|------|------|
| `/api/send` | POST | 发布消息；返回 `messageId` + 每目标传递回执 |
| `/api/inbox?pane=p1[&peek=1]` | GET/POST | 排空（或窥视）窗格的待处理消息；排空发出 `msg.ack` |
| `/api/transcript[?pane=p1][&limit=50]` | GET | 共享记录，整个 hive 或一个窗格 |
| `/api/panes` | GET / POST | 列出窗格 / 生成一个（`{command,args,cwd,deliveryMode,label}`） |
| `/api/panes/:id` | DELETE | 杀死窗格 |
| `/api/trace[?message=][?prefix=][?limit=200]` | GET | 追踪事件，全部 / 一条消息 / 一种前缀 |
| `/api/delivery?message=msg_xxx` | GET | 完整传递报告：推送、确认、通道、原因 |
| `/api/orchestrator[?limit=100]` | GET | 调度器状态 + 最近回合 |
| `/api/orchestrator/ask` | POST | `{text, to}` — 转发或询问模型 |
| `/api/status` | GET | url、窗格计数、调度器模式、客户端计数、追踪路径、协作存储状态 |
| `/api/agents/capabilities` | GET | 真实探测：每提供商解析的可执行文件 + 版本 |
| `/api/agents` | GET / POST | 列出 / 注册托管 Agent（`{provider,label,cwd,permissionProfile}`） |
| `/api/agents/:id/messages` | POST | 持久对等消息（202；搭载在 Agent 的下一个回合） |
| `/api/runs`, `/api/runs/:id` | GET / POST | 列出·检查 / 创建（`plan:true` 使用模型规划器） |
| `/api/runs/:id/state`, `/api/runs/:id/respond` | POST | 暂停·恢复·取消 / 回答被阻止运行的问题 |
| `/api/runs/:id/tasks`, `/api/tasks[/:id]` | GET / POST | 列出·添加 / 检查任务（带回执） |
| `/api/tasks/:id/review`, `/cancel`, `/retry` | POST | 批准（`evidence`）或拒绝 / 取消 / 重试（需要停止 + 副作用确认） |

窗口本身通过 WebSocket 在 `/ws` 连接并接收 `hello`、`pane.list`、`pane.created`、`pane.data`、
`pane.exit`、`message`、`delivery`、`trace` 和 `orch.reply` 帧，加上（协议 v2，附加）`agent.update`、
`task.update`、`run.update` 和 `agent.event`；它发送 `pane.create`、`pane.input`、`pane.resize`、
`pane.kill`、`pane.subscribe`、`message.send` 和 `orch.ask`。

## 测试

```bash
npm test                    # 单元/API 测试包括协作（假 CLI——模拟的，非真实协作的证明）
node scripts/smoke.mjs      # 用真实 PTY 端到端：发送、传递、确认、stdin 读取器
node scripts/verify-ui.mjs  # 在 Chromium 中驱动真实窗口（包括协作面板）
npm run check               # 解析每个源文件
node scripts/acceptance-real.mjs   # 真实 codex + claude 运行；写入 .artifacts 证据（需要两个 CLI 登录）
node scripts/acceptance-opencode.mjs <provider/model>   # 真实 opencode 运行（需要工作的 opencode 模型）
```

模拟测试和真实验收故意分开报告。最新的真实 CLI 记录，包括失败的第一次尝试，
在 [docs/acceptance-real-2026-10-07.md](docs/acceptance-real-2026-10-07.md)。

### 测试覆盖详情

#### 单元测试（174 个测试）

- **agent-adapters.test.js**: codex/claude 适配器参数生成、事件归一化、结果解析
- **agent-opencode.test.js**: opencode 适配器权限环境、JSON 提取容错、真实进程模拟
- **agent-jsonl.test.js**: JSONL 解析器边界情况、不完整行处理
- **agent-resolve-cli.test.js**: CLI 可执行文件解析、npm shim 处理、Windows 路径
- **bus.test.js**: 消息总线扇出、传递、确认、持久化
- **cli-profiles.test.js**: CLI 识别、徽章颜色、默认传递模式
- **collaboration-*.test.js**: 协作状态机、验证、存储 CAS、服务调度、结果解析
- **output-modes.test.js**: 终端模式追踪、备用屏幕检测
- **protocol.test.js**: 消息格式、验证、序列化
- **tracer-orchestrator.test.js**: 追踪事件、调度器回合

#### 端到端测试

- **smoke.mjs**: 真实 PTY 生成、stdin 传递（CR 结尾）、消息传递链、确认回执
- **verify-ui.mjs**: Chromium 自动化、UI 渲染、协作面板交互、主题切换

#### 真实 CLI 验收

- **acceptance-real.mjs**: codex + claude 端到端，只读权限，任务审核流程
- **acceptance-opencode.mjs**: opencode 端到端，权限环境验证，JSON 输出解析

## 布局

```
src/
  shared/protocol.js   消息 + 追踪词汇、验证、格式化
  server/
    bus.js             共享记录、扇出、传递、确认
    panes.js           PTY 生命周期、滚动、每窗格传递
    output-modes.js    从字节流追踪终端模式（备用屏幕）
    cli-profiles.js    识别每个窗格的 CLI（身份、强调色、安全默认值）
    tracer.js          仅追加 JSONL 追踪 + 内存环
    orchestrator.js    右侧窗口：手动转发或模型
    collaboration-*.js 持久存储、验证、任务状态机、结果解析、
                       服务（队列、调度、审核、预算）
    agent-runtime/     codex/claude/opencode 适配器、JSONL 解析、CLI 解析、
                       回合提示 + 结果模式
    http.js            HTTP/JSON API + WebSocket + 静态服务
    index.js           入口点
  cli/hive.js          窗格用来与 hive 对话的命令
  ui/                  窗口（xterm.js，无构建步骤）
bin/hive               shim 所以 `hive` 在窗格内解析
```

## 安全说明

- 仅绑定到环回。窗口用在启动时生成的令牌认证（`~/.clihive/token`，模式 600）并通过环境传递给窗格。
- `stdin` 传递写入进程的输入。仅将其用于程序将 stdin 作为提示读取的窗格；对普通 shell 使用默认的 `display`。
- 托管 Agent 永远不接收 hive 令牌或 `CLIHIVE_PANE_*` 变量（凭据分离）；它们的环境仅携带
  `CLIHIVE_MANAGED_AGENT=1` 和它们的 Agent ID。它们在你注册的 cwd 中运行，默认只读；
  `workspace-write` 需要 Agent 和运行都选择加入，并且永远不会传递 danger/bypass/approve-for-me 标志给 CLI。
- 协作状态失败关闭：损坏的日志毒害存储（HTTP 503）而不是猜测；同一 home 上的第二个服务器被写锁拒绝。

## 许可证

MIT
