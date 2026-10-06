// CLI flavor registry: recognize what a pane is running so the hive can adapt.
//
// Different CLIs behave differently, and the hive has to meet each one where it
// is:
//
//   - Identity. A pane running codex should *look* like codex at a glance:
//     its own accent color and badge in the window chrome and the fleet list,
//     instead of one undifferentiated wall of terminals.
//
//   - Injection safety. Full-screen TUI agents (codex, claude, gemini, qwen…)
//     own their screen and repaint by absolute cursor position; text painted
//     over them is the "overlapping context" bug. The output-mode tracker
//     holds display injections back while the screen is owned. Plain shells
//     scroll, so painting is immediately safe.
//
//   - Delivery semantics. An agent CLI reads its stdin *as a prompt* — writing
//     a message there is how you task it. A plain shell would try to EXECUTE
//     whatever arrives on stdin, so its safe default is display. `suggestMode`
//     encodes that per flavor and becomes the pane's delivery mode when the
//     caller did not pick one explicitly.

/**
 * @typedef {object} CliProfile
 * @property {string} id        Stable machine name (`codex`, `shell`, …).
 * @property {string} label     Short human name for badges.
 * @property {string[]} names   Executable basenames that identify this CLI.
 * @property {string} accent    Badge/identity color (hex).
 * @property {boolean} tui      True for full-screen agents that own the screen.
 * @property {'display'|'stdin'} suggestMode Default delivery mode for this flavor.
 * @property {string} note      One-line description shown in tooltips.
 */

/**
 * Ordered list: first match wins, so specific agents come before the shells
 * and interpreters that might wrap them.
 * @type {CliProfile[]}
 */
export const CLI_PROFILES = Object.freeze([
  {
    id: 'codex', label: 'codex', names: ['codex', 'codex-cli'],
    accent: '#10a37f', tui: true, suggestMode: 'stdin',
    note: 'OpenAI Codex CLI — full-screen agent; stdin is its prompt',
  },
  {
    id: 'claude', label: 'claude', names: ['claude', 'claude-code'],
    accent: '#d97757', tui: true, suggestMode: 'stdin',
    note: 'Claude Code — full-screen agent; stdin is its prompt',
  },
  {
    id: 'gemini', label: 'gemini', names: ['gemini'],
    accent: '#4285f4', tui: true, suggestMode: 'stdin',
    note: 'Gemini CLI — full-screen agent; stdin is its prompt',
  },
  {
    id: 'qwen', label: 'qwen', names: ['qwen', 'qwen-code'],
    accent: '#a06bff', tui: true, suggestMode: 'stdin',
    note: 'Qwen Code — full-screen agent; stdin is its prompt',
  },
  {
    id: 'opencode', label: 'opencode', names: ['opencode'],
    accent: '#c8ff4d', tui: true, suggestMode: 'stdin',
    note: 'opencode — full-screen agent; stdin is its prompt',
  },
  {
    id: 'amp', label: 'amp', names: ['amp'],
    accent: '#4cc9ff', tui: true, suggestMode: 'stdin',
    note: 'Amp — full-screen agent; stdin is its prompt',
  },
  {
    id: 'goose', label: 'goose', names: ['goose'],
    accent: '#ffb020', tui: true, suggestMode: 'stdin',
    note: 'goose — full-screen agent; stdin is its prompt',
  },
  {
    id: 'aider', label: 'aider', names: ['aider'],
    accent: '#e8744f', tui: false, suggestMode: 'stdin',
    note: 'aider — line-mode agent; stdin is its prompt',
  },
  {
    id: 'dsh', label: 'dsh', names: ['dsh', 'deepseek-harness'],
    accent: '#6e9bc4', tui: true, suggestMode: 'stdin',
    note: 'DeepSeek Harness — full-screen agent; stdin is its prompt',
  },
  {
    id: 'node', label: 'node', names: ['node', 'nodejs', 'bun', 'deno'],
    accent: '#689f63', tui: false, suggestMode: 'display',
    note: 'JS runtime — display injection paints safely; stdin feeds the program',
  },
  {
    id: 'python', label: 'python', names: ['python', 'python3', 'py', 'ipython'],
    accent: '#4b8bbe', tui: false, suggestMode: 'display',
    note: 'Python — display injection paints safely; stdin feeds the REPL',
  },
  {
    id: 'shell', label: 'shell', names: [
      'cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
    ],
    accent: '#8a93a3', tui: false, suggestMode: 'display',
    note: 'Plain shell — display paints into the viewport; stdin would EXECUTE the text',
  },
]);

/** Fallback for anything unrecognized. */
export const GENERIC_PROFILE = Object.freeze({
  id: 'generic', label: 'cli', names: [],
  accent: '#8a93a3', tui: false, suggestMode: 'display',
  note: 'Unknown CLI — safe display injection',
});

/**
 * Reduce a command or argument to a lowercase basename without a script
 * extension: `C:\tools\node.exe` → `node`, `/usr/local/bin/claude` → `claude`.
 * @param {unknown} value
 */
function tokenName(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const base = s.split(/[\\/]/).pop() ?? s;
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '').toLowerCase();
}

/**
 * Identify the CLI a pane will run, from its command and first arguments.
 * Wrapper invocations are handled by scanning a few leading arguments:
 * `npx codex`, `pnpm dlx claude`, `uvx aider` all resolve to the agent.
 *
 * @param {unknown} command
 * @param {unknown[]} [args]
 * @returns {CliProfile | typeof GENERIC_PROFILE}
 */
export function detectCliProfile(command, args = []) {
  const tokens = [tokenName(command)];
  const rest = Array.isArray(args) ? args : [];
  for (const arg of rest.slice(0, 4)) {
    const s = String(arg ?? '').trim();
    // Flags (`-e`, `--model`) and wrapper subcommands (`exec`, `dlx`, `run`)
    // never name the CLI itself; a real path or bare name might.
    if (!s || s.startsWith('-')) continue;
    const name = tokenName(s);
    if (name) tokens.push(name);
  }
  for (const token of tokens) {
    for (const profile of CLI_PROFILES) {
      if (profile.names.includes(token)) return profile;
    }
  }
  return GENERIC_PROFILE;
}
