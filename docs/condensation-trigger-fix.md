# Condensation Trigger Fix

## 问题发现

通过 5000 轮仿真（从 0 条消息开始，每条 ~370 tokens），发现源代码中的浓缩触发逻辑存在设计缺陷。

### 原始逻辑
```typescript
const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
if (chunk.items.length < fanout) break;
```

### 问题分析

1. **chunk 受 token 限制**：`chunkTokenBudget = 20000`
2. **每 summary 约 2400 tokens**，chunk 最多容纳 `20000 / 2400 ≈ 8` 个
3. **检查用的是 `chunk.items.length < fanout`**
4. **当 `fanout > 8` 时**，永远无法触发

| 场景 | chunk 容量 | fanout | 结果 |
|------|-----------|--------|------|
| 原始 | ~8 | 8 | ✓ 正常 |
| 修改后 | ~8 | 16 | ✗ 永远不触发 |

### 设计缺陷

`fanout` 被误用于两个不同的目的：
1. **触发阈值**：有多少 summaries 才值得压缩？
2. **chunk 大小检查**：选出的 chunk 是否有意义？

但这两者应该分开：
- 触发条件应该基于**实际 summary 计数**（运行时状态）
- Chunk 检查应该基于 **chunk 是否有内容**（不为空）

## 修复方案

### 修改前
```typescript
const fanout = this.resolveFanoutForDepth(targetDepth, false);
const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
if (chunk.items.length < fanout || chunk.summaryTokens < condensedMinChunkTokens) {
  break;
}
```

### 修改后
```typescript
const fanout = this.resolveFanoutForDepth(targetDepth, false);

// 1. 用实际 summary 数量与 fanout 比较（不受 chunk token 限制）
const contextItems = await this.summaryStore.getContextItems(conversationId);
const freshTailOrdinal = this.resolveFreshTailOrdinal(contextItems);
let actualSummaryCount = 0;
for (const item of contextItems) {
  if (item.ordinal >= freshTailOrdinal) break;
  if (item.itemType !== "summary" || item.summaryId == null) continue;
  const summary = await this.summaryStore.getSummary(item.summaryId);
  if (summary && summary.depth === targetDepth) {
    actualSummaryCount++;
  }
}
if (actualSummaryCount < fanout) {
  break;
}

// 2. chunk 只检查是否为空（移除 < fanout 检查）
const chunk = await this.selectOldestChunkAtDepth(conversationId, targetDepth);
if (chunk.items.length === 0 || chunk.summaryTokens < condensedMinChunkTokens) {
  break;
}
```

## 仿真验证

### 配置：fanout = 16（修改前无法触发）

| 指标 | 结果 |
|------|------|
| Total tokens | 69,714 (34.9%) |
| depth=0 summaries | 10 |
| depth=1 summaries | 9 |

### 配置：fanout = 8（原始值）

| 指标 | 结果 |
|------|------|
| Total tokens | 59,674 (29.8%) |
| depth=0 summaries | 3 |
| depth=1 summaries | 11 |

## 效果

- ✅ **向后兼容**：fanout <= chunk 容量时行为不变
- ✅ **新功能**：fanout > chunk 容量时也能正常工作
- ✅ **触发与压缩解耦**：可以"16个触发，每次压8个"
- ✅ **支持更高触发阈值**：通过设置 `leafMinFanout = 16` 控制保留更多 depth=0 summaries

## 相关文件

- `src/compaction.ts`: 修改 condensed pass 触发逻辑
- `scripts/simulate-using-source.ts`: 仿真脚本