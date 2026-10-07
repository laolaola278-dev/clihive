# opencode 托管适配器 — 真实验收记录（2026-10-07）

驱动脚本：`scripts/acceptance-opencode.mjs`（无任何 fake：真实 opencode 进程、真实 store、隔离的 `CLIHIVE_HOME` 与工作目录）。

- opencode：`1.18.34`
- 模型：`openrouter/deepseek/deepseek-chat`（agent 注册时通过 `model` 字段传入）
- 权限：`read-only`（`--agent plan` + `OPENCODE_CONFIG_CONTENT` 拒绝 edit/bash/webfetch/external_directory）

## 结论：通过（带明确局限）

| 检查 | 结果 |
|---|---|
| 读取任务：结构化 JSON 结果被解析，summary 含 fixture 数字 4242，会话 id 被捕获，exit 0 | PASS |
| 读取任务停在 `awaiting_review`，人工审核后 `completed` | PASS |
| 写入诱导任务：agent 报告 `blocked` 并附带 question，run 上出现 pendingQuestion | PASS |
| `INTRUDER.txt` / `INTRUDER2.txt` 不存在，`NOTES.txt` 哈希不变，工作目录无新增文件 | PASS |
| 所有回执权限均为 `read-only` | PASS |

## 过程中真实发现并修复的问题

1. **JSON 被 ```json 围栏包裹**：opencode 没有结构化输出开关，模型常把 JSON 包在 Markdown 围栏里，首次真实运行因此失败（`Unexpected token 'j'`）。已改为 `extractJsonObject`（裸 JSON / 围栏 / 前后带说明文字 / 多余 `json` 标签均可），结构合法性仍由服务端二次校验。
2. 验收脚本自身的缺陷：失败任务会让依赖它的任务永远 `queued`，脚本空等到超时；write 任务对 read 任务的依赖也使其在审核前无法启动。已改为任务独立，并在出现失败任务时停止等待。

## 本次运行**没有**证明的事（请勿夸大）

- **CLI 层的写入拦截没有被这次真实运行触发**：write 任务里模型是“读了提示词就拒绝”，写工具调用次数为 0（脚本会如实打印 `write-tool attempts`）。因此这次运行证明的是“提示词约束 + 结果链路”，不是 opencode 权限引擎本身。
- 权限引擎的拦截证据来自此前的**手工探测**（非本脚本）：
  - `plan` agent + `edit/bash` 设为 deny：强制要求写文件，未产生文件；
  - `build` agent + `edit/bash` allow + `external_directory` deny：目录内写入成功，目录外写入返回 `The user has specified a rule which prevents you from using this specific tool call`，文件未生成。
  - 但在 `build` agent + edit/bash deny 的强制尝试里，模型没有真正发出写工具调用而是调用了 `invalid` 工具，所以“deny 规则在模型真发起写入时的行为”只在目录外写入这一例上得到直接证据。
- 未验证：`workspace-write` 通过托管流水线的完整一轮、会话续接（`-s`，仅手工验证过模型能记住上下文）、多 agent 互发消息、重启恢复、预算耗尽。
- opencode 默认模型（free tier）在本机返回 403，deepseek 官方 key 返回 401，GitHub Copilot 路径返回服务端错误；只有 openrouter 模型可用。因此**必须显式指定模型**。
- 在 workspace-write 下，opencode 的 bash 工具没有路径限制（与 claude 的 Bash 同级别信任）。

## cline / zcode

- cline `3.0.62`：已安装，但无头运行返回 `cline requires re-authentication`，本机无法验证，**未做托管适配**。仅新增窗格识别。
- zcode：未安装，接口未知，**未做任何支持**。
