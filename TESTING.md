# clihive 测试指南 / Testing Guide

本文档详细说明 clihive 项目的测试体系，包括单元测试、集成测试、端到端测试和真实 CLI 验收测试。

This document details the clihive testing system, including unit tests, integration tests, end-to-end tests, and real CLI acceptance tests.

## 测试概览 / Test Overview

| 测试类型 | 命令 | 覆盖范围 | 证明强度 |
|---------|------|---------|---------|
| 单元测试 | `npm test` | 174 个测试，覆盖核心逻辑 | 单元正确性 |
| 烟雾测试 | `node scripts/smoke.mjs` | 真实 PTY 端到端流程 | 集成正确性 |
| UI 验证 | `node scripts/verify-ui.mjs` | Chromium 驱动的真实 UI | 用户体验 |
| 语法检查 | `npm run check` | 所有源文件解析 | 代码完整性 |
| 真实 CLI 验收 | `node scripts/acceptance-*.mjs` | 真实 codex/claude/opencode 进程 | 生产就绪 |

**关键原则**：模拟测试和真实验收故意分开报告。模拟测试证明逻辑正确性，但不证明真实 CLI 协作可用；真实验收提供生产环境的证据。

**Key Principle**: Simulated tests and real acceptance are reported separately on purpose. Simulated tests prove logical correctness but don't prove real CLI collaboration works; real acceptance provides production environment evidence.

---

## 单元测试 / Unit Tests (174 tests)

运行命令 / Run command:
```bash
npm test
# 或 / or
node --test "test/*.test.js"
```

### 测试文件清单 / Test Files

#### Agent 适配器测试 / Agent Adapter Tests

**`test/agent-adapters.test.js`** (codex + claude)
- ✅ `codexAdapter.buildArgs`: 生成正确的命令行参数（fresh turn / resume / unknown profile degrades to read-only）
- ✅ `claudeAdapter.buildArgs`: plan 模式 vs acceptEdits 模式、工具白名单、会话恢复
- ✅ `adapter argv safety`: 永远不包含 `--auto`、`--dangerous`、`--bypass`、`--yolo`、`--skip-permissions`
- ✅ `codexAdapter.normalizeEvent`: 将 JSONL 事件映射到标准词汇（session/text/tool/result/permission_denied/error/exit/diagnostic）
- ✅ `claudeAdapter.normalizeEvent`: assistant/user/result 事件解析、权限拒绝检测
- ✅ `codexAdapter.finalize`: 从 `lastMessagePath` 读取 JSON、验证 schema、处理错误
- ✅ `claudeAdapter.finalize`: 从 `lastResultEvent.resultText` 解析 JSON、处理非零退出码
- ✅ `runTurn with codex-shaped process`: 模拟进程验证 stdin 写入、事件流、结果提取
- ✅ `runTurn with claude-shaped process`: 模拟进程验证 schema 内联传递、权限模式

**`test/agent-opencode.test.js`** (opencode)
- ✅ `opencodeAdapter.buildArgs / buildEnv`: plan/build agent 选择、权限环境设置（edit/bash/webfetch/external_directory）
- ✅ `opencodeAdapter.normalizeEvent`: session/text/tool_use/error/step markers 映射
- ✅ `opencodeAdapter.finalize`: JSON 围栏提取（bare/fenced/prose）、错误处理
- ✅ `opencode registration`: MANAGED_PROVIDERS 包含 opencode、model 验证
- ✅ `runTurn with opencode-shaped process`: stdin 传递、权限环境应用、结果解析
- ✅ `Provider error handling`: APIError 事件导致 turn 失败

**`test/agent-jsonl.test.js`** (JSONL parser)
- ✅ `JsonlParser`: 完整行提取、不完整行缓冲、多行分割、空行处理
- ✅ `Edge cases`: 超长行、无效 JSON 跳过、UTF-8 边界

**`test/agent-resolve-cli.test.js`** (CLI resolution)
- ✅ `resolveCliExecutable`: npm shim 解析（.cmd/.ps1）、直接 .exe、环境变量覆盖
- ✅ `Windows path handling`: 路径规范化、扩展名处理
- ✅ `Shim formats`: opencode (node_modules/opencode-ai/bin/opencode.exe)、cline (node + node_modules/cline/bin/cline)

#### 消息总线测试 / Message Bus Tests

**`test/bus.test.js`**
- ✅ `Message fanout`: 单目标、多目标、全广播
- ✅ `Delivery tracking`: 推送状态、确认回执、通道记录
- ✅ `Persistence`: 消息持久化到 JSONL、重启恢复
- ✅ `Ordering`: 消息顺序保证、时间戳准确性

