/**
 * 使用源代码函数进行压缩仿真
 * 直接调用 CompactionEngine, ConversationStore, SummaryStore
 */

import { DatabaseSync } from "node:sqlite";
import { CompactionEngine } from "../src/compaction.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import type { LcmConfig } from "../src/db/config.js";

interface Snapshot {
  round: number;
  totalTokens: number;
  messages: number;
  messagesOutsideTail: number;
  softTriggerActive: boolean;
  hardTriggerActive: boolean;
  softTriggeredThisRound: boolean;
  hardTriggeredThisRound: boolean;
  leafCompressions: number;
  condensedCompressions: number;
  depths: Record<number, number>;
}

// 默认配置
const DEFAULT_LCM_CONFIG: LcmConfig = {
  enabled: true,
  databasePath: ":memory:",
  ignoreSessionPatterns: [],
  statelessSessionPatterns: [],
  skipStatelessSessions: true,
  contextThreshold: 0.75,
  freshTailCount: 64,  // 恢复 64
  leafMinFanout: 24,  // 改为 24，减少 depth=0 创建
  condensedMinFanout: 8,
  condensedMinFanoutHard: 2,
  incrementalMaxDepth: 1,
  leafChunkTokens: 20000,
  leafTargetTokens: 2400,
  condensedTargetTokens: 2000,
  maxExpandTokens: 4000,
  largeFileTokenThreshold: 25000,
  summaryProvider: "",
  summaryModel: "",
  largeFileSummaryProvider: "",
  largeFileSummaryModel: "",
  expansionProvider: "",
  expansionModel: "",
  delegationTimeoutMs: 120000,
  autocompactDisabled: false,
  timezone: "UTC",
  pruneHeartbeatOk: false,
  maxAssemblyTokenBudget: undefined,
  summaryMaxOverageFactor: 3,
  customInstructions: "",
  persistentAgents: [],
};

const COMPACTION_CONFIG = {
  contextThreshold: DEFAULT_LCM_CONFIG.contextThreshold,
  freshTailCount: DEFAULT_LCM_CONFIG.freshTailCount,
  leafMinFanout: DEFAULT_LCM_CONFIG.leafMinFanout,
  condensedMinFanout: DEFAULT_LCM_CONFIG.condensedMinFanout,
  condensedMinFanoutHard: DEFAULT_LCM_CONFIG.condensedMinFanoutHard,
  incrementalMaxDepth: DEFAULT_LCM_CONFIG.incrementalMaxDepth,
  leafChunkTokens: DEFAULT_LCM_CONFIG.leafChunkTokens,
  leafTargetTokens: DEFAULT_LCM_CONFIG.leafTargetTokens,
  condensedTargetTokens: DEFAULT_LCM_CONFIG.condensedTargetTokens,
  maxRounds: 10,
  timezone: DEFAULT_LCM_CONFIG.timezone,
  summaryMaxOverageFactor: DEFAULT_LCM_CONFIG.summaryMaxOverageFactor,
};

const TOKEN_BUDGET = 200000;

// Mock summarizer - 返回固定长度的摘要
function createMockSummarizer(): (text: string, aggressive?: boolean) => Promise<string> {
  return async (text: string, aggressive?: boolean): Promise<string> => {
    const targetTokens = aggressive ? 1200 : 2000;
    const targetChars = targetTokens * 4;
    if (text.length <= targetChars) {
      return text;
    }
    return text.slice(0, targetChars) + `\n[Compressed from ${Math.ceil(text.length / 4)} tokens]`;
  };
}

class SourceCodeSimulator {
  private db: DatabaseSync;
  private conversationStore: ConversationStore;
  private summaryStore: SummaryStore;
  private compaction: CompactionEngine;
  private conversationId: number = 0;

  static async create(): Promise<SourceCodeSimulator> {
    const sim = new SourceCodeSimulator();
    await sim.init();
    return sim;
  }

  private constructor() {
    // 创建内存数据库
    this.db = new DatabaseSync(":memory:");
    this.db.exec("PRAGMA journal_mode = WAL;");

    // 运行迁移
    const features = getLcmDbFeatures(this.db);
    runLcmMigrations(this.db, { fts5Available: features.fts5Available });

    // 创建store实例
    this.conversationStore = new ConversationStore(this.db, {
      fts5Available: features.fts5Available,
    });
    this.summaryStore = new SummaryStore(this.db, { fts5Available: features.fts5Available });

    // 创建compaction引擎
    this.compaction = new CompactionEngine(
      this.conversationStore,
      this.summaryStore,
      COMPACTION_CONFIG,
    );
  }

