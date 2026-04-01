/**
 * 详细分析原版压缩逻辑
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
  private readonly CONDENSED_MIN_FANOUT = 4;  // ← 原版
  private readonly CONTEXT_THRESHOLD = 0.75;
  private readonly TOKEN_BUDGET = 128000;  // ← 改回 128K

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

  leafPass(): boolean {
    const evictableMessages = this.items.filter((item, idx) =>
      item.type === 'message' && idx >= this.FRESH_TAIL_COUNT
    ).length;
    if (evictableMessages < this.LEAF_MIN_FANOUT) return false;

    const chunk = this.selectOldestLeafChunk();
    if (chunk.count < this.LEAF_MIN_FANOUT) return false;

    console.log(`    [叶压缩] 可压缩: ${evictableMessages} 条 → 选择: ${chunk.count} 条 (${chunk.tokens} tokens) → summary: ${this.LEAF_TARGET_TOKENS} tokens`);
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);
    return true;
  }

  condensedPass(targetDepth: number): boolean {
    const itemsAtDepth = this.items.filter((item, idx) =>
      item.type === 'summary' && item.depth === targetDepth && idx >= this.FRESH_TAIL_COUNT
    ).length;
    if (itemsAtDepth < this.CONDENSED_MIN_FANOUT) return false;

    const chunk = this.selectOldestChunkAtDepth(targetDepth);
    if (chunk.count < this.CONDENSED_MIN_FANOUT) return false;

    console.log(`    [冷凝 d${targetDepth}] 可压缩: ${itemsAtDepth} 个 → 选择: ${chunk.count} 个 (${chunk.tokens} tokens) → summary: ${this.CONDENSED_TARGET_TOKENS} tokens`);
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
    return true;
  }

  compact(): boolean {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();

    if (currentTokens <= threshold) return false;

    console.log(`\n[压缩] 当前: ${currentTokens} tokens, 阈值: ${threshold}`);

    let previousTokens = currentTokens;
    let rounds = 0;

    // Phase 1
    while (rounds < 50) {
      const tokensBefore = this.getTotalTokens();
      const result = this.leafPass();
      if (!result) {
        console.log(`    叶压缩停止`);
        break;
      }

      const tokensAfter = this.getTotalTokens();
      rounds++;

      if (tokensAfter <= threshold) {
        console.log(`    达到阈值以下`);
        break;
      }
      if (tokensAfter >= tokensBefore) break;
      if (tokensAfter >= previousTokens) break;

      previousTokens = tokensAfter;
    }

    // Phase 2
    let phase2Rounds = 0;
    while (rounds + phase2Rounds < 50) {
      const tokensBefore = this.getTotalTokens();

      let targetDepth = -1;
      for (let d = 0; d <= 10; d++) {
        const itemsAtDepth = this.items.filter(i => i.type === 'summary' && i.depth === d);
        if (itemsAtDepth.length >= this.CONDENSED_MIN_FANOUT) {
          const chunk = this.selectOldestChunkAtDepth(d);
          console.log(`    [Phase 2 检查] d${d}: 总数=${itemsAtDepth.length}, 可压缩=${chunk.count}, 需要=${this.CONDENSED_MIN_FANOUT}`);
          if (chunk.count >= this.CONDENSED_MIN_FANOUT) {
            targetDepth = d;
            break;
          }
        }
      }

      if (targetDepth === -1) break;

      const result = this.condensedPass(targetDepth);
      if (!result) break;

      const tokensAfter = this.getTotalTokens();
      rounds++;
      phase2Rounds++;

      if (tokensAfter <= threshold) break;
      if (tokensAfter >= tokensBefore) break;

      previousTokens = tokensAfter;
    }

    console.log(`[压缩结束] ${rounds} 轮, 最终: ${this.getTotalTokens()} tokens\n`);
    return rounds > 0;
  }

  printState(label: string) {
    const depths: Record<number, number> = {};
    let messages = 0;
    for (const item of this.items) {
      if (item.type === 'message') {
        messages++;
      } else {
        depths[item.depth] = (depths[item.depth] || 0) + 1;
      }
    }
    console.log(`[${label}] tokens: ${this.getTotalTokens()}, messages: ${messages}, depths: ${Object.entries(depths).map(([d,c]) => `d${d}=${c}`).join(', ') || '(无)'}`);
  }
}

// 模拟
const sim = new CompactionSimulator();
console.log('=== 原版压缩逻辑详细分析 ===\n');
console.log('配置:');
console.log('  LEAF_CHUNK_TOKENS = 20000');
console.log('  LEAF_MIN_FANOUT = 8 (触发阈值)');
console.log('  CONDENSED_MIN_FANOUT = 4 (触发阈值) ← 原版');
console.log('  TOKEN_BUDGET = 200000');
console.log('  CONTEXT_THRESHOLD = 0.75 (150K)\n');

sim.addMessages(100, 500);
sim.printState('初始: 100 条消息');

// 只运行几轮观察详细行为
for (let round = 1; round <= 100; round++) {
  sim.addMessages(20, 500);  // ← 增加到 20 条，强制触发更深的压缩

  const shouldLog = round <= 25 || round % 10 === 0;
  if (shouldLog) console.log(`\n--- 第 ${round} 轮: 添加 20 条消息 ---`);
  const result = sim.compact();
  if (!result && shouldLog) {
    console.log(`  未触发压缩`);
  }
  if (shouldLog) sim.printState(`第 ${round} 轮后`);
}

console.log('\n=== 总结 ===');
sim.printState('最终');