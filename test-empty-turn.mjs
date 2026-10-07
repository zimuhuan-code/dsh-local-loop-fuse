#!/usr/bin/env node
/**
 * test-empty-turn.mjs —— ⑤线「零正文 turn」判据与集成测试（v0.8.0，2026-10-04）
 *
 * 为什么写它：2026-10-04 17:33 生产 1.5 实录两轮「只产出 reasoning、正文一个字没有」
 *   （`session-4fa3d` turn 81/82，`seq 3407/3418`），**现有三条线全都没响**，
 *   用户只能人工喊停。判据本身很硬，但有以下易错点，不测就发现不了：
 *     ① **必须等 turn 收口**才判 —— 一个 turn 有多个 step，中途"只有思考"是正常的；
 *     ② **工具轮不是零正文** —— 只含 `tool-call` 的消息不该命中（否则每个工具轮都误报）；
 *     ③ **空 turn 不是零正文** —— 用户刚发出就取消（一条 assistant 消息都没有）时不能命中；
 *     ④ 判别式**不能依赖 usage**（有些 provider 不给）⇒ 主判据是**块结构**，usage 只作证据。
 *
 * 用法：node test-empty-turn.mjs   （约 1 秒，不依赖 dsh、不起网络）
 */
import { tmpdir } from 'node:os';
import fs from 'node:fs';
import { apply, DEFAULTS, isEmptyTurn, classifyAssistantBlocks } from './index.js';