#### CLI 识别测试 / CLI Profile Tests

**`test/cli-profiles.test.js`**
- ✅ `detectCliProfile`: codex/claude/gemini/qwen/aider/opencode/cline/amp/goose/dsh 识别
- ✅ `Windows shim paths`: `C:\Users\admin\AppData\Roaming\npm\<cli>.cmd` 解析
- ✅ `Wrapper invocations`: `npx -y <cli>`、`uvx <cli>`、`pnpm dlx <cli>`
- ✅ `Accent colors`: 每个 CLI 的品牌颜色（codex green、claude coral、gemini blue、qwen violet）
- ✅ `Default delivery modes`: stdin for agents、display for shells

#### 协作测试 / Collaboration Tests

**`test/collaboration-state.test.js`**
- ✅ `Task state machine`: queued → running → awaiting_review → completed/failed
- ✅ `Dependencies`: 依赖解析、循环检测、就绪检查
- ✅ `Budgets`: 并发、决策、Agent 回合、超时、交接深度限制

**`test/collaboration-validation.test.js`**
- ✅ `validateAgentInput`: provider/cwd/permissionProfile/model 验证
- ✅ `MANAGED_PROVIDERS`: codex/claude/opencode 允许
- ✅ `Permission profiles`: read-only/workspace-write/unknown degrades
- ✅ `Model validation`: opencode only、provider/model format

**`test/collaboration-store.test.js`**
- ✅ `CAS writes`: expectedRevision 检查、冲突检测
- ✅ `Writer lock`: 单进程独占、过期清理
- ✅ `Journal integrity`: 校验和验证、损坏检测

**`test/collaboration-service.test.js`**
- ✅ `Task scheduling`: 并发限制、依赖等待、优先级
- ✅ `Review gate`: awaiting_review 状态、operator approval/rejection
- ✅ `Peer messages`: at-least-once 传递、recipient next turn 搭载

**`test/collaboration-result.test.js`**
- ✅ `Result schema validation`: summary/outcome/artifacts/checks/messages/followUps/question
- ✅ `Outcome values`: done/blocked/failed
- ✅ `Blocked results`: 必须包含 question

**`test/collaboration-api.test.js`**
- ✅ `HTTP API`: /api/agents、/api/runs、/api/tasks 端点
- ✅ `WebSocket frames`: agent.update、task.update、run.update
- ✅ `Authentication`: token 验证、权限检查

#### 输出模式测试 / Output Modes Tests

