/**
 * test-abort.mjs —— ① 线「检测到 ⇒ 真掐断」的集成测试（v0.3.3，2026-09-29）
 *
 * 为什么写它：v0.3.2 之前「检测有效但掐不死」，**两层根因**，任何一层不测都发现不了：
 *   ① `AbortSignal` 按 `frame.turn` 索引保存，而 `agent/assistant-stream` 的 frame
 *      **根本没有 turn 字段** ⇒ `signals.get(agent).get(undefined)` 恒 undefined（日志 `turn=undefined hasSignal=false`）；
 *   ② 更深一层：Node 里 `AbortSignal` 实例**没有 `abort` 方法**（只有 `AbortController` 有），
 *      而 payload 只给 signal、不给 controller ⇒ `signal.abort()` **架构上就不通**。
 *   ⇒ 真掐断必须走 `Agent.cancel(cause, options)`；本测试直接断言它被调用、参数正确、且只调一次。
 *
 * 用法：node test-abort.mjs     （约 1 秒，不依赖 dsh，不起网络）
 */
import { tmpdir } from 'node:os';
import { apply, DEFAULTS, turnOfAttempt } from './index.js';

const results = [];
const t = (name, ok) => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}`);
};

/** 假 ctx：只收集 handler，够 apply() 用 */
function mkCtx() {
  const h = new Map();
  return {
    on(evt, fn) {
      if (!h.has(evt)) h.set(evt, []);
      h.get(evt).push(fn);
    },
    fire(evt, ...args) { return (h.get(evt) ?? []).map((f) => f(...args)); },
  };
}

/** 假 agent：官方字段 session + 记录 cancel 调用 */
function mkAgent(sid, opts = {}) {
  const calls = [];
  const agent = { session: { id: sid }, _calls: calls };
  if (opts.noCancel !== true) agent.cancel = (cause, options) => { calls.push({ cause, options }); };
  return agent;
}

// v0.7.6：测试日志落**临时目录**，不再写死作者本机的绝对路径（公开包不该假设本机目录存在）
const LOG = `${tmpdir()}/loop-fuse-test.log`;

function mk(cfgOverride = {}) {
  const ctx = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpSamples: false,   // ⚠️ 测试不许写进真 samples/ 目录（v0.6.0；踩过：跑一次留 5 条假样本）
    checkEvery: 50, window: 60, history: 4000, repeats: 3, minChars: 400,
    watchIntervalSec: 3600, logPath: LOG,
    ...cfgOverride,
  });
  return ctx;
}

/** 走一次完整的「请求 → 流式输出」链路 */
async function run(ctx, agent, chunks, signal, attemptId = 'session-test:7') {
  await ctx.fire('agent/request', { agent, turn: '7', signal }, async () => ({ ok: true }));
  for (const text of chunks) {
    ctx.fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, chunk: { type: 'reasoning-delta', text } },
    });
  }
}

/** 低熵重复文本：单元 260 字符 ⇒ 检测窗口 60 字符下非重叠命中足够多 */
const LOOP_UNIT = '让我再仔细想想这个问题，是否可以用另一种方式重新表述它。'.repeat(5);
const loopChunks = Array.from({ length: 8 }, () => LOOP_UNIT);

/** 正常文本：8 段各不相同（防误杀对照） */
const normalChunks = Array.from({ length: 8 }, (_, i) =>
  `第${i}步：检查配置文件 ${i}，读到的值与前一步不同，结论推进到下一节。`.repeat(4));

// ── 用例 ①（核心回归）：dryRun=false + 重复文本 ⇒ **agent.cancel 真被调用** ──
{
  const ctx = mk({ dryRun: false });
  const agent = mkAgent('s-abort');
  await run(ctx, agent, loopChunks, new AbortController().signal);
  const c = agent._calls[0];
  t('① dryRun=false + 重复文本 ⇒ agent.cancel() 被调用（v0.3.3 修复的核心）',
    agent._calls.length === 1);
  t('② cancel cause = {kind:"hook", reason}（AgentCancelCause 合法值）',
    c?.cause?.kind === 'hook' && typeof c?.cause?.reason === 'string');
  t('③ cancel 带 {keepInbox:true} ⇒ 只掐这场 turn，不牵连排队消息',
    c?.options?.keepInbox === true);
}

// ── 用例 ④：同一 attempt 命中多次 ⇒ 只掐一次（st.canceled 去抖）──────────
{
  const ctx = mk({ dryRun: false });
  const agent = mkAgent('s-once');
  await run(ctx, agent, [...loopChunks, ...loopChunks], new AbortController().signal);
  t('④ 同一 attempt 反复命中 ⇒ 只 cancel 一次（不重复中止）', agent._calls.length === 1);
}

// ── 用例 ⑤：dryRun=true 只观测，绝不动手 ────────────────────────────────
{
  const ctx = mk({ dryRun: true });
  const agent = mkAgent('s-dry');
  await run(ctx, agent, loopChunks, new AbortController().signal);
  t('⑤ dryRun=true ⇒ 检测到但不动手（观测模式语义不变）', agent._calls.length === 0);
}

// ── 用例 ⑥：正常文本不误杀 ───────────────────────────────────────────────
{
  const ctx = mk({ dryRun: false });
  const agent = mkAgent('s-ok');
  await run(ctx, agent, normalChunks, new AbortController().signal);
  t('⑥ 8 段各不相同的正常输出 ⇒ 不 cancel（防误杀）', agent._calls.length === 0);
}

// ── 用例 ⑦：agent 没有 cancel 方法（极端情况）⇒ 不抛异常、不拖垮会话链 ────
{
  const ctx = mk({ dryRun: false });
  const agent = mkAgent('s-nocancel', { noCancel: true });
  let threw = false;
  try {
    await run(ctx, agent, loopChunks, new AbortController().signal);
  } catch { threw = true; }
  t('⑦ agent 无 cancel 时检测到也不抛异常（插件绝不拖垮会话链）', threw === false);
}

// ── 用例 ⑧：路径 B 兜底 —— 若 signal 真可 abort（未来 DSH 递下 controller）⇒ 走 abort
{
  const ctx = mk({ dryRun: false, abortViaCancel: false });
  const agent = mkAgent('s-sig', { noCancel: true });
  const fakeSignal = { aborted: false, abort() { this.aborted = true; } };
  await run(ctx, agent, loopChunks, fakeSignal);
  t('⑧ 兜底路径：signal 可 abort 且关掉 cancel 时 ⇒ 调用 signal.abort()',
    fakeSignal.aborted === true);
}

// ── 用例 ⑨：陈旧 signal ⇒ 不走兜底 abort（避免误伤已结束的请求）──────────
//   做法：登记 signal 后**真的等一会**，再把时效窗口设成 0 ⇒ `now - at > 0` 成立 ⇒ 判陈旧。
{
  const ctx = mk({ dryRun: false, abortViaCancel: false, signalMaxAgeMinutes: 0 });
  const agent = mkAgent('s-stale', { noCancel: true });
  const fakeSignal = { aborted: false, abort() { this.aborted = true; } };
  await ctx.fire('agent/request', { agent, turn: '7', signal: fakeSignal }, async () => ({ ok: true }));
  await new Promise((r) => setTimeout(r, 15));           // 让 at 真的过期（0 分钟窗口）
  for (const text of loopChunks) {
    ctx.fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId: 'session-test:7', chunk: { type: 'reasoning-delta', text } },
    });
  }
  t('⑨ 陈旧 signal 超时效 ⇒ 不 abort（防御"拿旧 signal 误伤"）', fakeSignal.aborted === false);
}

// ── 用例 ⑩⑪：turnOfAttempt（frame 上没有 turn 字段，只能从 attemptId 取）──
t('⑩ turnOfAttempt("session-a3696597:17") ⇒ "17"', turnOfAttempt('session-a3696597:17') === '17');
t('⑪ turnOfAttempt(undefined) ⇒ undefined（不抛）', turnOfAttempt(undefined) === undefined);

// ── 用例 ⑫：Node 里 AbortSignal **没有** abort 方法（这是第二层根因的现场证据）──
{
  const s = new AbortController().signal;
  t('⑫ 现场证据：Node 的 AbortSignal 实例没有 abort 方法（故必须走 agent.cancel）',
    typeof s.abort !== 'function' && typeof s.aborted === 'boolean');
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过` +
  (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
process.exit(bad.length ? 1 : 0);
