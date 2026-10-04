/**
 * dsh-local-loop-fuse（原名 dsh-loop-guard）—— DSH 输出/思考循环护栏
 *
 * v0.1（观测优先）：监听 `agent/assistant-stream`，对 reasoning/text 增量做**字符级重复**检测。
 * v0.2（2026-09-29）：增加**行动层**检测 —— 按 turn 的「持续时长 / step 数」判定"卡住"。
 * v0.3.3（2026-09-29）：修 ① 线"检测有效但掐不死"（turn 索引错 + AbortSignal 没有 abort 方法）
 *   ⇒ ① 线改走官方原语 `Agent.cancel({kind:'hook',reason},{keepInbox})`。
 * v0.4.0（2026-10-01）：**行动层判据重写 + 弱信号与强动作解耦 + cancel 参数修正**。
 * v0.5.0（2026-10-02）：新增 **②b 线「同参调用连击」** —— 2026-10-02 桌面版实录：本地 27B 找不到
 *   后台 job 的输出 ⇒ 同一条 `Get-ChildItem -Recurse … pwsh-5*` **连调 21 次**（每次 `(no output)`），
 *   DSH 内置重复检测警告到 5/8 次也没用；而 ②线"无进展"判据**抓不到它**（每次调用都算"有进展"）。
 *   ⇒ 对 `tool/call` 的 `name+arguments` 指纹计数，**连续 `repeatCallLimit`(6) 次完全相同 ⇒ 直接 cancel**；
 *   `job_output`/`job_list` 等**合法轮询工具豁免**（等后台任务时本就连调同参）。
 * v0.6.0（2026-10-03）：新增 **④ 线「触发即 dump 样本」** —— 三条线每次判中（含**只记 strike 未掐断**的
 *   弱命中）都把证据落一条样本到 `samples/`，供**离线回归**与**阈值调参**使用。
 *   起因：想用真实污染样本验证 `tools/loop-detect.py` 时，发现当初的污染会话**正文已不可逆清除**，
 *   真实夹具**永远拿不到了** ⇒ 唯一出路是**让判中的那一刻自己把样本存下来**。
 *   ⚠️ 三条自保约束（否则等于把刚判为有问题的内容又抄一份落盘，与「清除」自相矛盾）：
 *     ① **脱敏**（`redactSecrets`：api key / Bearer / JWT / password= / 64 位 hex）；
 *     ② **限长**（`dumpMaxChars`，只留判据窗口及附近，不dump整段输出）；
 *     ③ **禁检索名单内不落盘**（`dumpDenylistPath`：机主明确标记过的会话一律跳过）。
 *   另加 `dumpKeep` 条数上限（防病态循环写爆盘）与 (session,turn,kind) 去重（防同一 turn 反复写）。
 *
 * ── v0.4.0 为什么推倒重来（2026-10-01 实录，详见知识库
 *    `05-issues/open/loop-fuse-kills-long-tasks.md`）────────────────────
 * 2026-10-01 晚，生产 1.5 跑 ComfyUI 基准测试：两个 turn（15.7 min / 15.6 min）**全程在推进**
 * （每张图都落盘、每步都有 `tool/result`），却被判「duration」凑够 2 个 strike ⇒
 * `agent.cancel({kind:'user'})` **掐断了正常任务、还清空了排队消息**。
 * ⇒ 结论：**"墙钟时长"是"卡住"的错误代理量**。那次企微循环的真特征是"反复失败重试"，
 *    时长只是它的影子；用它当判据 ⇒ 一切正常长任务（批量出图 / 视频 / 入库 / 备份）都会命中。
 *
 * v0.4.0 的三条改动：
 *   A. **②线改「无进展」判据**：用 `step/*`、`tool/*`、`assistant/message`、流式增量刷新
 *      `lastProgressAt`；**只有连续 `stallMinutes` 分钟零进展**才记 strike。
 *      另加"长工具豁免"：有未返回的 `tool/call` 时改用 `stallMinutesWithTool`（更长），
 *      既能容忍 30 分钟级的长工具，又能兜住"工具挂死"。
 *      ⚠️ **旧判据 `maxTurnMinutes` / `maxStepsPerTurn` 已删除**（被实测证伪，不再使用）。
 *   B. **弱信号不再直接进 cancel 池**：③线的 strike 只统计**强信号** ——
 *      ① 线文本重复命中（跨 attempt 累计）+ ② 线真停滞；两者各自也有去抖。
 *      （旧实现是"弱信号（时长）→ 强动作（cancel）"，本次拆开。）
 *   C. **③线 cancel 参数与①线对齐**：`{kind:'hook', reason}` + `{keepInbox:true}`，
 *      并追加写 `cancelLogPath`（独立切断日志）—— 旧实现用 `{kind:'user'}`（日志里与
 *      "用户手动取消"同类，复盘会误记）且不传 keepInbox ⇒ 清空用户排队消息。
 *
 * ⚠️ 已知边界（诚实标注）：
 *   1. 「反复失败重试」型行动层循环（企微那次 6 次 curl 全败仍重试）**抓不到** ——
 *      它有持续 `tool/result` ⇒ 在"无进展"判据下永远算"有进展"。当初试过的
 *      「同指纹连击 / 连续失败结果」两个判据都**无区分度**（正常会话 max=52 连击、
 *      实测连续失败仅 1 次），故不采用。
 *   2. 工具**永久挂死**时：靠 `stallMinutesWithTool`（默认 45 min）兜底。
 *   3. ②线判据只认「零事件」。若某个工具每 9 分钟返回一次垃圾结果，判据不会命中。
 *
 * 安装：`dsh plugin --profile web add link:/mnt/models/dsh-workspace/tools/dsh-local-loop-fuse`
 * 改代码后必须重启 dsh（`link:` + ESM 缓存，hot-applied ≠ 换掉代码）。
 */

export const name = 'dsh-local-loop-fuse';
export const inject = [];

