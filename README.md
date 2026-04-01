# lossless-claw (Customized Fork)

> **Customized version of [martian-engineering/lossless-claw](https://github.com/martian-engineering/lossless-claw) for long-lived agent memory with stable token control.**

## What This Is

This is a modified fork of the lossless-claw OpenClaw plugin. It retains the upstream DAG-based summarization system but adds specific improvements for persistent agents and predictable token usage.

## Custom Modifications

### 1. Persistent Agents (Single DAG Architecture)

Agents configured in `persistentAgents` use a single, long-lived conversation DAG across all sessions instead of per-session isolation. This enables true long-term memory for agents like "main" that need to remember everything.

**Configuration**:
```json
{
  "persistentAgents": ["main"]
}
```

### 2. Depth=1 Automatic Capping

When depth=1 summary count exceeds 8, the oldest summaries are automatically removed from assembled context (not deleted from database). This prevents unbounded token growth in long-running conversations.

**Implementation**: `capDepth1Summaries()` in `src/store/summary-store.ts`

### 3. Condensation Trigger Fix

Fixed a bug where condensation (depth=0 → depth=1) was comparing chunk token count against fanout value instead of actual summary count. Now correctly triggers when actual summary count reaches `condensedMinFanout`.

**File**: `src/compaction.ts` - `selectShallowestCondensationCandidate()`

## Installation

This is not published to npm. Install from source:

```bash
# Clone the repository
git clone https://github.com/LanicBlue/lossless-MemOS.git
cd lossless-MemOS

# Install dependencies
npm install

# Build (if needed)
npm run build
```

Then configure OpenClaw to use the local plugin path. See upstream [lossless-claw](https://github.com/martian-engineering/lossless-claw) for general OpenClaw plugin setup instructions.

## Configuration

Key configuration options for this fork:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "config": {
          "freshTailCount": 64,
          "leafMinFanout": 24,
          "condensedMinFanout": 8,
          "leafChunkTokens": 20000,
          "leafTargetTokens": 2400,
          "condensedTargetTokens": 2000,
          "incrementalMaxDepth": 1,
          "contextThreshold": 0.75,
          "persistentAgents": ["main"]
        }
      }
    }
  }
}
```

### Recommended Settings (200K context)

Tested with 10,000-round simulations (~530 tokens/message), achieving stable token control at ~46% budget usage:

| Setting | Value | Description |
|---------|-------|-------------|
| `freshTailCount` | 64 | Protects last 64 messages from compaction |
| `leafMinFanout` | 24 | Requires 24+ messages before leaf compression |
| `condensedMinFanout` | 8 | Requires 8+ depth=0 summaries before condensing |
| `leafChunkTokens` | 20000 | Max source tokens per leaf chunk |
| `incrementalMaxDepth` | 1 | Enables one condensed pass |
| `contextThreshold` | 0.75 | Triggers compaction at 75% of budget |
| `persistentAgents` | `["main"]` | Agents with single DAG across sessions |

## How It Works

1. **Persists every message** in SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into leaf summaries (depth=0)
3. **Condenses summaries** into higher-level nodes (depth=1, depth=2, ...)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Auto-caps depth=1** at 8 nodes to prevent unbounded growth
6. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) for historical recall

Persistent agents use a single conversation across sessions, enabling true long-term memory.

## Upstream Documentation

For detailed architecture, tool reference, and general usage, see the [upstream lossless-claw README](https://github.com/martian-engineering/lossless-claw).

## Development

```bash
# Run tests
npx vitest

# Type check
npx tsc --noEmit
```

## License

MIT (same as upstream lossless-claw)