**`test/output-modes.test.js`**
- ✅ `Terminal mode tracking`: 从字节流检测 alternate screen (\x1b[?1049h/l)
- ✅ `Display message holding`: alternate screen 期间持有消息
- ✅ `Mode reconstruction`: ConPTY 下的模式重建

#### 协议测试 / Protocol Tests

**`test/protocol.test.js`**
- ✅ `Message format`: messageId、from、to、text、kind、timestamp
- ✅ `Trace events`: send/fanout/deliver/ack 事件结构
- ✅ `Validation`: 必填字段、类型检查、长度限制

#### 追踪器测试 / Tracer Tests

**`test/tracer-orchestrator.test.js`**
- ✅ `Trace events`: JSONL 追加、内存环缓冲
- ✅ `Orchestrator turns`: manual relay vs model coordination
- ✅ `Event filtering`: message/prefix/limit 查询

---

## 端到端测试 / End-to-End Tests

### 烟雾测试 / Smoke Test

运行命令 / Run command:
```bash
node scripts/smoke.mjs
```

**测试内容 / Test Content**:
- ✅ **真实 PTY 生成**: 使用 node-pty 创建真实终端进程
- ✅ **stdin 传递 (CR 结尾)**: Windows ConPTY 需要 CR 才能释放输入到子进程
- ✅ **消息传递链**: send → fanout → deliver → ack 完整流程
- ✅ **确认回执**: `hive inbox` 拉取消息并确认
- ✅ **共享记录**: `hive read` 显示所有窗格的消息
- ✅ **追踪查询**: `hive trace --message msg_xxx` 显示传递路径

**证明 / Proof**: 脚本退出码 0 表示所有检查通过，输出包含 `smoke: OK`。

**Evidence**: Exit code 0 indicates all checks passed, output contains `smoke: OK`.

### UI 验证 / UI Verification

运行命令 / Run command:
```bash
node scripts/verify-ui.mjs
```

**测试内容 / Test Content**:
- ✅ **Chromium 自动化**: 使用 puppeteer 驱动真实浏览器
- ✅ **窗口渲染**: 标题栏、侧边栏、英雄网格、任务控制面板
- ✅ **窗格生成**: 点击 "+ CLI pane" 按钮创建窗格
- ✅ **主题切换**: Amber graphite / Matrix / Void / Neon 主题
- ✅ **协作面板**: ⚙ collab 标签、Agent 注册、运行创建
- ✅ **命令面板**: Ctrl/Cmd+K 模糊搜索
- ✅ **追踪抽屉**: Ctrl/Cmd+Shift+T 事件流

**证明 / Proof**: 脚本退出码 0，输出包含 `ui: OK`，截图保存在 `.artifacts/ui-*.png`。

**Evidence**: Exit code 0, output contains `ui: OK`, screenshots saved to `.artifacts/ui-*.png`.

---

## 真实 CLI 验收 / Real CLI Acceptance

### codex + claude 验收 / codex + claude Acceptance

运行命令 / Run command:
```bash
node scripts/acceptance-real.mjs
```

**前提条件 / Prerequisites**:
- codex-cli 0.160.0 已安装并登录
- claude 2.1.287 已安装并登录
- 网络连接正常

**测试内容 / Test Content**:
- ✅ **Agent 注册**: `hive agents add codex` / `hive agents add claude`
- ✅ **运行创建**: 两个只读任务（codex 报告、claude 验证）
- ✅ **任务执行**: 真实 codex/claude 进程运行、JSONL 事件流
- ✅ **结构化结果**: JSON schema 验证、magic number 检查
- ✅ **审核门**: awaiting_review 状态、operator approval
- ✅ **权限边界**: 工作目录未被修改、NOTES.txt 哈希不变
- ✅ **会话捕获**: sessionId 记录、可用于恢复

**证据文件 / Evidence Files**:
- `.artifacts/acceptance-real-<timestamp>.json`: 完整证据（versions、receipts、summaries、hashes、timings）
- `.artifacts/acceptance-real-<timestamp>.md`: 人类可读记录
- `docs/acceptance-real-2026-10-07.md`: 首次真实验收记录（包括失败的第一次尝试）

**证明 / Proof**: 脚本退出码 0，输出包含 `acceptance: PASSED`，所有检查项显示 `PASS`。

**Evidence**: Exit code 0, output contains `acceptance: PASSED`, all checks show `PASS`.

### opencode 验收 / opencode Acceptance

运行命令 / Run command:
```bash
node scripts/acceptance-opencode.mjs <provider/model>
# 例如 / e.g.
node scripts/acceptance-opencode.mjs openrouter/deepseek/deepseek-chat
```

**前提条件 / Prerequisites**:
- opencode 1.18.34 已安装
- 可用的 opencode 模型（默认 free tier 在某些机器上被拒绝）
- 网络连接正常

**测试内容 / Test Content**:
- ✅ **Agent 注册**: `hive agents add opencode --model provider/model`
- ✅ **读取任务**: 读取 NOTES.txt、报告 magic number、结构化 JSON 结果
- ✅ **写入诱导任务**: 要求创建 INTRUDER.txt、验证权限拦截
- ✅ **权限环境**: `OPENCODE_CONFIG_CONTENT` 应用（edit/bash/webfetch/external_directory）
- ✅ **JSON 提取**: 围栏/裸 JSON/散文包围的结果解析
- ✅ **审核流程**: awaiting_review → completed
- ✅ **工作目录完整性**: 无新文件、NOTES.txt 哈希不变

**已知限制 / Known Limitations**:
- 写入诱导任务中模型可能从提示词拒绝而不调用写工具（记录为 `write-tool attempts: 0`）
- 权限引擎的 CLI 层拦截证据来自手工探测而非本脚本
- workspace-write 的完整托管一轮未验证

**证据文件 / Evidence Files**:
- `.artifacts/acceptance-opencode-<timestamp>.json`: 完整证据
- `.artifacts/acceptance-opencode-<timestamp>.md`: 人类可读记录
- `docs/acceptance-opencode-2026-10-07.md`: 首次真实验收记录

**证明 / Proof**: 脚本退出码 0，输出包含 `acceptance: PASSED`。

**Evidence**: Exit code 0, output contains `acceptance: PASSED`.

---

## 测试覆盖矩阵 / Test Coverage Matrix

| 组件 | 单元测试 | 集成测试 | 真实验收 |
|------|---------|---------|---------|
| **Agent 适配器** | ✅ codex/claude/opencode 参数、事件、结果 | ✅ runTurn 模拟进程 | ✅ codex/claude/opencode 真实 CLI |
| **消息总线** | ✅ 扇出、传递、确认、持久化 | ✅ smoke.mjs 端到端 | - |
| **CLI 识别** | ✅ 所有 CLI 配置文件 | ✅ verify-ui.mjs 徽章显示 | - |
| **协作状态机** | ✅ 任务状态、依赖、预算 | ✅ collaboration-api.test.js | ✅ acceptance-*.mjs |
| **协作存储** | ✅ CAS、写锁、日志完整性 | ✅ 多进程并发测试 | ✅ acceptance-*.mjs |
| **权限边界** | ✅ permissionProfile 验证 | ✅ smoke.mjs 只读检查 | ✅ acceptance-*.mjs 工作目录完整性 |
| **审核门** | ✅ awaiting_review 状态 | ✅ collaboration-service.test.js | ✅ acceptance-*.mjs operator review |
| **UI 渲染** | - | ✅ verify-ui.mjs Chromium | - |
| **PTY 生成** | - | ✅ smoke.mjs 真实 PTY | - |
| **stdin 传递** | ✅ CR 结尾测试 | ✅ smoke.mjs stdin reader | ✅ acceptance-*.mjs prompt on stdin |

---

## 运行完整测试套件 / Running the Full Test Suite

```bash
# 1. 语法检查 / Syntax check
npm run check

# 2. 单元测试 / Unit tests
npm test

# 3. 烟雾测试 / Smoke test
node scripts/smoke.mjs

# 4. UI 验证 / UI verification
node scripts/verify-ui.mjs

# 5. 真实 CLI 验收（需要 CLI 登录）/ Real CLI acceptance (requires CLI login)
node scripts/acceptance-real.mjs
node scripts/acceptance-opencode.mjs openrouter/deepseek/deepseek-chat
```

**预期结果 / Expected Results**:
- `npm run check`: 退出码 0，无解析错误
- `npm test`: 退出码 0，`ℹ pass 174`，`ℹ fail 0`
- `smoke.mjs`: 退出码 0，输出 `smoke: OK`
- `verify-ui.mjs`: 退出码 0，输出 `ui: OK`
- `acceptance-*.mjs`: 退出码 0，输出 `acceptance: PASSED`

---

## 测试失败排查 / Test Failure Troubleshooting

### 单元测试失败 / Unit Test Failures

```bash
# 运行单个测试文件 / Run a single test file
node --test test/agent-opencode.test.js

# 查看详细错误 / See detailed errors
node --test --test-reporter=spec test/*.test.js
```

### 烟雾测试失败 / Smoke Test Failures

**常见原因 / Common Causes**:
- node-pty 未安装：`npm install`
- 端口 7420 被占用：`netstat -ano | findstr :7420`，杀死占用进程
- 写锁未清理：检查 `~/.clihive/collab/writer.lock`，确认进程已死后删除

### UI 验证失败 / UI Verification Failures

**常见原因 / Common Causes**:
- Chromium 未安装：`npm install`（puppeteer 会自动下载）
- 服务未启动：`npm start` 在另一个终端
- Token 不匹配：服务重启后 token 会变化，脚本会重新读取

### 真实验收失败 / Real Acceptance Failures

**codex/claude 失败 / codex/claude Failures**:
- CLI 未登录：运行 `codex auth` / `claude login`
- 网络问题：检查代理、防火墙
- 超时：模型响应慢，增加 `taskTimeoutMs`

**opencode 失败 / opencode Failures**:
- 默认模型被拒绝：使用 `--model provider/model` 指定可用模型
- JSON 解析失败：检查 `extractJsonObject` 日志，确认模型输出格式
- 权限环境未应用：检查 `OPENCODE_CONFIG_CONTENT` 是否正确设置

---

## 测试最佳实践 / Testing Best Practices

1. **先运行单元测试**：快速发现逻辑错误
2. **再运行烟雾测试**：验证集成正确性
3. **定期运行 UI 验证**：确保用户体验无回归
4. **重大改动后运行真实验收**：证明生产就绪
5. **保留证据文件**：`.artifacts/` 目录包含历史验收记录
6. **诚实报告**：模拟测试和真实验收分开，不夸大验证范围

---

## 贡献测试 / Contributing Tests

添加新测试时：
1. 单元测试放在 `test/*.test.js`
2. 端到端脚本放在 `scripts/*.mjs`
3. 真实验收脚本命名为 `scripts/acceptance-<cli>.mjs`
4. 更新本文档的测试清单
5. 在 README.md 中补充测试命令

Adding new tests:
1. Unit tests go in `test/*.test.js`
2. End-to-end scripts go in `scripts/*.mjs`
3. Real acceptance scripts named `scripts/acceptance-<cli>.mjs`
4. Update this document's test list
5. Add test commands to README.md

---

## 许可证 / License

MIT
