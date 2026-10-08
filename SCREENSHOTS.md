# clihive 截图指南 / Screenshots Guide

本文档说明如何获取 clihive 的运行截图，以及截图应展示的内容。

This document explains how to capture clihive screenshots and what they should show.

## 自动截图 / Automated Screenshots

### UI 验证脚本 / UI Verification Script

clihive 包含一个自动 UI 验证脚本，使用 Puppeteer 驱动 Chromium 浏览器截取截图：

clihive includes an automated UI verification script that uses Puppeteer to drive Chromium and capture screenshots:

```bash
node scripts/verify-ui.mjs
```

**生成的截图 / Generated Screenshots**:
- `.artifacts/ui-main.png` - 主界面（标题栏、侧边栏、英雄网格、任务控制面板）
- `.artifacts/ui-matrix-theme.png` - Matrix 主题
- `.artifacts/ui-void-theme.png` - Void 主题
- `.artifacts/ui-neon-theme.png` - Neon 赛博朋克主题
- `.artifacts/ui-collab-panel.png` - 协作面板（Agent 注册、运行创建）
- `.artifacts/ui-command-palette.png` - 命令面板 (Ctrl/Cmd+K)
- `.artifacts/ui-trace-drawer.png` - 活动追踪抽屉 (Ctrl/Cmd+Shift+T)

**前提条件 / Prerequisites**:
- 安装 puppeteer: `npm install --save-dev puppeteer`
- clihive 服务正在运行: `npm start`
- Chromium 会自动下载（首次运行）

## 手动截图 / Manual Screenshots

如果自动截图脚本不可用，可以手动截取以下关键界面：

If the automated script is unavailable, manually capture these key screens:

### 1. 主界面 / Main Interface

**应展示 / Should Show**:
- 标题栏（工作区名称、实时状态、连接状态）
- 左侧工作区侧边栏（可折叠）
- 中央英雄区（窗格网格，聚焦窗格有钢蓝色边框）
- 右侧任务控制面板（Fleet 名单、调度器线程）
- 底部编辑器（发送消息到窗格）

**操作步骤 / Steps**:
1. 启动 clihive: `npm start`
2. 打开浏览器访问打印的 URL
3. 点击 "+ CLI pane" 生成 2-3 个窗格
4. 截取完整窗口

### 2. 主题变体 / Theme Variants

**应展示 / Should Show**:
四种主题的视觉差异：
- **Amber graphite** (默认): 温暖中性石墨色 + 琥珀色强调
- **Matrix**: 荧光绿 `#00FF41` + 青色，CRT 闪烁效果
- **Void**: 无色近黑，极简
- **Neon**: 赛博朋克，热品红 `#FF2E9A` + 电青色，渐变聚焦环

**操作步骤 / Steps**:
1. 点击标题栏 ⚙ 按钮
2. 选择 "Appearance settings"
3. 切换主题
4. 每个主题截一张图

### 3. 协作面板 / Collaboration Panel

**应展示 / Should Show**:
- ⚙ collab 标签激活
- Agent 列表（provider、label、state、permission）
- "Register agent" 表单（provider 下拉、cwd、permission、model for opencode）
- Run 列表（objective、state、tasks）
- Task 详情（state、result、review 按钮）

**操作步骤 / Steps**:
1. 点击右侧面板的 "⚙ collab" 标签
2. 注册一个 Agent: `hive agents add codex --label test --cwd .`
3. 创建一个 Run: `hive run "test task" --agents <id>`
4. 截取面板

### 4. 命令面板 / Command Palette

**应展示 / Should Show**:
- Ctrl/Cmd+K 打开的模糊搜索框
- 命令列表（spawn pane、switch theme、toggle panels）
- 窗格跳转

**操作步骤 / Steps**:
1. 按 Ctrl/Cmd+K
2. 输入 "spawn" 或 "theme"
3. 截取面板

### 5. 活动追踪抽屉 / Activity Trace Drawer

**应展示 / Should Show**:
- Ctrl/Cmd+Shift+T 打开的底部抽屉
- JSONL 事件流（send、fanout、deliver、ack）
- 可过滤的追踪视图

**操作步骤 / Steps**:
1. 发送一条消息: `hive send --to all "test"`
2. 按 Ctrl/Cmd+Shift+T
3. 截取事件流

### 6. 窗格内 hive CLI / hive CLI Inside a Pane

**应展示 / Should Show**:
- 窗格内的终端
- `hive whoami` 输出
- `hive panes` 列表
- `hive inbox` 消息

**操作步骤 / Steps**:
1. 在一个窗格内输入: `hive whoami`
2. 输入: `hive panes`
3. 截取终端输出

## 截图最佳实践 / Screenshot Best Practices

1. **分辨率**: 1920x1080 或更高，确保 UI 元素清晰
2. **窗格数量**: 2-4 个窗格，展示平铺布局
3. **主题**: 至少展示 Amber graphite（默认）和一种其他主题
4. **内容**: 窗格内应有实际输出（如 `ls` 或 `hive whoami`），不要空白
5. **标注**: 可选用红框或箭头标注关键元素

## 截图文件命名 / Screenshot File Naming

建议的命名规范：

```
screenshots/
  01-main-interface.png
  02-theme-amber.png
  03-theme-matrix.png
  04-theme-void.png
  05-theme-neon.png
  06-collab-panel.png
  07-command-palette.png
  08-trace-drawer.png
  09-pane-hive-cli.png
```

## 集成到 README / Integration into README

截图应放置在 README.md 的以下位置：

```markdown
## 界面预览 / Interface Preview

![主界面](screenshots/01-main-interface.png)
*主界面：窗格网格、任务控制面板、编辑器*

![Matrix 主题](screenshots/03-theme-matrix.png)
*Matrix 主题：荧光绿 + CRT 闪烁*

![协作面板](screenshots/06-collab-panel.png)
*协作面板：Agent 注册、运行管理、任务审核*
```

## 自动截图脚本故障排除 / Automated Script Troubleshooting

### Puppeteer 未安装 / Puppeteer Not Installed

```bash
npm install --save-dev puppeteer
```

### Chromium 下载失败 / Chromium Download Failed

设置国内镜像：
```bash
set PUPPETEER_DOWNLOAD_HOST=https://npmmirror.com/mirrors/chrome-for-testing
npm install --save-dev puppeteer
```

### 服务未运行 / Server Not Running

```bash
npm start
# 在另一个终端运行
node scripts/verify-ui.mjs
```

### Token 不匹配 / Token Mismatch

服务重启后 token 会变化，脚本会自动重新读取 `~/.clihive/token`。

## 许可证 / License

MIT
