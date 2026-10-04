#!/usr/bin/env node
/**
 * dsh-local-loop-fuse v0.6.0 ④线「触发即 dump 样本」测试
 *
 * 覆盖：
 *   A. `redactSecrets()` —— 凭据必须被替换（否则等于把密钥抄进样本）
 *   B. `extractCycleEvidence()` —— 必须只取**判据相关的那一段**且保尾部
 *   C. 三条线真的会落样本（文本重复 / 同参连击 / 停滞），且 JSON 可解析
 *   D. **去重**：同一 (session,turn,kind) 只落一条
 *   E. **禁检索名单守卫**：在册会话**不许落盘**（否则与「清除」自相矛盾）
 *   F. **条数上限**：超过 dumpKeep 删最旧（防病态循环写爆盘）
 *   G. 总开关 dumpSamples=false ⇒ 一个文件都不写
 *
 * 用法：node test-dump.mjs        （约 8 秒，停滞场景要等 setInterval）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, DEFAULTS, redactSecrets, extractCycleEvidence } from './index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-fuse-dump-'));

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

const files = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
const readSamples = (dir) => files(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));

// ══ A. 脱敏 ═══════════════════════════════════════════════════════════
console.log('── A. redactSecrets ──');
{
  const samples = [
    ['sk-', 'key=sk-abcdefghijklmnopqrstuvwx', (s) => !s.includes('abcdefghijklmnopqrstuvwx')],
    ['Bearer', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9', (s) => !s.includes('eyJhbGciOiJIUzI1NiJ9')],
    ['JWT', 'tok=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g',
      (s) => !s.includes('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g')],
    ['password=', 'password=hunter2xyz', (s) => !s.includes('hunter2xyz')],
    ['api_key:', 'api_key: "AKIAIOSFODNN7EXAMPLE"', (s) => !s.includes('AKIAIOSFODNN7EXAMPLE')],
    ['URL token', 'https://x/y?token=abc123def456&z=1', (s) => !s.includes('abc123def456') && s.includes('z=1')],
    ['hex64', `sha=${'a1b2c3d4'.repeat(8)}`, (s) => !s.includes('a1b2c3d4a1b2c3d4')],
  ];
  for (const [label, input, ok] of samples) {
    const out = redactSecrets(input);
    check(`A.${label} 被脱敏`, ok(out), `→ ${out.slice(0, 62)}`);
  }
  // 关键反例：**不能**把普通内容一起毁掉（过度脱敏会让样本失去价值）
  const keep = '帮我看看 /mnt/models/dsh-workspace/tools/dsh-local-loop-fuse/index.js 第 123 行，'
    + '窗口 window=600、repeats=3，这段中文和路径必须原样保留。';
  check('A.负例 普通路径/中文/数字**不被**误脱敏', redactSecrets(keep) === keep);
  check('A.负例 32 位 md5（非 64）不被误脱敏',
    redactSecrets('md5=1e4ef1127a53abcd1e4ef1127a53abcd') === 'md5=1e4ef1127a53abcd1e4ef1127a53abcd');
}

// ══ B. 取证切片 ═══════════════════════════════════════════════════════
console.log('\n── B. extractCycleEvidence ──');
{
  const unit = 'U'.repeat(150) + 'M'.repeat(150);      // 300 字符、无内部重复
  // ⚠️ 构造必须**纯周期**：真实循环里"尾部窗口"本身就是重复单元的一部分。
  //    我第一版在末尾加了 `TAIL-SENTINEL`，结果尾部窗口不周期 ⇒ `first=-1`、occurrences 只有 2
  //    —— 那是**测试构造不当**，不是被测函数的缺陷（B.3 曾因此假失败）。
  const buf = unit.repeat(12);
  const ev = extractCycleEvidence(buf, { ...DEFAULTS, dumpMaxChars: 8000, window: 600, history: 4000 });
  check('B.1 取到的正文本身以重复单元结尾', ev.text.endsWith(unit), `len=${ev.text.length}`);
  check('B.2 周期被记下（=window）', ev.period === 600, `period=${ev.period}`);
  check('B.3 occurrences ≥ 3（与 isLooping 同口径）', ev.occurrences >= 3, `occurrences=${ev.occurrences}`);
  check('B.4 长度受限（dumpMaxChars 生效）', ev.text.length <= 8000, `len=${ev.text.length}`);
  check('B.5 totalLen 记录原始长度', ev.totalLen === buf.length, `${ev.totalLen}/${buf.length}`);
  check('B.5b 未截断时 truncated=false', ev.truncated === false);

  // 限长必须**保尾部**：给一个超长 buffer，验证结尾完整
  const big = unit.repeat(200) + 'END-MARK';
  const ev2 = extractCycleEvidence(big, { ...DEFAULTS, dumpMaxChars: 3000, window: 600, history: 4000 });
  check('B.6 超长输入截断后仍以真实结尾收尾', ev2.text.endsWith('END-MARK'), `len=${ev2.text.length}`);
  check('B.7 截断标记 truncated=true', ev2.truncated === true);
}

// ══ C1. 文本重复线 ════════════════════════════════════════════════════
console.log('\n── C1. 文本重复 ⇒ DUMP text-loop ──');
const DIR_TEXT = path.join(ROOT, 'text');
{
  const { ctx, fire } = mkCtx();
  const cancelled = [];
  const agent = { session: { id: 'sess-text' }, cancel(c) { cancelled.push(c); } };
  apply(ctx, {
    ...DEFAULTS,
    dumpDir: DIR_TEXT,
    logPath: path.join(ROOT, 'text.log'),
    cancelLogPath: path.join(ROOT, 'text-cancel.log'),
    textStrikesBeforeCancel: 99,      // 只观察不掐 ⇒ 验证「弱命中也 dump」
  });
  await fire('agent/request', { agent, turn: 7, signal: new AbortController().signal }, async () => ({}));

  // 单元里塞一个假密钥：验证端到端脱敏
  const unit = `这是一段用于触发重复检测的文本，key=sk-abcdefghijklmnop1234567890。${'填'.repeat(60)}\n`;
  const attemptId = 'sess-text:7';
  for (let i = 0; i < 40; i += 1) {
    fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, turn: 7, chunk: { type: 'reasoning-delta', text: unit } },
    });
  }
  // 再补一次同内容（确保跨过 minChars 且出现足够重复）
  for (let i = 0; i < 40; i += 1) {
    fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, turn: 7, chunk: { type: 'reasoning-delta', text: unit } },
    });
  }
  await sleep(900);

  const ss = readSamples(DIR_TEXT);
  check('C1.1 落了一条样本', ss.length === 1, `files=${ss.length}`);
  const r = ss[0] ?? {};
  check('C1.2 kind=text-loop', r.kind === 'text-loop', `kind=${r.kind}`);
  check('C1.3 session/turn 正确', r.session === 'sess-text' && r.turn === 7, `${r.session}#${r.turn}`);
  check('C1.4 带正文 text', typeof r.text === 'string' && r.text.length > 500, `chars=${r.chars}`);
  check('C1.5 ★端到端脱敏：假密钥不在样本里', !JSON.stringify(r).includes('abcdefghijklmnop1234567890'));
  check('C1.6 evidence 记下 period/occurrences/hits',
    r.evidence?.period === 600 && r.evidence?.occurrences >= 3 && r.evidence?.hits >= 1,
    `period=${r.evidence?.period} occ=${r.evidence?.occurrences} hits=${r.evidence?.hits}`);
  check('C1.7 acted=false（textStrikesBeforeCancel=99，属弱命中）', r.acted === false, `acted=${r.acted}`);
  check('C1.8 没有真掐断（只观察）', cancelled.length === 0);

  // D. 去重：同一 (session,turn,kind) 不该有第二条
  for (let i = 0; i < 40; i += 1) {
    fire('agent/assistant-stream', {
      agent,
      frame: { type: 'chunk', attemptId, turn: 7, chunk: { type: 'reasoning-delta', text: unit } },
    });
  }
  await sleep(600);
  check('D.1 ★去重：同一 turn 再命中多次仍只有 1 条', readSamples(DIR_TEXT).length === 1,
    `files=${readSamples(DIR_TEXT).length}`);
}

// ══ C2. 同参连击线 ════════════════════════════════════════════════════
console.log('\n── C2. 同参连击 ⇒ DUMP repeat-call ──');
const DIR_CALL = path.join(ROOT, 'call');
{
  const { ctx, fire } = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpDir: DIR_CALL,
    logPath: path.join(ROOT, 'call.log'),
    cancelLogPath: path.join(ROOT, 'call-cancel.log'),
    repeatCallLimit: 6,
    repeatCallCancel: false,          // 只记 strike ⇒ 不依赖 agentsBySession
  });
  fire('session/event', { id: 'sess-call' }, { type: 'turn/start', data: { turn: 3 } });
  for (let i = 0; i < 8; i += 1) {
    fire('session/event', { id: 'sess-call' }, {
      type: 'tool/call',
      data: { turn: 3, step: i, name: 'Bash', arguments: { command: 'Get-ChildItem -Recurse pwsh-5*', token: 'abc123def456' } },
    });
  }
  await sleep(900);
  const ss = readSamples(DIR_CALL);
  check('C2.1 落了一条样本', ss.length === 1, `files=${ss.length}`);
  const r = ss[0] ?? {};
  check('C2.2 kind=repeat-call', r.kind === 'repeat-call', `kind=${r.kind}`);
  check('C2.3 记下工具名与连击次数',
    r.evidence?.tool === 'Bash' && r.evidence?.consecutive >= 6, `${r.evidence?.tool} ×${r.evidence?.consecutive}`);
  check('C2.4 记下 arguments 原文（供复现）',
    typeof r.arguments === 'string' && r.arguments.includes('Get-ChildItem'), (r.arguments ?? '').slice(0, 48));
  check('C2.5 arguments 里的 token 也被脱敏', !JSON.stringify(r).includes('abc123def456'));
  check('C2.6 acted=false（repeatCallCancel=false ⇒ 只记 strike）', r.acted === false);
}

// ══ C3. 停滞线 ════════════════════════════════════════════════════════
console.log('\n── C3. 停滞 ⇒ DUMP stalled（要等 5 s 扫描） ──');
const DIR_STALL = path.join(ROOT, 'stall');
{
  const { ctx, fire } = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpDir: DIR_STALL,
    logPath: path.join(ROOT, 'stall.log'),
    cancelLogPath: path.join(ROOT, 'stall-cancel.log'),
    stallMinutes: 0, stallMinutesWithTool: 0,
    watchIntervalSec: 5, strikesBeforeCancel: 9,
  });
  fire('session/event', { id: 'sess-stall' }, { type: 'turn/start', data: { turn: 5 } });
  fire('session/event', { id: 'sess-stall' }, { type: 'step/start', data: { turn: 5, step: 2 } });
  await sleep(6200);
  const ss = readSamples(DIR_STALL);
  check('C3.1 落了一条样本', ss.length === 1, `files=${ss.length}`);
  const r = ss[0] ?? {};
  check('C3.2 kind=stalled', r.kind === 'stalled', `kind=${r.kind}`);
  check('C3.3 停滞线不 dump 正文（它本来就没有正文）', r.text === undefined);
  check('C3.4 记下 noProgressMin / pendingTools / limitUsedMin',
    r.evidence?.pendingTools === 0 && r.evidence?.limitUsedMin === 0 && typeof r.evidence?.noProgressMin === 'number',
    `noProgress=${r.evidence?.noProgressMin}min limit=${r.evidence?.limitUsedMin}`);
}

// ══ E. 禁检索名单守卫 ═════════════════════════════════════════════════
console.log('\n── E. 禁检索名单守卫 ──');
const DIR_DENY = path.join(ROOT, 'deny');
{
  const denyPath = path.join(ROOT, 'denylist.json');
  fs.writeFileSync(denyPath, JSON.stringify({ sessions: { 'sess-banned': { label: '测试' } } }));
  const { ctx, fire } = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpDir: DIR_DENY,
    dumpDenylistPath: denyPath,
    logPath: path.join(ROOT, 'deny.log'),
    cancelLogPath: path.join(ROOT, 'deny-cancel.log'),
    repeatCallLimit: 6, repeatCallCancel: false,
  });
  fire('session/event', { id: 'sess-banned' }, { type: 'turn/start', data: { turn: 1 } });
  for (let i = 0; i < 8; i += 1) {
    fire('session/event', { id: 'sess-banned' }, {
      type: 'tool/call', data: { turn: 1, step: i, name: 'Bash', arguments: { command: 'ls' } },
    });
  }
  await sleep(900);
  check('E.1 ★在册会话**不落盘**（与「清除」一致）', readSamples(DIR_DENY).length === 0,
    `files=${readSamples(DIR_DENY).length}`);
  const lg = fs.existsSync(path.join(ROOT, 'deny.log')) ? fs.readFileSync(path.join(ROOT, 'deny.log'), 'utf8') : '';
  check('E.2 日志里有 DUMP-SKIP 记录（可审计）', lg.includes('DUMP-SKIP'), lg.split('\n').filter((l) => l.includes('DUMP')).slice(-1)[0]?.slice(0, 90) ?? '');
}

// ══ F. 条数上限 ═══════════════════════════════════════════════════════
console.log('\n── F. dumpKeep 条数上限 ──');
const DIR_KEEP = path.join(ROOT, 'keep');
{
  const { ctx, fire } = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpDir: DIR_KEEP, dumpKeep: 2,
    logPath: path.join(ROOT, 'keep.log'),
    cancelLogPath: path.join(ROOT, 'keep-cancel.log'),
    repeatCallLimit: 6, repeatCallCancel: false,
  });
  for (let turn = 1; turn <= 4; turn += 1) {
    fire('session/event', { id: 'sess-keep' }, { type: 'turn/start', data: { turn } });
    for (let i = 0; i < 8; i += 1) {
      fire('session/event', { id: 'sess-keep' }, {
        type: 'tool/call', data: { turn, step: i, name: 'Bash', arguments: { command: 'ls' } },
      });
    }
    await sleep(320);
  }
  await sleep(700);
  const n = readSamples(DIR_KEEP).length;
  check('F.1 ★超过 dumpKeep 后只留最新 2 条', n === 2, `files=${n}`);
  const turns = readSamples(DIR_KEEP).map((r) => r.turn).sort();
  check('F.2 留下的是**最新**的两个 turn', JSON.stringify(turns) === JSON.stringify([3, 4]), `turns=${turns}`);
}

// ══ G. 总开关 ═════════════════════════════════════════════════════════
console.log('\n── G. dumpSamples=false 总开关 ──');
const DIR_OFF = path.join(ROOT, 'off');
{
  const { ctx, fire } = mkCtx();
  apply(ctx, {
    ...DEFAULTS,
    dumpSamples: false,
    dumpDir: DIR_OFF,
    logPath: path.join(ROOT, 'off.log'),
    cancelLogPath: path.join(ROOT, 'off-cancel.log'),
    repeatCallLimit: 6, repeatCallCancel: false,
  });
  fire('session/event', { id: 'sess-off' }, { type: 'turn/start', data: { turn: 1 } });
  for (let i = 0; i < 8; i += 1) {
    fire('session/event', { id: 'sess-off' }, {
      type: 'tool/call', data: { turn: 1, step: i, name: 'Bash', arguments: { command: 'ls' } },
    });
  }
  await sleep(700);
  check('G.1 ★总开关关闭时一个文件都不写', readSamples(DIR_OFF).length === 0);
  check('G.2 目录也没被创建', !fs.existsSync(DIR_OFF));
}

// ══ 汇总 ══════════════════════════════════════════════════════════════
const bad = results.filter((r) => !r.ok);
console.log(`\n${bad.length === 0 ? '✅ 全部通过' : `❌ ${bad.length} 项失败`}  `
  + `（${results.length - bad.length}/${results.length}）`);
if (bad.length) { for (const b of bad) console.log(`   ❌ ${b.name}`); }
console.log(`样本目录（临时）：${ROOT}`);
console.log('ℹ️  真机样本落在 tools/dsh-local-loop-fuse/samples/ —— 用 promote-sample.sh 提升为回归夹具');
process.exit(bad.length === 0 ? 0 : 1);