/** 默认阈值：刻意宽松（宁漏报不误杀 —— 机主 2026-09-28 定的原则） */
export const DEFAULTS = {
  enabled: true,
  // ⚠️ 2026-09-29 夜 **机主决定上膛**（此前 dryRun 观测期已攒到真实样本：12:15 企微 1 条 +
  //    19:58 本会话 6 条命中，hits 1→6、len 1.95万→2.28万字符；另有 5.7 万字符正常输出不误杀对照）。
  //    上膛后 ① 线命中即 `agent.cancel({kind:'hook',reason},{keepInbox:true})` 掐断当前 turn。
  //    想回到观测模式：把这里改回 true + 重启 dsh。
  dryRun: false,     // false = 命中即掐断；true = 只记日志
  // ── ① 文本重复层（v0.1，信号强）──────────────────────────────
  minChars: 2000,    // 累计输出达此长度才启动检测（保护正常短回答）。
                     // ⚠️ 2026-09-30 实测：**不要抬高它** —— 抬到 5000 会让 4000 字符以内的真循环逃检；
                     //    降敏的主杠杆是 window，不是 minChars。
  window: 600,       // 比对用的特征窗口（字符）。2026-09-30 降敏：300→600。
                     //    实测三档：600 ✅（误杀样本不命中 + 2010/5025 字符真循环仍命中）；
                     //    800 ❌（2010 字符的真循环漏检）；300 ❌（把"长思考里反复引用同一段配置"误判成循环）。
  history: 4000,     // 回溯范围（字符）
  repeats: 3,        // 同一窗口在回溯范围内出现 ≥ repeats 次 ⇒ 判定循环（保持 3：再抬高会漏短循环）
  textStrikesBeforeCancel: 2, // ① 线：**命中达此次数才掐断**（2026-09-30 新增；此前首次命中即掐）
  checkEvery: 200,   // 每新增这么多字符检查一次
  signalMaxAgeMinutes: 10, // 保存的 AbortSignal 超过此时长视为陈旧 ⇒ 不 abort（防御性，见 v0.3.3）
  // ── ① 线的"真掐断"路径（v0.3.3 修）────────────────────────────
  // ⚠️ 实测（Node 22）：`AbortSignal` 实例上**没有 `abort` 方法**（`typeof sig.abort === 'undefined'`），
  //    只有 `AbortController` 能 abort；而 `agent/request` payload 只给 `signal`、不给 controller
  //    （dsh-agent 类型：`{agent, turn, step, signal: AbortSignal}`）⇒ **`signal.abort()` 此路不通**。
  //    官方可用的中止原语是 `Agent.cancel(cause, options)`（dsh-agent-loop 里 `phase.abort.abort(cause)`，
  //    abort 的正是同一个 turn signal），所以主路径走它。
  abortViaCancel: true,      // 真掐断 = agent.cancel({kind:'hook',reason})（推荐保持 true）
  cancelKeepInbox: true,     // 掐断时**保留排队消息** —— 只终止这场跑飞的 turn，不牵连用户排队输入
  // ── ② 行动层（v0.4.0 **重写：无进展判据**）────────────────────
  // ⛔ 已删除并被证伪的旧判据：`maxTurnMinutes`（墙钟时长）、`maxStepsPerTurn`（步数）。
  //    2026-10-01 实测：两个正常长 turn（15.7 / 15.6 min，全程有产出）被判 duration ⇒
  //    误杀 + 清空排队消息。**不要再把它们加回来。**
  stallMinutes: 10,  // 连续**没有任何进展事件**达此分钟数 ⇒ 判停滞（进 cancel 池）
  stallMinutesWithTool: 45, // 有未返回的 tool/call 在跑时，用这个更长的线兜底（容忍长工具 + 抓挂死）
  progressEvents: [  // 视为"有进展"的会话事件（见 dsh-session 的 SessionEventMap）
    'step/start', 'step/end', 'tool/call', 'tool/result',
    'assistant/message', 'assistant/attempt',
  ],
  watchIntervalSec: 60,   // 定时扫描间隔（秒）
  // ── ②b 同参调用连击（v0.5.0 新增）────────────────────────────
  // 2026-10-02 桌面版实录：本地 27B 找不到后台 job 的输出 ⇒ 同一条
  //   `Get-ChildItem -Recurse … pwsh-5*` **连调 21 次**（每次 `(no output)`），
  //   DSH 内置的"重复工具调用检测"警告到 5 次、8 次都没用；
  //   而"无进展"判据**抓不到它**（每次调用都算"有进展"）⇒ 需要指纹级判据。
  repeatCallLimit: 6,        // 连续 N 次 (tool + arguments) 完全相同 ⇒ 判循环
  repeatCallCancel: true,    // true = 立即掐；false = 只记 strike，交给③线累计
  repeatCallExemptTools: ['job_output', 'job_list'], // 合法轮询豁免（等后台任务时会连调同参）
  // ── ③ 累积止损（v0.3；v0.4.0 起**只收强信号**）────────────────
  strikesBeforeCancel: 2, // 同一会话**窗口内** strike 达此数 ⇒ agent.cancel() 中止当前 turn
  strikeWindowMinutes: 120, // strike 时效窗口：超过此时长的旧 strike 不计入（=「近期反复」语义）
  cancelOnStrikes: true,  // false = 只记 CANCEL-DRY，不真切断（试阈值时用）
  logPath: '/mnt/models/dsh-workspace/.tmp/loop-fuse.log',
  cancelLogPath: '/mnt/models/dsh-workspace/.tmp/loop-fuse-cancels.log',
  // ── ④ 触发即 dump 样本（v0.6.0 新增）────────────────────────────
  // 目的：把"判中的那一刻"存成**可离线复跑的样本**。三条线都 dump（包括**只记 strike、没掐断**的
  //   弱命中 —— 那些正是**误杀候选**，对调参比真循环更值钱）。
  // ⚠️ 落盘前必须过三道闸，否则就是"把判为污染的内容又抄一份"：
  //   · dumpRedact   —— 脱敏（api key / Bearer / JWT / password= / 64 位 hex）
  //   · dumpMaxChars —— 限长（只留判据窗口及附近；不是 dump 整段输出）
  //   · dumpDenylistPath —— 会话在**禁检索名单**内 ⇒ **不落盘**（机主标记过的内容不进样本）
  // 落点放在插件自己的 `samples/`（**在工作区 tools/ 下 ⇒ 进每日备份**；不放 `.tmp/`，
  //   因为 `.tmp/` 被备份排除、样本是证据不该丢）。
  dumpSamples: true,          // 总开关（false = 完全不落盘）
  dumpDir: '/mnt/models/dsh-workspace/tools/dsh-local-loop-fuse/samples',
  dumpMaxChars: 8000,         // 单条样本正文上限（字符）
  dumpKeep: 30,               // 目录内最多保留多少条（超出按时间删最旧）
  dumpRedact: true,           // 脱敏（⚠️ 除非明确知道自己在干什么，否则不要关）
  // ⚠️ 必须按**本实例的 home** 解析，不能硬编码：1.5 与 2.0 各有独立 home，
  //    硬编码会让 2.0 去读 1.5 的名单（2026-10-03 实测：2.0 加载行打印的是 1.5 的路径）。
  //    当前 2.0 尚无名单文件 ⇒ 影响为 0，但语义错：在 2.0 上屏蔽的会话不会被 dump 跳过。
  dumpDenylistPath: `${process.env.DSH_HOME ?? '/mnt/models/dsh-home'}`
    + '/storages/recall-denylist.json',
};

