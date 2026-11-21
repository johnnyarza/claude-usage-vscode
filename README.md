# Claude Usage for VS Code

Shows your Claude plan utilization in the status bar, for example `5h 36% · wk 30%`. These are the same numbers `/usage` shows in Claude Code. Click it to open a panel that shows:

- **Plan limits:** the 5-hour session limit and weekly limits, each with its reset time, plus the weekly usage split by product (Claude Code, chats, Cowork).
- **Claude Code tokens on this computer:** totals for the current session window, today and the last 7 days, a daily chart, and tables by model and by project.

The status bar turns yellow at 75% and red at 90%. You can change both thresholds in the settings.

## How it works

- **Plan limits:** read from Anthropic's usage endpoint with the login Claude Code already stores in `~/.claude/.credentials.json`. The extension only reads the token and never refreshes or changes it. If the token expires, run Claude Code once and the extension picks up the new one.
- **Token counts:** read from the Claude Code session logs in `~/.claude/projects/**/*.jsonl`.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeUsage.fetchPlanUsage` | `true` | Turn off to show only local token counts |
| `claudeUsage.refreshIntervalSeconds` | `120` | How often plan limits are fetched (minimum 60) |
| `claudeUsage.claudeDir` | `""` | Claude config folder (defaults to `CLAUDE_CONFIG_DIR` or `~/.claude`) |
| `claudeUsage.warningThreshold` | `75` | Percent at which the status bar turns yellow |
| `claudeUsage.criticalThreshold` | `90` | Percent at which the status bar turns red |

## Rebuild and install

Run `build.ps1`. It packages `claude-usage-0.1.0.vsix` and installs it with `code --install-extension`. You don't need Node.js.
