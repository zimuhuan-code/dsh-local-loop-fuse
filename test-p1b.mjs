#!/usr/bin/env node
/**
 * test-p1b.mjs —— ①c P1-b「命中即注入 + 预注册观测 + 能力自检」的回归测试（2026-10-07）
 *
 * 为什么写它：P1-b 是**本仓库第一条会替使用者发消息**的动作线
 *   （`agent.steer()` 往会话里注入一条 user 消息），2026-10-07 上线时**没有任何测试覆盖** ——
 *   而写它的过程中，测试当场抓出两个只有测才看得见的错：
 *     ① **会二次注入**：观测窗口结束把 `st.p1b` 置回 null，命中持续时 `!st.p1b` 又成立
 *        ⇒ 同一 attempt 反复注入（原文注释写着"每 attempt 只注入一次"，代码做不到）；
 *     ② **读数 2 恒为真**：观测用**整个 `buf`** 调 `isLooping`，而注入点之前那段循环永久留在
 *        buf 里 ⇒ `line1StillHits` 永远是 true ⇒ verdict 永远"无效" ⇒ 观测等于白做。
 *        （正确口径 = **只问注入之后新增的那一段**，见 ⑧/⑨。）
 *   ⇒ 本文件就是这两条的防线：⑧ 锁"能读出有效"、⑩ 锁"只注入一次"。
 *
 * 用法：node test-p1b.mjs   （约 2 秒，不依赖 dsh、不起网络）
 */
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { apply, DEFAULTS, k24Max } from './index.js';