  private async init(): Promise<void> {
    // 创建conversation
    const conversation = await this.conversationStore.getOrCreateConversation("test-session", {});
    this.conversationId = conversation.conversationId;
  }

  private estimateTokens(content: string): number {
    return Math.ceil(content.length / 4);
  }

  async addMessage(content: string): Promise<void> {
    const tokenCount = this.estimateTokens(content);
    const maxSeq = await this.conversationStore.getMaxSeq(this.conversationId);
    const seq = maxSeq + 1;

    const msg = await this.conversationStore.createMessage({
      conversationId: this.conversationId,
      seq,
      role: "user",
      content,
      tokenCount,
    });

    await this.summaryStore.appendContextMessage(this.conversationId, msg.messageId);
  }

  async getStats(): Promise<{
    totalTokens: number;
    messages: number;
    messagesOutsideTail: number;
    depths: Record<number, number>;
  }> {
    const contextItems = await this.summaryStore.getContextItems(this.conversationId);
    const freshTailOrdinal = Math.min(DEFAULT_LCM_CONFIG.freshTailCount!, contextItems.length);

    let messages = 0;
    let messagesOutsideTail = 0;
    const depths: Record<number, number> = {};

    for (let i = 0; i < contextItems.length; i++) {
      const item = contextItems[i];
      if (item.itemType === "message") {
        messages++;
        if (i >= freshTailOrdinal) messagesOutsideTail++;
      } else if (item.itemType === "summary") {
        depths[item.ordinal] = (depths[item.ordinal] || 0) + 1;
      }
    }

    // 重新组织depth数据（按summary的depth属性）
    const depthCounts: Record<number, number> = {};
    for (const item of contextItems) {
      if (item.itemType === "summary") {
        const summary = await this.summaryStore.getSummary(item.summaryId!);
        if (summary) {
          depthCounts[summary.depth] = (depthCounts[summary.depth] || 0) + 1;
        }
      }
    }

    const totalTokens = await this.summaryStore.getContextTokenCount(this.conversationId);

    return {
      totalTokens,
      messages,
      messagesOutsideTail,
      depths: depthCounts,
    };
  }

  async takeSnapshot(round: number, softTriggered: boolean, hardTriggered: boolean): Promise<Snapshot> {
    const stats = await this.getStats();
    const softTriggerActive = (await this.compaction.evaluateLeafTrigger(this.conversationId)).shouldCompact;
    const currentTokens = stats.totalTokens;
    const hardThreshold = TOKEN_BUDGET * DEFAULT_LCM_CONFIG.contextThreshold!;

    return {
      round,
      totalTokens: currentTokens,
      messages: stats.messages,
      messagesOutsideTail: stats.messagesOutsideTail,
      softTriggerActive,
      hardTriggerActive: currentTokens > hardThreshold,
      softTriggeredThisRound: softTriggered,
      hardTriggeredThisRound: hardTriggered,
      leafCompressions: 0,
      condensedCompressions: 0,
      depths: stats.depths,
    };
  }

  async compactLeaf(): Promise<{ leafCompressions: number; condensedCompressions: number }> {
    const summarize = createMockSummarizer();

    const result = await this.compaction.compactLeaf({
      conversationId: this.conversationId,
      tokenBudget: TOKEN_BUDGET,
      summarize,
      force: false,
    });

    const leafCompressions = result.actionTaken ? 1 : 0;
    const condensedCompressions = 0; // TODO: 需要更精确的方式跟踪

    return { leafCompressions, condensedCompressions };
  }

  async compactFullSweep(): Promise<{ leafCompressions: number; condensedCompressions: number }> {
    const summarize = createMockSummarizer();

    const result = await this.compaction.compactFullSweep({
      conversationId: this.conversationId,
      tokenBudget: TOKEN_BUDGET,
      summarize,
      force: false,
      hardTrigger: false,
    });

    const leafCompressions = result.actionTaken ? 1 : 0;
    const condensedCompressions = 0; // 简化处理

    return { leafCompressions, condensedCompressions };
  }

