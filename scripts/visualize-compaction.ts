/**
 * 可视化压缩逻辑
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
  private history: Array<{
    round: number;
    items: Array<{ type: string; depth: number; idx: number }>;
    stats: any;
  }> = [];

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
    return { startIdx: chunk[0], endIdx: chunk[chunk.length - 1], count: chunk.length, tokens: chunkTokens };
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
    return { startIdx: chunk[0], endIdx: chunk[chunk.length - 1], count: chunk.length, tokens: chunkTokens };
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

  compact(): { leafCompressions: number; condensedCompressions: number } {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();
    if (currentTokens <= threshold) return { leafCompressions: 0, condensedCompressions: 0 };

    let previousTokens = currentTokens;
    let rounds = 0;
    let leafCompressions = 0;
    let condensedCompressions = 0;

    // Phase 1
    while (rounds < 50) {
      const evictableMessages = this.items.filter((item, idx) =>
        item.type === 'message' && idx >= this.FRESH_TAIL_COUNT
      ).length;
      if (evictableMessages < this.LEAF_MIN_FANOUT) break;

      const chunk = this.selectOldestLeafChunk();
      if (chunk.count < this.LEAF_MIN_FANOUT) break;

      this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);
      leafCompressions++;
      rounds++;

      const tokensAfter = this.getTotalTokens();
      if (tokensAfter <= threshold) break;
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
          if (chunk.count >= this.CONDENSED_MIN_FANOUT) {
            targetDepth = d;
            break;
          }
        }
      }

      if (targetDepth === -1) break;

      const chunk = this.selectOldestChunkAtDepth(targetDepth);
      this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
      condensedCompressions++;
      rounds++;
      phase2Rounds++;

      const tokensAfter = this.getTotalTokens();
      if (tokensAfter <= threshold) break;
      if (tokensAfter >= tokensBefore) break;
      previousTokens = tokensAfter;
    }

    return { leafCompressions, condensedCompressions };
  }

  recordHistory(round: number) {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const depths: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };

    for (const item of this.items) {
      if (item.type === 'summary') {
        depths[item.depth] = (depths[item.depth] || 0) + 1;
      }
    }

    this.history.push({
      round,
      items: this.items.slice(0, 150).map((item, idx) => ({
        type: item.type === 'message' ? 'M' : `S${item.depth}`,
        depth: item.depth,
        idx
      })),
      stats: {
        totalItems: this.items.length,
        messages: this.items.filter(i => i.type === 'message').length,
        summaries: this.items.filter(i => i.type === 'summary').length,
        depths,
        tokens: this.getTotalTokens()
      }
    });
  }
}

// 模拟并生成可视化
const sim = new CompactionSimulator();
sim.addMessages(100, 500);
sim.recordHistory(0);

const rounds = 30;
const actions: Array<{ round: number; action: string; leaf: number; condensed: number }> = [];

for (let round = 1; round <= rounds; round++) {
  sim.addMessages(20, 500);
  const result = sim.compact();
  actions.push({
    round,
    action: result.leafCompressions + result.condensedCompressions > 0 ? '压缩' : '无',
    leaf: result.leafCompressions,
    condensed: result.condensedCompressions
  });
  sim.recordHistory(round);
}

// 生成 HTML 可视化
const history = (sim as any).history;
const maxItems = Math.max(...history.map(h => h.items.length));

function generateHtml(): string {
  const rows = history.map((h, i) => {
    const visual = h.items.slice(0, 100).map(item => {
      const color = item.type === 'M' ? '#4a9eff' : `hsl(${item.depth * 60 + 280}, 70%, 60%)`;
      return `<div style="background:${color};flex:1;height:20px;border-right:1px solid #222;" title="${item.type}"></div>`;
    }).join('');

    const stats = h.stats;
    const depthsStr = Object.entries(stats.depths)
      .filter(([_, c]) => (c as number) > 0)
      .map(([d, c]) => `d${d}=${c}`)
      .join(', ') || '-';

    const action = actions[i]?.action || '-';

    return `
      <tr>
        <td>${i}</td>
        <td>${stats.messages}</td>
        <td>${stats.summaries}</td>
        <td>${depthsStr}</td>
        <td>${action}</td>
        <td><div style="display:flex;height:20px;">${visual}</div></td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Compaction Visualization</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background: #1a1a1a; color: #e0e0e0; }
        h1 { color: #fff; }
        table { border-collapse: collapse; width: 100%; margin-top: 20px; }
        th, td { padding: 8px; text-align: left; border: 1px solid #333; font-size: 12px; }
        th { background: #2a2a2a; color: #fff; position: sticky; top: 0; }
        tr:nth-child(even) { background: #222; }
        .legend { display: flex; gap: 20px; margin: 20px 0; padding: 15px; background: #2a2a2a; border-radius: 8px; }
        .legend-item { display: flex; align-items: center; gap: 8px; }
        .color-box { width: 30px; height: 20px; border-radius: 4px; }
        .fresh-tail-indicator { position: absolute; top: 0; left: 0; width: 64%; height: 100%; background: rgba(255,255,255,0.05); border-right: 2px dashed #666; pointer-events: none; }
        .visual-cell { position: relative; }
    </style>
</head>
<body>
    <h1>Lossless-Claw 压缩可视化</h1>
    <div class="legend">
        <div class="legend-item">
            <div class="color-box" style="background:#4a9eff;"></div>
            <span>Message (M)</span>
        </div>
        <div class="legend-item">
            <div class="color-box" style="background:hsl(280,70%,60%);"></div>
            <span>Summary depth=0</span>
        </div>
        <div class="legend-item">
            <div class="color-box" style="background:hsl(340,70%,60%);"></div>
            <span>Summary depth=1</span>
        </div>
        <div class="legend-item">
            <div class="color-box" style="background:hsl(40,70%,60%);"></div>
            <span>Summary depth=2</span>
        </div>
        <div class="legend-item">
            <div style="width:64%;height:20px;border-right:2px dashed #666;background:rgba(255,255,255,0.05);"></div>
            <span>Fresh Tail (64 items)</span>
        </div>
    </div>
    <table>
        <thead>
            <tr>
                <th>轮次</th>
                <th>Messages</th>
                <th>Summaries</th>
                <th>各层分布</th>
                <th>操作</th>
                <th>数组可视化 (前100个)</th>
            </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
    </table>
    <p style="margin-top:20px;color:#888;">注意：fresh tail 保护前 64 个 items (左侧 64%)，只有 idx ≥ 64 的 items 才能被压缩</p>
</body>
</html>`;
}

const html = generateHtml();

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const outFile = path.join(process.cwd(), 'temp', 'compaction-viz.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);

console.log(`Visualization generated: ${outFile}`);
console.log(`\nFinal stats:`);
const final = (sim as any).history[(sim as any).history.length - 1].stats;
console.log(`  Messages: ${final.messages}`);
console.log(`  Summaries: ${final.summaries}`);
console.log(`  Tokens: ${final.tokens} (${(final.tokens/128000*100).toFixed(1)}%)`);

const platform = process.platform;
if (platform === 'win32') {
  exec(`start "" "${outFile}"`);
} else if (platform === 'darwin') {
  exec(`open "${outFile}"`);
} else {
  exec(`xdg-open "${outFile}"`);
}