const results = [];
const t = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}${extra ? `   ${extra}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 纯函数：块分类 ────────────────────────────────────────────────────────
t('① 纯函数 · reasoning + text ⇒ text=true',
  classifyAssistantBlocks([{ type: 'reasoning' }, { type: 'text', text: '结论' }]).text === true);
t('② 纯函数 · 只有 tool-call ⇒ tool=true, text=false',
  (() => { const c = classifyAssistantBlocks([{ type: 'reasoning' }, { type: 'tool-call', name: 'bash' }]);
    return c.tool === true && c.text === false; })());
t('③ 纯函数 · 空文本块不算正文（"text" 但内容空白）',
  classifyAssistantBlocks([{ type: 'text', text: '   \n ' }]).text === false);
t('④ 纯函数 · tool_use / function_call 两种别名都认',
  classifyAssistantBlocks([{ type: 'tool_use' }]).tool === true
  && classifyAssistantBlocks([{ type: 'function_call' }]).tool === true);
t('⑤ 纯函数 · 非数组/畸形输入不抛',
  (() => { try { classifyAssistantBlocks(undefined); classifyAssistantBlocks('x');
    classifyAssistantBlocks([null, 3, 'y']); return true; } catch { return false; } })());

// ── 纯函数：零正文判据 ────────────────────────────────────────────────────
t('⑥ 判据 · 只有 reasoning ⇒ 零正文=true',
  isEmptyTurn({ sawText: false, sawTool: false, reasoningOnlyCount: 1 }) === true);
t('⑦ 判据 · 有正文 ⇒ false',
  isEmptyTurn({ sawText: true, sawTool: false, reasoningOnlyCount: 1 }) === false);
t('⑧ 判据 · 工具轮（sawTool）⇒ false',
  isEmptyTurn({ sawText: false, sawTool: true, reasoningOnlyCount: 1 }) === false);
t('⑨ 判据 · 空 turn（一条消息都没有）⇒ false ← 用户取消不算',
  isEmptyTurn({ sawText: false, sawTool: false, reasoningOnlyCount: 0 }) === false);
t('⑩ 判据 · 多 step：某步零正文但后来补了正文 ⇒ false',
  isEmptyTurn({ sawText: true, sawTool: false, reasoningOnlyCount: 2 }) === false);
t('⑪ 判据 · st 为 undefined 不抛',
  isEmptyTurn(undefined) === false);

// ── 集成：驱动真实 apply()，看日志行 ──────────────────────────────────────
function mkCtx() {
  const h = new Map();
  return {
    on(evt, fn) { if (!h.has(evt)) h.set(evt, []); h.get(evt).push(fn); },
    fire(evt, ...args) { return (h.get(evt) ?? []).map((f) => f(...args)); },
  };
}

const LOG = `${tmpdir()}/loop-fuse-empty-turn-test.log`;
const mk = (over = {}) => {
  try { fs.rmSync(LOG, { force: true }); } catch { /* ignore */ }
  const ctx = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpSamples: false,        // ⚠️ 测试不许写进真 samples/（v0.6.0 守卫）
    watchIntervalSec: 3600,
    logPath: LOG,
    ...over,
  });
  return ctx;
};
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch { return ''; } };

const REASON = { type: 'reasoning', text: '让我想想……' };
const TEXT = { type: 'text', text: '结论如下。' };

/** 走一个完整 turn：start → assistant/message → end */
function playTurn(ctx, sid, turn, blocks, usage) {
  ctx.fire('session/event', { id: sid }, { type: 'turn/start', data: { turn, step: 0 } });
  ctx.fire('session/event', { id: sid }, {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: blocks }, usage },
  });
  ctx.fire('session/event', { id: sid }, { type: 'turn/end', data: { turn } });
}

/** 真实夹具：turn 81 的原样结构（seq 3407）—— 只有 reasoning，output==reasoning==3706 */
const REAL_EMPTY_USAGE = { inputTokens: 753, outputTokens: 3706, reasoningTokens: 3706, cacheReadTokens: 339840 };

{
  const ctx = mk();
  playTurn(ctx, 'sess-empty', 1, [REASON], REAL_EMPTY_USAGE);
  await sleep(400);
  const log = readLog();
  t('⑫ 集成 · 真实夹具（turn81 结构）⇒ 记 EMPTY-TURN', /EMPTY-TURN session=sess-empty turn=1/.test(log),
    log.match(/EMPTY-TURN[^\n]*/)?.[0]?.slice(0, 90) ?? '(无日志)');
}

{
  const ctx = mk();
  playTurn(ctx, 'sess-ok', 1, [REASON, TEXT], { outputTokens: 2167, reasoningTokens: 1960 });
  playTurn(ctx, 'sess-ok', 2, [REASON], REAL_EMPTY_USAGE);   // 之后来一轮零正文
  await sleep(400);
  const log = readLog();
  t('⑬ 集成 · 前面有正常 turn ≠ 命中（本 turn 自己才判）',
    /EMPTY-TURN session=sess-ok turn=2/.test(log) && !/EMPTY-TURN session=sess-ok turn=1/.test(log));
}

{
  const ctx = mk();
  ctx.fire('session/event', { id: 'sess-tool' }, { type: 'turn/start', data: { turn: 1, step: 0 } });
  ctx.fire('session/event', { id: 'sess-tool' }, {
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [REASON, { type: 'tool-call', name: 'bash', arguments: '{}' }] },
      usage: { outputTokens: 500, reasoningTokens: 400 },
    },
  });
  ctx.fire('session/event', { id: 'sess-tool' }, { type: 'turn/end', data: { turn: 1 } });
  await sleep(400);
  t('⑭ 集成 · 工具轮（含 tool-call）不误报', !/EMPTY-TURN session=sess-tool/.test(readLog()));
}

{
  const ctx = mk();
  ctx.fire('session/event', { id: 'sess-cancel' }, { type: 'turn/start', data: { turn: 1, step: 0 } });
  ctx.fire('session/event', { id: 'sess-cancel' }, { type: 'turn/end', data: { turn: 1 } });  // 用户秒取消
  await sleep(400);
  t('⑮ 集成 · 空 turn（用户刚发出就取消）不误报', !/EMPTY-TURN session=sess-cancel/.test(readLog()));
}

{
  const ctx = mk({ emptyTurnLimit: 2 });
  playTurn(ctx, 'sess-2', 1, [REASON], REAL_EMPTY_USAGE);
  await sleep(300);
  const first = readLog();
  t('⑯ 集成 · limit=2 时第一次只记 PENDING（不上膛）',
    /EMPTY-TURN-PENDING session=sess-2 turn=1 streak=1\/2/.test(first) && !/^.*EMPTY-TURN session=sess-2/m.test(first.replace(/EMPTY-TURN-PENDING[^\n]*/g, '')));
  playTurn(ctx, 'sess-2', 2, [REASON], REAL_EMPTY_USAGE);
  await sleep(400);
  t('⑰ 集成 · limit=2 时第二次才真命中',
    /EMPTY-TURN session=sess-2 turn=2 streak=2\/2/.test(readLog()));
}

{
  const ctx = mk({ emptyTurnLimit: 2 });
  playTurn(ctx, 'sess-3', 1, [REASON], REAL_EMPTY_USAGE);      // 零正文
  playTurn(ctx, 'sess-3', 2, [REASON, TEXT], {});              // 正常 ⇒ 断链
  playTurn(ctx, 'sess-3', 3, [REASON], REAL_EMPTY_USAGE);      // 又零正文（streak 应回到 1）
  await sleep(400);
  const log = readLog();
  t('⑱ 集成 · 中间有正常 turn ⇒ 连续计数归零（streak=1/2，不误报）',
    /EMPTY-TURN-PENDING session=sess-3 turn=3 streak=1\/2/.test(log)
    && !/EMPTY-TURN session=sess-3 turn=3 streak=2/.test(log));
}

{
  // 上膛路径：steer 需要 dsh 内部包（link 插件可能 import 不到）⇒ 这里只断言
  // 「不会因为没有 steer 能力而抛/影响其它线」：动作仍记为命中，并留下 SKIP 说明。
  const ctx = mk({ emptyTurnAction: 'steer', emptyTurnSteerMax: 1 });
  playTurn(ctx, 'sess-steer', 1, [REASON], REAL_EMPTY_USAGE);
  await sleep(700);
  const log = readLog();
  t('⑲ 上膛路径 · 无论 import 成败都不抛，且留下可诊断的一行',
    /EMPTY-TURN session=sess-steer turn=1 .*action=steer/.test(log)
    && /(EMPTY-TURN-STEER-SKIP|EMPTY-TURN-STEER-FAIL|EMPTY-TURN-STEER) session=sess-steer/.test(log));
}

{
  // ⑤ 线**会话终身硬顶**（与 ①c 同款）：episode 额度还很大，但终身额度已用完 ⇒ 必须 SKIP
  const ctx = mk({ emptyTurnAction: 'steer', emptyTurnSteerMax: 99, emptyTurnSteerMaxSessionHard: 1 });
  // ⚠️ ⑤ 线的补救走 `agentsBySession`（不是随便找 agent）⇒ 本文件其余用例只发 session/event，
  //    所以"拿不到 Agent"分支会先命中、lifetime 根本不会增长。这里显式注册一个假 agent（照 test-p1b 做法）。
  const agent05 = { session: { id: 's-hard05' }, inbox: {}, cancel() {}, steer() {} };
  await Promise.all(ctx.fire('agent/request',
    { agent: agent05, turn: 1, signal: new AbortController().signal }, async () => ({})));
  playTurn(ctx, 's-hard05', 1, [REASON], REAL_EMPTY_USAGE);   // 第 1 次补救（lifetime 1/1）
  await sleep(700);
  playTurn(ctx, 's-hard05', 2, [REASON], REAL_EMPTY_USAGE);   // 撞终身硬顶
  await sleep(700);
  const log = readLog();
  t('⑳ ⑤ 线会话终身硬顶：episode 还有额度也用完 ⇒ SKIP 带 lifetime 1/1',
    /EMPTY-TURN-STEER-SKIP session=s-hard05 .*lifetime 1\/1/.test(log),
    log.match(/EMPTY-TURN-STEER-SKIP[^\n]*/)?.[0]?.slice(0, 110) ?? '(无日志)');
}

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过`
  + (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
process.exit(bad.length ? 1 : 0);