  async compact(): Promise<{
    leafCompressions: number;
    condensedCompressions: number;
    softTrigger: boolean;
    hardTrigger: boolean;
  }> {
    const currentTokens = await this.summaryStore.getContextTokenCount(this.conversationId);
    const threshold = TOKEN_BUDGET * DEFAULT_LCM_CONFIG.contextThreshold!;
    const hardTrigger = currentTokens > threshold;
    const leafTrigger = await this.compaction.evaluateLeafTrigger(this.conversationId);
    const softTrigger = leafTrigger.shouldCompact;

    let leafCompressions = 0;
    let condensedCompressions = 0;

    if (softTrigger && !hardTrigger) {
      const result = await this.compaction.compactLeaf({
        conversationId: this.conversationId,
        tokenBudget: TOKEN_BUDGET,
        summarize: createMockSummarizer(),
        force: false,
      });
      leafCompressions = result.actionTaken ? 1 : 0;
    } else if (hardTrigger) {
      const result = await this.compaction.compactFullSweep({
        conversationId: this.conversationId,
        tokenBudget: TOKEN_BUDGET,
        summarize: createMockSummarizer(),
        force: false,
        hardTrigger: false,
      });
      leafCompressions = result.actionTaken ? 1 : 0;
    }

    return { leafCompressions, condensedCompressions, softTrigger, hardTrigger };
  }
}

// 运行模拟
async function simulate(rounds: number): Promise<Snapshot[]> {
  const sim = await SourceCodeSimulator.create();
  const snapshots: Snapshot[] = [];

  // 初始状态：0条消息
  snapshots.push(await sim.takeSnapshot(0, false, false));

  let totalLeaf = 0;
  let totalCondensed = 0;

  for (let round = 1; round <= rounds; round++) {
    // 每轮添加1条消息 (~530 tokens)
    await sim.addMessage(`Message ${round} - ${"x".repeat(2100)}`);

    // 执行压缩
    const result = await sim.compact();
    totalLeaf += result.leafCompressions;
    totalCondensed += result.condensedCompressions;

    // 每轮都记录快照
    snapshots.push(await sim.takeSnapshot(round, result.softTrigger, result.hardTrigger));

    // 每500轮输出一次进度
    if (round % 500 === 0) {
      console.log(`Progress: ${round}/${rounds} rounds complete...`);
    }
  }

  console.log(`Simulation complete: ${totalLeaf} leaf compressions, ${totalCondensed} condensed compressions`);
  return snapshots;
}

// 生成图表函数
function getDepthColor(depth: number): string {
  const colors = [
    '#ff79c6', '#bd93f9', '#8be9fd', '#50fa7b',
    '#f1fa8c', '#ffb86c', '#ff5555', '#f8f8f2'
  ];
  return colors[depth % colors.length];
}