const results = [];
const t = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}${extra ? `   ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 纯函数：观测读数 k24Max ────────────────────────────────────────────────
t('① k24Max · 同一 3-gram 出现 3 次 ⇒ 3', k24Max('abcabcabc', 3) === 3);
t('② k24Max · 空串 ⇒ 0（不抛）', k24Max('') === 0);

// ── 夹具 ──────────────────────────────────────────────────────────────────
function mkCtx() {
  const h = new Map();
  return {
    on(evt, fn) { if (!h.has(evt)) h.set(evt, []); h.get(evt).push(fn); },
    fire(evt, ...args) { return (h.get(evt) ?? []).map((f) => f(...args)); },
  };
}

const LOG = `${tmpdir()}/loop-fuse-p1b-test.log`;
const mk = (over = {}) => {
  try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }
  const ctx = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpSamples: false,        // ⚠️ 测试不许写进真 samples/（v0.6.0 守卫）
    watchIntervalSec: 3600,
    logPath: LOG,
    dryRun: true,              // 只测**注入**，不测掐断（掐断另有 test-abort/test-cancel）
    minChars: 1000,
    p1bEnabled: true,
    ...over,
  });
  return ctx;
};
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };
const count = (log, re) => (log.match(re) ?? []).length;

/** 一段**周期文本**（整体重复才构成循环；单段内部无 24-gram 重复） */
const A = Array.from({ length: 42 }, (_, i) => `第${i}项检查：确认状态正常。`).join('');
/** 高多样性文本（2000 个互不相同的汉字）⇒ 任何循环判据都不该命中 */
const BIG = Array.from({ length: 2000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');
/** 短周期循环文本（~15 字符/周期，像真实事故的 `（停）→（调用）→（结束）→`） */
const CYC = '（停）→（调用）→（结束）→'.repeat(140);

function mkAgent(sid, { steer = true } = {}) {
  const calls = { steer: [], cancel: [] };
  const agent = { session: { id: sid }, inbox: {}, cancel: (...a) => calls.cancel.push(a) };
  if (steer) agent.steer = (...a) => calls.steer.push(a);
  return { agent, calls };
}

/** 喂一个流式 chunk（reasoning-delta） */
function feed(ctx, agent, attemptId, text, turn = 1) {
  return ctx.fire('agent/assistant-stream', {
    agent,
    frame: { attemptId, turn, type: 'chunk', chunk: { type: 'reasoning-delta', text } },
  });
}

/**
 * 把一次 attempt 喂到**首次命中**（hits=1）。
 *
 * ⚠️ 为什么是**两次** `A×4`：① 线的精确子串判据**不接受重叠**命中 ⇒ `A×4`（~2.3k 字符）时
 *   末尾窗口的两个接缝相距 < 一个窗口宽，只数出 1 次 ⇒ 达不到 `repeats-1=2`；
 *   到 `A×8`（~4.6k）时刻点变成 3 个 ⇒ 命中。（这是判据的**设计行为**，不是测试凑数。）
 */
function hitOnce(ctx, agent, attemptId) {
  feed(ctx, agent, attemptId, A.repeat(4));   // 未命中：接缝被不重叠规则滤掉
  feed(ctx, agent, attemptId, A.repeat(4));   // 命中：hits=1
}

// ── ③④ 注入基本路径：命中即注入一次，且预注册参数全部落日志 ─────────────────
{
  const ctx = mk();
  const { agent, calls } = mkAgent('s-inject');
  hitOnce(ctx, agent, 'a1');               // 喂到首次命中（hits=1）
  await sleep(400);
  const log = readLog();
  t('③ 命中即注入 · 日志有 P1B-INJECT 且 agent.steer 被调用一次',
    /P1B-INJECT session=s-inject turn=\? hit=1 via=(dsh-llm|self-built) /.test(log) && calls.steer.length === 1,
    log.match(/P1B-INJECT[^\n]*/)?.[0]?.slice(0, 100) ?? '(无日志)');
  t('④ 预注册参数已打印（observeN / dropPct / atChar / k24Before）',
    /observeN=2000 dropPct=50/.test(log) && /atChar=\d+ k24Before=\d+/.test(log));
  t('④b 注入文本 = p1bHint（含「停止推理」）',
    calls.steer.length === 1 && /停止推理/.test(JSON.stringify(calls.steer[0])));

  // ── ⑧ 观测读数 2 必须只覆盖**注入之后**那一段（否则恒为 true ⇒ 永远"无效"）──
  feed(ctx, agent, 'a1', BIG);              // 注入后换成高多样性文本 ⇒ 应当判"有效"
  await sleep(400);
  const log2 = readLog();
  t('⑧ 观测 · 注入后不再循环 ⇒ line1StillHits=false 且 verdict=有效',
    /P1B-OBSERVE session=s-inject.*line1StillHits=false.*verdict=有效/.test(log2),
    log2.match(/P1B-OBSERVE[^\n]*/)?.[0]?.slice(0, 140) ?? '(无日志)');
}

// ── ⑩ 每 attempt 只注入一次（回归：st.p1b 置 null 后不得二次注入）────────────
{
  const ctx = mk();
  const { agent, calls } = mkAgent('s-once');
  hitOnce(ctx, agent, 'b1');                // hits=1 ⇒ 注入
  await sleep(300);
  feed(ctx, agent, 'b1', CYC);              // 观测窗口走完（短周期循环 ⇒ 仍判得出循环 ⇒ 无效）
  await sleep(300);
  feed(ctx, agent, 'b1', A.repeat(2));      // 观测已结束、命中仍在 ⇒ 曾经会在这里二次注入
  await sleep(400);
  const log2 = readLog();
  t('⑩ 每 attempt 只注入一次（观测结束后命中仍持续 ⇒ 不重复注入）',
    count(log2, /P1B-INJECT session=s-once/g) === 1 && calls.steer.length === 1,
    `INJECT 行数=${count(log2, /P1B-INJECT session=s-once/g)} · steer 调用=${calls.steer.length}`);
  t('⑨ 观测 · 注入后仍在循环 ⇒ line1StillHits=true 且 verdict=无效',
    /P1B-OBSERVE session=s-once.*line1StillHits=true.*verdict=无效/.test(log2),
    log2.match(/P1B-OBSERVE[^\n]*/)?.[0]?.slice(0, 140) ?? '(无日志)');
  t('⑨b 观测行带 segLen（口径可诊断）', /P1B-OBSERVE session=s-once.*segLen=\d+/.test(log2));
}

// ── ⑤ 发布包默认保守：p1bEnabled=false ⇒ 不注入 ────────────────────────────
{
  const ctx = mk({ p1bEnabled: false });
  const { agent, calls } = mkAgent('s-off');
  hitOnce(ctx, agent, 'c1');
  await sleep(400);
  const log = readLog();
  t('⑤ p1bEnabled=false ⇒ 无 P1B-INJECT、steer 未被调用（发布包默认值是 false）',
    !/P1B-INJECT session=s-off/.test(log) && calls.steer.length === 0);
}

// ── ⑥ 预注册注入点：p1bInjectAtHit=2 ⇒ 第二次命中才注入 ─────────────────────
{
  const ctx = mk({ p1bInjectAtHit: 2 });
  const { agent, calls } = mkAgent('s-hit2');
  hitOnce(ctx, agent, 'd1');                // hits=1 ⇒ 还不注入
  await sleep(300);
  const first = readLog();
  const injectedAtHit1 = /P1B-INJECT session=s-hit2/.test(first);
  feed(ctx, agent, 'd1', A.repeat(2));      // hits=2 ⇒ 注入
  await sleep(400);
  const log = readLog();
  t('⑥ p1bInjectAtHit=2 · 首次命中不注入、第二次命中才注入（hit=2）',
    !injectedAtHit1 && /P1B-INJECT session=s-hit2 turn=\? hit=2 /.test(log) && calls.steer.length === 1);
}

// ── ⑦ 拿不到能力时必须留痕、且不抛 ────────────────────────────────────────
{
  const ctx = mk();
  const { agent } = mkAgent('s-nosteer', { steer: false });
  try {
    hitOnce(ctx, agent, 'e1');
    await sleep(400);
    const log = readLog();
    t('⑦ 无 steer 能力 ⇒ P1B-INJECT-SKIP（不抛、不静默）',
      /P1B-INJECT-SKIP session=s-nosteer/.test(log));
  } catch (e) {
    t('⑦ 无 steer 能力 ⇒ P1B-INJECT-SKIP（不抛、不静默）', false, String(e));
  }
}

// ── ⑪⑫ 能力自检：不必等循环就能回答"能不能注入"，每会话一行 ───────────────────
{
  const ctx = mk();
  const { agent } = mkAgent('s-cap');
  const next = async () => ({ ok: true });
  const payload = { agent, turn: 1, signal: new AbortController().signal };
  await Promise.all(ctx.fire('agent/request', payload, next));
  await Promise.all(ctx.fire('agent/request', payload, next));   // 第二次不应再打
  await sleep(400);
  const log = readLog();
  t('⑪ 能力自检 · P1B-CAPABILITY 行含 steer=true cancel=true（机器可读格式）',
    /P1B-CAPABILITY session=s-cap steer=true cancel=true inbox=object/.test(log),
    log.match(/P1B-CAPABILITY[^\n]*/)?.[0]?.slice(0, 110) ?? '(无日志)');
  t('⑫ 能力自检 · 每会话只打一行', count(log, /P1B-CAPABILITY session=s-cap/g) === 1);
  t('⑫b 能力自检 · 说明文字里不再出现 steer=false 之类布尔字面量（防统计脚本重复计数）',
    !/steer=false/.test(log));
}

// ── ⑬ 能力自检不受 p1bEnabled 影响（它是探测，不是动作）──────────────────────
{
  const ctx = mk({ p1bEnabled: false });
  const { agent } = mkAgent('s-cap-off');
  await Promise.all(ctx.fire('agent/request',
    { agent, turn: 1, signal: new AbortController().signal }, async () => ({})));
  await sleep(400);
  t('⑬ p1bEnabled=false 时能力自检仍打印（探测与动作解耦）',
    /P1B-CAPABILITY session=s-cap-off steer=true/.test(readLog()));
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过`
  + (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
process.exit(bad.length ? 1 : 0);