// ─────────────────────────────────────────────────────────────────────
// 纯函数区（可单测，见 test-islooping.mjs）
// ─────────────────────────────────────────────────────────────────────

/** 文本重复检测（v0.1） */
export function isLooping(buf, cfg) {
  if (buf.length < cfg.minChars) return false;
  const w = Math.min(cfg.window, Math.floor(buf.length / 2));
  if (w < 40) return false;
  const tail = buf.slice(-w);
  const histEnd = buf.length - w;
  const histStart = Math.max(0, histEnd - cfg.history);
  const hist = buf.slice(histStart, histEnd);
  // ⚠️ 只计「不重叠」的命中：一片连续的低熵文本（如 500 个相同字符）不算多次重复。
  //    2026-09-29 版测试发现原实现会把这类文本误判为循环。
  let n = 0;
  let last = -Infinity;
  let idx = hist.indexOf(tail);
  while (idx !== -1) {
    if (idx - last >= w) {                     // 与上次命中至少相隔一个窗口宽
      n += 1;
      last = idx;
      if (n >= cfg.repeats - 1) return true;   // tail 自身算 1 次
    }
    idx = hist.indexOf(tail, idx + 1);
  }
  return false;
}

/**
 * 行动层判定（v0.4.0）—— 返回 'stalled' | null
 *
 * 判据 = **无进展**（不再看墙钟时长/步数）：
 *   - 有未返回的 `tool/call`（pendingTools > 0）⇒ 用 `stallMinutesWithTool`（长工具豁免）
 *   - 否则用 `stallMinutes`
 *
 * @param {{lastProgressAt?:number, startedAt?:number, pendingTools?:number}} st 该 turn 的状态
 * @param {object} cfg 阈值
 * @param {number} nowMs 当前时间（注入以便测试）
 */
export function checkStall(st, cfg, nowMs) {
  if (!st) return null;
  const base = st.lastProgressAt ?? st.startedAt ?? nowMs;
  const busy = (st.pendingTools ?? 0) > 0;
  const limitMin = busy
    ? (cfg.stallMinutesWithTool ?? 45)
    : (cfg.stallMinutes ?? 10);
  return nowMs - base >= limitMin * 60000 ? 'stalled' : null;
}

/**
 * 从 `attemptId` 提取 turn（形如 `session-xxx:17`）—— v0.3.3 新增。
 * `agent/assistant-stream` 的 frame **没有 `turn` 字段**（这正是原 abort 失效的根因），
 * 日志里要显示 turn 只能这么取。
 */
export function turnOfAttempt(attemptId) {
  const s = String(attemptId ?? '');
  const i = s.lastIndexOf(':');
  return i >= 0 && i < s.length - 1 ? s.slice(i + 1) : undefined;
}

/**
 * 工具调用指纹（v0.5.0）—— `name + 参数原文` 的轻量哈希（djb2）+ 长度。
 * 用途：识别「完全相同的工具调用」连击（本地小模型找不到东西时会反复重试同一条命令）。
 * 用纯字符串哈希而非 node:crypto，避免在同步事件处理器里引入异步。
 */
