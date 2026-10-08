# clihive 截图指南 / Screenshots Guide

本文档说明如何获取 clihive 的运行截图。`screenshots/` 目录中的 9 张图全部由
**真实运行的 UI** 捕获（不是 mockup），可用一条命令重新生成。

All nine screenshots in `screenshots/` are captured from the **real, running UI**
(headless Chromium driving a live `HiveServer` with real PTYs), not mockups.
Regenerate them with one command.

## 自动截图（推荐）/ Automated Screenshots (recommended)

```bash
npm run screenshots
# 即 / i.e.
node scripts/screenshots.mjs
```

脚本行为 / What the script does:

1. 在进程内启动一个真实的 `HiveServer`（托管 Agent 用确定性假 CLI，绝不执行真实 agent 回合）
2. 用本机已有的 Playwright Chromium（`ms-playwright` 缓存）打开真实窗口
3. 生成 2 个真实 PTY 窗格，用键盘输入 `hive send`，验证消息进入共享记录
4. 打开调度器并发一条消息，等待两个窗格都收到真实投递回执
5. 依次切换四种主题（amber / matrix / void / neon），每种主题截一张
6. 在窗格内运行 `hive whoami`，截取 CLI 输出
7. 注册一个托管 Agent、创建一个 Run，截取协作面板
8. 打开命令面板 (Ctrl+K)、追踪抽屉 (Ctrl+Shift+T) 并截取
9. 每一步都有断言（`PASS`/`FAIL`），任何 console 错误都会导致失败

Every step is assertion-checked (`PASS`/`FAIL`); any console error fails the run.

**生成的文件 / Output files**（`screenshots/` 目录）/ (in the `screenshots/` directory):

| 文件 / File | 内容 / Content |
|---|---|
| `01-main-interface.png` | 主界面：两个真实 PTY 窗格、侧边栏、Fleet 名单 / main grid, sidebar, fleet roster |
| `02-theme-amber.png` | 琥珀石墨主题（默认）：调度器展开 + 真实投递回执 / default amber theme, orchestrator + real receipts |
| `03-theme-matrix.png` | Matrix 主题 / Matrix theme |
| `04-theme-void.png` | Void 主题 / Void theme |
| `05-theme-neon.png` | Neon 赛博朋克主题 / Neon cyberpunk theme |
| `06-collab-panel.png` | 协作面板：已注册 Agent + 已创建 Run / collab panel with agent + run |
| `07-command-palette.png` | 命令面板（已过滤 "theme"）/ command palette filtered |
| `08-trace-drawer.png` | 底部活动追踪抽屉（真实事件流）/ bottom trace drawer with real events |
| `09-pane-hive-cli.png` | 窗格内 `hive whoami` 输出 / `hive whoami` output inside a pane |

**前提条件 / Prerequisites**:
- `playwright-core` 已安装（`npm install` 即可，devDependency）
- 本机有 Playwright Chromium 缓存（`%LOCALAPPDATA%\ms-playwright\chromium-*`）
- 不需要预先启动服务器（脚本自启动，用完即关）

## 与 verify-ui.mjs 的关系 / Relationship to verify-ui.mjs

`scripts/verify-ui.mjs` 是 UI **验证**脚本（45 项断言，可加 `--shot <path>` 附一张截图）；
`scripts/screenshots.mjs` 是截图**采集**脚本（产出 README 画廊）。两者共用同一套
「进程内服务器 + 本机 Chromium」策略。

`verify-ui.mjs` is the UI **verification** script (45 assertions, `--shot` optional);
`screenshots.mjs` is the **capture** script that produces the README gallery.
Both use the same in-process-server + local-Chromium strategy.

## 手动截图 / Manual Screenshots

如果自动脚本不可用（例如没有 Chromium 缓存），可手动截取以下关键界面。
启动服务器 `npm start` 后在浏览器中操作：

If the automated script is unavailable (e.g. no Chromium cache), capture these
key screens manually: start the server with `npm start`, then operate in the browser:

1. **主界面 / Main Interface** — 点 "+ CLI pane" 生成 2-3 个窗格，确保窗格内有真实输出
2. **四种主题 / Themes** — 标题栏 ⚙ → Appearance settings 切换，每种截一张
3. **协作面板 / Collab Panel** — 右侧 "⚙ collab" 标签，注册 Agent、创建 Run
4. **命令面板 / Command Palette** — Ctrl/Cmd+K，输入过滤词
5. **追踪抽屉 / Trace Drawer** — 先发一条消息，再按 Ctrl/Cmd+Shift+T
6. **窗格内 CLI / hive CLI in a pane** — 窗格内输入 `hive whoami` / `hive panes`

## 截图最佳实践 / Screenshot Best Practices

1. 分辨率 ≥ 1500×900，确保 UI 元素清晰
2. 窗格内应有真实输出（如 `hive whoami`），不要空白
3. 至少展示默认 Amber 主题 + 一种其他主题
4. 截图后运行 `npm test` + `node scripts/verify-ui.mjs` 确认无回归

## 许可证 / License

MIT
