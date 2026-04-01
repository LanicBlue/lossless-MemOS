/**
 * 模拟 lossless-claw 压缩逻辑 - 完整版本
 */

interface ContextItem {
  id: string;
  type: 'message' | 'summary';
  depth: number;
  tokens: number;
}

interface Snapshot {
  round: number;
  totalTokens: number;
  messages: number;
  messagesOutsideTail: number;
  softTriggerActive: boolean;
  hardTriggerActive: boolean;
  depths: Record<number, number>;
}

class CompactionSimulator {
  private items: ContextItem[] = [];
  private summaryIdCounter = 0;

  // 配置
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

  private evaluateLeafTrigger(): { shouldCompact: boolean; rawTokensOutsideTail: number; threshold: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    let rawTokens = 0;

    for (let i = 0; i < this.items.length; i++) {
      if (i >= freshTailBoundary) break;
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

  takeSnapshot(round: number): Snapshot {
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
      depths
    };
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

  private selectOldestChunkAtDepth(targetDepth: number, hardTrigger: boolean): { startIdx: number; endIdx: number; count: number; tokens: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const chunkTokenBudget = this.LEAF_CHUNK_TOKENS;
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

  private condensedPass(targetDepth: number, hardTrigger: boolean): boolean {
    const fanout = hardTrigger ? this.CONDENSED_MIN_FANOUT_HARD : this.CONDENSED_MIN_FANOUT;

    const itemsAtDepth = this.items.filter((item, idx) =>
      item.type === 'summary' && item.depth === targetDepth && idx >= this.FRESH_TAIL_COUNT
    ).length;
    if (itemsAtDepth < fanout) return false;

    const chunk = this.selectOldestChunkAtDepth(targetDepth, hardTrigger);
    const minChunkTokens = this.resolveMinChunkTokens();
    if (chunk.tokens < minChunkTokens) return false;

    if (chunk.count < fanout) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
    return true;
  }

  compact(): { leafCompressions: number; condensedCompressions: number; softTriggers: number; hardTriggers: number } {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();

    let leafCompressions = 0;
    let condensedCompressions = 0;
    let softTriggers = 0;
    let hardTriggers = currentTokens > threshold ? 1 : 0;
    const hardTrigger = currentTokens > threshold;

    // 软触发检查
    const leafTrigger = this.evaluateLeafTrigger();
    if (leafTrigger.shouldCompact) {
      softTriggers++;
      const depth = this.getDeepestSummaryDepth();
      if (depth < this.INCREMENTAL_MAX_DEPTH) {
        const result = this.leafPass();
        if (result) leafCompressions++;
      }
    }

    // 硬触发
    if (currentTokens > threshold) {
      let previousTokens = currentTokens;
      let rounds = 0;

      // Phase 1
      while (rounds < 50) {
        const tokensBefore = this.getTotalTokens();
        const result = this.leafPass();
        if (!result) break;

        leafCompressions++;
        rounds++;

        const tokensAfter = this.getTotalTokens();
        if (!hardTrigger && tokensAfter <= threshold) {
          previousTokens = tokensAfter;
          break;
        }
        if (tokensAfter >= tokensBefore || tokensAfter >= previousTokens) {
          break;
        }
        previousTokens = tokensAfter;
      }

      // Phase 2
      let phase2Rounds = 0;
      while (hardTrigger || previousTokens > threshold) {
        let targetDepth = -1;
        const depthLevels = this.getDistinctDepths();

        for (const d of depthLevels) {
          const fanout = hardTrigger ? this.CONDENSED_MIN_FANOUT_HARD : this.CONDENSED_MIN_FANOUT;
          const chunk = this.selectOldestChunkAtDepth(d, hardTrigger);

          if (chunk.count >= fanout) {
            const minChunkTokens = this.resolveMinChunkTokens();
            if (chunk.tokens >= minChunkTokens) {
              targetDepth = d;
              break;
            }
          }
        }

        if (targetDepth === -1) break;

        const result = this.condensedPass(targetDepth, hardTrigger);
        if (!result) break;

        condensedCompressions++;
        rounds++;
        phase2Rounds++;

        const tokensAfter = this.getTotalTokens();
        if (!hardTrigger && tokensAfter <= threshold) {
          previousTokens = tokensAfter;
          break;
        }
        if (tokensAfter >= previousTokens) break;

        previousTokens = tokensAfter;
      }
    }

    return { leafCompressions, condensedCompressions, softTriggers, hardTriggers };
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

  private getDistinctDepths(): number[] {
    const depths = new Set<number>();
    for (const item of this.items) {
      if (item.type === 'summary') {
        depths.add(item.depth);
      }
    }
    return Array.from(depths).sort((a, b) => a - b);
  }
}

// 运行模拟
function simulate(rounds: number): Snapshot[] {
  const sim = new CompactionSimulator();
  const snapshots: Snapshot[] = [];

  sim.addMessages(100, 500);
  snapshots.push(sim.takeSnapshot(0));

  for (let round = 1; round <= rounds; round++) {
    sim.addMessages(10, 500);
    sim.compact();

    if (round % 5 === 0 || round <= 20) {
      snapshots.push(sim.takeSnapshot(round));
    }
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

// 运行并输出
const snapshots = simulate(200);

import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const outFile = path.join(process.cwd(), 'temp', 'simulation-chart.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });

// 构建 JSON 数据
const jsonSnapshots = JSON.stringify(snapshots);

const tokenData = snapshots.map(s => [s.round, s.totalTokens]).join(', ');
const messagesData = snapshots.map(s => [s.round, s.messages]).join(', ');
const messagesOutsideTailData = snapshots.map(s => [s.round, s.messagesOutsideTail]).join(', ');
const softTriggerData = snapshots.map(s => [s.round, s.softTriggerActive ? 1 : 0]).join(', ');
const hardTriggerData = snapshots.map(s => [s.round, s.hardTriggerActive ? 1 : 0]).join(', ');

// 收集所有 depth
const allDepths = new Set<number>();
for (const s of snapshots) {
  Object.keys(s.depths).forEach(d => allDepths.add(parseInt(d)));
}
const sortedDepths = Array.from(allDepths).sort((a, b) => a - b);

const depthDatasets = sortedDepths.map(d => {
  const data = snapshots.map(s => [s.round, (s.depths[d] || 0)]);
  return `{ label: 'depth=' + d + ', data: [' + data.join('], ') + '], color: "' + getDepthColor(d) + '" }';
}).join(',\n        ');

const html = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Compaction Simulation (Complete)</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background: #1a1a1a; color: #e0e0e0; }
        .chart-container { background: #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
        h2 { margin-top: 0; color: #fff; }
        .info-box { background: #2a2a2a; border-radius: 8px; padding: 15px; margin-bottom: 20px; }
        canvas { display: block; width: 100%; }
    </style>
</head>
<body>
    <h1>Compaction Simulation (Complete)</h1>
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
        const tokenData = [${tokenData}];
        const messagesData = [${messagesData}];
        const messagesOutsideTailData = [${messagesOutsideTailData}];
        const softTriggerData = [${softTriggerData}];
        const hardTriggerData = [${hardTriggerData}];
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