// 主函数
async function main() {
  console.log("Starting simulation using source code...");
  const snapshots = await simulate(10000);

  // 生成HTML
  const fs = await import("fs");
  const path = await import("path");
  const { exec } = await import("child_process");

  const outFile = path.join(process.cwd(), "temp", "simulation-source-chart.html");
  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  const tokenData = '[' + snapshots.map(s => '[' + String(s.round) + ', ' + String(s.totalTokens) + ']').join(', ') + ']';
  const messagesData = '[' + snapshots.map(s => '[' + String(s.round) + ', ' + String(s.messages) + ']').join(', ') + ']';
  const messagesOutsideTailData = '[' + snapshots.map(s => '[' + String(s.round) + ', ' + String(s.messagesOutsideTail) + ']').join(', ') + ']';
  const softTriggerData = '[' + snapshots.map(s => '[' + String(s.round) + ', ' + (s.softTriggeredThisRound ? '1' : '0') + ']').join(', ') + ']';
  const hardTriggerData = '[' + snapshots.map(s => '[' + String(s.round) + ', ' + (s.hardTriggeredThisRound ? '1' : '0') + ']').join(', ') + ']';

  const allDepths = new Set<number>();
  for (const s of snapshots) {
    Object.keys(s.depths).forEach(d => allDepths.add(parseInt(d)));
  }
  const sortedDepths = Array.from(allDepths).sort((a, b) => a - b);

  const depthDatasets = sortedDepths.map(d => {
    const dataPoints = snapshots.map(s => '[' + s.round + ', ' + (s.depths[d] || 0) + ']').join(', ');
    return "{ label: 'depth=" + d + "', data: [" + dataPoints + "], color: '" + getDepthColor(d) + "' }";
  }).join(',\n        ');

  // Build HTML as a single string using concatenation
  let html = '';
  html += '<!DOCTYPE html>\n<html>\n<head>\n    <meta charset="utf-8">\n    <title>Compaction Simulation (Using Source Code)</title>';
  html += '<style>';
  html += 'body { font-family: system-ui, sans-serif; margin: 20px; background: #1a1a1a; color: #e0e0e0; }';
  html += '.chart-container { background: #2a2a2a; border-radius: 8px; padding: 20px; margin-bottom: 30px; }';
  html += 'h2 { margin-top: 0; color: #fff; }';
  html += '.info-box { background: #2a2a2a; border-radius: 8px; padding: 15px; margin-bottom: 20px; }';
  html += 'canvas { display: block; width: 100%; }';
  html += '</style>\n</head>\n<body>';
  html += '<h1>Compaction Simulation (Using Source Code) - 10000 rounds</h1>';
  html += '<div class="info-box">';
  html += '  <strong>配置:</strong> FRESH_TAIL=64 | LEAF_CHUNK_TOKENS=20000 | LEAF_MIN_FANOUT=24 | CONDENSED_MIN_FANOUT=8 | CONDENSED_MIN_FANOUT_HARD=2 | INCREMENTAL_MAX_DEPTH=1 | TOKEN_BUDGET=200K | CONTEXT_THRESHOLD=75% | depth=1 cap=8';
  html += '</div>';
  html += '<p style="color:#aaa;"><strong>初始状态</strong>: 0条消息 | <strong>每条消息</strong>: ~530 tokens | <strong>软触发</strong>: fresh tail 外的 messages ≥ 20K tokens (~38条) | <strong>depth=0→1触发</strong>: 需24个summaries | <strong>depth=1 cap</strong>: 保持最多8个,忽略fresh tail保护</p>';
  html += '<div class="chart-container"><h2>Total Tokens Over Time</h2><canvas id="tokenChart" height="300"></canvas></div>';
  html += '<div class="chart-container"><h2>Messages Count (Total vs Outside Tail)</h2><canvas id="messagesChart" height="300"></canvas></div>';
  html += '<div class="chart-container"><h2>Trigger Status (This Round)</h2><canvas id="triggerChart" height="250"></canvas></div>';
  html += '<div class="chart-container"><h2>Summary Count by Depth</h2><canvas id="depthChart" height="300"></canvas></div>';
  html += '<script>';
  html += 'const tokenData = ' + tokenData + ';';
  html += 'const messagesData = ' + messagesData + ';';
  html += 'const messagesOutsideTailData = ' + messagesOutsideTailData + ';';
  html += 'const softTriggerData = ' + softTriggerData + ';';
  html += 'const hardTriggerData = ' + hardTriggerData + ';';
  html += 'const depthDatasets = [' + depthDatasets + '];';

  // Add the drawChart function
  html += "function drawChart(canvasId, datasets, yMax, yLabel) {";
  html += "  const canvas = document.getElementById(canvasId);";
  html += "  const ctx = canvas.getContext('2d');";
  html += "  const width = canvas.offsetWidth;";
  html += "  const height = canvas.height;";
  html += "  const dpr = window.devicePixelRatio || 1;";
  html += "  canvas.width = width * dpr;";
  html += "  canvas.height = height * dpr;";
  html += "  ctx.scale(dpr, dpr);";
  html += "  const padding = { top: 20, right: 150, bottom: 40, left: 60 };";
  html += "  const chartW = width - padding.left - padding.right;";
  html += "  const chartH = height - padding.top - padding.bottom;";
  html += "  ctx.fillStyle = '#2a2a2a';";
  html += "  ctx.fillRect(0, 0, width, height);";
  html += "  let maxX = 0, maxY = 0;";
  html += "  datasets.forEach(ds => {";
  html += "    ds.data.forEach(([x, y]) => {";
  html += "      if (x > maxX) maxX = x;";
  html += "      if (y > maxY) maxY = y;";
  html += "    });";
  html += "  });";
  html += "  maxY = yMax || maxY * 1.1;";
  html += "  ctx.strokeStyle = '#3a3a3a';";
  html += "  ctx.lineWidth = 1;";
  html += "  for (let i = 0; i <= 5; i++) {";
  html += "    const y = padding.top + (chartH / 5) * i;";
  html += "    ctx.beginPath();";
  html += "    ctx.moveTo(padding.left, y);";
  html += "    ctx.lineTo(padding.left + chartW, y);";
  html += "    ctx.stroke();";
  html += "    const value = Math.round(maxY - (maxY / 5) * i);";
  html += "    ctx.fillStyle = '#888';";
  html += "    ctx.font = '12px system-ui';";
  html += "    ctx.textAlign = 'right';";
  html += "    ctx.fillText(value.toLocaleString(), padding.left - 10, y + 4);";
  html += "  }";
  html += "  for (let i = 0; i <= 10; i++) {";
  html += "    const x = padding.left + (chartW / 10) * i;";
  html += "    const value = Math.round((maxX / 10) * i);";
  html += "    ctx.fillStyle = '#888';";
  html += "    ctx.textAlign = 'center';";
  html += "    ctx.fillText(value, x, height - padding.bottom + 20);";
  html += "  }";
  html += "  ctx.save();";
  html += "  ctx.translate(15, height / 2);";
  html += "  ctx.rotate(-Math.PI / 2);";
  html += "  ctx.textAlign = 'center';";
  html += "  ctx.fillStyle = '#aaa';";
  html += "  ctx.fillText(yLabel, 0, 0);";
  html += "  ctx.restore();";
  html += "  datasets.forEach((ds, idx) => {";
  html += "    if (ds.data.length < 2) return;";
  html += "    const color = ds.color;";
  html += "    ctx.strokeStyle = color;";
  html += "    ctx.lineWidth = 2;";
  html += "    ctx.beginPath();";
  html += "    ds.data.forEach(([x, y], i) => {";
  html += "      const px = padding.left + (x / maxX) * chartW;";
  html += "      const py = padding.top + chartH - (y / maxY) * chartH;";
  html += "      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);";
  html += "    });";
  html += "    ctx.stroke();";
  html += "    ctx.fillStyle = color;";
  html += "    ctx.font = '13px system-ui';";
  html += "    ctx.textAlign = 'left';";
  html += "    const legendY = padding.top + (chartH / datasets.length) * idx + 15;";
  html += "    ctx.fillText(ds.label, padding.left + chartW + 10, legendY);";
  html += "  });";
  html += "}";

  html += "drawChart('tokenChart', [{ label: 'Total Tokens', data: tokenData, color: '#4a9eff' }], 200000, 'Tokens');";
  html += "drawChart('messagesChart', [{ label: 'Total Messages', data: messagesData, color: '#50fa7b' }, { label: 'Outside Tail', data: messagesOutsideTailData, color: '#ffb86c' }], null, 'Count');";
  html += "drawChart('triggerChart', [{ label: 'Soft Trigger', data: softTriggerData, color: '#ff79c6' }, { label: 'Hard Trigger', data: hardTriggerData, color: '#ff5555' }], 1.2, 'Active (1/0)');";
  html += "drawChart('depthChart', depthDatasets, null, 'Count');";
  html += '</script>\n</body>\n</html>';

  fs.writeFileSync(outFile, html);

  const final = snapshots[snapshots.length - 1];
  console.log(`Chart generated: ${outFile}`);
  console.log(`\nFinal state (round ${final.round}):`);
  console.log(`  Total tokens: ${final.totalTokens} (${(final.totalTokens / 200000 * 100).toFixed(1)}%)`);
  console.log(`  Total messages: ${final.messages}`);
  console.log(`  Messages outside tail: ${final.messagesOutsideTail}`);
  console.log(`  Summaries:`);
  const depthEntries = Object.entries(final.depths);
  const sortedEntries = depthEntries.sort(function(a, b) {
    return parseInt(a[0]) - parseInt(b[0]);
  });
  for (let i = 0; i < sortedEntries.length; i++) {
    const entry = sortedEntries[i];
    const d = entry[0];
    const c = entry[1];
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
}

main().catch(console.error);