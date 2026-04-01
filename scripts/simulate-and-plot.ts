/**
 * 模拟 lossless-claw 压缩逻辑 - 完整版本
 * 匹配 src/compaction.ts 和 src/engine.ts 的所有逻辑
 */

interface ContextItem {
  id: string;
  type: 'message' | 'summary';
  depth: number;
  tokens: number;
  messageId?: number;  // 用于追踪原始消息ID
}

interface Snapshot {
  round: number;
  totalTokens: number;
  messages: number;
  messagesOutsideTail: number;
  softTriggerActive: boolean;
  hardTriggerActive: boolean;
  softTriggeredThisRound: boolean;  // 本轮是否执行了软触发压缩
  hardTriggeredThisRound: boolean;  // 本轮是否执行了硬触发压缩
  depths: Record<number, number>;
  leafCompressions: number;
  condensedCompressions: number;
}

class CompactionSimulator {
  private items: ContextItem[] = [];
  private summaryIdCounter = 0;
  private messageIdCounter = 0;

  // 配置 (与 src/db/config.ts 默认值一致)
  private readonly FRESH_TAIL_COUNT = 64;
  private readonly LEAF_CHUNK_TOKENS = 20000;
  private readonly LEAF_TARGET_TOKENS = 2400;
  private readonly CONDENSED_TARGET_TOKENS = 2000;
  private readonly LEAF_MIN_FANOUT = 8;
  private readonly CONDENSED_MIN_FANOUT = 4;
  private readonly CONDENSED_MIN_FANOUT_HARD = 2;
  private readonly CONDENSED_MIN_INPUT_RATIO = 0.1;
  private readonly CONTEXT_THRESHOLD = 0.75;
  private readonly TOKEN_BUDGET = 200000;
  private readonly INCREMENTAL_MAX_DEPTH = 1;

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  private resolveMinChunkTokens(): number {
    const chunkTarget = this.LEAF_CHUNK_TOKENS;
    const ratioFloor = Math.floor(chunkTarget * this.CONDENSED_MIN_INPUT_RATIO);
    return Math.max(this.CONDENSED_TARGET_TOKENS, ratioFloor);
  }

  private resolveFanoutForDepth(targetDepth: number, hardTrigger: boolean): number {
    if (hardTrigger) {
      return this.CONDENSED_MIN_FANOUT_HARD;
    }
    if (targetDepth === 0) {
      return this.LEAF_MIN_FANOUT;
    }
    return this.CONDENSED_MIN_FANOUT;
  }

  /**
   * 软触发检查 - 匹配 src/compaction.ts evaluateLeafTrigger()
   * 检查 fresh tail 外的原始 messages 的 tokens 是否 >= LEAF_CHUNK_TOKENS
   *
   * 注意：数组用 unshift 添加，索引0是最新的，索引越大越旧
   * freshTailBoundary = 64 保护索引 0-63（最新64条）
   * 应该统计索引 64+ 的 messages（旧消息，可压缩）
   */
  private evaluateLeafTrigger(): { shouldCompact: boolean; rawTokensOutsideTail: number; threshold: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    let rawTokens = 0;

    for (let i = freshTailBoundary; i < this.items.length; i++) {
      if (this.items[i].type === 'message') {
        rawTokens += this.items[i].tokens;
      }
    }

    return {
      shouldCompact: rawTokens >= this.LEAF_CHUNK_TOKENS,
      rawTokensOutsideTail: rawTokens,
      threshold: this.LEAF_CHUNK_TOKENS
    };
  }