export function callFingerprint(name, args) {
  const s = `${name ?? ''}\u0000${typeof args === 'string' ? args : JSON.stringify(args ?? '')}`;
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(16)}-${s.length}`;
}

// ─────────────────────────────────────────────────────────────────────
// v0.6.0 ④线：样本脱敏与取证（纯函数，可单测）
// ─────────────────────────────────────────────────────────────────────

/** 敏感串模式表（顺序有意义：具体形态在通用 `token=` 之前，免得被先吃掉）。
 *  ⚠️ 刻意**保守**：只认高置信度的凭据形态。过度脱敏会把样本毁掉（样本的价值就在原文细节），
 *  所以**不**去模糊"长路径""长中文"，只打真凭据。 */
const SECRET_PATTERNS = [
  [/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-<redacted>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g, '<redacted-token>'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '<redacted-token>'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 <redacted>'],
  [/([?&](?:token|key|api[_-]?key|apikey|access[_-]?token|secret|password)=)[^&\s"']+/gi, '$1<redacted>'],
  // ⚠️ 值字符类**必须排除 `&<>`**：否则第一轮把 `?token=abc&z=1` 变成 `?token=<redacted>&z=1` 后，
  //    这一轮会把 `<redacted>&z=1` 整个当值吃掉（实测踩到：URL 的其余参数被误删）。
  //    键允许可选闭引号，才能认 `{"token":"…"}` 这种 JSON 形态。
  [/((?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}"'&<>]+)/gi, '$1<redacted>'],
  [/\b[A-Fa-f0-9]{64}\b/g, '<redacted-hex64>'],
];

/** 脱敏：把高置信度凭据换成占位符。返回新串（不改入参）。 */
export function redactSecrets(text) {
  let s = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

/**
 * 从一个"判定为循环"的缓冲区里**只取判据相关的那一段**（v0.6.0）。
 *
 * 为什么不 dump 整段：① 可能几十万字符；② 判据只看"窗口在 history 内重复 ≥repeats 次"，
 * 把无关上下文一起搬走既不必要、也扩大了落盘面。
 *
 * 取法：从**回溯范围内第一次出现的重复单元**开始，取到结尾，再按 `dumpMaxChars` 截断
 * （截断保留**尾部** —— 尾部才是判据窗口所在）。
 *
 * @returns {{text:string, period:number, occurrences:number, from:number, totalLen:number, truncated:boolean}}
 */
export function extractCycleEvidence(buf, cfg) {
  const s = String(buf ?? '');
  const cap = Math.max(500, cfg?.dumpMaxChars ?? 8000);
  const w = Math.min(cfg?.window ?? 600, Math.floor(s.length / 2));
  if (w < 1) return { text: s.slice(-cap), period: 0, occurrences: 0, from: Math.max(0, s.length - cap), totalLen: s.length, truncated: s.length > cap };

  const tail = s.slice(-w);
  const histEnd = s.length - w;
  const histStart = Math.max(0, histEnd - (cfg?.history ?? 4000));
  let first = s.indexOf(tail, histStart);
  if (first < 0 || first > histEnd) first = histStart;

  // 命中次数：与 isLooping 同口径（不重叠计数，tail 自身算 1 次）
  let n = 0;
  let last = -Infinity;
  let idx = s.indexOf(tail, histStart);
  while (idx !== -1 && idx <= histEnd) {
    if (idx - last >= w) { n += 1; last = idx; }
    idx = s.indexOf(tail, idx + 1);
  }

  const from = Math.max(0, Math.max(first, s.length - cap));
  const text = s.slice(from);
  return {
    text,
    period: w,
    occurrences: n + 1,
    from,
    totalLen: s.length,
    truncated: from > 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 插件主体
// ─────────────────────────────────────────────────────────────────────

export const apply = (ctx, config) => {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  if (!cfg.enabled) return;

  /** Agent → **最近一次**请求的 `{ signal, turn, at }`。
   *
   *  ⚠️ v0.3.3 修的真 bug（2026-09-29 实测 7 条 `DETECT` 却 `hasSignal=false`）：
   *  原实现按 turn 索引 `WeakMap<agent, Map<turn, signal>>`，但 `agent/assistant-stream`
   *  的 frame **没有 `turn` 字段**（turn 只藏在 `attemptId` 里，形如 `session-xxx:17`）
   *  ⇒ `signals.get(agent).get(undefined)` 恒为 `undefined` ⇒ **即使 `dryRun=false` 也 abort 不了**。
   *  改直接存 signal：同一 agent 同时只有一个活跃请求，取"最近一次"就是当前这次。
   *  用 WeakMap 避免持有 agent 生命周期。 */
  const signals = new WeakMap();
  /** attemptId → { buf, nextCheck, hits } */
  const states = new Map();
  /** `${sessionId}#${turn}` → turn 状态（v0.4.0：无进展判据用 lastProgressAt / pendingTools） */
  const turns = new Map();
  /** Agent → 当前 turn（流式增量时用它找到该 turn 的状态刷新"有进展"） */
  const lastTurnByAgent = new WeakMap();

  /** 本地时间戳（带时区偏移）—— `toISOString()` 输出 UTC，人工读日志容易差 8 小时 */
  const stamp = (d = new Date()) => {
    const p = (n) => String(n).padStart(2, '0');
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
      + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
      + `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
  };

  const appendLine = (path, line) => {
    try {
      // eslint-disable-next-line
      import('node:fs').then((fs) => {
        try { fs.appendFileSync(path, `${stamp()} ${line}\n`); } catch { /* ignore */ }
      }).catch(() => {});
    } catch { /* ignore */ }
  };

  const note = (line) => {
    try {
      // 不依赖 ctx.logger 的形态，双写：console + 文件
      // eslint-disable-next-line no-console
      console.warn(`[loop-fuse] ${line}`);
      appendLine(cfg.logPath, line);
    } catch { /* ignore */ }
  };

  /** 切断单独一份日志（v0.4.0-D）：给人快速核对"到底切了谁、为什么" */
  const noteCancel = (line) => appendLine(cfg.cancelLogPath, line);

  // ── ④ 线：触发即 dump 样本（v0.6.0）────────────────────────────────
  // 为什么需要它：想用**真实**污染样本回归 `tools/loop-detect.py` 时发现，当初的污染会话正文
  //   已不可逆清除 ⇒ 真实夹具**再也拿不到**。唯一出路是让"判中的那一刻"自己把证据存下来。
  // 为什么**弱命中也要 dump**：只记 strike、没掐断的那些才是**误杀候选**，
  //   对调阈值（window / repeats / repeatCallLimit）比真循环更值钱。
  const dumpSeen = new Set();
  let dumpSeq = 0;
  let denylistCache = null;
  let denylistAt = 0;

  /** 读禁检索名单（60 s TTL —— 名单是**热生效**的，别缓存一辈子） */
  const loadDenylist = async (fs) => {
    if (denylistCache && Date.now() - denylistAt < 60000) return denylistCache;
    const set = new Set();
    try {
      const j = JSON.parse(fs.readFileSync(cfg.dumpDenylistPath, 'utf8'));
      for (const k of Object.keys(j?.sessions ?? {})) set.add(k);
    } catch { /* 名单不存在/坏了 ⇒ 空集：不因缺文件而拒绝 dump */ }
    denylistCache = set;
    denylistAt = Date.now();
    return set;
  };

  /** 条数上限（防病态循环写爆盘）：按 **mtime** 排序（同秒内多条也能定序），删最旧 */
  const pruneSamples = (fs, dir) => {
    try {
      const keep = Math.max(1, cfg.dumpKeep ?? 30);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        .map((f) => {
          let m = 0;
          try { m = fs.statSync(`${dir}/${f}`).mtimeMs; } catch { /* ignore */ }
          return { f, m };
        })
        .sort((a, b) => (a.m - b.m) || a.f.localeCompare(b.f));
      for (const { f } of files.slice(0, Math.max(0, files.length - keep))) {
        try { fs.unlinkSync(`${dir}/${f}`); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };

  /**
   * 落一条样本。**调用即返回、异步写盘** —— 调用点在事件处理器里，绝不阻塞会话事件链。
   * 去重键 = `session#turn#kind`：同一 turn 的同类命中只留**第一次**（那时的证据最干净、最小）。
   */
  const dumpSample = (spec) => {
    if (!cfg.dumpSamples) return;
    const key = `${spec.sid ?? '?'}#${spec.turn ?? '?'}#${spec.kind}`;
    if (dumpSeen.has(key)) return;
    dumpSeen.add(key);
    try {
      import('node:fs').then(async (fs) => {
        try {
          const deny = await loadDenylist(fs);
          if (spec.sid && deny.has(spec.sid)) {
            note(`DUMP-SKIP kind=${spec.kind} session=${spec.sid} —— 会话在禁检索名单内，不落盘样本`);
            return;
          }
          const dir = cfg.dumpDir;
          fs.mkdirSync(dir, { recursive: true });
          const cap = Math.max(500, cfg.dumpMaxChars ?? 8000);
          // turn 归一成数字：①线从 `attemptId` 取到的是**字符串**（`turnOfAttempt` 是 slice 出来的），
          //   而 session/event 给的是数字 ⇒ 不归一的话同一份样本里 `turn` 会两种类型混用。
          const turnN = spec.turn == null
            ? null
            : (Number.isFinite(Number(spec.turn)) ? Number(spec.turn) : spec.turn);
          const rec = {
            v: 1,
            at: new Date().toISOString(),
            atLocal: stamp(),
            kind: spec.kind,
            session: spec.sid ?? null,
            turn: turnN,
            attemptId: spec.attemptId ?? null,
            why: spec.why ?? null,
            acted: spec.acted ?? null,
            evidence: spec.evidence ?? null,
          };
          if (spec.text != null) {
            const raw = String(spec.text);
            const body = raw.slice(-cap);             // 保尾部：判据窗口在尾部
            rec.chars = body.length;
            rec.truncated = raw.length > body.length;
            rec.text = cfg.dumpRedact === false ? body : redactSecrets(body);
          }
          if (spec.arguments != null) {
            const raw = typeof spec.arguments === 'string'
              ? spec.arguments : JSON.stringify(spec.arguments);
            const cut = raw.slice(0, cap);
            rec.arguments = cfg.dumpRedact === false ? cut : redactSecrets(cut);
            rec.argumentsTruncated = raw.length > cut.length;
          }
          dumpSeq += 1;
          const tsPart = stamp().replace(/[^0-9]/g, '').slice(0, 14);
          const name = `${tsPart}-${spec.kind}-${String(spec.sid ?? 'nosid').slice(0, 20)}`
            + `-${dumpSeq.toString(36)}.json`;
          fs.writeFileSync(`${dir}/${name}`, `${JSON.stringify(rec, null, 2)}\n`);
          pruneSamples(fs, dir);
          note(`DUMP kind=${spec.kind} session=${spec.sid ?? '?'} turn=${spec.turn ?? '?'} `
             + `chars=${rec.chars ?? 0} acted=${rec.acted} redact=${cfg.dumpRedact !== false} file=${name}`);
        } catch (e) {
          note(`DUMP-FAIL kind=${spec.kind} ${String(e)}`);
        }
      }).catch(() => {});
    } catch { /* 绝不影响检测主链路 */ }
  };

  // ── ① 请求开始：保存该请求的 AbortSignal ────────────────────────────
  // ⚠️⚠️ agent/request 是 **waterfall（瀑布）**扩展点：handler 必须写成
  //      `async (payload, next) => { const r = await next(); …; return r; }`。
  //      若像 v0.1 那样写成 `(payload) => {…}`（既无 next、也不返回），
  //      瀑布链会在本监听器处**终止**，下游 `dsh-agent` 拿到 `resolved === undefined`，
  //      抛出实测到的：
  //        Cannot destructure property 'reasoningEffort' of 'resolved' as it is undefined
  //      ⇒ **这才是那次"本轮运行失败"的真实根因**（不是 settings.yaml 缺字段）。
  /** v0.3：sessionId → Agent —— 「累积止损」要靠它拿到 agent 才能调 `cancel()`。
   *  Agent 上没有反查 session 的公开 helper，但 `agent.session` 是官方字段，
   *  所以每次 agent/request 时顺手登记即可（turn 开始必然先有一次 LLM 请求）。 */
  const agentsBySession = new Map();

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    try {
      const { agent, turn, signal } = payload ?? {};
      if (agent && signal) signals.set(agent, { signal, turn, at: Date.now() });
      const sid = agent?.session?.id ?? agent?.session?.header?.id;
      if (sid) agentsBySession.set(sid, agent);
      if (agent && turn != null) lastTurnByAgent.set(agent, turn);
    } catch { /* 绝不因自身异常影响请求链 */ }
    return resolved;   // ← 必须原样透传下游结果
  });

  // ── ② 流式输出：累计 reasoning/text 增量并做宽松重复检测（v0.1）──────
  ctx.on('agent/assistant-stream', (payload) => {
    const { agent, frame } = payload ?? {};
    if (!frame || !frame.attemptId) return;

    // v0.4.0-A：**流式吐字也算"有进展"** —— 否则"长时间生成一大段文本"会被误判停滞。
    try {
      const sid = agent?.session?.id ?? agent?.session?.header?.id;
      const turn = frame.turn ?? lastTurnByAgent.get(agent);
      if (sid && turn != null) {
        const t = turns.get(`${sid}#${turn}`);
        if (t) t.lastProgressAt = Date.now();
      }
    } catch { /* ignore */ }

    if (frame.type === 'end') { states.delete(frame.attemptId); return; }
    if (frame.type !== 'chunk') return;

    const c = frame.chunk;
    if (!c) return;
    if (c.type !== 'reasoning-delta' && c.type !== 'text-delta') return;

    const st = states.get(frame.attemptId) ?? { buf: '', nextCheck: cfg.minChars, hits: 0, kind: c.type };
    if (c.text) st.buf += c.text;
    st.kind = c.type;

    if (st.buf.length >= st.nextCheck) {
      st.nextCheck = st.buf.length + cfg.checkEvery;
      if (isLooping(st.buf, cfg)) {
        st.hits += 1;
        const turn = turnOfAttempt(frame.attemptId);
        const sid = agent?.session?.id ?? agent?.session?.header?.id;
        // v0.3.3：直接取"最近一次请求"的 signal（不再按 frame.turn 索引 —— 那个字段根本不存在）
        const rec = signals.get(agent);
        const sig = rec?.signal;
        const stale = !rec || (Date.now() - rec.at > cfg.signalMaxAgeMinutes * 60000);
        // v0.3.3 节流：同一 attempt 命中多次只记 1、6、11… 次（原实现一次命中写一行，
        //   实测同一 attempt 写了 6 行 `hits=1→6`）。
        if (st.hits % 5 === 1) {
          note(`DETECT attempt=${frame.attemptId} turn=${turn ?? '?'} len=${st.buf.length} `
             + `kind=${st.kind} hits=${st.hits} hasSignal=${Boolean(sig)} stale=${stale} `
             + `canCancel=${typeof agent?.cancel === 'function'} dryRun=${cfg.dryRun}`);
        }

        if (cfg.dryRun || st.canceled) { /* 观测模式 / 本 attempt 已掐过 ⇒ 不动手 */ }
        else if (st.hits < cfg.textStrikesBeforeCancel) {
          // 2026-09-30 降敏：首次命中先只观察，避免"长思考里反复引用同一段配置"被误杀
          note(`STRIKE-PENDING attempt=${frame.attemptId} turn=${turn ?? '?'} len=${st.buf.length} `
             + `hits=${st.hits}/${cfg.textStrikesBeforeCancel} —— 首次命中，继续观察；再次命中才掐断`);
        } else {
          // v0.4.0-B：文本线是**强信号** ⇒ 也计入 strike 池（③线跨 turn 累计用）
          const sid = agent?.session?.id ?? agent?.session?.header?.id;
          const n = sid ? recordStrike(sid, 'text-loop', { turn }) : 0;
          // ── 路径 A（主）：`agent.cancel()` —— v0.3.3 的真正修法 ──────────────
          // 为什么不是 `sig.abort()`：实测 Node 22 里 `AbortSignal` 实例上**没有 abort 方法**
          //   （`typeof c.signal.abort === 'undefined'`），只有 `AbortController` 能 abort；
          //   而 `agent/request` payload 只有 `{agent, turn, step, signal}`，**不给 controller**
          //   ⇒ 从 signal 反查 controller 也不可能（signal 是单向的）。
          // 官方原语：`Agent.cancel(cause, {keepInbox})` ⇒ dsh-agent-loop 内 `phase.abort.abort(cause)`，
          //   abort 的正是同一个 turn signal ⇒ 真正中止该 turn。
          if (cfg.abortViaCancel && typeof agent?.cancel === 'function') {
            try {
              agent.cancel(
                { kind: 'hook', reason: 'loop-fuse: output loop detected' },
                { keepInbox: cfg.cancelKeepInbox },
              );
              st.canceled = true;
              note(`ABORT-VIA-CANCEL session=${sid ?? '?'} turn=${turn ?? '?'} `
                 + `len=${st.buf.length} hits=${st.hits} keepInbox=${cfg.cancelKeepInbox} `
                 + `cause=hook ← 文本重复判定为循环，已中止该 turn`);
              noteCancel(`CANCEL source=text-loop session=${sid ?? '?'} turn=${turn ?? '?'} `
                 + `hits=${st.hits} len=${st.buf.length} strikes=${n}/${cfg.strikesBeforeCancel} `
                 + `keepInbox=${cfg.cancelKeepInbox} cause=hook`);
            } catch (e) {
              note(`CANCEL-FAIL attempt=${frame.attemptId} ${String(e)}`);
            }
          }
          // ── 路径 B（兜底）：若将来 DSH 递下可 abort 的 signal / controller，就直接 abort ──
          if (!st.canceled && sig && !stale && typeof sig.abort === 'function' && !sig.aborted) {
            try {
              sig.abort(new Error('loop-fuse: output loop detected'));
              st.canceled = true;
              note(`ABORT-VIA-SIGNAL attempt=${frame.attemptId} turn=${turn ?? '?'} `
                 + `len=${st.buf.length} hits=${st.hits} sigTurn=${rec?.turn ?? '?'}`);
            } catch (e) {
              note(`ABORT-FAIL attempt=${frame.attemptId} ${String(e)}`);
            }
          }
          if (!st.canceled) {
            note(`ABORT-SKIP attempt=${frame.attemptId} turn=${turn ?? '?'} —— 检测到循环但没有可用中止原语`
               + `（canCancel=${typeof agent?.cancel === 'function'} hasAbortableSignal=`
               + `${Boolean(sig && typeof sig.abort === 'function')}）`);
          }
        }
        // ── ④线：把"判中的这一刻"存成离线样本（v0.6.0）──────────────
        // 放在 if/else 之外 ⇒ **弱命中（只记 strike）也 dump** —— 那才是调阈值时最需要的误杀候选。
        {
          const ev = extractCycleEvidence(st.buf, cfg);
          dumpSample({
            kind: 'text-loop', sid, turn, attemptId: frame.attemptId,
            why: `isLooping hit #${st.hits}（window=${cfg.window} repeats=${cfg.repeats} history=${cfg.history}）`,
            acted: !cfg.dryRun && st.hits >= cfg.textStrikesBeforeCancel,
            evidence: {
              hits: st.hits, bufLen: st.buf.length, streamKind: st.kind,
              mode: cfg.dryRun ? 'dryRun' : 'armed',
              textStrikesBeforeCancel: cfg.textStrikesBeforeCancel,
              period: ev.period, occurrences: ev.occurrences,
              from: ev.from, totalLen: ev.totalLen, truncated: ev.truncated,
            },
            text: ev.text,
          });
        }
      }
    }
    states.set(frame.attemptId, st);
  });

  // ── ③ 行动层记账（v0.4.0-A：按"进展"记账，不再看时长/步数）────────
  // session/event 是 **同步 emit**（`(session, event)` 两个参数，不是单个 payload），
  // 事件形态：`{type, seq, time, data}`；data 见 dsh-session 的 SessionEventMap。
  // 签名已对过 5 个官方插件（dsh-acp / dsh-agent-loop / dsh-agent-instructions /
  // dsh-agent-presets / dsh-api-session-controller）—— 全部是 `(session, event) => …`。
  const progressSet = new Set(cfg.progressEvents ?? DEFAULTS.progressEvents);
  let sawFirstEvent = false;
  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type;
      const d = event?.data;
      if (!type || !d) return;
      // dsh-acp 读 `session.header.id`、dsh-api-session-controller 读 `session.id` —— 两者都兜住
      const sid = session?.id ?? session?.header?.id ?? session?.sessionId ?? 'unknown';

      // 🔎 一次性自检：证明「事件通道真的接上了」。
      //    没有它，插件在超时前**毫无输出** ⇒ 无法区分"通道断了"和"还没超时"
      //    （2026-09-29 踩过这个不可证伪状态：dryRun 零命中时不知死活）。
      if (!sawFirstEvent) {
        sawFirstEvent = true;
        note(`EVENT-OK 事件通道已接通（首个事件 type=${type} session=${sid}）`);
      }

      if (type === 'turn/start') {
        turns.set(`${sid}#${d.turn}`, {
          sid, turn: d.turn, step: d.step ?? 0,
          startedAt: Date.now(), lastProgressAt: Date.now(),
          pendingTools: 0, warned: false,
          lastCallFp: '', lastCallCount: 0,     // v0.5.0：同参调用连击计数
        });
        return;
      }
      if (type === 'turn/end') {
        turns.delete(`${sid}#${d.turn}`);
        killed.delete(`${sid}#${d.turn}`);   // 2026-10-03：turn 结束即清（条目已无用，防 Set 无限增长）
        return;
      }

      // 其余事件：找到该 turn 刷新"有进展"
      const key = `${sid}#${d.turn}`;
      const st = turns.get(key);
      if (!st) return;
      if (progressSet.has(type)) {
        st.lastProgressAt = Date.now();
        if (d.step != null) st.step = Math.max(st.step ?? 0, d.step);
      }
      // 未返回的工具调用计数（长工具豁免的依据）
      if (type === 'tool/call') {
        st.pendingTools = (st.pendingTools ?? 0) + 1;
        // ── v0.5.0（②b 线）：同参调用连击 ──────────────────────────
        // 本地小模型"找不到东西"时会反复重试**逐字相同**的命令（每次 (no output) 都当"没找到"）。
        // 这类循环每次都有 tool/call ⇒ "无进展"判据看不见；只能靠指纹连击抓。
        const exempt = new Set(cfg.repeatCallExemptTools ?? []);
        if (!exempt.has(d.name)) {
          const fp = callFingerprint(d.name, d.arguments);
          if (fp === st.lastCallFp) st.lastCallCount = (st.lastCallCount ?? 1) + 1;
          else { st.lastCallFp = fp; st.lastCallCount = 1; }
          if (st.lastCallCount >= (cfg.repeatCallLimit ?? 6)) {
            const n = recordStrike(sid, 'repeat-call', { turn: d.turn });
            note(`REPEAT-WARN session=${sid} turn=${d.turn} step=${d.step} tool=${d.name} `
               + `consecutive=${st.lastCallCount} strikes=${n}/${cfg.strikesBeforeCancel}`);
            if (cfg.repeatCallCancel !== false) {
              cancelWithHook(sid, d.turn,
                `loop-fuse: repeated identical tool call ×${st.lastCallCount} (${d.name})`,
                { source: 'repeat-call', step: d.step, consecutive: st.lastCallCount, strikes: n });
            }
            // ── ④线：同参连击样本（v0.6.0）—— 只留**参数**（正文可能很大，dumpSample 内再截断+脱敏）
            dumpSample({
              kind: 'repeat-call', sid, turn: d.turn,
              why: `identical tool call ×${st.lastCallCount}（${d.name}）`,
              acted: cfg.repeatCallCancel !== false,
              arguments: d.arguments,
              evidence: {
                tool: d.name, consecutive: st.lastCallCount, step: d.step,
                fingerprint: st.lastCallFp, limit: cfg.repeatCallLimit, strikes: n,
                cancel: cfg.repeatCallCancel !== false,
              },
            });
          }
        }
      } else if (type === 'tool/result') st.pendingTools = Math.max(0, (st.pendingTools ?? 0) - 1);
    } catch { /* 绝不影响会话事件链 */ }
  });

  /** v0.3：sessionId → **窗口内** strike 列表（{at, source, turn}）。
   *  语义是"同一个会话**近期反复**卡住" —— 单次偶发不算，**很久以前的也不算**（见 strikeWindowMinutes）。
   *  v0.4.0-B：**只收强信号** —— source ∈ {'text-loop'（①线）, 'stalled'（②线真停滞）}。*/
  const strikes = new Map();
  /** v0.3：已切断过的 session，避免同一会话被反复 cancel */
  const killed = new Set();

  const recordStrike = (sid, source, info = {}) => {
    const now = Date.now();
    const arr = (strikes.get(sid) ?? [])
      .filter((s) => now - s.at <= cfg.strikeWindowMinutes * 60000);
    arr.push({ at: now, source, ...info });
    strikes.set(sid, arr);
    return arr.length;
  };

  /** v0.5.0：统一的「hook 掐断」路径 —— ②b 线（同参连击）与 ③线（停滞）共用，
   *  保证两条线的 cause/keepInbox/日志格式一致（`cause=hook` + `keepInbox:true`）。*/
  const cancelWithHook = (sid, turn, reason, meta = {}) => {
    // 2026-10-03 修：原先按 **session** 去重 ⇒ 一次掐断后**整个会话永久失保**（实测：turn 3 掐断后
    //   turn 4 同参连击 6→23 次只 warn 不 cancel，最后靠机主手动停）。改成按 **(session, turn)** 去重：
    //   同一 turn 不重复切，**新 turn 仍可再切**（这才是原意）。
    const killKey = `${sid}#${turn ?? '?'}`;
    if (killed.has(killKey)) return false;           // 本 turn 切过就不再切
    const ag = agentsBySession.get(sid);
    if (!ag || typeof ag.cancel !== 'function') {
      note(`CANCEL-SKIP session=${sid}（拿不到 Agent，会话可能已结束）`);
      return false;
    }
    try {
      ag.cancel({ kind: 'hook', reason }, { keepInbox: cfg.cancelKeepInbox });
      killed.add(killKey);
      note(`CANCEL session=${sid} turn=${turn} source=${meta.source ?? '?'} `
         + `step=${meta.step ?? '?'} strikes=${meta.strikes ?? '-'}/${cfg.strikesBeforeCancel} `
         + `keepInbox=${cfg.cancelKeepInbox} cause=hook ← ${reason}`);
      noteCancel(`CANCEL source=${meta.source ?? '?'} session=${sid} turn=${turn} step=${meta.step ?? '?'} `
         + `consecutive=${meta.consecutive ?? '-'} noProgress=${meta.noProgressMin ?? '-'}min `
         + `pendingTools=${meta.pendingTools ?? '-'} strikes=${meta.strikes ?? '-'}/${cfg.strikesBeforeCancel} `
         + `keepInbox=${cfg.cancelKeepInbox} cause=hook reason="${reason}"`);
      return true;
    } catch (e) {
      note(`CANCEL-FAIL session=${sid} ${String(e)}`);
      return false;
    }
  };

  // 定时扫描：turn 真的停滞时不会再有新事件，只能靠主动轮询发现
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      for (const st of turns.values()) {
        if (st.warned) continue;          // ← 每个 turn 最多只贡献 1 个 strike
        const why = checkStall(st, cfg, now);
        if (!why) continue;
        st.warned = true;
        const mins = ((now - (st.lastProgressAt ?? st.startedAt)) / 60000).toFixed(1);
        const n = recordStrike(st.sid, 'stalled', { turn: st.turn });
        note(`STALL-WARN reason=${why} session=${st.sid} turn=${st.turn} step=${st.step} `
           + `noProgress=${mins}min pendingTools=${st.pendingTools ?? 0} `
           + `strikes=${n}/${cfg.strikesBeforeCancel}`);

        // ── ④线：停滞样本（v0.6.0）—— 停滞线**没有正文**（它就是"没有事件"），
        //    所以只保存该 turn 的**状态账**：太久没进展 / 谁在挂着 / 攒了几个 strike。
        //    这类样本的价值在于**事后判断"这次到底该不该算卡住"**（长工具 vs 真挂死）。
        dumpSample({
          kind: 'stalled', sid: st.sid, turn: st.turn,
          why: `no progress ${mins} min（pendingTools=${st.pendingTools ?? 0}）`,
          acted: Boolean(cfg.cancelOnStrikes) && n >= cfg.strikesBeforeCancel,
          evidence: {
            reason: why, step: st.step, noProgressMin: Number(mins),
            pendingTools: st.pendingTools ?? 0, strikes: n,
            strikesBeforeCancel: cfg.strikesBeforeCancel,
            limitUsedMin: (st.pendingTools ?? 0) > 0 ? cfg.stallMinutesWithTool : cfg.stallMinutes,
            startedAtLocal: new Date(st.startedAt ?? now).toISOString(),
            lastProgressAtLocal: new Date(st.lastProgressAt ?? st.startedAt ?? now).toISOString(),
          },
        });

        // ── ③ 累积止损：同一会话反复出强信号 ⇒ **真切断**（v0.3；v0.5.0 统一走 cancelWithHook）──
        if (!cfg.cancelOnStrikes) continue;
        if (n < cfg.strikesBeforeCancel) continue;
        cancelWithHook(st.sid, st.turn,
          `loop-fuse: stalled turn — no progress for ${mins} min`,
          { source: 'stalled', step: st.step, noProgressMin: mins, pendingTools: st.pendingTools ?? 0, strikes: n });
      }
    } catch { /* ignore */ }
  }, Math.max(5, cfg.watchIntervalSec) * 1000);
  // 不让这个定时器拖住进程退出
  if (typeof timer?.unref === 'function') timer.unref();

  note(`loaded v0.7.1 enabled=${cfg.enabled} dryRun=${cfg.dryRun} minChars=${cfg.minChars} `
     + `window=${cfg.window} repeats=${cfg.repeats} history=${cfg.history} `
     + `signalMaxAgeMinutes=${cfg.signalMaxAgeMinutes} `
     + `abortViaCancel=${cfg.abortViaCancel} cancelKeepInbox=${cfg.cancelKeepInbox} `
     + `stallMinutes=${cfg.stallMinutes} stallMinutesWithTool=${cfg.stallMinutesWithTool} `
     + `progressEvents=${(cfg.progressEvents ?? []).join(',')} `
     + `repeatCallLimit=${cfg.repeatCallLimit} repeatCallCancel=${cfg.repeatCallCancel} `
     + `strikesBeforeCancel=${cfg.strikesBeforeCancel} strikeWindowMinutes=${cfg.strikeWindowMinutes} `
     + `cancelOnStrikes=${cfg.cancelOnStrikes}`);
  note(`loaded v0.7.1 dumpSamples=${cfg.dumpSamples} dumpDir=${cfg.dumpDir} `
     + `dumpMaxChars=${cfg.dumpMaxChars} dumpKeep=${cfg.dumpKeep} dumpRedact=${cfg.dumpRedact} `
     + `dumpDenylistPath=${cfg.dumpDenylistPath}`);
};

export const Config = undefined;
