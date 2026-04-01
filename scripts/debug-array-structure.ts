/**
 * 调试数组结构
 */

interface ContextItem {
  id: string;
  type: 'message' | 'summary';
  depth: number;
  tokens: number;
}

class CompactionSimulator {
  private items: ContextItem[] = [];
  private summaryIdCounter = 0;

  private readonly FRESH_TAIL_COUNT = 64;
  private readonly LEAF_CHUNK_TOKENS = 20000;
  private readonly LEAF_TARGET_TOKENS = 2400;
  private readonly CONDENSED_TARGET_TOKENS = 2000;
  private readonly LEAF_MIN_FANOUT = 8;
  private readonly CONDENSED_MIN_FANOUT = 4;
  private readonly CONTEXT_THRESHOLD = 0.75;
  private readonly TOKEN_BUDGET = 128000;

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  addMessages(count: number, tokensPerMessage: number = 500) {
    for (let i = 0; i < count; i++) {
      this.items.unshift({
        id: `msg_${Date.now()}_${i}`,
        type: 'message',
        depth: 0,
        tokens: tokensPerMessage,
      });
    }
  }

  private selectOldestLeafChunk(): { startIdx: number; endIdx: number; count: number; tokens: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const chunk: number[] = [];
    let chunkTokens = 0;
    let started = false;

    for (let i = this.items.length - 1; i >= freshTailBoundary; i--) {
      const item = this.items[i];
      if (item.type === 'message') {
        started = true;
        if (chunkTokens + item.tokens > this.LEAF_CHUNK_TOKENS) {
          if (chunk.length === 0) chunk.push(i);
          break;
        }
        chunk.push(i);
        chunkTokens += item.tokens;
        if (chunkTokens >= this.LEAF_CHUNK_TOKENS) break;
      } else if (started) {
        break;
      }
    }

    chunk.sort((a, b) => a - b);
    return {
      startIdx: chunk[0],
      endIdx: chunk[chunk.length - 1],
      count: chunk.length,
      tokens: chunkTokens
    };
  }

  private selectOldestChunkAtDepth(targetDepth: number): { startIdx: number; endIdx: number; count: number; tokens: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const chunk: number[] = [];
    let chunkTokens = 0;
    let started = false;

    for (let i = this.items.length - 1; i >= freshTailBoundary; i--) {
      const item = this.items[i];
      if (item.type !== 'summary' || item.depth !== targetDepth) {
        if (started) break;
        continue;
      }

      started = true;
      if (chunkTokens + item.tokens > this.LEAF_CHUNK_TOKENS) {
        if (chunk.length === 0) chunk.push(i);
        break;
      }
      chunk.push(i);
      chunkTokens += item.tokens;
    }

    chunk.sort((a, b) => a - b);
    return {
      startIdx: chunk[0],
      endIdx: chunk[chunk.length - 1],
      count: chunk.length,
      tokens: chunkTokens
    };
  }

  private replaceRangeWithSummary(startIdx: number, endIdx: number, depth: number, targetTokens: number): void {
    const summary: ContextItem = {
      id: `sum_${depth}_${this.summaryIdCounter++}`,
      type: 'summary',
      depth,
      tokens: targetTokens,
    };
    this.items.splice(startIdx, endIdx - startIdx + 1, summary);
  }

  compact(): boolean {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();
    if (currentTokens <= threshold) return false;

    let previousTokens = currentTokens;
    let rounds = 0;

    // Phase 1: 叶压缩
    while (rounds < 50) {
      const evictableMessages = this.items.filter((item, idx) =>
        item.type === 'message' && idx >= this.FRESH_TAIL_COUNT
      ).length;
      if (evictableMessages < this.LEAF_MIN_FANOUT) break;

      const chunk = this.selectOldestLeafChunk();
      if (chunk.count < this.LEAF_MIN_FANOUT) break;

      this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);

      const tokensAfter = this.getTotalTokens();
      rounds++;
      if (tokensAfter <= threshold) break;
      if (tokensAfter >= previousTokens) break;
      previousTokens = tokensAfter;
    }

    // Phase 2: 冷凝
    let phase2Rounds = 0;
    while (rounds + phase2Rounds < 50) {
      const tokensBefore = this.getTotalTokens();

      let targetDepth = -1;
      for (let d = 0; d <= 10; d++) {
        const itemsAtDepth = this.items.filter(i => i.type === 'summary' && i.depth === d);
        if (itemsAtDepth.length >= this.CONDENSED_MIN_FANOUT) {
          const chunk = this.selectOldestChunkAtDepth(d);
          if (chunk.count >= this.CONDENSED_MIN_FANOUT) {
            targetDepth = d;
            break;
          }
        }
      }

      if (targetDepth === -1) break;

      const chunk = this.selectOldestChunkAtDepth(targetDepth);
      this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);

      const tokensAfter = this.getTotalTokens();
      rounds++;
      phase2Rounds++;
      if (tokensAfter <= threshold) break;
      if (tokensAfter >= tokensBefore) break;
      previousTokens = tokensAfter;
    }

    return rounds > 0;
  }

  // 分析数组结构
  analyzeStructure(label: string) {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);

    let freshTailMsgs = 0;
    let freshTailSummaries = 0;
    let evictableMsgs = 0;
    let evictableSummaries = 0;

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (i < freshTailBoundary) {
        if (item.type === 'message') freshTailMsgs++;
        else freshTailSummaries++;
      } else {
        if (item.type === 'message') evictableMsgs++;
        else evictableSummaries++;
      }
    }

    console.log(`\n[${label}]`);
    console.log(`  总 items: ${this.items.length}`);
    console.log(`  Fresh tail (idx 0-${freshTailBoundary - 1}): ${freshTailMsgs} messages, ${freshTailSummaries} summaries`);
    console.log(`  可压缩 (idx ${freshTailBoundary}+): ${evictableMsgs} messages, ${evictableSummaries} summaries`);

    // 显示前 70 个 items 的类型
    const preview: string[] = [];
    for (let i = 0; i < Math.min(70, this.items.length); i++) {
      const item = this.items[i];
      preview.push(item.type === 'message' ? 'M' : `S${item.depth}`);
    }
    console.log(`  前 70 个: ${preview.join('')}`);
  }
}

// 模拟
const sim = new CompactionSimulator();
console.log('=== 调试数组结构 ===\n');

sim.addMessages(100, 500);
sim.analyzeStructure('初始: 100 条 messages');

for (let round = 1; round <= 50; round++) {
  sim.addMessages(20, 500);
  sim.compact();

  if (round % 10 === 0) {
    sim.analyzeStructure(`第 ${round} 轮后`);
  }
}

sim.analyzeStructure('最终');