  takeSnapshot(round: number, leafCompressions: number, condensedCompressions: number, softTriggeredThisRound: boolean, hardTriggeredThisRound: boolean): Snapshot {
    const depths: Record<number, number> = {};
    let messages = 0;
    let messagesOutsideTail = 0;
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);

    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i].type === 'message') {
        messages++;
        if (i >= freshTailBoundary) messagesOutsideTail++;
      } else {
        depths[this.items[i].depth] = (depths[this.items[i].depth] || 0) + 1;
      }
    }

    const trigger = this.evaluateLeafTrigger();
    const hardThreshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;

    return {
      round,
      totalTokens: this.getTotalTokens(),
      messages,
      messagesOutsideTail,
      softTriggerActive: trigger.shouldCompact,
      hardTriggerActive: this.getTotalTokens() > hardThreshold,
      softTriggeredThisRound,
      hardTriggeredThisRound,
      depths,
      leafCompressions,
      condensedCompressions
    };
  }

  addMessages(count: number, tokensPerMessage: number = 500) {
    for (let i = 0; i < count; i++) {
      this.items.unshift({
        id: `msg_${this.messageIdCounter++}`,
        type: 'message',
        depth: 0,
        tokens: tokensPerMessage,
        messageId: this.messageIdCounter - 1,
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

  private selectOldestChunkAtDepth(targetDepth: number, freshTailOrdinal: number): { startIdx: number; endIdx: number; count: number; tokens: number } {
    const chunkTokenBudget = this.LEAF_CHUNK_TOKENS;
    const chunk: number[] = [];
    let chunkTokens = 0;
    let started = false;

    for (let i = this.items.length - 1; i >= freshTailOrdinal; i--) {
      const item = this.items[i];
      if (item.type !== 'summary' || item.depth !== targetDepth) {
        if (started) break;
        continue;
      }

      started = true;
      if (chunkTokens + item.tokens > chunkTokenBudget) {
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

  private leafPass(): boolean {
    const evictableMessages = this.items.filter((item, idx) =>
      item.type === 'message' && idx >= this.FRESH_TAIL_COUNT
    ).length;
    if (evictableMessages < this.LEAF_MIN_FANOUT) return false;

    const chunk = this.selectOldestLeafChunk();
    if (chunk.count < this.LEAF_MIN_FANOUT) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);
    return true;
  }

  private condensedPass(targetDepth: number, hardTrigger: boolean, freshTailOrdinal: number): boolean {
    const fanout = this.resolveFanoutForDepth(targetDepth, hardTrigger);
    const minChunkTokens = this.resolveMinChunkTokens();

    const itemsAtDepth = this.items.filter((item, idx) =>
      item.type === 'summary' && item.depth === targetDepth && idx >= freshTailOrdinal
    ).length;
    if (itemsAtDepth < fanout) return false;

    const chunk = this.selectOldestChunkAtDepth(targetDepth, freshTailOrdinal);
    if (chunk.tokens < minChunkTokens) return false;
    if (chunk.count < fanout) return false;

    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
    return true;
  }

  /**
   * 找最浅层的condensed候选 - 匹配 src/compaction.ts selectShallowestCondensationCandidate()
   * 从浅到深遍历depths，找第一个满足fanout和minChunkTokens条件的
   */
  private selectShallowestCondensationCandidate(hardTrigger: boolean): { targetDepth: number; freshTailOrdinal: number } | null {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const minChunkTokens = this.resolveMinChunkTokens();

    // 获取所有depths (从浅到深)
    const depthLevels = new Set<number>();
    for (let i = freshTailBoundary; i < this.items.length; i++) {
      if (this.items[i].type === 'summary') {
        depthLevels.add(this.items[i].depth);
      }
    }
    const sortedDepths = Array.from(depthLevels).sort((a, b) => a - b);

    // 从浅到深找第一个满足条件的
    for (const targetDepth of sortedDepths) {
      const fanout = this.resolveFanoutForDepth(targetDepth, hardTrigger);
      const chunk = this.selectOldestChunkAtDepth(targetDepth, freshTailBoundary);

      if (chunk.count >= fanout && chunk.tokens >= minChunkTokens) {
        return { targetDepth, freshTailOrdinal: freshTailBoundary };
      }
    }

    return null;
  }

  /**
   * 软触发模式 - 匹配 src/compaction.ts compactLeaf()
   * 执行一次leaf pass，然后执行incrementalMaxDepth层condensed passes
   */
  private compactLeafMode(): { leafCompressions: number; condensedCompressions: number } {
    let leafCompressions = 0;
    let condensedCompressions = 0;

    // 首先执行 leaf pass（不需要检查 depth）
    const result = this.leafPass();
    if (result) leafCompressions++;

    // 然后执行增量 condensed passes（受 incrementalMaxDepth 限制）
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    if (this.INCREMENTAL_MAX_DEPTH > 0) {
      for (let targetDepth = 0; targetDepth < this.INCREMENTAL_MAX_DEPTH; targetDepth++) {
        const fanout = this.resolveFanoutForDepth(targetDepth, false);
        const minChunkTokens = this.resolveMinChunkTokens();

        const itemsAtDepth = this.items.filter((item, idx) =>
          item.type === 'summary' && item.depth === targetDepth && idx >= freshTailBoundary
        ).length;
        if (itemsAtDepth < fanout) break;

        const chunk = this.selectOldestChunkAtDepth(targetDepth, freshTailBoundary);
        if (chunk.count < fanout || chunk.tokens < minChunkTokens) break;

        const result = this.condensedPass(targetDepth, false, freshTailBoundary);
        if (result) {
          condensedCompressions++;
        } else {
          break;
        }
      }
    }

    return { leafCompressions, condensedCompressions };
  }

  /**
   * 硬触发模式 - 匹配 src/compaction.ts compactFullSweep()
   * Phase 1: 反复leaf pass
   * Phase 2: 反复condensed pass (选最浅层)
   */
  private compactFullSweepMode(): { leafCompressions: number; condensedCompressions: number } {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();

    let leafCompressions = 0;
    let condensedCompressions = 0;
    let previousTokens = currentTokens;

    // Phase 1: 反复leaf pass
    while (true) {
      const tokensBefore = this.getTotalTokens();
      const result = this.leafPass();
      if (!result) break;

      leafCompressions++;

      const tokensAfter = this.getTotalTokens();
      if (tokensAfter <= threshold) {
        previousTokens = tokensAfter;
        break;
      }
      if (tokensAfter >= tokensBefore || tokensAfter >= previousTokens) {
        break;
      }
      previousTokens = tokensAfter;
    }

    // Phase 2: 反复condensed pass (选最浅层)
    while (previousTokens > threshold) {
      const candidate = this.selectShallowestCondensationCandidate(true);
      if (!candidate) break;

      const tokensBefore = this.getTotalTokens();
      const result = this.condensedPass(candidate.targetDepth, true, candidate.freshTailOrdinal);
      if (!result) break;

      condensedCompressions++;

      const tokensAfter = this.getTotalTokens();
      if (tokensAfter <= threshold) {
        previousTokens = tokensAfter;
        break;
      }
      if (tokensAfter >= tokensBefore || tokensAfter >= previousTokens) break;

      previousTokens = tokensAfter;
    }

    return { leafCompressions, condensedCompressions };
  }

  compact(): { leafCompressions: number; condensedCompressions: number; softTrigger: boolean; hardTrigger: boolean } {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();
    const hardTrigger = currentTokens > threshold;

    const leafTrigger = this.evaluateLeafTrigger();
    const softTrigger = leafTrigger.shouldCompact;

    let leafCompressions = 0;
    let condensedCompressions = 0;

    if (softTrigger && !hardTrigger) {
      // 软触发模式: 执行一次leaf pass + incremental condensed passes
      const result = this.compactLeafMode();
      leafCompressions = result.leafCompressions;
      condensedCompressions = result.condensedCompressions;
    } else if (hardTrigger) {
      // 硬触发模式: full sweep
      const result = this.compactFullSweepMode();
      leafCompressions = result.leafCompressions;
      condensedCompressions = result.condensedCompressions;
    }

    return { leafCompressions, condensedCompressions, softTrigger, hardTrigger };
  }

  private getDeepestSummaryDepth(): number {
    let maxDepth = 0;
    for (const item of this.items) {
      if (item.type === 'summary' && item.depth > maxDepth) {
        maxDepth = item.depth;
      }
    }
    return maxDepth;
  }
}

// 运行模拟
function simulate(rounds: number): Snapshot[] {
  const sim = new CompactionSimulator();
  const snapshots: Snapshot[] = [];

  // 初始: 100条消息 (messageId 0-99)
  sim.addMessages(100, 500);
  let totalLeaf = 0;
  let totalCondensed = 0;
  snapshots.push(sim.takeSnapshot(0, totalLeaf, totalCondensed, false, false));

  for (let round = 1; round <= rounds; round++) {
    // 每轮添加1条新消息
    sim.addMessages(1, 500);

    // 执行压缩
    const result = sim.compact();
    totalLeaf += result.leafCompressions;
    totalCondensed += result.condensedCompressions;

    // 每轮都记录快照
    snapshots.push(sim.takeSnapshot(round, totalLeaf, totalCondensed, result.softTrigger, result.hardTrigger));
  }

  return snapshots;
}

// 生成图表
function getDepthColor(depth: number): string {
  const colors = [
    '#ff79c6', '#bd93f9', '#8be9fd', '#50fa7b',
    '#f1fa8c', '#ffb86c', '#ff5555', '#f8f8f2'
  ];
  return colors[depth % colors.length];
}

// 运行
const snapshots = simulate(1000);

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const outFile = path.join(process.cwd(), 'temp', 'simulation-chart.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

// 构建 JSON 数据 (嵌套数组格式)
const tokenData = '[' + snapshots.map(s => `[${s.round}, ${s.totalTokens}]`).join(', ') + ']';
const messagesData = '[' + snapshots.map(s => `[${s.round}, ${s.messages}]`).join(', ') + ']';
const messagesOutsideTailData = '[' + snapshots.map(s => `[${s.round}, ${s.messagesOutsideTail}]`).join(', ') + ']';
// 显示的是"本轮是否执行了压缩"而不是压缩后的状态
const softTriggerData = '[' + snapshots.map(s => `[${s.round}, ${s.softTriggeredThisRound ? 1 : 0}]`).join(', ') + ']';
const hardTriggerData = '[' + snapshots.map(s => `[${s.round}, ${s.hardTriggeredThisRound ? 1 : 0}]`).join(', ') + ']';

// 收集所有 depth
const allDepths = new Set<number>();
for (const s of snapshots) {
  Object.keys(s.depths).forEach(d => allDepths.add(parseInt(d)));
}
const sortedDepths = Array.from(allDepths).sort((a, b) => a - b);

const depthDatasets = sortedDepths.map(d => {
  const dataPoints = snapshots.map(s => `[${s.round}, ${s.depths[d] || 0}]`).join(', ');
  return `{ label: 'depth=${d}', data: [${dataPoints}], color: '${getDepthColor(d)}' }`;
}).join(',\n        ');

const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Compaction Simulation (1000 rounds)</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background: #1a1a1a; color: #e0e0e0; }
        .chart-container { background: #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
        h2 { margin-top: 0; color: #fff; }
        .info-box { background: #2a2a2a; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
        canvas { display: block; width: 100%; }
    </style>
</head>
<body>
    <h1>Compaction Simulation (1000 rounds)</h1>
    <div class="info-box">
      <strong>配置:</strong>
      FRESH_TAIL=64 | LEAF_CHUNK_TOKENS=20000 | LEAF_MIN_FANOUT=8 | CONDENSED_MIN_FANOUT=4 | CONDENSED_MIN_FANOUT_HARD=2 |
      INCREMENTAL_MAX_DEPTH=1 | TOKEN_BUDGET=200K | CONTEXT_THRESHOLD=75%
    </div>
    <p style="color:#aaa;">
      <strong>软触发</strong>: fresh tail 外的 messages ≥ 20K tokens |
      <strong>硬触发</strong>: 总 tokens > 150K (75% of 200K)
    </p>

    <div class="chart-container">
        <h2>Total Tokens Over Time</h2>
        <canvas id="tokenChart" height="300"></canvas>
    </div>

    <div class="chart-container">
        <h2>Messages Count (Total vs Outside Tail)</h2>
        <canvas id="messagesChart" height="300"></canvas>
    </div>

    <div class="chart-container">
        <h2>Trigger Status</h2>
        <canvas id="triggerChart" height="250"></canvas>
    </div>

    <div class="chart-container">
        <h2>Summary Count by Depth</h2>
        <canvas id="depthChart" height="300"></canvas>
    </div>

    <script>
        const tokenData = ${tokenData};
        const messagesData = ${messagesData};
        const messagesOutsideTailData = ${messagesOutsideTailData};
        const softTriggerData = ${softTriggerData};
        const hardTriggerData = ${hardTriggerData};
        const depthDatasets = [
${depthDatasets}
        ];

        function drawChart(canvasId, datasets, yMax, yLabel) {
            const canvas = document.getElementById(canvasId);
            const ctx = canvas.getContext('2d');
            const width = canvas.offsetWidth;
            const height = canvas.height;

            const dpr = window.devicePixelRatio || 1;
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            ctx.scale(dpr, dpr);

            const padding = { top: 20, right: 150, bottom: 40, left: 60 };
            const chartW = width - padding.left - padding.right;
            const chartH = height - padding.top - padding.bottom;

            ctx.fillStyle = '#2a2a2a';
            ctx.fillRect(0, 0, width, height);

            let maxX = 0, maxY = 0;
            datasets.forEach(ds => {
                ds.data.forEach(([x, y]) => {
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                });
            });
            maxY = yMax || maxY * 1.1;

            // 网格
            ctx.strokeStyle = '#3a3a3a';
            ctx.lineWidth = 1;
            for (let i = 0; i <= 5; i++) {
                const y = padding.top + (chartH / 5) * i;
                ctx.beginPath();
                ctx.moveTo(padding.left, y);
                ctx.lineTo(padding.left + chartW, y);
                ctx.stroke();

                const value = Math.round(maxY - (maxY / 5) * i);
                ctx.fillStyle = '#888';
                ctx.font = '12px system-ui';
                ctx.textAlign = 'right';
                ctx.fillText(value.toLocaleString(), padding.left - 10, y + 4);
            }

            // X 轴
            for (let i = 0; i <= 10; i++) {
                const x = padding.left + (chartW / 10) * i;
                const value = Math.round((maxX / 10) * i);
                ctx.fillStyle = '#888';
                ctx.textAlign = 'center';
                ctx.fillText(value, x, height - padding.bottom + 20);
            }

            // Y 轴标签
            ctx.save();
            ctx.translate(15, height / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#aaa';
            ctx.fillText(yLabel, 0, 0);
            ctx.restore();

            // 画数据线
            datasets.forEach((ds, idx) => {
                if (ds.data.length < 2) return;

                const color = ds.color;
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                ctx.beginPath();

                ds.data.forEach(([x, y], i) => {
                    const px = padding.left + (x / maxX) * chartW;
                    const py = padding.top + chartH - (y / maxY) * chartH;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                });
                ctx.stroke();

                // 图例
                ctx.fillStyle = color;
                ctx.font = '13px system-ui';
                ctx.textAlign = 'left';
                const legendY = padding.top + (chartH / datasets.length) * idx + 15;
                ctx.fillText(ds.label, padding.left + chartW + 10, legendY);
            });
        }

        drawChart('tokenChart', [{ label: 'Total Tokens', data: tokenData, color: '#4a9eff' }], 200000, 'Tokens');
        drawChart('messagesChart', [
          { label: 'Total Messages', data: messagesData, color: '#50fa7b' },
          { label: 'Outside Tail', data: messagesOutsideTailData, color: '#ffb86c' }
        ], null, 'Count');
        drawChart('triggerChart', [
          { label: 'Soft Trigger', data: softTriggerData, color: '#ff79c6' },
          { label: 'Hard Trigger', data: hardTriggerData, color: '#ff5555' }
        ], 1.2, 'Active (1/0)');
        drawChart('depthChart', depthDatasets, null, 'Count');
    </script>
</body>
</html>`;

fs.writeFileSync(outFile, html);

console.log(`Chart generated: ${outFile}`);
console.log(`\nFinal state (round ${snapshots[snapshots.length-1].round}):`);
const final = snapshots[snapshots.length-1];
console.log(`  Total tokens: ${final.totalTokens} (${(final.totalTokens/200000*100).toFixed(1)}%)`);
console.log(`  Total messages: ${final.messages}`);
console.log(`  Messages outside tail: ${final.messagesOutsideTail}`);
console.log(`  Total leaf compressions: ${final.leafCompressions}`);
console.log(`  Total condensed compressions: ${final.condensedCompressions}`);
console.log(`  Summaries:`);
for (const [d, c] of Object.entries(final.depths).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
  console.log(`    depth=${d}: ${c}`);
}

// 在浏览器中打开
const platform = process.platform;
if (platform === 'win32') {
  exec(`start "" "${outFile}"`);
} else if (platform === 'darwin') {
  exec(`open "${outFile}"`);
} else {
  exec(`xdg-open "${outFile}"`);
}