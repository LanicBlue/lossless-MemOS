/**
 * 对比原版和新版压缩逻辑
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
  maxDepth: number;
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
  private readonly CONTEXT_THRESHOLD = 0.75;
  private readonly TOKEN_BUDGET = 128000;

  constructor(
    private readonly LEAF_TRIGGER_FANOUT: number,
    private readonly CONDENSED_TRIGGER_FANOUT: number,
    private readonly LEAF_COMPRESS_FANOUT: number,
    private readonly CONDENSED_COMPRESS_FANOUT: number,
    private readonly name: string
  ) {}

  getTotalTokens(): number {
    return this.items.reduce((sum, item) => sum + item.tokens, 0);
  }

  takeSnapshot(round: number): Snapshot {
    const depths: Record<number, number> = {};
    let messages = 0;
    let maxDepth = 0;
    for (const item of this.items) {
      if (item.type === 'message') {
        messages++;
      } else {
        depths[item.depth] = (depths[item.depth] || 0) + 1;
        if (item.depth > maxDepth) maxDepth = item.depth;
      }
    }
    return {
      round,
      totalTokens: this.getTotalTokens(),
      messages,
      maxDepth,
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

  private selectOldestLeafChunk(): { startIdx: number; endIdx: number; count: number } {
    const freshTailBoundary = Math.min(this.FRESH_TAIL_COUNT, this.items.length);
    const chunk: number[] = [];
    let chunkTokens = 0;
    let started = false;

    for (let i = this.items.length - 1; i >= freshTailBoundary; i--) {
      const item = this.items[i];
      if (item.type === 'message') {
        started = true;
        // 原版：只受 token 限制，没有数量限制
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
      count: chunk.length
    };
  }

  private selectOldestChunkAtDepth(targetDepth: number, maxCount?: number): { startIdx: number; endIdx: number; count: number } {
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
      // 如果有 maxCount，则同时受数量限制
      if (maxCount && chunk.length >= maxCount) {
        break;
      }
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
      count: chunk.length
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
    if (evictableMessages < this.LEAF_TRIGGER_FANOUT) return false;

    const chunk = this.selectOldestLeafChunk();
    if (chunk.count < this.LEAF_COMPRESS_FANOUT) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, 0, this.LEAF_TARGET_TOKENS);
    return true;
  }

  private condensedPass(targetDepth: number): boolean {
    const chunk = this.selectOldestChunkAtDepth(targetDepth, this.CONDENSED_COMPRESS_FANOUT);
    if (chunk.count < this.CONDENSED_COMPRESS_FANOUT) return false;
    this.replaceRangeWithSummary(chunk.startIdx, chunk.endIdx, targetDepth + 1, this.CONDENSED_TARGET_TOKENS);
    return true;
  }

  compact(): boolean {
    const threshold = this.TOKEN_BUDGET * this.CONTEXT_THRESHOLD;
    const currentTokens = this.getTotalTokens();

    if (currentTokens <= threshold) {
      return false;
    }

    let previousTokens = currentTokens;
    let rounds = 0;

    // Phase 1
    while (rounds < 50) {
      const tokensBefore = this.getTotalTokens();
      const result = this.leafPass();
      if (!result) break;

      const tokensAfter = this.getTotalTokens();
      rounds++;

      if (tokensAfter <= threshold) break;
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
        if (itemsAtDepth.length >= this.CONDENSED_TRIGGER_FANOUT) {
          const chunk = this.selectOldestChunkAtDepth(d, this.CONDENSED_COMPRESS_FANOUT);
          if (chunk.count >= this.CONDENSED_COMPRESS_FANOUT) {
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

    return rounds > 0;
  }
}

function simulate(name: string, leafTrigger: number, condTrigger: number, leafCompress: number, condCompress: number, rounds: number): Snapshot[] {
  const sim = new CompactionSimulator(leafTrigger, condTrigger, leafCompress, condCompress, name);
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

// 生成对比图表
function generateComparisonHtml(results: Array<{name: string, snapshots: Snapshot[], color: string}>): string {
  const maxRound = Math.max(...results.flatMap(r => r.snapshots.map(s => s.round)));

  // 构建 CSV 数据用于下载
  let csvData = 'Round,Version,Tokens,Messages,MaxDepth';
  for (let d = 0; d <= 10; d++) csvData += `,Depth${d}`;
  csvData += '\n';

  for (const r of results) {
    for (const s of r.snapshots) {
      csvData += `${s.round},${r.name},${s.totalTokens},${s.messages},${s.maxDepth}`;
      for (let d = 0; d <= 10; d++) {
        csvData += `,${s.depths[d] || 0}`;
      }
      csvData += '\n';
    }
  }

  // 构建 JavaScript 数据 - 使用嵌套数组格式 [[x1,y1], [x2,y2], ...]
  const dataDefs = results.map((r, i) => {
    const tokenData = r.snapshots.map(s => `[${s.round},${s.totalTokens}]`).join(', ');
    const maxDepthData = r.snapshots.map(s => `[${s.round},${s.maxDepth}]`).join(', ');
    return `
  const ${r.name.replace(/[^a-z]/gi, '')}_tokens = [${tokenData}];
  const ${r.name.replace(/[^a-z]/gi, '')}_maxDepth = [${maxDepthData}];`;
  }).join('\n');

  const tokenDatasets = results.map(r => {
    const name = r.name.replace(/[^a-z]/gi, '');
    return `  { label: '${r.name}', data: ${name}_tokens, color: '${r.color}' }`;
  }).join(',\n');

  const maxDepthDatasets = results.map(r => {
    const name = r.name.replace(/[^a-z]/gi, '');
    return `  { label: '${r.name}', data: ${name}_maxDepth, color: '${r.color}' }`;
  }).join(',\n');

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Compaction Comparison</title>
    <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background: #1a1a1a; color: #e0e0e0; }
        .chart-container { background: #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 30px; }
        h2 { margin-top: 0; color: #fff; }
        canvas { display: block; width: 100%; }
        .download-btn {
            background: #4a9eff; color: white; border: none; padding: 10px 20px;
            border-radius: 4px; cursor: pointer; font-size: 14px; margin-bottom: 20px;
        }
        .download-btn:hover { background: #3a8eef; }
    </style>
</head>
<body>
    <h1>Compaction Strategy Comparison</h1>
    <button class="download-btn" onclick="downloadCSV()">Download CSV</button>

    <div class="chart-container">
        <h2>Total Tokens Over Time</h2>
        <canvas id="tokenChart" height="300"></canvas>
    </div>

    <div class="chart-container">
        <h2>Max Depth Over Time</h2>
        <canvas id="maxDepthChart" height="300"></canvas>
    </div>

    <script>
${dataDefs}

        function drawChart(canvasId, datasets, yMax, yLabel, stacked = false) {
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

            ctx.save();
            ctx.translate(15, height / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillStyle = '#aaa';
            ctx.fillText(yLabel, 0, 0);
            ctx.restore();

            datasets.forEach((ds, idx) => {
                if (ds.data.length < 2) return;

                ctx.strokeStyle = ds.color;
                ctx.lineWidth = 2;
                ctx.beginPath();

                ds.data.forEach(([x, y], i) => {
                    const px = padding.left + (x / maxX) * chartW;
                    const py = padding.top + chartH - (y / maxY) * chartH;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                });
                ctx.stroke();

                ctx.fillStyle = ds.color;
                ctx.font = '13px system-ui';
                ctx.textAlign = 'left';
                const legendY = padding.top + (chartH / datasets.length) * idx + 15;
                ctx.fillText(ds.label, padding.left + chartW + 10, legendY);
            });
        }

        drawChart('tokenChart', [
${tokenDatasets}
        ], 128000, 'Tokens');

        drawChart('maxDepthChart', [
${maxDepthDatasets}
        ], null, 'Max Depth');

        function downloadCSV() {
            const csv = ${JSON.stringify(csvData)};
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'compaction-comparison.csv';
            a.click();
        }
    </script>
</body>
</html>`;
}

// 运行对比
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const results = [
  {
    name: 'Original (trigger=compress=4)',
    snapshots: simulate('orig', 4, 4, 4, 4, 500),
    color: '#ff5555'
  },
  {
    name: 'New (trigger=8, compress=4)',
    snapshots: simulate('new', 12, 8, 8, 4, 500),
    color: '#50fa7b'
  }
];

// 输出最终对比
console.log('\n=== Final State Comparison ===');
for (const r of results) {
  const final = r.snapshots[r.snapshots.length - 1];
  console.log(`\n${r.name}:`);
  console.log(`  Tokens: ${final.totalTokens} (${(final.totalTokens/128000*100).toFixed(1)}%)`);
  console.log(`  Messages: ${final.messages}`);
  console.log(`  Max Depth: ${final.maxDepth}`);
  for (const [d, c] of Object.entries(final.depths).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
    console.log(`    depth=${d}: ${c}`);
  }
}

const html = generateComparisonHtml(results);
const outFile = path.join(process.cwd(), 'temp', 'comparison-chart.html');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, html);

console.log(`\nChart generated: ${outFile}`);

const platform = process.platform;
if (platform === 'win32') {
  exec(`start "" "${outFile}"`);
} else if (platform === 'darwin') {
  exec(`open "${outFile}"`);
} else {
  exec(`xdg-open "${outFile}"`);
}