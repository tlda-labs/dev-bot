# tlda dev bot

The dev bot monitors the configured testing environment with a real document-load
probe and an opt-in disposable core phi probe across
spawn/login/inbox/hibernate/delegate/wake/login/inbox. Healthy checks stay quiet. Failures notify eligible
on-call agents. The bot also owns cleanup of idle Playwright sessions, merged
clean worktrees, and over-budget worktree dependency caches.

Its authority is limited to its configured non-stable environment, disposable
probe agents and tasks, configured failure-notice recipients, local cleanup
eligibility rules, and its report file in the ordinary `info` project. It does not deploy,
modify stable environments, clean dirty or active worktrees, or create a
separate artifact store.

## Inputs and outputs

Inputs are fleet and project API responses, local worktree/process/disk
measurements, chat commands, and the configuration below. Outputs are structured
logs, an append-only heartbeat, bounded failure notices, cleanup actions, and a
volatile semantic Markdown status report with an additional interactive SVG
timeline.

Persistent state consists of the fleet identity file and heartbeat. The
supervisor owns the process and PID file. Failure-notice cooldown and timeline
samples are process-local and reset on restart. Reconnect does not replay a
cleanup or probe; normal schedules self-correct.

## Commands

<!-- BEGIN GENERATED COMMANDS -->
### `status`

Publish and return the current disk/worktree status report.

Writes the current semantic Markdown report and interactive timeline to the ordinary info project through the normal source-change pipeline, then returns its project-file reference.

Examples:

- `status`
<!-- END GENERATED COMMANDS -->

## Configuration

The runtime validator and this section use the same schema.

<!-- BEGIN GENERATED CONFIG -->
- `TLDA_DEV_BOT_INTERVAL_MS` (intervalMs; default: `60000`) — Behavioral probe interval in milliseconds.
- `TLDA_DEV_BOT_FAILURE_COOLDOWN_MS` (failureCooldownMs; default: `300000`) — Minimum interval between identical failure notices.
- `TLDA_DEV_BOT_REQUEST_TIMEOUT_MS` (requestTimeoutMs; default: `15000`) — Fleet and HTTP request timeout in milliseconds.
- `TLDA_DEV_BOT_SPAWN_WAKE_INTERVAL_MS` (spawnWakeIntervalMs; default: `1800000`) — Spawn/wake probe cadence in milliseconds.
- `TLDA_DEV_BOT_SPAWN_WAKE_TIMEOUT_MS` (spawnWakeTimeoutMs; default: `180000`) — Overall spawn/wake probe deadline.
- `TLDA_DEV_BOT_SPAWN_WAKE_ENABLED` (spawnWakeEnabled; default: `false`) — Whether the mutating disposable core phi probe runs after shadow verification.
- `TLDA_DEV_BOT_SPAWN_WAKE_MODEL` (spawnWakeModel; default: `""`) — Optional model override for the disposable probe agent.
- `TLDA_DEV_BOT_LINKED_REMOTE_ENABLED` (linkedRemoteEnabled; default: `false`) — Whether to exercise the disposable linked Git remote.
- `TLDA_DEV_BOT_LINKED_REMOTE_INTERVAL_MS` (linkedRemoteIntervalMs; default: `1800000`) — Linked remote safety probe cadence in milliseconds.
- `TLDA_DEV_BOT_LINKED_REMOTE_HOST` (linkedRemoteHost; default: `""`) — Tailnet address advertised by the disposable Git remote.
- `TLDA_DEV_BOT_LINKED_REMOTE_PORT` (linkedRemotePort; default: `19418`) — Port for the disposable Git remote.
- `TLDA_DEV_BOT_LINKED_REMOTE_RESTART_COMMAND` (linkedRemoteRestartCommand; default: `""`) — Command that restarts the testing server during the linked remote transition.
- `TLDA_DEV_BOT_DOC` (probeDoc; default: `""`) — Optional project selected for the SVG load probe.
- `TLDA_DEV_BOT_ASSET_PATH_OVERRIDE` (assetPathOverride; default: `""`) — Optional exact SVG asset path for the document probe.
- `TLDA_DEV_BOT_ALLOW_NONDEFAULT` (allowNondefault; default: `false`) — Permit probing an environment not assigned to this bot.
- `TLDA_DEV_BOT_NUDGE_TO` (nudgeTo; default: `""`) — Exact failure-notice recipient override.
- `TLDA_DEV_BOT_NUDGE_LABEL` (nudgeLabel; default: `"on-call"`) — Fleet label used to select failure-notice recipients.
- `TLDA_DEV_BOT_NUDGE_SETUP` (nudgeOnSetup; default: `false`) — Send notices for probe setup failures.
- `TLDA_DEV_BOT_NUDGE_DRY_RUN` (nudgeDryRun; default: `false`) — Record but do not send failure notices.
- `TLDA_DEV_BOT_RESOURCE_CLEANUP_INTERVAL_MS` (resourceCleanupIntervalMs; default: `60000`) — Playwright cleanup cadence.
- `TLDA_DEV_BOT_WORKTREE_CLEANUP_INTERVAL_MS` (worktreeCleanupIntervalMs; default: `3600000`) — Worktree cleanup cadence.
- `TLDA_DEV_BOT_STATUS_FILE` (statusFile; default: `"dev-bot-status.md"`) — Project-relative volatile status Markdown path.
<!-- END GENERATED CONFIG -->

The shared harness also honors `TLDA_BOT_NAME`, `TLDA_BOT_PIDFILE`,
`TLDA_BOT_IDFILE`, `TLDA_BOT_MACHINE_ID`, and `TLDA_BOT_TMUX_SESSION`.
`TLDA_BOT_HEARTBEAT` selects the append-only heartbeat file.

## Operation

From this repository:

```sh
npm install
tlda bot install dev
tlda bot start dev
tlda bot status dev
tlda bot log dev
tlda bot stop dev
tlda bot uninstall dev
```

`tlda bot install dev` installs the configured launchd service; `start`, `stop`,
`status`, `log`, and `uninstall` are the only supported live-process operations.
Do not use a detached manual process as a live proof.

Default persistent files are `~/.config/tlda/dev.fleet-id`,
`~/.config/tlda/dev.pid`, and `~/.config/tlda/dev.heartbeat`. Logs are owned by
the configured launchd service and read with `tlda bot log dev`.

## Recovery and verification

For a stale or failed process, run `tlda bot status dev`, inspect
`tlda bot log dev`, then run `tlda bot stop dev` followed by
`tlda bot start dev`. The persisted fleet identity must remain in place; do not
mint a replacement identity.

Local verification:

```sh
npm test
node --check dev-bot.mjs
TLDA_DEV_BOT_NO_START=1 node generate-docs.mjs --check
```

The remaining live proof is supervisor-owned login and heartbeat, `help`, one
`status` command, and the browser-visible rendered status document.
