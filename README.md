# lossless-MemOS

> **Unified memory system for OpenClaw agents — DAG-based context + vector semantic recall, in one SQLite DB.**

Fork of [lossless-claw](https://github.com/martian-engineering/lossless-claw) (LCM) with two major extensions:

1. **Persistent Agent DAG** — Single conversation DAG across all sessions for designated agents (e.g. `"main"`), instead of per-session isolation.
2. **Controlled Memory Window** — Per-depth node caps + max depth limits, ensuring context memory usage stays within predictable bounds regardless of conversation length.

### Planned: Vector Recall Integration

The next phase merges LCM's standardized leaf summaries with MemOS-style vector semantic recall into a single system. Instead of running two separate memory systems (LCM for context + MemOS for search), this project will embed leaf summaries directly into the LCM database and provide semantic search as a built-in capability.

```
┌─────────────────────────────────────────────┐
│              lossless-MemOS                  │
├─────────────────────────────────────────────┤
│  DAG Context Layer (from LCM)               │
│  ├─ Raw messages → Leaf summaries (depth 0) │
│  ├─ Condensed summaries (depth 1, 2)        │
│  └─ Token-budget assembly with node caps    │
├─────────────────────────────────────────────┤
│  Vector Recall Layer (planned)              │
│  ├─ Embed leaf summaries (BGE-M3 local)     │
│  ├─ Semantic search on new user messages    │
│  └─ Top-K injection into prependContext      │
├─────────────────────────────────────────────┤
│  Single SQLite Database                      │
│  ├─ messages / summaries / context_items     │
│  └─ embeddings (planned)                    │
└─────────────────────────────────────────────┘
```

## What's Changed from Upstream LCM

### ✅ Done

| Feature | Config | Description |
|---------|--------|-------------|
| Persistent Agent | `persistentAgents: ["main"]` | Single DAG across sessions instead of per-session isolation |
| HEARTBEAT_OK pruning | `pruneHeartbeatOk: true` | Auto-delete heartbeat cycles from DAG storage |
| Max Summary Depth | `maxSummaryDepth: 2` | Limit assembled context to summaries ≤ this depth; deeper nodes stay in DB for expand |
| Per-depth Node Caps | `maxNodesPerDepth: [20, 8, 4]` | Cap node count per depth level; oldest dropped first, not deleted from DB |

### 📋 Planned

See [Issues](https://github.com/LanicBlue/lossless-MemOS/issues) for details.

| Priority | Feature | Status |
|----------|---------|--------|
| P0 | Vector recall (embed leaf summaries + semantic search) | Planned |
| P0 | Replace MemOS with built-in recall (deprecate memos-local plugin) | Planned |
| P1 | Recency boost in vector search (time-decay weighting) | Planned |
| P1 | Fact extraction from leaf summaries (structured memory) | Planned |
| P2 | Todo system integration (active todos in heartbeat) | Planned |
| P2 | Memory sharing (Hub publish/search across agents) | Planned |

## Quick Start

*(Same as upstream LCM — install via OpenClaw plugin slot)*

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "slot": "contextEngine",
        "package": "@LanicBlue/lossless-memos"
      }
    }
  }
}
```

## Recommended Configuration (200K context)

```json
{
  "lossless-claw": {
    "config": {
      "maxNodesPerDepth": [20, 8, 4],
      "maxSummaryDepth": 2,
      "incrementalMaxDepth": 3,
      "persistentAgents": ["main"],
      "freshTailCount": 32,
      "pruneHeartbeatOk": true
    }
  }
}
```

**Memory budget**: ~48K tokens (24% of 200K), stable and predictable.

## Architecture

### DAG Depth Model

```
Depth 0 (Leaf):     ~1200 tokens each, max 20 nodes = 24K
Depth 1 (Condensed): ~2000 tokens each, max 8 nodes  = 16K  
Depth 2 (Condensed): ~2000 tokens each, max 4 nodes  =  8K
Fresh Tail:         ~300 tokens each, 32 raw messages = 10K
                                              Total ≈ 48K
```

- `incrementalMaxDepth: 3` → compaction loop runs depth 0,1,2 → DB max depth = 3
- `maxSummaryDepth: 2` → only depth ≤ 2 loaded into context
- Depth 3 nodes exist in DB but are never loaded and never further compacted

### Why Per-depth Caps (not just token budget)

The original LCM uses pure token-budget eviction: when context exceeds 75% budget, oldest items are dropped. This causes:

- **Unpredictable context size** — varies with conversation patterns
- **Sudden context shifts** — large compaction events change what the model sees
- **Inconsistent behavior** — short chats vs long chats have very different context profiles

Per-depth caps ensure **stable, predictable memory footprint** regardless of conversation length.

## Development

```bash
git clone https://github.com/LanicBlue/lossless-MemOS.git
cd lossless-MemOS
npm install
npm test
```

## License

Same as upstream [lossless-claw](https://github.com/martian-engineering/lossless-claw) (MIT).
