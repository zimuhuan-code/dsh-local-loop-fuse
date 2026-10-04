#!/usr/bin/env node
/**
 * dsh-local-loop-fuse v0.4.0 集成测试：**不依赖 dsh**，用假 ctx / 假 agent 驱动真实的 `apply()`。
 *
 * 覆盖关键链路（纯函数单测碰不到的）：
 *   ① `agent/request` 是否把 sessionId → Agent 登记进映射；
 *   ② `session/event` 是否真的按"进展"记账（turn/start + tool/result 刷新 lastProgressAt）；
 *   ③ 扫描器是否在**停滞**时打出 STALL-WARN；
 *   ④ **累积 strike 达到阈值后是否真的调用 `agent.cancel({kind:'hook'}, {keepInbox:true})`**
 *      （v0.4.0-C：旧实现是 `{kind:'user'}` 且不传 keepInbox ⇒ 会丢用户排队消息）；
 *   ⑤ `killed` 是否阻止同一会话被反复 cancel；
 *   ⑥ **【2026-10-01 事故回归】持续有进展的长 turn 不许被切断**（旧 duration 判据会误杀）。
 *
 * 用法：node test-cancel.mjs        （约需 35 秒，因为要等 setInterval 真跑）
 */
import { apply, DEFAULTS } from './index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mkCtx = () => {
  const h = Object.create(null);
  return {
    h,
    ctx: { on(ev, fn) { (h[ev] ??= []).push(fn); return () => {}; } },
    fire: (ev, ...a) => (h[ev] ?? []).forEach((fn) => fn(...a)),
  };
};

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}${extra ? `   ${extra}` : ''}`);
};

// ══ 场景 1：停滞判据 + strike 累计 + cancel 参数 ══════════════════════
const { ctx: fakeCtx, fire } = mkCtx();
const cancelled = [];
const agent = {
  session: { id: 'sess-test' },
  cancel(cause, options) { cancelled.push({ cause, options }); },
};

// 阈值压到极限：stallMinutes=0 ⇒ 一旦没有新进展就立刻算停滞；扫描间隔 5 s（代码下限）
apply(fakeCtx, {
  ...DEFAULTS, dumpSamples: false,   // 测试不许写进真 samples/ 目录（v0.6.0）
  stallMinutes: 0,
  stallMinutesWithTool: 0,
  watchIntervalSec: 5,
  strikesBeforeCancel: 2,
  logPath: '/tmp/loop-fuse-test.log',
  cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});

// ① 先来一次请求 → 应登记 sessionId → Agent 映射
await fire('agent/request', { agent, turn: 1, signal: new AbortController().signal }, async () => ({}));

// ② 第一轮停滞的 turn（turn=1，永不 end）
fire('session/event', { id: 'sess-test' }, { type: 'turn/start', data: { turn: 1 } });
fire('session/event', { id: 'sess-test' }, { type: 'step/start', data: { turn: 1, step: 3 } });
await sleep(6200);
check('① strikes=1 时不切断（首次只留痕）', cancelled.length === 0, `cancelled=${cancelled.length}`);

// ③ 第二轮停滞的 turn（turn=2）→ strikes=2 ⇒ 应真切断
fire('session/event', { id: 'sess-test' }, { type: 'turn/start', data: { turn: 2 } });
fire('session/event', { id: 'sess-test' }, { type: 'step/start', data: { turn: 2, step: 2 } });
await sleep(6200);
check('② strikes=2 时调用 agent.cancel({kind:"hook"})',
  cancelled.length === 1 && cancelled[0]?.cause?.kind === 'hook',
  `cancelled=${JSON.stringify(cancelled)}`);
check('②b cancel 带 {keepInbox:true} ⇒ 不丢用户排队消息（v0.4.0-C 修）',
  cancelled[0]?.options?.keepInbox === true,
  `options=${JSON.stringify(cancelled[0]?.options)}`);
check('②c cancel 原因带 reason（会话事件里可查，不再是静默掐断）',
  typeof cancelled[0]?.cause?.reason === 'string' && cancelled[0].cause.reason.includes('stalled'),
  `reason=${cancelled[0]?.cause?.reason}`);

// ④ 同一 turn 内再触发 → 不应重复 cancel
//    （2026-10-03 修：去重键由 session 改为 session#turn）
fire('session/event', { id: 'sess-test' }, { type: 'step/start', data: { turn: 2, step: 6 } });
await sleep(6200);
check('③ 同一 turn 内不重复 cancel（killed 按 sid#turn 去重）', cancelled.length === 1, `cancelled=${cancelled.length}`);

// ④b 新 turn（turn=3）再停滞 → **应再次 cancel**
//    ⚠️ 旧实现按 session 去重 ⇒ 整个会话只切一次 ⇒ 后续 turn 永久失保
//    （2026-10-03 实测：turn 3 掐断后 turn 4 同参连击 6→23 次只 warn 不 cancel，最后机主手动停）。
//    本用例锁住修复后的语义：**同一 turn 不重复切，但新 turn 可以再切**。
fire('session/event', { id: 'sess-test' }, { type: 'turn/start', data: { turn: 3 } });
fire('session/event', { id: 'sess-test' }, { type: 'step/start', data: { turn: 3, step: 1 } });
await sleep(6200);
check('③b 新 turn 仍会被切断（修复：一次掐断不再让会话永久失保）', cancelled.length === 2, `cancelled=${cancelled.length}`);

// ⑤ 对照：另一个 session 不该受影响
const other = { session: { id: 'sess-other' }, cancel(c, o) { cancelled.push({ cause: c, options: o, who: 'other' }); } };
await fire('agent/request', { agent: other, turn: 1, signal: new AbortController().signal }, async () => ({}));
fire('session/event', { id: 'sess-other' }, { type: 'turn/start', data: { turn: 1 } });
fire('session/event', { id: 'sess-other' }, { type: 'step/start', data: { turn: 1, step: 1 } });
await sleep(6200);
check('④ 新会话独立计数（首次不切）', cancelled.filter((c) => c.who === 'other').length === 0);

// ══ 场景 2：strike 时效窗口（v0.3.1 修的 bug）══════════════════════════
// 窗口设为负 ⇒ 每个 strike 立刻过期 ⇒ 同会话连开多个停滞 turn 也到不了 2 ⇒ 不该切断。
// 原实现把计数**永久累计** ⇒ "上周卡过一次 + 今天卡过一次" 也会把今天正常会话切掉。
const s2 = mkCtx();
const c2 = [];
const agentWin = { session: { id: 'sess-win' }, cancel(c, o) { c2.push({ c, o }); } };
apply(s2.ctx, {
  ...DEFAULTS, dumpSamples: false, stallMinutes: 0, stallMinutesWithTool: 0, watchIntervalSec: 5, strikesBeforeCancel: 2,
  strikeWindowMinutes: -1, logPath: '/tmp/loop-fuse-test.log',
  cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});
await s2.fire('agent/request', { agent: agentWin, turn: 1, signal: new AbortController().signal }, async () => ({}));
for (const turn of [1, 2]) {
  s2.fire('session/event', { id: 'sess-win' }, { type: 'turn/start', data: { turn } });
  s2.fire('session/event', { id: 'sess-win' }, { type: 'step/start', data: { turn, step: 1 } });
  await sleep(6200);
}
check('⑤ 过期 strike 不累计（陈旧卡顿不会误切今天的会话）', c2.length === 0, `cancelled=${c2.length}`);

// ══ 场景 3：【2026-10-01 事故回归】有进展的长任务不许被切 ═══════════════
// 复刻事故形态：turn 持续十几分钟，但每几秒就有一次 tool/result（批量出图的真实节奏）。
// 旧判据（墙钟 >15 min）会误杀；新判据（无进展）必须放行。
// 这里把 stallMinutes 压到 1 分钟、strikesBeforeCancel 压到 1（最敏感），仍有进展 ⇒ 不许切。
const s3 = mkCtx();
const c3 = [];
const agentLong = { session: { id: 'sess-long' }, cancel(c, o) { c3.push({ c, o }); } };
apply(s3.ctx, {
  ...DEFAULTS, dumpSamples: false, stallMinutes: 1, stallMinutesWithTool: 1, watchIntervalSec: 5, strikesBeforeCancel: 1,
  logPath: '/tmp/loop-fuse-test.log', cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});
await s3.fire('agent/request', { agent: agentLong, turn: 1, signal: new AbortController().signal }, async () => ({}));
s3.fire('session/event', { id: 'sess-long' }, { type: 'turn/start', data: { turn: 1 } });
for (let i = 0; i < 4; i += 1) {
  s3.fire('session/event', { id: 'sess-long' },
    { type: 'tool/result', data: { turn: 1, step: i + 1, message: { role: 'tool' } } });
  await sleep(3000);
}
check('⑥ 【事故回归】持续有 tool/result 的长 turn 不被切断（旧 duration 判据在这里误杀过）',
  c3.length === 0, `cancelled=${c3.length}`);

// ══ 场景 4：②b 线「同参调用连击」（v0.5.0 · 2026-10-02 桌面版实录）═══════════
// 桌面版本地 27B 找不到后台 job 输出 ⇒ 同一条 pwsh 连调 21 次（每次 (no output)）。
// DSH 内置检测只警告，这里要**真掐**；同时合法轮询（job_output）必须豁免。
const s4 = mkCtx();
const c4 = [];
const agentRep = { session: { id: 'sess-rep' }, cancel(c, o) { c4.push({ c, o }); } };
apply(s4.ctx, {
  ...DEFAULTS, dumpSamples: false, repeatCallLimit: 6, repeatCallCancel: true, watchIntervalSec: 60,
  logPath: '/tmp/loop-fuse-test.log', cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});
await s4.fire('agent/request', { agent: agentRep, turn: 1, signal: new AbortController().signal }, async () => ({}));
s4.fire('session/event', { id: 'sess-rep' }, { type: 'turn/start', data: { turn: 1 } });
const SAME = JSON.stringify({ command: 'Get-ChildItem "$env:DSH_HOME" -Recurse -File | Where-Object { $_.Name -like "pwsh-5*" }' });
for (let i = 0; i < 6; i += 1) {
  s4.fire('session/event', { id: 'sess-rep' },
    { type: 'tool/call', data: { turn: 1, step: i + 1, callId: `c${i}`, name: 'pwsh', arguments: SAME } });
}
check('⑦ 连续 6 次完全相同的工具调用 ⇒ 直接 cancel', c4.length === 1, `cancelled=${c4.length}`);
check('⑦b cause=hook 且 reason 说明是"重复同一调用"',
  c4[0]?.c?.kind === 'hook' && /repeated identical tool call/.test(String(c4[0]?.c?.reason)),
  `reason=${c4[0]?.c?.reason}`);
check('⑦c 掐断仍保留排队消息（keepInbox=true）', c4[0]?.o?.keepInbox === true);

// 场景 5：合法轮询豁免 —— job_output 连调 10 次不许掐
const s5 = mkCtx();
const c5 = [];
const agentPoll = { session: { id: 'sess-poll' }, cancel(c, o) { c5.push({ c, o }); } };
apply(s5.ctx, {
  ...DEFAULTS, dumpSamples: false, repeatCallLimit: 6, watchIntervalSec: 60,
  logPath: '/tmp/loop-fuse-test.log', cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});
await s5.fire('agent/request', { agent: agentPoll, turn: 1, signal: new AbortController().signal }, async () => ({}));
s5.fire('session/event', { id: 'sess-poll' }, { type: 'turn/start', data: { turn: 1 } });
for (let i = 0; i < 10; i += 1) {
  s5.fire('session/event', { id: 'sess-poll' },
    { type: 'tool/call', data: { turn: 1, step: i + 1, callId: `j${i}`, name: 'job_output', arguments: '{"job_id":"pwsh-59","wait":true}' } });
}
check('⑧ 豁免工具（job_output）连调 10 次不掐（合法轮询）', c5.length === 0, `cancelled=${c5.length}`);

// 场景 6：交替不同命令 ⇒ 计数重置，不掐（防止把"翻来覆去排查"误当连击）
const s6 = mkCtx();
const c6 = [];
const agentAlt = { session: { id: 'sess-alt' }, cancel(c, o) { c6.push({ c, o }); } };
apply(s6.ctx, {
  ...DEFAULTS, dumpSamples: false, repeatCallLimit: 6, watchIntervalSec: 60,
  logPath: '/tmp/loop-fuse-test.log', cancelLogPath: '/tmp/loop-fuse-test-cancels.log',
});
await s6.fire('agent/request', { agent: agentAlt, turn: 1, signal: new AbortController().signal }, async () => ({}));
s6.fire('session/event', { id: 'sess-alt' }, { type: 'turn/start', data: { turn: 1 } });
for (let i = 0; i < 8; i += 1) {
  for (const cmd of ['ls A', 'ls B']) {
    s6.fire('session/event', { id: 'sess-alt' },
      { type: 'tool/call', data: { turn: 1, step: i + 1, callId: `a${i}${cmd}`, name: 'pwsh', arguments: JSON.stringify({ command: cmd }) } });
  }
}
check('⑨ 交替不同命令（各 8 次）不掐 —— 计数按"连续相同"重置', c6.length === 0, `cancelled=${c6.length}`);

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过` +
  (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
console.log('（日志见 /tmp/loop-fuse-test.log 与 /tmp/loop-fuse-test-cancels.log）');
process.exit(bad.length ? 1 : 0);
