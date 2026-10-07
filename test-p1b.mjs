#!/usr/bin/env node
/**
 * test-p1b.mjs —— ①c P1-b「命中即注入 + 预注册观测 + 能力自检」的回归测试（2026-10-07）
 *
 * 为什么写它：P1-b 是**本仓库第一条会替使用者发消息**的动作线
 *   （`agent.steer()` 往会话里注入一条 user 消息），2026-10-07 上线时**没有任何测试覆盖** ——
 *   而写它的过程中，测试当场抓出四个只有测才看得见的缺陷：
 *     ① `createUserMessage` **从未 import** ⇒ 每次注入 `ReferenceError`；
 *     ② 修完①才暴露：`@deepseek-ai/dsh-llm`（dsh 内部包）在零依赖插件里**解析不到**
 *        ⇒ 加**自建 UserMessage 兜底**（`buildSteerMessage`；拾遗第 3 轮已端到端验证可被消费/回放）；
 *     ③ 观测读数 2 用**整个 buf** ⇒ 注入点之前那段循环永久留在里面 ⇒ `line1StillHits` 恒真；
 *     ④ 观测结束把状态置 null ⇒ 同一 attempt **二次注入**。
 *
 * ⚠️ **第三轮审阅（拾遗）又推翻了两件事，本文件是那两条的防线**：
 *     · **观测窗口只在同一 attempt 内是错的**：`attempt` = 一次模型请求 = 一个 step，
 *       而 `steer` 到**下一个 step** 才进 prompt ⇒ 同 attempt 内的"注入后文本"是注入**不可能影响**的。
 *       现在读数改成 **session/turn 级**：注入之后**新 attempt** 的文本才累计（见 ⑧/⑨/⑯）。
 *     · **跨 step 会每步注入一次且无上限** ⇒ 加 `p1bSteerMaxPerSession`（见 ⑩b）。
 *
 * 用法：node test-p1b.mjs   （约 3 秒，不依赖 dsh、不起网络）
 */
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { apply, DEFAULTS, k24Max, buildSteerMessage } from './index.js';

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
/** 短周期循环文本（每段 14 字符 × 140 = 1960 字符；用时按需 repeat，像真实事故的 `（停）→…`）*/
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

/** 结束一个 turn（观测窗口的关闭点） */
function turnEnd(ctx, sid, turn = 1) {
  return ctx.fire('session/event', { id: sid }, { type: 'turn/end', data: { turn } });
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
  hitOnce(ctx, agent, 'a1');
  await sleep(400);
  const log = readLog();
  t('③ 命中即注入 · P1B-INJECT + agent.steer 被调用一次',
    /P1B-INJECT session=s-inject attempt=a1 hit=1 via=(dsh-llm|self-built) /.test(log) && calls.steer.length === 1,
    log.match(/P1B-INJECT[^\n]*/)?.[0]?.slice(0, 110) ?? '(无日志)');
  t('④ 预注册参数已打印（observeN / dropPct / atChars / k24Before / quota）',
    /observeN=2000 dropPct=50 quota=1\/2/.test(log) && /atChars=\d+ k24Before=\d+/.test(log));
  t('④b 注入文本 = p1bHint（含「停止推理」）',
    calls.steer.length === 1 && /停止推理/.test(JSON.stringify(calls.steer[0])));

  // ── ⑧ 观测：跨 attempt 累计，且**本 attempt 的尾巴不进读数**（只记 blindChars）──
  feed(ctx, agent, 'a1', 'X'.repeat(500));   // 注入所在 attempt 的后续输出 ⇒ blindChars
  feed(ctx, agent, 'a2', BIG);               // 注入**之后**的新 attempt ⇒ 这才是读数
  await sleep(400);
  const log2 = readLog();
  t('⑧ 观测 · 读数只取"注入后的新 attempt" ⇒ line1StillHits=false & verdict=有效',
    /P1B-OBSERVE session=s-inject attempt=a1 .*segLen=2000 blindChars=500 .*line1StillHits=false .*verdict=有效/.test(log2),
    log2.match(/P1B-OBSERVE[^\n]*/)?.[0]?.slice(0, 150) ?? '(无日志)');
  t('⑧b 观测行带 attempt=（不是被误当 turn 的 attempt 计数）', /P1B-OBSERVE session=s-inject attempt=a1 /.test(log2));
}

// ── ⑨ 观测 · 注入后仍在循环 ⇒ 无效 ────────────────────────────────────────
{
  const ctx = mk();
  const { agent } = mkAgent('s-still');
  hitOnce(ctx, agent, 'a1');
  await sleep(300);
  feed(ctx, agent, 'a2', CYC.repeat(2));     // 短周期循环（≥N）⇒ 新 attempt 里仍判得出循环
  await sleep(400);
  t('⑨ 观测 · 注入后仍循环 ⇒ line1StillHits=true & verdict=无效',
    /P1B-OBSERVE session=s-still .*line1StillHits=true .*verdict=无效/.test(readLog()));
}

// ── ⑩a 同一 attempt 内不重复注入（p1bDone）────────────────────────────────
{
  const ctx = mk();
  const { agent, calls } = mkAgent('s-once');
  hitOnce(ctx, agent, 'a1');
  await sleep(300);
  feed(ctx, agent, 'a1', A.repeat(4));       // 同一 attempt 继续命中 ⇒ 不该再注入
  await sleep(400);
  t('⑩a attempt 内 · 命中持续也只注入一次（p1bDone）',
    count(readLog(), /P1B-INJECT session=s-once/g) === 1 && calls.steer.length === 1);
}

