/**
 * 模拟 lossless-claw 压缩逻辑的长期运行
 *
 * items 结构：items[0] = 最新, items[length-1] = 最旧
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
  // 触发阈值：达到这个数量才触发压缩
  private readonly LEAF_TRIGGER_FANOUT = 12;  // 叶压缩需要更多才触发
  private readonly CONDENSED_TRIGGER_FANOUT = 8;
  // 压缩数量：每次压缩多少个
  private readonly LEAF_COMPRESS_FANOUT = 8;   // 叶压缩一次压缩 8 个
  private readonly CONDENSED_COMPRESS_FANOUT = 4;
  private readonly CONTEXT_THRESHOLD = 0.75;
  private readonly TOKEN_BUDGET = 128000;

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  getStats() {
    const byDepth: Record<number, { count: number; tokens: number }> = {};
    const messages = { count: 0, tokens: 0 };

    for (const item of this.items) {
      if (item.type === 'message') {
        messages.count++;
        messages.tokens += item.tokens;
      } else {
        if (!byDepth[item.depth]) byDepth[item.depth] = { count: 0, tokens: 0 };
        byDepth[item.depth].count++;
        byDepth[item.depth].tokens += item.tokens;
      }
    }

    return { totalTokens: this.getTotalTokens(), totalItems: this.items.length, messages, byDepth };
  }

  addMessages(count: number, tokensPerMessage: number = 500) {
    // 新消息添加到数组前面（索引0）
    for (let i = 0; i < count; i++) {
      this.items.unshift({
        id: `msg_${Date.now()}_${i}`,
        type: 'message',
        depth: 0,
        tokens: tokensPerMessage,
      });
    }
  }

  // 选择最旧的叶压缩块（从数组末尾开始）
  private selectOldestLeafChunk(): { startIdx: number; endIdx: number; count: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const chunk: number[] = [];  // 要删除的索引
    let chunkTokens = 0;
    let started = false;

    // 从数组末尾（最旧）开始，向前选择
    for (let i = this.items.length - 1; i >= freshTailBoundary; i--) {
      const item = this.items[i];
      if (item.type === 'message') {
        started = true;
        // 同时受 token 限制和数量限制
        if (chunkTokens + item.tokens > this.LEAF_CHUNK_TOKENS || chunk.length >= this.LEAF_COMPRESS_FANOUT) {
          if (chunk.length === 0) chunk.push(i);  // 至少选一个
          break;
        }
        chunk.push(i);
        chunkTokens += item.tokens;
      } else if (started) {
        break;  // 已开始收集 messages 后遇到 summary，停止
      }
      // 如果还没开始，跳过 summary 继续向前找 messages
    }

    // chunk 中存储的是索引，需要排序 [startIdx, endIdx]
    chunk.sort((a, b) => a - b);
    return {
      startIdx: chunk[0],
      endIdx: chunk[chunk.length - 1],
      count: chunk.length
    };
  }

  private selectOldestChunkAtDepth(targetDepth: number): { startIdx: number; endIdx: number; count: number } {
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
      // 同时受 token 限制和数量限制
      if (chunkTokens + item.tokens > this.LEAF_CHUNK_TOKENS || chunk.length >= this.CONDENSED_COMPRESS_FANOUT) {
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
      count: chunk.length
    };
  }

  private replaceRangeWithSummary(startIdx: number, endIdx: number, depth: number, targetTokens: number): void {
    const oldTokens = this.getTotalTokens();

    const summary: ContextItem = {
      id: `sum_${depth}_${this.summaryIdCounter++}`,
      type: 'summary',
      depth,
      tokens: targetTokens,
    };

    // 删除 [startIdx, endIdx] 范围内的元素，插入 summary
    this.items.splice(startIdx, endIdx - startIdx + 1, summary);

    const newTokens = this.getTotalTokens();
    console.log(`    [replace] 删除 ${endIdx - startIdx + 1} 个 items, tokens: ${oldTokens} → ${newTokens} (变化: ${newTokens - oldTokens})`);
  }

  private leafPass(): boolean {
    // 检查是否有足够的 messages 触发压缩
    const evictableMessages = this.items.filter((item, idx) =>
      item.type === 'message' && idx >= this.FRESH_TAIL_COUNT
    ).length;
    if (evictableMessages < this.LEAF_TRIGGER_FANOUT) return false;

    const chunk = this.selectOldestLeafChunk();
    if (chunk.count < this.LEAF_COMPRESS_FANOUT) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);
    return true;
  }

  private condensedPass(targetDepth: number): boolean {
    const chunk = this.selectOldestChunkAtDepth(targetDepth);
    if (chunk.count < this.CONDENSED_COMPRESS_FANOUT) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
    return true;
  }

  compact(): { actionTaken: boolean; rounds: number; maxDepth: number } {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();

    if (currentTokens <= threshold) {
      return { actionTaken: false, rounds: 0, maxDepth: 0 };
    }

    console.log(`\n[压缩] 当前: ${currentTokens} tokens, 阈值: ${threshold}`);

    let actionTaken = false;
    let rounds = 0;
    let maxDepth = 0;
    let previousTokens = currentTokens;

    // Phase 1: 叶压缩
    while (rounds < 50) {
      const tokensBefore = this.getTotalTokens();
      const result = this.leafPass();
      if (!result) {
        console.log(`    叶压缩停止 (fanout不足)`);
        break;
      }

      const tokensAfter = this.getTotalTokens();
      actionTaken = true;
      rounds++;

      if (tokensAfter <= threshold) {
        console.log(`    达到阈值以下`);
        break;
      }
      if (tokensAfter >= tokensBefore) {
        console.log(`    tokens 没有减少，停止`);
        break;
      }
      if (tokensAfter >= previousTokens) {
        console.log(`    tokens 比上一轮没有减少，停止`);
        break;
      }

      previousTokens = tokensAfter;
    }

    // Phase 2: 冷凝
    let phase2Rounds = 0;
    while (rounds + phase2Rounds < 50) {
      const tokensBefore = this.getTotalTokens();

      // 找最浅层有足够 items 的
      let targetDepth = -1;
      for (let d = 0; d <= 5; d++) {
        const itemsAtDepth = this.items.filter(i => i.type === 'summary' && i.depth === d);
        if (itemsAtDepth.length >= this.CONDENSED_TRIGGER_FANOUT) {
          const chunk = this.selectOldestChunkAtDepth(d);
          if (chunk.count >= this.CONDENSED_COMPRESS_FANOUT) {
            targetDepth = d;
            break;
          }
        }
      }

      if (targetDepth === -1) break;
      if (targetDepth > maxDepth) maxDepth = targetDepth;

      // 详细日志：各层 summary 数量
      const depthCountsBefore: Record<number, number> = {};
      for (const item of this.items) {
        if (item.type === 'summary') {
          depthCountsBefore[item.depth] = (depthCountsBefore[item.depth] || 0) + 1;
        }
      }
      const beforeStr = Object.entries(depthCountsBefore).map(([d, c]) => `d${d}=${c}`).join(', ') || '(无)';

      const result = this.condensedPass(targetDepth);
      if (!result) break;

      const depthCountsAfter: Record<number, number> = {};
      for (const item of this.items) {
        if (item.type === 'summary') {
          depthCountsAfter[item.depth] = (depthCountsAfter[item.depth] || 0) + 1;
        }
      }
      const afterStr = Object.entries(depthCountsAfter).map(([d, c]) => `d${d}=${c}`).join(', ') || '(无)';

      console.log(`    [冷凝] d${targetDepth}: ${beforeStr} → ${afterStr}`);

      const tokensAfter = this.getTotalTokens();
      actionTaken = true;
      rounds++;
      phase2Rounds++;

      if (tokensAfter <= threshold) break;
      if (tokensAfter >= tokensBefore) break;

      previousTokens = tokensAfter;
    }

    console.log(`[压缩结束] ${rounds} 轮, 最终: ${this.getTotalTokens()} tokens, 最大深度: ${maxDepth}`);

    return { actionTaken, rounds, maxDepth };
  }

  printState(label: string) {
    const stats = this.getStats();
    console.log(`\n[${label}]`);
    console.log(`  总 items: ${stats.totalItems}, 总 tokens: ${stats.totalTokens}`);
    console.log(`  messages: ${stats.messages.count} (${stats.messages.tokens} tokens)`);

    for (const depth of [0, 1, 2, 3, 4, 5]) {
      if (stats.byDepth[depth]) {
        console.log(`  depth=${depth}: ${stats.byDepth[depth].count} (${stats.byDepth[depth].tokens} tokens)`);
      }
    }
  }
}

// 模拟
function simulate() {
  const sim = new CompactionSimulator();

  console.log('=== 模拟 lossless-claw 压缩逻辑 ===\n');

  sim.addMessages(100, 500);
  sim.printState('初始: 100 条消息');

  for (let round = 1; round <= 2000; round++) {
    sim.addMessages(10, 500);

    const result = sim.compact();
    if (result.actionTaken) {
      if (round % 200 === 0) sim.printState(`第 ${round} 轮后`);
    }
  }

  sim.printState('最终');

  const stats = sim.getStats();
  console.log(`\n=== 分析 ===`);
  console.log(`总 items: ${stats.totalItems}`);
  console.log(`总 tokens: ${stats.totalTokens} (${(stats.totalTokens / 128000 * 100).toFixed(1)}% of 128K)`);

  for (const depth of [0, 1, 2, 3, 4, 5]) {
    if (stats.byDepth[depth]) {
      const pct = (stats.byDepth[depth].tokens / stats.totalTokens * 100).toFixed(1);
      console.log(`depth=${depth}: ${stats.byDepth[depth].count} 个, ${stats.byDepth[depth].tokens} tokens (${pct}%)`);
    }
  }
}

simulate();