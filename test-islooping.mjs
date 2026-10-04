#!/usr/bin/env node
/**
 * dsh-local-loop-fuse 检测函数测试
 *
 * 目的：验证 `isLooping()` 「能判出真循环」且「不误杀正常长输出」——后者尤其重要，
 * 因为机主明确要求**保留"适当循环"**（正常 CoT 会反复推敲）。
 *
 * 用真实源码（import 插件的 isLooping），不用复刻逻辑。
 * 负样本 ⑥ 用**真实模型输出**（从会话日志提取，见调用方的 bash）。
 *
 * 用法：node tools/dsh-local-loop-fuse/test-islooping.mjs
 */
import fs from 'node:fs';
import { isLooping, DEFAULTS } from './index.js';

const cfg = DEFAULTS;
const results = [];

function t(name, text, want) {
  const got = isLooping(text, cfg);
  const ok = got === want;
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}   len=${String(text.length).padStart(6)}  want=${want}  got=${got}`);
}

// ── 构造样本 ──────────────────────────────────────────────────────────────
const para = '这是一段用来测试循环检测的重复文本，它需要足够长才能触发阈值。';

t('① 极短文本（不该触发）', '你好世界', false);
t('② 长度不足 minChars（不该触发）', para.repeat(10), false);
t('③ 病态循环：同段重复 120 次（该触发）', para.repeat(120), true);
const para2 = '另一段完全不同的说明文字，用来把上下文隔开，避免连续同源内容干扰判定。';
const para3 = '再来一段与前面都不相同的描述，作为填充，确保总长度超过检测门槛。';
t('④ 同段真出现 2 次（不该触发）',
  para.repeat(1) + para2.repeat(12) + para.repeat(1) + para3.repeat(12), false);
t('④b 模板化列表：60 个相似条目（不该触发，考验误杀）',
  Array.from({ length: 160 }, (_, i) => `第 ${i} 项：检查完成，结果正常，无需处理。`).join('\n'), false);
t('⑤ 无重复的长文本（不该触发）',
  Array.from({ length: 80 }, (_, i) => `第${i}段内容：${para}编号${i}。`).join('\n'), false);

// ── 真实样本（从会话日志提取的模型输出）──────────────────────────────────
const realPath = process.argv[2] || '/tmp/loop-fuse-sample-real.txt';
if (fs.existsSync(realPath) && fs.readFileSync(realPath,'utf8').length > 500) {
  const real = fs.readFileSync(realPath, 'utf8');
  t(`⑥ 真实模型输出（应不触发）[${real.length} 字符]`, real, false);
} else {
  console.log(`ℹ️  未找到真实样本 ${realPath} —— 跳过 ⑥`);
}

// ── 行动层（v0.4.0）单测：checkStall（「无进展」判据）─────────────────────
// ⛔ 旧判据 `maxTurnMinutes`（墙钟时长）/ `maxStepsPerTurn`（步数）**已删除**：
//    2026-10-01 实测两个正常长 turn（15.7 / 15.6 min、全程有产出）被 duration 判据误杀，
//    详见知识库 `05-issues/open/loop-fuse-kills-long-tasks.md`。**不要再加回来。**
const { checkStall } = await import('./index.js');
const NOW = 1_800_000_000_000;
const minAgo = (m) => NOW - m * 60000;

function tc(name, st, want) {
  const got = checkStall(st, cfg, NOW);
  const ok = got === want;
  results.push({ name, ok });
  const noProg = ((NOW - (st.lastProgressAt ?? st.startedAt)) / 60000).toFixed(1);
  console.log(`${ok ? '✅' : '❌'}  ${name}   noProgress=${String(noProg).padStart(5)}min `
    + `pendingTools=${st.pendingTools ?? 0}  want=${want}  got=${got}`);
}

tc('⑦ 正常 turn（3 分钟前有进展）不触发', { lastProgressAt: minAgo(3), pendingTools: 0 }, null);
tc('⑧ 【本次事故回归】批量出图跑了 25 分钟，但 30 秒前刚有 tool/result ⇒ 必须 null'
  + '（旧 duration 判据在这里误杀过）',
  { startedAt: minAgo(25), lastProgressAt: minAgo(0.5), pendingTools: 0 }, null);
tc('⑨ 停滞 11 分钟、无工具在跑 ⇒ stalled', { lastProgressAt: minAgo(11), pendingTools: 0 }, 'stalled');
tc('⑩ 恰好 10 分钟边界 ⇒ stalled（阈值 = stallMinutes）', { lastProgressAt: minAgo(10), pendingTools: 0 }, 'stalled');
tc('⑪ 长工具在跑（pendingTools=1）12 分钟 ⇒ null（长工具豁免，容忍 30 分钟级工具）',
  { lastProgressAt: minAgo(12), pendingTools: 1 }, null);
tc('⑫ 工具挂死 46 分钟 ⇒ stalled（stallMinutesWithTool=45 兜底）',
  { lastProgressAt: minAgo(46), pendingTools: 1 }, 'stalled');
tc('⑬ 企微那次循环 turn6（19 步 / 8 分钟）⇒ null —— ⚠️ 诚实记录：「反复失败重试」型循环'
  + '在无进展判据下抓不到（它有持续 tool/result）',
  { startedAt: minAgo(8), lastProgressAt: minAgo(1), pendingTools: 0, step: 19 }, null);
tc('⑭ 旧实现会误杀的场景：两个连续 15 分钟级正常 turn —— 判据只看"有没有进展"',
  { startedAt: minAgo(16), lastProgressAt: minAgo(2), pendingTools: 0 }, null);

// ── ②b 线（v0.5.0）单测：callFingerprint（同参调用连击的指纹）──────────────
const { callFingerprint } = await import('./index.js');
function tf(name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'}  ${name}${extra ? `   ${extra}` : ''}`);
}
const fpA = callFingerprint('pwsh', '{"command":"Get-ChildItem -Recurse"}');
tf('⑮ 同工具同参数 ⇒ 指纹相同（连击判据的前提）',
  fpA === callFingerprint('pwsh', '{"command":"Get-ChildItem -Recurse"}'), fpA);
tf('⑯ 参数差一个字符 ⇒ 指纹不同', fpA !== callFingerprint('pwsh', '{"command":"Get-ChildItem -RecursE"}'));
tf('⑰ 换工具同参数 ⇒ 指纹不同', fpA !== callFingerprint('read', '{"command":"Get-ChildItem -Recurse"}'));
tf('⑱ 超长参数不抛且稳定', (() => {
  const big = 'x'.repeat(200000);
  return callFingerprint('pwsh', big) === callFingerprint('pwsh', big);
})());
tf('⑲ 对象型参数也能算（不强依赖字符串）',
  callFingerprint('t', { a: 1 }) === callFingerprint('t', { a: 1 })
  && callFingerprint('t', { a: 1 }) !== callFingerprint('t', { a: 2 }));

const bad = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - bad.length}/${results.length} 通过` +
  (bad.length ? ` · 未通过：${bad.map((b) => b.name).join(' / ')}` : ' ✅'));
process.exit(bad.length ? 1 : 0);