// ── ⑩b 跨 attempt 有**每会话上限**（拾遗第 3 轮 §3：实测一会话 6 条、且永久进存档）──
{
  const ctx = mk({ p1bSteerMaxPerSession: 1 });
  const { agent, calls } = mkAgent('s-quota');
  hitOnce(ctx, agent, 'a1');                 // 第 1 次注入
  await sleep(300);
  feed(ctx, agent, 'b1', A.repeat(8));       // 新 attempt 又命中 ⇒ 撞上限
  await sleep(400);
  const log = readLog();
  t('⑩b 跨 attempt · 超过 p1bSteerMaxPerSession ⇒ P1B-INJECT-QUOTA，不再注入',
    count(log, /P1B-INJECT session=s-quota/g) === 1
    && /P1B-INJECT-QUOTA session=s-quota attempt=b1 .*已注入 1\/1 次/.test(log)
    && calls.steer.length === 1,
    `INJECT=${count(log, /P1B-INJECT session=s-quota/g)} · steer=${calls.steer.length}`);
}

// ── ⑭ SKIP / 未注入 ⇒ **不出 verdict**（否则有效率分母被污染）──────────────
{
  const ctx = mk();
  const { agent } = mkAgent('s-skip', { steer: false });
  hitOnce(ctx, agent, 'a1');
  await sleep(300);
  feed(ctx, agent, 'a2', BIG);
  turnEnd(ctx, 's-skip', 1);
  await sleep(400);
  const log = readLog();
  t('⑭ 无 steer ⇒ 记 SKIP，但**不产 OBSERVE/verdict**',
    /P1B-INJECT-SKIP session=s-skip/.test(log) && !/P1B-OBSERVE session=s-skip/.test(log));
}

// ── ⑯ 观测未满 N 就 turn 结束 ⇒ **必须补一行"观察中断"**（否则成功样本静默消失）──
{
  const ctx = mk();
  const { agent } = mkAgent('s-cut');
  hitOnce(ctx, agent, 'a1');
  await sleep(300);
  feed(ctx, agent, 'a2', '短'.repeat(300));  // 只来 300 字符（< N=2000）
  turnEnd(ctx, 's-cut', 1);
  await sleep(400);
  t('⑯ 观察量不足 ⇒ P1B-OBSERVE … verdict=观察中断（有日志行，不是静默）',
    /P1B-OBSERVE session=s-cut .*segLen=300 .*verdict=观察中断/.test(readLog()));
}

// ── ⑤ p1bEnabled=false ⇒ 不注入（发布包默认值就是它）────────────────────────
{
  const ctx = mk({ p1bEnabled: false });
  const { agent, calls } = mkAgent('s-off');
  hitOnce(ctx, agent, 'a1');
  await sleep(400);
  t('⑤ p1bEnabled=false ⇒ 无 P1B-INJECT、steer 未被调用',
    !/P1B-INJECT session=s-off/.test(readLog()) && calls.steer.length === 0);
}

// ── ⑥ 预注册注入点：p1bInjectAtHit=2 ⇒ 第二次命中才注入 ─────────────────────
{
  const ctx = mk({ p1bInjectAtHit: 2 });
  const { agent, calls } = mkAgent('s-hit2');
  hitOnce(ctx, agent, 'd1');
  await sleep(300);
  const injectedAtHit1 = /P1B-INJECT session=s-hit2/.test(readLog());
  feed(ctx, agent, 'd1', A.repeat(2));       // hits=2 ⇒ 注入
  await sleep(400);
  t('⑥ p1bInjectAtHit=2 · 首次命中不注入、第二次才注入（hit=2）',
    !injectedAtHit1 && /P1B-INJECT session=s-hit2 .*hit=2 /.test(readLog()) && calls.steer.length === 1);
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
    log.match(/P1B-CAPABILITY[^\n]*/)?.[0]?.slice(0, 100) ?? '(无日志)');
  t('⑫ 能力自检 · 每会话只打一行', count(log, /P1B-CAPABILITY session=s-cap/g) === 1);
  t('⑫b 能力自检 · 说明文字里不再出现布尔字面量（防统计脚本重复计数）', !/steer=false/.test(log));
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

// ── ⑮ 自建消息必须过**回放侧四条 invariant**（拾遗第 3 轮 §1.4 的"毒化会话"风险）──
//    来源：`dsh-session/lib/index.js:928-947 assertMessageEventShape`（照抄判据，不 import dsh）。
//    ⚠️ 症状不对称：形状错**不会当场炸**（live append 不校验），要等**回放会话存档**才抛
//    ⇒ 将来 dsh 加一个必填字段，坏掉的是机主的存档，而不是插件日志。
{
  const r = await buildSteerMessage('测试提示');
  const m = r.message;
  const okShape = typeof m.id === 'string' && m.id.length > 0
    && m.role === 'user'
    && typeof m.source?.kind === 'string' && m.source.kind.length > 0
    && Array.isArray(m.content);
  const frozenDeep = Object.isFrozen(m) && Object.isFrozen(m.content)
    && Object.isFrozen(m.content[0]) && Object.isFrozen(m.source);
  t('⑮ 自建消息满足回放侧四条 invariant（id/role/source.kind/content 数组）', okShape, `via=${r.via}`);
  t('⑮b 自建消息四层深冻结（dsh 按不可变值使用）', frozenDeep);
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过`
  + (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
process.exit(bad.length ? 1 : 0);
