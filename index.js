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
 * v0.7.6（2026-10-04）：**去掉写死的本机绝对路径**（公开发布后自查发现的问题）——
 *   ① 默认落点全部改为**按本实例 `DSH_HOME` 派生**（`${DSH_HOME}/logs/dsh-local-loop-fuse/…`），
 *      本机（原路径）由 `profiles/web/cordis.patch.yml` 用 `config:` 显式钉住 ⇒ 行为不变；
 *   ② `appendLine` 补 `mkdirSync` —— 旧默认值指的本机目录恰好已存在，**换个环境就静默不写日志**；
 *   ③ `loaded` 行的版本号改为**动态读 `package.json`**（此前硬编码 `v0.7.1`，bump 后从不更新，
 *      曾导致"怎么升级日志都写 0.7.1"的误判）。
 *
 * v0.8.0（2026-10-04）：新增 **⑤ 线「零正文 turn」** —— 这是**第 4 条检测线**（编号取 ⑤ 是因为
 *   v0.6.0 已把"④"用于 **dump 机制**、并非检测线；文档里别把两者混为一谈）。
 *   现场（1.5，`session-4fa3d`，2026-10-04 17:33）：连着两轮（`turn 81`/`turn 82`）**只产出 reasoning、
 *   正文一个字没有** ⇒ 机主在 GUI 里只看到"它停住了"，只能人工喊「停 你循环了」。
 *   取证（`seq 3407/3418`）：`content` 只有 `reasoning` 块 · `outputTokens === reasoningTokens`
 *   （3706＝3706 / 1366＝1366）· `stream` 结束是 `{"type":"finish","reason":{"kind":"stop"}}`
 *   （**正常收尾，不是 `length` 截断**）· provider `maxTokens: 8192` 远未到顶 ·
 *   该会话 **508 条 assistant/message 里只此 2 条**（0.4%）· 现有三条线**全都没响**
 *   （没重复 / 时长仅 14.8s·6.8s / 无累积）⇒ 这是**唯一"用户完全看不到任何东西"**的失效形态。
 *   判别式**极硬且便宜**（纯结构、不看正文）：**整个 turn 里没有 text 块、也没有 tool-call 块**，
 *   且至少有一条 assistant/message 的 `outputTokens === reasoningTokens > 0`。
 *   ⚠️ 关键设计取舍：判定放在 **`turn/end`**（一个 turn 有多个 step，中途"暂无正文"是正常的，
 *   必须等 turn 收口才能断言）；**默认动作为 `log`（只记日志 + 落结构样本，不上膛）** ——
 *   `steer`（自动补一句"你没有输出正文，请直接给结论"）属于**替机主自动发消息**，是行为改变，
 *   **发布包默认 `log`**、由使用者一行配置决定是否上膛（`emptyTurnAction: 'steer'`）。
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
 * 安装：`dsh plugin --profile <profile> add link:/path/to/dsh-local-loop-fuse`
 *   （或 `npm i dsh-local-loop-fuse`）。
 * 改代码后必须重启 dsh（`link:` + ESM 缓存，hot-applied ≠ 换掉代码）。
 * ⚠️ 默认落点 = **`${DSH_HOME}/logs/dsh-local-loop-fuse/`**（可移植）；要换位置就在该 profile 的
 *   `cordis.patch.yml` 里加一条 `- id: dsh-local-loop-fuse` + `config: { logPath, cancelLogPath, dumpDir }`。
 */

import { dirname } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';

/** 版本号：**动态读同目录 `package.json`**（v0.7.6 修 —— 此前硬编码 `v0.7.1`，
 *  bump 之后日志永远打旧版本，2026-10-03 曾因此误判"升级没生效"）。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();

/** 本实例的 DSH home（1.5 / 2.0 各自不同 —— 所以只能**运行时解析**，不能写死）。 */
const DSH_HOME_DIR = process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`;
/** 本插件的默认落点根目录（v0.7.6：**可移植**，跟着 `DSH_HOME` 走）。
 *  ⚠️ 本机要沿用旧路径（`.tmp/loop-fuse*.log` 与 `samples/`）由 `cordis.patch.yml` 显式钉住。 */
const LOOP_FUSE_DIR = `${DSH_HOME_DIR}/logs/dsh-local-loop-fuse`;

export const name = 'dsh-local-loop-fuse';
export const inject = [];

/** 默认阈值：刻意宽松（宁漏报不误杀 —— 机主 2026-09-28 定的原则） */
export const DEFAULTS = {
  enabled: true,
  // 可选挂载点**默认关闭**（v0.8.1）：`exit-check.mjs` 只在本机**显式打开**时才会被加载。
  //   ⇒ 默认情况下本包**不会 import 任何本地文件**；见 README「关于 index.js 末尾的可选挂载点」。
  probeMount: false,
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
  // ── ①b 低多样性高重复（v0.8.2 新增；补 ① 线**抓不到**的那一类）────────────
  // 2026-10-07 真实事故（本机 1.5，三次循环、护栏零反应）逼出来的：
  //   ① 线是**精确子串匹配**（末尾 window 字符必须原样出现在 history 里），而事故形态是
  //   **多个短片段交替铺满 + 夹少量噪声**（`（停）→（调用）→（结束）→…`，偶尔插 `d`）
  //   ⇒ 末尾 600 字符**永远不会精确出现**在 history ⇒ ① 线**一次都不命中**。
  //   【实测】三段真实循环文本回放：① 线全程 false（日志里连 DETECT 都没有，与现场吻合）。
  // 判据 = ①「用词极度贫乏」AND ②「同一片段高频重复」—— 两个都要，理由见函数注释。
  lowDivDetect: true,      // 总开关（false = 退回只有 ① 线精确匹配的行为）
  lowDivWindow: 2000,      // 统计窗口（字符，取末尾）
  lowDivNgram: 24,         // 片段长度（字符）
  lowDivMaxUniq: 45,       // 窗口内**唯一字符数**上限（低于它才算"用词贫乏"）
                           // 🔴 2026-10-07 机主定 40 → **45**（拾遗在 159 会话样本上测：
                           //   `45` = 10/10 召回 · 0 误报；`60` = 有误报）。
                           // ⚠️ 白露在 **160 会话 / 5,013 块**上复测：45 与 40 结果**相同**（都召回 3/5，
                           //   漏 `14856`(uniq 56) 与 `14872`(局部循环,整段 uniq 247)）；且"误报"里混着
                           //   **未标注的真循环**（`aed7127e` 的 do-it 循环）⇒ **该数字待"真循环标注集"建好后重验**。
                           // 📌 机主原话：「**阈值可以先给 45，慢慢调整 —— 实践的样本永远是最好的**」。
  lowDivMinRepeat: 10,     // 同一 lowDivNgram 片段在窗口内出现次数下限
  // ── ①b-2 滑窗支（2026-10-07 机主授权加）────────────────────────────────
  // 为什么必须加：① 与 ①b（末窗）**都只看末尾 2000 字符**，会被正常部分的词汇**稀释**
  //   ⇒ 「**正常推理里夹一段空转**」这种**最自然的循环形态**在结构上抓不到。
  //   实测（`seq 14872` · turn 308 · 第 2 次自愈）：整段 `uniq=247` ⇒ 末窗判据全不命中；
  //   而按 400 字符滑窗其最小 `uniq=29`（循环段约 900 字符，结尾 `I must stop. Calling the tool now.`）。
  // ⚠️ **阈值必须与口径配套，不能共用**：实测（160 会话 / 5,013 块）
  //   末窗(2000) 下 45 可用（机主定）；**滑窗(400) 下 45 误报 850 块（17%）**，
  //   滑窗 `uniq<30` 才回到可用区。⇒ 故本支**独立阈值**，不复用 `lowDivMaxUniq`。
  lowDivSlideDetect: true,   // 滑窗支总开关（false = 退回只有末窗口径）
  lowDivSlideWin: 400,       // 滑窗窗口（字符）
  lowDivSlideStep: 100,      // 滑窗步长（字符）
  lowDivSlideUniq: 30,       // 滑窗内唯一字符数上限（实测：<30 ⇒ 真循环 5/5 召回）
  // ⚠️ 滑窗支的 ② 条件门槛**非常低**（2，不是末窗支的 10）—— 由测试 `④b 模板化列表` 逼出来：
  //   在「min-uniq 窗口」内实测 k24：真循环 `2/3/3/5/9` vs **模板列表 `1`**
  //   ⇒ 门槛取 2 就能挡住模板列表、又不漏真循环。**别再抬高**（会漏 `14872`/`14922`）。
  lowDivSlideMinRepeat: 3,   // 滑窗内 k-gram 重复次数下限（窗口内计算，不跨窗）
  // 🔄 2026-10-07 拾遗 round2 实测后 2 → **3**：她扫过 1/2/3/4 ——
  //   `2→3` 是**免费**的（召回仍 5/5，只在一个样本上多 600 字符延迟），真悬崖在 4（漏 14872）。
  //   我方复测（含尾部补偿窗）仍 5/5。⇒ 取 3 换一档误报余量。
  // ⚠️ 她另建议改判据为「**窗内 distinct 重复 24-gram ≥ 3**」（对 ④b 形态更稳：④b 恒 0）。
  //   我方在**全库 5,076 块**实测：现状(maxRep≥2) 与 distinct≥3 的命中集**完全相同（16/16）**，
  //   distinct≥5 仅少 2 块 ⇒ **换过去没有实测收益** ⇒ **暂不换**，记为候选（本轮实测口径见
  //   `07-experiments/2026-10-07-loopfuse-round2-round1.md` 与我方复算）。
  // ── ①c P1-b：① 线命中时**注入「停止」类词** + **预注册观测**（2026-10-07 机主定「加」）──
  // 背景与争议：机主要"加"（"2 次脱困是实打实的 · 一切等实测数据"）；拾遗 round2 判"不该做"
  //   （seq14900 全文 9 处「停止」仍失败）；烛微 round6 判：**机主的证伪不成立**（那 2 例
  //   结构上碰不到注入通路 —— ① 线命中走 cancel、⑤ 线判据要求零正文）**且拾遗 over-claim**
  //   （"非充分"≠"注入无效"），**但她用 seq14911 加强了方向**（机主**亲自发的「停」已送达** +
  //   模型逐字引用规则，随后仍循环 ~100 行）。
  // ⇒ 结论：**可以加，但必须按"能出结论"的方式加**（烛微四条，逐条对应下面的设计）：
  //   ① 单臂前后测无反事实 ⇒ 除密度外，**另记「注入后 ① 线是否仍命中」作独立读数**；
  //   ② 度量污染（注入文本含"停"字、恰在碎片族里）⇒ 读数用 **k24 最高重复**，**不数"停"字**；
  //   ③ 无预注册 ⇒ 注入点 / N / 成功阈值**全部配置化并在日志里打印**；
  //   ④ **基础率 2/6**（本簇 6 段真循环有 2 段自愈）⇒ 单次"注入后它停了"**不算证据**，日志明记。
  // ⚠️ 本项**会替机主自动发消息**（同 ⑤ 线 steer 一类动作）；发布包里应默认 false。
  // ⚠️ 默认 **false**（2026-10-07 对齐 0.8.1 的 `probeMount` 模式）：本项**替使用者自动发消息**
  //   （往会话里注入一条 user 消息）⇒ 保守默认 = **发布包不自动注入**，要用的人显式打开。
  //   本机（1.5）由 `profiles/web/cordis.patch.yml` 显式 `p1bEnabled: true` 保持行为不变。
  //   撤销条件：机主决定不再要这条时，删 patch 里那行（改完需重启 dsh）。
  p1bEnabled: false,         // 总开关（发布包默认 false；本机由配置钉 true）
  p1bInjectAtHit: 1,         // **预注册**：第几次 ① 线命中后注入（1 = 首次命中即注入）
  p1bObserveChars: 2000,     // **预注册 N**：注入后再观察这么多字符才判
  p1bSuccessDropPct: 50,     // **预注册成功阈值**：k24 降到 ≤ 注入前的 50% **且** ① 线不再命中
  p1bHint: '⚠️ 系统提示（dsh-local-loop-fuse）：检测到你在**原地重复**。请**停止推理，直接输出结论**，'
    + '或直接调用你要调用的工具。不要继续复述同一串词。',
  // ⚠️ **每会话注入上限**（v0.8.2 加 · 拾遗第 3 轮 §3 实测）：`attempt` = 一次模型请求 = **一个 step**
  //   ⇒ 光靠 attempt 内的 `p1bDone` 挡不住跨 step 的循环：实测一个会话注入 **6 次**，且每条都
  //   **永久进 durable transcript**（`dsh-agent-loop:1028`）。姊妹插件 `loop-restart-exp` 的教训：
  //   「**steer 没有平台级限次保护**，无条件重启 = 自造死循环」。
  // ⚠️ 键名与语义（第 3 轮审阅 §F）：这是**每个 episode**的上限。
  //   旧名 `p1bSteerMaxPerSession` 已改名，仍兼容（apply 里有 alias + 一行日志）。
  p1bSteerMaxPerEpisode: 2,
  // 🔴 **会话终身硬顶**（§F 补的上界）：episode 计数是**滑动 idle-gap**、不是定长窗口 ——
  //   一个每 ~11 min 循环一次的常驻会话会**永远算新 episode** ⇒ 只靠它等于没有上限
  //   （实测量级 ≈260 条/天永久写进会话存档）。这一条是不可绕过的硬顶。
  p1bSteerMaxPerSessionHard: 8,
  // 🔴 **额度用尽后要不要动手**（第 3/4 轮审阅留下的 Q2）：`QUOTA` 的含义是
  //   「本 episode 的注入额度用完，**而它仍在命中**」—— 这是"持续循环"的强证据。
  //   ⚠️ 危险形状 = **跨 step 循环**：每个 step 只命中一次，永远攒不到 attempt 内的
  //   `textStrikesBeforeCancel`，于是**既不掐、也不再注入**，就这么一直转。
  //   `'log'`（默认，发布保守）= 只记一行；`'cancel'` = 复用 `agent.cancel` 掐断该 turn。
  //   本机由 profile patch 设 `'cancel'`。
  p1bQuotaAction: 'log',
  // ⚠️ 上面那个上限的**计数单位**（拾遗第 2 轮 §1-2）：按「循环 episode」而不是会话终身制。
  //   会话级终身计数下，一个常驻会话的样本天花板就是 2，而统计脚本自己规定「n<5 不足以下结论」
  //   ⇒ 重启后观察**在统计上不可能出结论**。现在：距上次注入超过本窗口 ⇒ 视为新 episode（计数归零）。
  //   取 10 min 与 `stallMinutes` 同量级 —— "同一次失控"通常就在这个尺度内。
  p1bEpisodeWindowMinutes: 10,
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
  logPath: `${LOOP_FUSE_DIR}/loop-fuse.log`,
  cancelLogPath: `${LOOP_FUSE_DIR}/loop-fuse-cancels.log`,
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
  dumpDir: `${LOOP_FUSE_DIR}/samples`,
  dumpMaxChars: 8000,         // 单条样本正文上限（字符）
  dumpKeep: 30,               // 目录内最多保留多少条（超出按时间删最旧）
  dumpRedact: true,           // 脱敏（⚠️ 除非明确知道自己在干什么，否则不要关）
  // ⚠️ 必须按**本实例的 home** 解析，不能硬编码：1.5 与 2.0 各有独立 home，
  //    硬编码会让 2.0 去读 1.5 的名单（2026-10-03 实测：2.0 加载行打印的是 1.5 的路径）。
  //    当前 2.0 尚无名单文件 ⇒ 影响为 0，但语义错：在 2.0 上屏蔽的会话不会被 dump 跳过。
  dumpDenylistPath: `${DSH_HOME_DIR}/storages/recall-denylist.json`,
  // ── ⑤ 零正文 turn（v0.8.0 新增；**检测线第 4 条**，编号取 ⑤ 见文件头）────────
  // 症状：整个 turn 只有 thinking、没有 text/tool-call ⇒ 用户侧"它停住了"，且现有三条线都抓不到。
  // 判别式只看**结构**（不看正文）⇒ 不涉及隐私，也不再落一份思考正文（样本里只存结构证据）。
  emptyTurnDetect: true,     // 总开关
  emptyTurnLimit: 1,         // 同一会话**连续** N 个零正文 turn 才触发（中间有正常 turn 即归零）。
                             //   默认 1 = 第一次零正文就记/补救 —— 因为它对用户就是"什么都没看到"；
                             //   想更保守就调 2（代价：第一轮仍然白等）。
  emptyTurnAction: 'log',    // 'log' = 只记日志 + 落结构样本；'steer' = **另自动补一句"你没输出正文"提示**
                             // 🔴 2026-10-07 机主定**本机**上膛（依据：事故当时 ⑤ 线已看到 3 次却只 `log`，
                             //   缺的是**动作**不是检测；拾遗独立得出同一结论）。
                             // ⚠️ 但**发布包默认 `'log'`**（v0.8.2 收口）：本项与 ①c 一样属于
                             //   「**替使用者自动发消息**，且会写进 durable transcript」⇒ 按同一条原则保守默认；
                             //   本机由 `profiles/web/cordis.patch.yml` 显式钉 `'steer'`（行为不变）。
                             // 限次：`emptyTurnSteerMax`（**每会话 3 次**，防"补救本身变成新循环"）。
  emptyTurnSteerMax: 3,      // action='steer' 时，**每会话**最多补救几次（防"补救本身变成新循环"）
  emptyTurnHint: '⚠️ 系统提示（dsh-local-loop-fuse）：你上一轮**只产出了思考、正文一个字都没有**，'
    + '用户看不到任何内容。请**直接输出结论**，不要再展开推理。',
};

// ─────────────────────────────────────────────────────────────────────
// 纯函数区（可单测，见 test-islooping.mjs）
// ─────────────────────────────────────────────────────────────────────

/** 文本重复检测 · **精确子串版**（v0.1）—— 总入口见下方 `isLooping` */
export function isLoopingExact(buf, cfg) {
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
 * 低多样性高重复检测（v0.8.2 新增）—— 抓**精确匹配抓不到**的那类原地打转。
 *
 * 事故形态（2026-10-07 实测，本机 1.5，有目击者）：模型在 reasoning 里空转，
 *   **多个短片段交替铺满**（`（停）→（调用）→（结束）→（停）…`），偶尔夹一点噪声（`d`）。
 *   ⇒ 末尾 window=600 字符**不会原样出现**在 history 里 ⇒ `isLoopingExact` **一次都不命中**
 *   （三段真实循环文本回放：全程 false）。日志侧吻合：15:20–15:30 连 `DETECT` 都没有。
 *
 * 判据 = **两个条件同时成立**：
 *   ① 窗口内**唯一字符数** < `lowDivMaxUniq` —— 「用词极度贫乏」。
 *      正常长推理在 2000 字符里通常用 100~400 个不同字符；事故文本只有 32/35/35 个。
 *   ② 同一 `lowDivNgram` 字符片段出现 ≥ `lowDivMinRepeat` 次 —— 「同一片段反复铺」。
 *  ⚠️ **两个都必须有，缺一即误杀**：
 *     · 只有 ② ⇒ 误杀**模板化列表**：`第 N 项：检查完成，结果正常，无需处理。`×160
 *       实测 k24=**1**（数字在变 ⇒ 24 字符片段不重复）却 k16=84。
 *     · 只有 ① ⇒ 误杀低多样性但正常的**短枚举/代码块**。
 *  🔄 **2026-10-07 归因更正（拾遗 round2 实测 · 我方已复现）**：原文写「④b 靠 ① 的 uniq 挡」——**写反了**。
 *     实测 ④b 的末窗 `uniq=**29**` (**< 45 门槛 ⇒ ① 放行**)，真正拦下它的是 **②(k24=1 < 10)**。
 *     ⇒ **① 对模板化列表毫无区分度**，两支（末窗/滑窗）**共用这同一个脆弱的 bit**。
 *     ⚠️ 且这个分隔是**编号递增的副产品**：把数字归一化后 ④b 的 k24 立刻跳到 **90**（我方复现）
 *     ⇒ **任何"先归一化数字/标点再比对"的改动都会误杀**（见 README「判定逻辑」节的同条更正）。
 *     ⚠️ 更严重的是：**固定段再长 3–5 字符，④b 就翻**（拾遗构造的 3 个变体已被**末窗支**判 true）。
 *
 * 误报验证【实测】（2026-10-07）：8 个真实会话日志共 **504 条**长文本（≥2500 字符，
 *   reasoning+text 块）⇒ 本判据命中 **3 条，而那 3 条正是三段真实循环**
 *   ⇒ **召回 3/3 · 误报 0/504**。
 * ⚠️ **诚实边界**：阈值是在这批样本（504 条、8 个会话、同一个模型家族）上定的，
 *   样本量有限 ⇒ 参数**全部可配**、默认偏保守（**宁可漏也不误杀**），
 *   上膛前建议再攒样本；要回退只需 `lowDivDetect: false`。
 */
export function isLowDiversityLoop(buf, cfg) {
  if (isLowDivTail(buf, cfg)) return true;                    // ①b 末窗口径
  if (cfg.lowDivSlideDetect !== false && isLowDivSliding(buf, cfg)) return true;  // ①b-2 滑窗口径
  return false;
}

/** ①b **末窗口径**（原实现）—— 抓「**整段单调**」型 */
function isLowDivTail(buf, cfg) {
  const win = cfg.lowDivWindow ?? 2000;
  const k = cfg.lowDivNgram ?? 24;
  const maxUniq = cfg.lowDivMaxUniq ?? 45;
  const minRepeat = cfg.lowDivMinRepeat ?? 10;
  if (buf.length < win) return false;          // 样本不足整个窗口 ⇒ 不判（保守）
  const seg = buf.slice(-win);
  if (new Set(seg).size >= maxUniq) return false;   // ① 用词够丰富 ⇒ 不是这种循环
  const seen = new Map();
  for (let i = 0; i + k <= seg.length; i++) {
    const g = seg.slice(i, i + k);
    const n = (seen.get(g) ?? 0) + 1;
    if (n >= minRepeat) return true;           // ② 已达下限 ⇒ 立即返回（不必跑满窗口）
    seen.set(g, n);
  }
  return false;
}

/**
 * ①b-2 **滑窗口径**（2026-10-07 机主授权新增）—— 抓「**局部循环 + 整段词汇丰富**」型
 *
 * 为什么必须单列一支：末窗只看末尾 2000 字符，正常部分的词汇会把 `uniq` **抬上去**
 *   ⇒ 「正常推理里夹一段空转」在结构上抓不到。实测 `seq 14872`（turn 308 · 第 2 次自愈）：
 *   整段 `uniq=247`（末窗两条件全不命中），按 400 字符滑窗最小 **`uniq=29`**。
 *
 * ⚠️ **本支也是两条件，但 ② 的门槛与末窗支不同**（`k24 ≥ 2` vs 末窗支的 `≥ 10`）—— 实测逼出来的：
 *   · 在 **2000 字符**窗口上算，局部循环的 `k16` 只有 **1–3**（每轮夹噪声 `d`/`执行。`/`I must call…`）
 *     ⇒ 若沿用末窗支的 `≥10`，这一支**永远不命中**（这正是末窗支最大的盲区）；
 *   · 但在**同一个 400 字符窗口内**算 `k24`：真循环可达 **`2/3/3/5/9`**，而**模板化列表只有 `1`**
 *     （数字变化打断 24-gram）⇒ **门槛取 2 恰好分开两者**。
 *   📌 这条门槛是**测试逼出来的**：本支初版「只看 uniq」时，`④b 模板化列表` 被判 `true`（误杀）。
 *
 * 实测依据（160 会话 / 5,013 长文本块）：末窗 45 可用；**滑窗 45 误报 850 块（17%）**，
 *   滑窗 `uniq<30` 才回到可用区。⚠️ 但"误报"未甄别（混有未标注真循环，如 `aed7127e`）
 *   ⇒ **精确误报率待"真循环标注集"建好后重验**。
 */
function isLowDivSliding(buf, cfg) {
  const win = cfg.lowDivSlideWin ?? 400;
  const step = cfg.lowDivSlideStep ?? 100;
  const maxUniq = cfg.lowDivSlideUniq ?? 30;
  const k = cfg.lowDivNgram ?? 24;
  const minRepeat = cfg.lowDivSlideMinRepeat ?? 2;
  if (buf.length < win) return false;
  // ⚠️ **尾部补偿**（拾遗 round2 §1.6 实测）：步进窗的最后一个终点是 `win + n*step`，
  //    因此**最后 `< step` 个字符从不属于任何窗**；与 `checkEvery:200` 叠加可造成最多 ~99 字符
  //    的检测延迟（不是漏报，是延迟）。⇒ 额外补一个**以 buf 末尾结尾**的窗。
  const ends = [];
  for (let end = win; end <= buf.length; end += step) ends.push(end);
  if (ends[ends.length - 1] !== buf.length) ends.push(buf.length);
  for (const end of ends) {
    const seg = buf.slice(end - win, end);
    if (new Set(seg).size >= maxUniq) continue;      // ① 该窗口用词够丰富 ⇒ 跳过
    const seen = new Map();                          // ② **该窗口内** k-gram 重复 ≥ minRepeat
    for (let i = 0; i + k <= seg.length; i++) {
      const g = seg.slice(i, i + k);
      const n = (seen.get(g) ?? 0) + 1;
      if (n >= minRepeat) return true;
      seen.set(g, n);
    }
  }
  return false;
}

/**
 * P1-b 观测读数：窗口内 **24-gram 最高重复次数**（`k24Max`）。
 *
 * ⚠️ 为什么读数不用"碎片/「停」字密度"（烛微 round6 §2.1 第 2 条）：**注入文本本身含"停"字**，
 *    一旦被模型抄回 reasoning（已实测会发生），**只有处理臂的密度会被抬高** ⇒ 不对称偏差，
 *    可能把"有效"读成"无效"、也可能反向。⇒ 读数改用**结构量 k24**，它不数任何特定字。
 */
export function k24Max(s, k = 24) {
  const m = new Map();
  let best = 0;
  for (let i = 0; i + k <= s.length; i++) {
    const g = s.slice(i, i + k);
    const v = (m.get(g) ?? 0) + 1;
    if (v > best) best = v;
    m.set(g, v);
  }
  return best;
}

/**
 * 递归冻结（等价于 dsh `createUserMessage` 内部做的 `deepFreeze`）。
 * 消息进入 inbox 后会被 dsh 当作**不可变**值使用 ⇒ 自建消息必须同样冻结。
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/**
 * 构造一条要交给 `agent.steer()` 的 **UserMessage** —— ①c P1-b 与 ⑤ 线**共用**。
 *
 * 两条路，按优先级：
 *  1. `dsh-llm` —— 官方构造器 `createUserMessage()`（语义最正、随 dsh 演进而变）；
 *  2. `self-built` —— **自建兜底**：`{ id, role:'user', content, source }` + 深冻结
 *     （`createUserMessage` 运行时做的就是"补 `id` + `deepFreeze(structuredClone())`"，
 *      而 `brandString` 是**编译期**品牌、运行时是恒等函数 —— 见 dsh-brand 的 `index.js`）。
 *
 * ⚠️ **为什么必须有兜底**（2026-10-07 · 写 `test-p1b.mjs` 时抓到，两连 bug）：
 *   - 第一层：①c 起初**直接调用** `createUserMessage(...)`，而它**从未被 import**
 *     ⇒ 每次注入都 `ReferenceError`（`P1B-INJECT-FAIL`）⇒ P1-b **上线即失效**；
 *   - 第二层（修完第一层才暴露）：`@deepseek-ai/dsh-llm` 是 dsh 内部包，
 *     `link:` 插件的解析路径上**够不着它**（`ERR_MODULE_NOT_FOUND`）⇒ **照样注入不了**。
 *   ⚠️ 兜底路径能否被 dsh 正常消费 = **【待验证】**（需重启 dsh 后在真实会话里看）；
 *     日志用 `via=` 区分走了哪条路，便于回查。
 *
 * @returns {Promise<{ via: 'dsh-llm'|'self-built', message: object }>}
 */
export async function buildSteerMessage(text, plugin = 'dsh-local-loop-fuse') {
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm');
    return {
      via: 'dsh-llm',
      message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } }),
    };
  } catch {
    const { randomUUID } = await import('node:crypto');
    return {
      via: 'self-built',
      message: deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin },
      }),
    };
  }
}

/**
 * 向 agent 注入一条**系统提示**（user 消息）—— ①c P1-b 与 ⑤ 线**共用**这一个实现。
 *
 * ⚠️ 两条注入路径**必须共用本函数**：各写一遍就会重演上面那两层 bug（未定义 / 拿不到包）。
 *   测试（`test-p1b.mjs`）是这条约束的防线。
 *
 * @param {object} agent 具备 `steer` 的 Agent
 * @param {string} text 提示正文
 * @param {string} [plugin] 来源标注（写进消息的 `source.plugin`）
 * @returns {Promise<'dsh-llm'|'self-built'>} 实际走的构造路径（调用方写进日志）
 */
async function steerHint(agent, text, plugin = 'dsh-local-loop-fuse') {
  const { via, message } = await buildSteerMessage(text, plugin);
  agent.steer(message);
  return via;
}

/**
 * 文本重复检测（v0.1；v0.8.2 起 = **精确子串 OR 低多样性高重复**）
 *
 * 为什么是 OR 而不是替换：`isLoopingExact` 抓得住「**逐字**重放同一段」（历史两次
 *   真实掐断都是这种，如反复引用同一段配置），但抓不住带噪声的交替打转；
 *   新判据补后者，**不改前者行为** ⇒ 零回归风险，且可各自配置。
 */
export function isLooping(buf, cfg) {
  if (buf.length < cfg.minChars) return false;
  if (isLoopingExact(buf, cfg)) return true;
  if (cfg.lowDivDetect !== false && isLowDiversityLoop(buf, cfg)) return true;
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

/** 不参与「动作同一性」判定的参数键：`description` 是模型给这次调用的**自注**，不是动作本身。
 *  ⚠️ **v0.8.1 修语义 bug**：原先整串 arguments 进指纹 ⇒「同一条命令、每次换一句说明」会被算成
 *  **不同**调用而漏判（2026-10-05 实测：三次 `echo <同一命令>` 只有 `description` 不同 ⇒
 *  老口径不命中、剔掉后命中）。指纹的语义是「动作是否同一」，`description` 不是动作 ——
 *  所以这是**修 bug**，不是"等自然症状再说的调参项"。 */
const VOLATILE_ARG_KEYS = ['description'];

/**
 * 规范化工具参数（v0.8.1）—— 把 `tool/call` 的 arguments 变成「只含动作本身」的稳定字符串。
 *   · arguments 是**原始 JSON 字符串**（`dsh-session` types.d.ts:333-339）⇒ 先解析；
 *   · 解析失败（非 JSON）⇒ **原串返回**（退化为精确比较，不误伤）；
 *   · 顶层键排序 + 剔除 `VOLATILE_ARG_KEYS` ⇒ 键序无关、自注无关。
 * ⚠️ 只排顶层：工具参数是扁平对象，递归排序会拖慢这条同步热路径。
 */
export function canonicalArgs(args) {
  let v = args;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return v; }
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return JSON.stringify(v ?? '');
  const o = {};
  for (const k of Object.keys(v).sort()) {
    if (VOLATILE_ARG_KEYS.indexOf(k) === -1) o[k] = v[k];
  }
  return JSON.stringify(o);
}

/**
 * 工具调用指纹（v0.5.0；**v0.8.1 改为只对动作参数取指纹**）——
 * `name + 规范化参数` 的轻量哈希（djb2）+ 长度。
 * 用途：识别「完全相同的工具调用」连击（本地小模型找不到东西时会反复重试同一条命令）。
 * 用纯字符串哈希而非 node:crypto，避免在同步事件处理器里引入异步。
 */
export function callFingerprint(name, args) {
  const s = `${name ?? ''}\u0000${canonicalArgs(args)}`;
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(h >>> 0).toString(16)}-${s.length}`;
}

// ─────────────────────────────────────────────────────────────────────
// v0.8.0 ⑤线：零正文 turn（纯函数，可单测）
// ─────────────────────────────────────────────────────────────────────

/** 拆一个 assistant/message 的 `content` 数组，看它有没有「正文 / 工具调用 / 思考」。
 *  ⚠️ 块类型名跨版本不统一 ⇒ 工具调用三种写法都认（`tool-call` / `tool_use` / `function_call`）。 */
export function classifyAssistantBlocks(content) {
  const out = { text: false, tool: false, reasoning: false };
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const t = b.type;
    if (t === 'text') {
      if (String(b.text ?? '').trim()) out.text = true;
    } else if (t === 'tool-call' || t === 'tool_use' || t === 'tool_call' || t === 'function_call') {
      out.tool = true;
    } else if (t === 'reasoning' || t === 'thinking') {
      out.reasoning = true;
    }
  }
  return out;
}

/**
 * ⑤线判据（v0.8.0）：这个 turn 是不是**「零正文 turn」**。
 *
 * 定义（只看**结构**，不看正文 —— 所以既不涉隐私，也不必把思考再抄一份落盘）：
 *   **整个 turn 里没有任何 text 块、也没有任何 tool-call 块，但有消息只含 reasoning 块。**
 *
 * ⚠️ 为什么要等整个 turn（在 `turn/end` 才判）：一个 turn 可有多个 step，
 *   中途某个 step"暂时只有思考"完全正常（下一步就会调工具或写正文）。
 * ⚠️ 为什么要求「至少一条只含 reasoning 的消息」：否则会把**用户刚发出就取消**的空 turn
 *   （一条 assistant 消息都没有）也算进来 ⇒ 那是用户行为，不是引擎故障。
 *
 * @param {{sawText?:boolean, sawTool?:boolean, reasoningOnlyCount?:number}} st 该 turn 的累计状态
 */
export function isEmptyTurn(st) {
  if (!st) return false;
  if (st.sawText) return false;
  if (st.sawTool) return false;
  return (st.reasoningOnlyCount ?? 0) > 0;
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
        try {
          // v0.7.6：默认落点改为按 `DSH_HOME` 派生后，**目录不再保证预先存在**
          //   （旧版写死的本机目录恰好已在）⇒ 不 mkdir 的话，新环境会**静默不写日志**。
          //   失败仍一律吞掉：落盘是尽力而为，不该影响会话。
          mkdirSync(dirname(path), { recursive: true });
          fs.appendFileSync(path, `${stamp()} ${line}\n`);
        } catch { /* ignore */ }
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
  // §F 收口（第 4 轮审阅 ①②）：**生效值只算一次**，注入处 / loaded 行 / deprecation 判据共用 ——
  //   三处各写一遍就会漂（实测：loaded 报错生效值、deprecation 判据成死代码）。
  //   旧键 `p1bSteerMaxPerSession` 的兼容判据 = 「用户显式写了旧键」且「新键仍是 DEFAULTS 值」。
  const p1bLegacyMax = cfg.p1bSteerMaxPerSession;
  const p1bEpMax = Math.max(1,
    (p1bLegacyMax != null && cfg.p1bSteerMaxPerEpisode === DEFAULTS.p1bSteerMaxPerEpisode)
      ? p1bLegacyMax : (cfg.p1bSteerMaxPerEpisode ?? 2));
  const p1bHardMax = Math.max(1, cfg.p1bSteerMaxPerSessionHard ?? 8);

  /** P1-b 能力自检：已探测过的会话（每个会话只打一行，防空转日志） @type {Set<string>} */
  const capProbed = new Set();

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    try {
      const { agent, turn, signal } = payload ?? {};
      if (agent && signal) signals.set(agent, { signal, turn, at: Date.now() });
      const sid = agent?.session?.id ?? agent?.session?.header?.id;
      if (sid) agentsBySession.set(sid, agent);
      // ── ①c P1-b **能力自检**（2026-10-07 机主定「**先解决能不能注入**」）────────────
      // 为什么要有它：`agent.steer` 能不能用，原先**只能等一次真循环**才知道 ——
      //   而今天它是 **0 次触发**（`grep -c EMPTY-TURN-STEER` = 0）⇒ 那条路等于没法验证。
      //   这里在**任何一次 LLM 请求**时就地探测并留痕 ⇒ **不必等循环**就能回答"API 在不在"。
      // ⚠️ 边界：它回答的是「**能力在不在**」，**不回答**「注入有没有用」——
      //   后者必须真循环 + 观测（`P1B-OBSERVE`），两者别混。
      if (sid && !capProbed.has(sid)) {
        capProbed.add(sid);
        // ⚠️ 本行是 `p1b-stats.sh` 的**机器可读行**：格式必须保持 `steer=<bool> cancel=<bool>`，
        //   说明文字里**不要再出现布尔字面量** —— v0.8.2 首版这里写了 `steer=false ⇒ …`，
        //   被统计脚本的宽正则在同一行上数了两次 ⇒ 报出假的 `1/2 = 50%` 与一条假 🚩。
        note(`P1B-CAPABILITY session=${sid} steer=${typeof agent?.steer === 'function'} `
           + `cancel=${typeof agent?.cancel === 'function'} inbox=${typeof agent?.inbox} `
           + `—— 能力探测行：注入要求 steer 可用（P1-b 与 ⑤ 线共用同一个 API）；`
           + `拿不到就先解决这一层，不是调参能救的`);
      }
      if (agent && turn != null) lastTurnByAgent.set(agent, turn);
    } catch { /* 绝不因自身异常影响请求链 */ }
    return resolved;   // ← 必须原样透传下游结果
  });

  // ── ①c P1-b 的观测状态（v0.8.2 重构：**session/turn 级**，不再是 attempt 级）──────
  // ⚠️ 为什么必须搬到 session 级（拾遗第 3 轮实测，归档 `07-experiments/2026-10-07-p1b-inject-round1.md` §2.1）：
  //   `attemptId` = **一次模型请求 = 一个 step**，而 `steer` 要到**下一个 step 边界**才被 claim 进 prompt
  //   （`dsh-agent-loop:889` 的 preStep / 类型声明 `runtime-types.d.ts:195` 原话 "next step boundary"）
  //   ⇒ **同一 attempt 内、注入点之后的每个字符都是"注入还没进 prompt"时生成的**，
  //     拿它们当读数 = 测注入**不可能影响**的文本。实测两种坏结局：
  //     A) 同一 attempt 继续吐 ⇒ `verdict=无效` 是**结构性必然**（不是测量结果）；
  //     B) 本 step 很快 end、跨 step 继续循环 ⇒ 旧实现**连一行都不留**（`steer=6 / OBSERVE=0`）；
  //     而"注入成功"的样本**更容易**落进 B（模型收尾快 ⇒ 攒不满 N）⇒ 样本系统性偏向"无效"。
  //   ⇒ 现在：**注入之后新出现的 attempt** 才开始累计；本 attempt 的剩余输出只记 `blindChars`；
  //     turn 结束仍未满 N ⇒ **补一行** `verdict=观察中断`（否则统计分母只包含"没救回来的那些"）。
  /** @type {Map<string, {injectAttempt:string, openTurn:number|null, deferred:boolean, spans:number, k24Before:number, k24BeforeWin:number, until:number, acc:string, blindChars:number, injected:boolean, atChars:number}>} */
  const p1bPending = new Map();
  /**
   * ①c 注入额度：**按「循环 episode」计数，不是会话终身制**（拾遗第 2 轮 §1-2 实测）。
   * 为什么必须改单位：会话级终身计数下，一个常驻会话的样本天花板 = `p1bSteerMaxPerSession`（2），
   *   而统计脚本自己规定「n<5 不足以下结论」⇒ **重启后观察在统计上不可能出结论**。
   * 现在：同一次失控（窗口内）最多 2 次；距上次注入超过 `p1bEpisodeWindowMinutes` ⇒ 视为新 episode。
   * @type {Map<string, {count:number, lastAt:number}>}
   */
  const p1bSteeredBySession = new Map();
  /** 会话**终身**注入计数（§F 的硬顶依据） @type {Map<string, number>} */
  const p1bSteerLifetime = new Map();
  /** 观测窗口 TTL（§B）：挂太久的窗一律结算，避免「下一个 turn 是谁就算谁」 */
  const p1bTtlMs = Math.max(1, cfg.p1bEpisodeWindowMinutes ?? 10) * 60000;
  /** 取/衰减 episode 计数（⑤ 线共用同一套语义，见 §Q3-2） */
  const episodeOf = (map, sid, now, ttlMinutes) => {
    const rec = map.get(sid);
    const ttl = Math.max(1, ttlMinutes ?? 10) * 60000;
    if (!rec || now - rec.lastAt > ttl) return { count: 0, lastAt: now };
    return { count: rec.count, lastAt: rec.lastAt };
  };

  /**
   * 出观测结论。四条出口都走这里（观察满 N / turn 结束 / 跨 turn / 被新窗口顶掉）⇒ **分母完整**。
   * @param extra 附加上下文（turnEndReason / why 等），只进日志
   */
  const emitP1bObserve = (p, agentRef, sid, interrupted = false, extra = {}) => {
    try {
      const afterWin = Math.min(p.acc.length, cfg.p1bObserveChars);
      const k24After = k24Max(p.acc.slice(-cfg.p1bObserveChars));
      // ⚠️ 读数 2 的口径 = **注入之后新 attempt 的累计文本**（不是整个 buf、也不是本 attempt 的尾巴）
      const still = p.acc.length >= cfg.minChars ? isLooping(p.acc, cfg) : null; // null = 观察量不足
      // ⚠️ `drop` 只在**两个 k24 窗口等长**时才可比（§1-4）：`k24Max` 对周期文本 ≈ (len-23)/period，
      //   **线性于窗口长度**；而 k24Before 的窗口是 min(buf, N) ⇒ 注入早时窗口更小、k24 更小，
      //   算出来的 drop 会虚高甚至为负。interrupted 更是"零观测"（segLen=0 ⇒ k24After=0 ⇒ drop=100%），
      //   那一行看起来像「完美见效」—— 所以这两种情况一律打 `—`。
      const comparable = !interrupted && p.k24Before > 0 && p.k24BeforeWin === afterWin && afterWin > 0;
      const drop = comparable ? Math.round((1 - k24After / p.k24Before) * 100) : null;
      const ok = comparable && p.injected === true
        && k24After <= p.k24Before * (1 - cfg.p1bSuccessDropPct / 100) && still === false;
      // 🔴 §A：**归因**。被 DEFER 过的窗口，其后面的 turn 是「用户新发起的 turn」（被掐断后不会自动
      //   开新 turn）⇒ 循环停没停**无法区分**是注入的功劳还是"掐断 + 换话题"⇒ 不许与普通样本同池计率。
      const attributable = (p.spans ?? 0) === 0;
      const base = ok ? (attributable ? '有效' : '有效(跨turn·不可归因)')
        : (still === true ? '无效' : '不确定');
      // §D：`注入未确认` **优先于** `观察中断` —— 竞态里 steer 尚未 resolve，先别归到"中断"桶，
      //   否则能力层（INJECT 成功）与效果层的计数会互相打脸、且 `injected=false` 与后一行 INJECT 矛盾。
      const verdict = p.injected !== true ? '注入未确认' : (interrupted ? '观察中断' : base);
      const ctx = Object.entries(extra).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join(' ');
      note(`P1B-OBSERVE session=${sid ?? '?'} attempt=${p.injectAttempt} N=${cfg.p1bObserveChars} `
         + `segLen=${p.acc.length} blindChars=${p.blindChars} k24Before=${p.k24Before} k24BeforeWin=${p.k24BeforeWin} `
         + `k24After=${k24After} k24AfterWin=${afterWin} drop=${drop == null ? '—' : drop + '%'} `
         + `line1StillHits=${still} injected=${p.injected} verdict=${verdict} `
         + `turnsSpanned=${p.spans ?? 0} attributable=${attributable}${ctx ? ' ' + ctx : ''} `
         + `—— ⚠️ 基础率 2/6 ⇒ 单次只作记录、不作结论`);
    } catch (e) {
      // ⚠️ 这里**不许静默**（§1-6）：本文件对注入侧的纪律是「SKIP/FAIL 必须留痕」，观测侧同理。
      try { note(`P1B-OBSERVE-FAIL session=${sid ?? '?'} attempt=${p?.injectAttempt ?? '?'} ${String(e).slice(0, 160)}`); } catch { /* ignore */ }
    }
    void agentRef;
  };

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

    // ①c 观测累计（**session 级**）：本 attempt 的剩余输出只记 `blindChars`，
    //   注入之后**新 attempt** 的文本才进读数（`pend.acc`）。
    const sidOfFrame = agent?.session?.id ?? agent?.session?.header?.id;
    {
      const pend = sidOfFrame ? p1bPending.get(sidOfFrame) : null;
      if (pend && c.text) {
        const curTurn = lastTurnByAgent.get(agent) ?? frame.turn ?? null;
        // §B：DEFER 过的窗**绑定它遇到的第一个新 turn**，之后照常走跨 turn 守卫 ——
        //   原来 `deferred=true` 直接豁免了守卫 ⇒ 两个 turn 的文本混进同一读数（实测 segLen 2200 > N 2000）。
        if (pend.deferred && pend.openTurn == null && curTurn != null) pend.openTurn = curTurn;
        // §1-3b：跨 turn ⇒ **先结算再累计**（否则两个 turn 的文本混进同一个窗，还会被下一次注入覆盖）
        if (pend.openTurn != null && curTurn != null && curTurn !== pend.openTurn) {
          p1bPending.delete(sidOfFrame);
          emitP1bObserve(pend, agent, sidOfFrame, true, { why: 'turn-changed' });
        } else if (pend.openedAt && Date.now() - pend.openedAt > p1bTtlMs) {
          // §B：TTL —— 挂太久的窗一律结算并留痕（`P1B-OBSERVE-EXPIRED` 便于统计）
          p1bPending.delete(sidOfFrame);
          note(`P1B-OBSERVE-EXPIRED session=${sidOfFrame} attempt=${pend.injectAttempt} `
             + `ageMs=${Date.now() - pend.openedAt} ttlMin=${cfg.p1bEpisodeWindowMinutes}`);
          emitP1bObserve(pend, agent, sidOfFrame, true, { why: 'ttl-expired' });
        } else {
          if (frame.attemptId === pend.injectAttempt) pend.blindChars += c.text.length;
          else pend.acc += c.text;
          if (pend.acc.length >= pend.until) {
            p1bPending.delete(sidOfFrame);
            emitP1bObserve(pend, agent, sidOfFrame);
          }
        }
      }
    }

    if (st.buf.length >= st.nextCheck) {
      st.nextCheck = st.buf.length + cfg.checkEvery;
      if (isLooping(st.buf, cfg)) {
        st.hits += 1;
        const turn = turnOfAttempt(frame.attemptId);          // ⚠️ 这是 **attempt 尾号**，不是 turn（§G）
        const realTurn = lastTurnByAgent.get(agent) ?? null;   // ← 需要真 turn 的地方一律用它
        const sid = agent?.session?.id ?? agent?.session?.header?.id;
        // v0.3.3：直接取"最近一次请求"的 signal（不再按 frame.turn 索引 —— 那个字段根本不存在）
        const rec = signals.get(agent);
        const sig = rec?.signal;
        const stale = !rec || (Date.now() - rec.at > cfg.signalMaxAgeMinutes * 60000);
        // ── ①c P1-b：命中时注入「停止」类词（**带预注册观测**；见 DEFAULTS 里的长注释）──
        // ⚠️ 与 ⑤ 线**共用 `agent.steer`**（同一 API、另一个触发条件）。
        // ⚠️ 本动作**替机主自动发消息** ⇒ 失败/拿不到能力时必须留痕（SKIP/FAIL），不许静默。
        // ⚠️ **两道限次，各管一层**（别把它们混为一谈）：
        //   · `p1bDone`（attempt 内）—— 同一 attempt 不重复尝试；
        //   · `p1bSteerMaxPerSession`（会话内）—— **这才是安全属性**：`attempt` = 一次模型请求 = **一个 step**
        //     ⇒ 只靠前者挡不住跨 step 的循环。拾遗第 3 轮实测：一个会话注入 **6 次**，而且每条都会
        //     **永久写进 durable transcript**（`dsh-agent-loop:1028 session.append`）——
        //     那不是"发一句话"，是往会话存档里钉 N 条。
        //     姊妹插件 `tools/loop-restart-exp` 的原话：「steer 没有平台级限次保护，无条件重启 = 自造死循环」。
        if (cfg.p1bEnabled !== false && !st.p1bDone && st.hits >= (cfg.p1bInjectAtHit ?? 1)) {
          st.p1bDone = true;
          // §F：**两道**上限 —— per-episode（统计要）**加上**会话终身硬顶（安全属性）。
          //   旧键 `p1bSteerMaxPerSession` 仍兼容（作为 per-episode 值）。
          const epMax = p1bEpMax;       // 生效值统一在 apply() 顶部算一次（第 4 轮 ①②）
          const hardMax = p1bHardMax;
          const now = Date.now();
          const ep = episodeOf(p1bSteeredBySession, sid, now, cfg.p1bEpisodeWindowMinutes);
          const lifeUsed = sid ? (p1bSteerLifetime.get(sid) ?? 0) : 0;
          const hitAt = st.hits;
          // §3（第 4 轮）：**没有 sid 就没法计数、也没法观测** ⇒ 不注入。
          //   原来 `canSteer` 不含 sid，而 QUOTA 条件又要求 `sid` ⇒ 无 sid 时**两道限次被整条旁路**。
          const canSteer = Boolean(sid && agent && typeof agent.steer === 'function');
          if (canSteer && (ep.count >= epMax || lifeUsed >= hardMax)) {
            note(`P1B-INJECT-QUOTA session=${sid} turn=${lastTurnByAgent.get(agent) ?? '?'} `
               + `attempt=${frame.attemptId} —— episode=${ep.count}/${epMax} lifetime=${lifeUsed}/${hardMax}`
               + `（episode 窗口 ${cfg.p1bEpisodeWindowMinutes} min；lifetime 为**会话终身硬顶**），跳过`);
            // §Q2：额度用尽仍命中 ⇒ 视配置决定是否动手（见 DEFAULTS 里 `p1bQuotaAction` 的说明）
            if (cfg.p1bQuotaAction === 'cancel' && typeof agent?.cancel === 'function' && !cfg.dryRun) {
              try {
                agent.cancel(
                  { kind: 'hook', reason: 'loop-fuse: p1b quota exhausted, loop still hitting' },
                  { keepInbox: cfg.cancelKeepInbox },
                );
                st.canceled = true;
                note(`P1B-QUOTA-CANCEL session=${sid ?? '?'} attempt=${frame.attemptId} `
                   + `episode=${ep.count}/${epMax} lifetime=${lifeUsed}/${hardMax} `
                   + `keepInbox=${cfg.cancelKeepInbox} ← 额度用尽且仍命中，已掐断`);
                noteCancel(`CANCEL source=p1b-quota session=${sid ?? '?'} turn=${realTurn ?? '?'} `
                   + `episode=${ep.count}/${epMax} lifetime=${lifeUsed}/${hardMax} `
                   + `keepInbox=${cfg.cancelKeepInbox} cause=hook`);
              } catch (e) {
                note(`P1B-QUOTA-CANCEL-FAIL session=${sid ?? '?'} attempt=${frame.attemptId} ${String(e).slice(0, 160)}`);
              }
            }
          } else {
            const win = Math.min(st.buf.length, cfg.p1bObserveChars);
            const p = {
              injectAttempt: frame.attemptId,
              openTurn: lastTurnByAgent.get(agent) ?? frame.turn ?? null,
              openedAt: Date.now(),
              deferred: false,
              spans: 0,
              atChars: st.buf.length,
              until: cfg.p1bObserveChars,
              k24Before: k24Max(st.buf.slice(-win)),
              k24BeforeWin: win,
              acc: '',
              blindChars: 0,
              injected: false,   // ← 配额**同步预扣**（§1-5）：不等 `.then`，FAIL 也不退
            };
            if (sid && canSteer) {
              // §1-3a：**同步建窗**（原来在 `.then` 里建 ⇒ 与 turn/end 竞态 ⇒ 窗口成孤儿 ⇒ 假「有效」）
              const prev = p1bPending.get(sid);
              if (prev) {
                p1bPending.delete(sid);
                emitP1bObserve(prev, agent, sid, true, { why: 'replaced' });
              }
              p1bPending.set(sid, p);
              p1bSteeredBySession.set(sid, { count: ep.count + 1, lastAt: now });
              p1bSteerLifetime.set(sid, lifeUsed + 1);   // §F：终身计数（预扣，与 episode 同时）
            }
            if (canSteer) {
              // ⚠️ 动态 import ⇒ 不能阻塞流式事件链；**成败都留痕**（本项替使用者发消息，不许静默）
              steerHint(agent, cfg.p1bHint, name).then((via) => {
                p.injected = true;   // 只翻标志；窗口早在上面建好了
                note(`P1B-INJECT session=${sid ?? '?'} turn=${lastTurnByAgent.get(agent) ?? '?'} `
                   + `attempt=${frame.attemptId} hit=${hitAt} via=${via} `
                   + `atChars=${p.atChars} k24Before=${p.k24Before} k24BeforeWin=${p.k24BeforeWin} `
                   + `observeN=${cfg.p1bObserveChars} dropPct=${cfg.p1bSuccessDropPct} `
                   + `quota=episode:${ep.count + 1}/${epMax} lifetime:${lifeUsed + 1}/${hardMax} —— 预注册参数已打印；`
                   + `⚠️ 基础率 2/6（本簇 6 段真循环有 2 段自愈）⇒ 单次结果只作记录、不作证据`);
              }).catch((e) => {
                note(`P1B-INJECT-FAIL session=${sid ?? '?'} attempt=${frame.attemptId} ${String(e).slice(0, 160)}`
                   + ` —— ⚠️ 额度不退（§1-5：通路坏了就该停手，不该每个 step 再试一次）`);
              });
            } else {
              note(`P1B-INJECT-SKIP session=${sid ?? '?'} attempt=${frame.attemptId} —— agent 无 steer（拿不到能力）`);
            }
          }
        }
        // v0.3.3 节流：同一 attempt 命中多次只记 1、6、11… 次（原实现一次命中写一行，
        //   实测同一 attempt 写了 6 行 `hits=1→6`）。
        if (st.hits % 5 === 1) {
          note(`DETECT attempt=${frame.attemptId} len=${st.buf.length} `
             + `kind=${st.kind} hits=${st.hits} hasSignal=${Boolean(sig)} stale=${stale} `
             + `canCancel=${typeof agent?.cancel === 'function'} dryRun=${cfg.dryRun}`);
        }

        if (cfg.dryRun || st.canceled) { /* 观测模式 / 本 attempt 已掐过 ⇒ 不动手 */ }
        else if (st.hits < cfg.textStrikesBeforeCancel) {
          // 2026-09-30 降敏：首次命中先只观察，避免"长思考里反复引用同一段配置"被误杀
          note(`STRIKE-PENDING attempt=${frame.attemptId} len=${st.buf.length} `
             + `hits=${st.hits}/${cfg.textStrikesBeforeCancel} —— 首次命中，继续观察；再次命中才掐断`);
        } else {
          // v0.4.0-B：文本线是**强信号** ⇒ 也计入 strike 池（③线跨 turn 累计用）
          const sid = agent?.session?.id ?? agent?.session?.header?.id;
          const n = sid ? recordStrike(sid, 'text-loop', { turn: realTurn }) : 0;
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
              note(`ABORT-VIA-CANCEL session=${sid ?? '?'} attempt=${frame.attemptId} `
                 + `len=${st.buf.length} hits=${st.hits} keepInbox=${cfg.cancelKeepInbox} `
                 + `cause=hook ← 文本重复判定为循环，已中止该 turn`);
              noteCancel(`CANCEL source=text-loop session=${sid ?? '?'} turn=${realTurn ?? '?'} `
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
              note(`ABORT-VIA-SIGNAL attempt=${frame.attemptId} turn=${realTurn ?? '?'} `
                 + `len=${st.buf.length} hits=${st.hits} sigTurn=${rec?.turn ?? '?'}`);
            } catch (e) {
              note(`ABORT-FAIL attempt=${frame.attemptId} ${String(e)}`);
            }
          }
          if (!st.canceled) {
            note(`ABORT-SKIP attempt=${frame.attemptId} —— 检测到循环但没有可用中止原语`
               + `（canCancel=${typeof agent?.cancel === 'function'} hasAbortableSignal=`
               + `${Boolean(sig && typeof sig.abort === 'function')}）`);
          }
        }
        // ── ④线：把"判中的这一刻"存成离线样本（v0.6.0）──────────────
        // 放在 if/else 之外 ⇒ **弱命中（只记 strike）也 dump** —— 那才是调阈值时最需要的误杀候选。
        {
          const ev = extractCycleEvidence(st.buf, cfg);
          dumpSample({
            kind: 'text-loop', sid, turn: realTurn, attemptId: frame.attemptId,
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
  // ── v0.8.0 ⑤线「零正文 turn」的判定与动作 ─────────────────────────
  /** 同一会话**连续**零正文 turn 计数（中间出现一个正常 turn ⇒ 归零）。 */
  const emptyTurnStreak = new Map();
  /** `action:'steer'` 时，每会话已补救次数（防"补救"本身变成新循环）。 */
  const emptyTurnSteered = new Map();

  /**
   * ⑤线动作。**只在 `turn/end` 调用**（此时该 turn 的正文已成定局）。
   * 默认 `emptyTurnAction:'log'` ⇒ 只写日志 + 落**结构样本**（样本里**不含思考正文**）。
   * 上膛（`'steer'`）= 自动给 agent 补一句「你没有输出正文」—— 属于**替机主自动发消息**，
   *   所以**发布包默认关闭**（本机由 `profiles/web/cordis.patch.yml` 显式钉 `'steer'`）；
   *   且受 `emptyTurnSteerMax`（每会话上限）约束。
   */
  const evaluateEmptyTurn = (sid, st) => {
    try {
      if (!isEmptyTurn(st)) {
        if ((emptyTurnStreak.get(sid) ?? 0) > 0) emptyTurnStreak.set(sid, 0);  // 有正常 turn ⇒ 断链
        return;
      }
      const streak = (emptyTurnStreak.get(sid) ?? 0) + 1;
      emptyTurnStreak.set(sid, streak);
      const limit = Math.max(1, cfg.emptyTurnLimit ?? 1);
      const stat = `output=${st.outputTokens ?? '?'} reasoning=${st.reasoningTokens ?? '?'} `
        + `msgs=${st.msgCount ?? 0} reasoningOnly=${st.reasoningOnlyCount ?? 0}`;
      if (streak < limit) {
        note(`EMPTY-TURN-PENDING session=${sid} turn=${st.turn} streak=${streak}/${limit} ${stat}`);
        return;
      }
      const action = cfg.emptyTurnAction ?? 'log';
      note(`EMPTY-TURN session=${sid} turn=${st.turn} streak=${streak}/${limit} action=${action} ${stat}`);
      // 结构样本：判据是结构性的 ⇒ **不再抄一份思考正文**（少一份内容外泄面）
      dumpSample({
        kind: 'empty-turn', sid, turn: st.turn,
        why: `turn 只有 reasoning、无 text/tool-call（连续 ${streak}/${limit}）`,
        acted: action === 'steer',
        evidence: {
          streak, limit, action,
          messages: st.msgCount ?? 0, reasoningOnlyMessages: st.reasoningOnlyCount ?? 0,
          outputTokens: st.outputTokens ?? null, reasoningTokens: st.reasoningTokens ?? null,
          step: st.step ?? null,
          startedAtLocal: new Date(st.startedAt ?? Date.now()).toISOString(),
        },
      });
      if (action !== 'steer') return;
      const maxSteer = Math.max(0, cfg.emptyTurnSteerMax ?? 3);
      // ⚠️ 与 ①c **同一套语义**（拾遗 §Q3-2）：按 episode 计数，不再是会话终身制 ——
      //   否则一个常驻会话里第 3 次以后的零正文 turn 永远不会被补救（同一原则两处必须一起动）。
      const now05 = Date.now();
      const used = episodeOf(emptyTurnSteered, sid, now05, cfg.p1bEpisodeWindowMinutes).count;
      if (used >= maxSteer) {
        note(`EMPTY-TURN-STEER-SKIP session=${sid} —— 本 episode 已补救 ${used}/${maxSteer} 次`);
        return;
      }
      const ag = agentsBySession.get(sid);
      if (!ag || typeof ag.steer !== 'function') {
        note(`EMPTY-TURN-STEER-SKIP session=${sid}（拿不到 Agent，或它没有 steer）`);
        return;
      }
      // ⚠️ 与 ①c P1-b 共用 `steerHint()` —— 内部含动态 import + 失败降级。
      steerHint(ag, cfg.emptyTurnHint, name).then((via) => {
        emptyTurnSteered.set(sid, { count: used + 1, lastAt: now05 });
        note(`EMPTY-TURN-STEER session=${sid} turn=${st.turn} via=${via}（第 ${used + 1}/${maxSteer} 次）`);
      }).catch((e) => {
        note(`EMPTY-TURN-STEER-FAIL session=${sid} ${String(e).slice(0, 160)}`);
      });
    } catch { /* 绝不影响会话事件链 */ }
  };

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
          // ── v0.8.0 ⑤线：本 turn 的"有没有正文/工具调用"累计账 ──────────
          msgCount: 0, sawText: false, sawTool: false, reasoningOnlyCount: 0,
          outputTokens: 0, reasoningTokens: 0,
        });
        return;
      }
      if (type === 'turn/end') {
        // ── v0.8.0 ⑤线：**turn 收口才判**「零正文」（多 step 的 turn 中途无正文是正常的）──
        const stEnd = turns.get(`${sid}#${d.turn}`);
        if (stEnd && cfg.emptyTurnDetect !== false) evaluateEmptyTurn(sid, stEnd);
        // ── ①c P1-b：turn 收口 ⇒ 观测窗口关闭。**未满 N 也必须留一行**（拾遗第 3 轮 §2.1 第 4 点）：
        //   否则"注入后模型很快收尾"的成功样本会**静默消失**，统计分母只剩"没救回来的那些"
        //   ⇒ 效果层的率会被系统性拉成"无效"。
        const pendEnd = p1bPending.get(sid);
        if (pendEnd) {
          const reasonKind = d.reason?.kind ?? null;
          // §1-1（拾遗第 2 轮 🔴）：默认参数下 ① 线是「hit#1 注入、hit#2 掐断」，两者同 attempt 内
          //   相隔约 `checkEvery`(200) 字符；而 `cancel(keepInbox:true)` **不清 inbox**、掐断后
          //   **不会自动开新 turn**（`wakeAfterAbort=false`）⇒ 那条 steer 要等**用户下次发言**才进 prompt。
          //   若此时就关窗口 ⇒ 永远只得到 `segLen=0 / 观察中断`，而**真正消费 steer 的那个 turn 一行都不测**。
          //   ⇒ 判据现成：`segLen===0` ⇔ 没有任何新 attempt 消费过它。此时**把窗口带进下一个 turn**
          //     （最多 1 次，防无限悬挂），并在日志里明记。
          if (pendEnd.acc.length === 0 && reasonKind === 'aborted' && (pendEnd.spans ?? 0) < 1) {
            pendEnd.spans = (pendEnd.spans ?? 0) + 1;
            pendEnd.deferred = true;
            pendEnd.openTurn = null;   // 🔴 必须清空：绑定逻辑靠 `openTurn == null` 才有机会认领新 turn
                                       //    （不回填的话，守卫会拿旧 turn 直接判 turn-changed 结算掉 —— 实测过）
            note(`P1B-OBSERVE-DEFER session=${sid} attempt=${pendEnd.injectAttempt} `
               + `turnEndReason=${reasonKind} turnsSpanned=${pendEnd.spans} —— 注入尚未被消费`
               + `（本 turn 被掐断且无新 attempt），窗口带进下一个 turn`);
          } else {
            p1bPending.delete(sid);
            emitP1bObserve(pendEnd, agentsBySession.get(sid), sid, true, { turnEndReason: reasonKind });
          }
        }
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
      // ── v0.8.0 ⑤线：累计"这个 turn 到底有没有正文 / 工具调用" ──────────
      //    ⚠️ 只统计**块类型**，不读正文内容（判据是结构性的，也不需要复制思考正文）。
      if (type === 'assistant/message') {
        const cls = classifyAssistantBlocks(d.message?.content);
        st.msgCount = (st.msgCount ?? 0) + 1;
        if (cls.text) st.sawText = true;
        if (cls.tool) st.sawTool = true;
        if (cls.reasoning && !cls.text && !cls.tool) {
          st.reasoningOnlyCount = (st.reasoningOnlyCount ?? 0) + 1;
        }
        const u = d.usage;
        if (u && Number.isFinite(u.outputTokens)) {
          st.outputTokens = (st.outputTokens ?? 0) + u.outputTokens;
          st.reasoningTokens = (st.reasoningTokens ?? 0) + (Number(u.reasoningTokens) || 0);
        }
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

  note(`loaded v${VERSION} enabled=${cfg.enabled} dryRun=${cfg.dryRun} minChars=${cfg.minChars} `
     + `window=${cfg.window} repeats=${cfg.repeats} history=${cfg.history} `
     + `signalMaxAgeMinutes=${cfg.signalMaxAgeMinutes} `
     + `abortViaCancel=${cfg.abortViaCancel} cancelKeepInbox=${cfg.cancelKeepInbox} `
     + `stallMinutes=${cfg.stallMinutes} stallMinutesWithTool=${cfg.stallMinutesWithTool} `
     + `progressEvents=${(cfg.progressEvents ?? []).join(',')} `
     + `repeatCallLimit=${cfg.repeatCallLimit} repeatCallCancel=${cfg.repeatCallCancel} `
     + `strikesBeforeCancel=${cfg.strikesBeforeCancel} strikeWindowMinutes=${cfg.strikeWindowMinutes} `
     + `cancelOnStrikes=${cfg.cancelOnStrikes}`);
  note(`loaded v${VERSION} dumpSamples=${cfg.dumpSamples} dumpDir=${cfg.dumpDir} `
     + `dumpMaxChars=${cfg.dumpMaxChars} dumpKeep=${cfg.dumpKeep} dumpRedact=${cfg.dumpRedact} `
     + `dumpDenylistPath=${cfg.dumpDenylistPath}`);
  note(`loaded v${VERSION} emptyTurnDetect=${cfg.emptyTurnDetect} emptyTurnLimit=${cfg.emptyTurnLimit} `
     + `emptyTurnAction=${cfg.emptyTurnAction} emptyTurnSteerMax=${cfg.emptyTurnSteerMax}`);
  // ⚠️ 为什么把 ①b/①b-2 参数也打出来（2026-10-07 加）：**代码改动没有"特征串"就没法判生效**。
  //    本机踩过两次：① `loaded v0.8.1` 的版本号是**运行时读 package.json** ⇒ 旧代码进程重启后
  //    照样打印新版本号；② 滑窗支加完时，`loaded` 行**一个字都没变** ⇒ 只能靠
  //    "进程启动时间 > index.js mtime" 这种外部判据。打出来之后，**一行 grep 就能判**。
  //    ⚠️ 注意：**hot 重载也会打印本行**（它 ≠ 换掉代码 —— `link:` + ESM 缓存）⇒
  //    看见本行**不代表**新代码在跑；判定仍要用「进程启动时间 > 代码 mtime」。
  note(`loaded v${VERSION} lowDivDetect=${cfg.lowDivDetect} lowDivMaxUniq=${cfg.lowDivMaxUniq} `
     + `lowDivSlideDetect=${cfg.lowDivSlideDetect} slideWin=${cfg.lowDivSlideWin} `
     + `slideStep=${cfg.lowDivSlideStep} slideUniq=${cfg.lowDivSlideUniq} slideMinRepeat=${cfg.lowDivSlideMinRepeat}`);
  // §1-8：①c/⑤ 的**行为参数必须有 load-time 特征串** —— 否则"日志里没有 P1B-* 行"时
  //   无法区分「没触发」与「跑的是旧代码」（本仓库自己立的规矩，见上面那段注释）。
  note(`loaded v${VERSION} p1bEnabled=${cfg.p1bEnabled} injectAtHit=${cfg.p1bInjectAtHit} `
     + `observeN=${cfg.p1bObserveChars} steerMaxPerEpisode=${p1bEpMax} steerMaxHard=${p1bHardMax} `
     + `episodeWinMin=${cfg.p1bEpisodeWindowMinutes} dropPct=${cfg.p1bSuccessDropPct} quotaAction=${cfg.p1bQuotaAction} `
     + `emptyTurnAction=${cfg.emptyTurnAction} emptyTurnSteerMax=${cfg.emptyTurnSteerMax}`);
  // §F：旧键名兼容 + 一行 deprecation（只有用户显式写了旧键才会走到这里）
  if (p1bLegacyMax != null && cfg.p1bSteerMaxPerEpisode === DEFAULTS.p1bSteerMaxPerEpisode) {
    note(`loaded v${VERSION} ⚠️ 配置项 p1bSteerMaxPerSession 已改名为 p1bSteerMaxPerEpisode`
       + `（旧名仍兼容，本次按旧值 ${p1bEpMax} 生效）`);
  }
  // §C：`minChars < p1bObserveChars` ⇒ `k24BeforeWin` 恒小于 `k24AfterWin` ⇒ `comparable=false`
  //   ⇒ **`verdict=有效` 结构上不可达**（测试夹具就是 minChars:1000）。默认两者相等故不咬，但要说出来。
  if (cfg.minChars < cfg.p1bObserveChars) {
    note(`loaded v${VERSION} P1B-WARN minChars(${cfg.minChars}) < observeN(${cfg.p1bObserveChars}) `
       + `⇒ k24BeforeWin 恒小于 k24AfterWin ⇒ verdict=有效 不可达（请把两者设为相等，或调大 minChars）`);
  }

  // ─────────────────────────────────────────────────────────────────────
  // ⚠️ 可选挂载点（**维护者本机的实验代码，不属于本项目的功能**）
  //   见 README「关于 index.js 末尾的可选挂载点」一节 —— 那里是对使用者的完整说明。
  //   * `exit-check.mjs` **不在** `package.json` 的 `files` 白名单里 ⇒ **发布包里没有这个文件**；
  //     干净安装下它不存在 ⇒ 下面的 `import` 失败、被 `catch` 吞掉，插件功能与日志一切照常。
  //   * ⚠️ **但它是一个挂载点，不是一段死代码**：**谁能把 `probeMount` 打开、
  //     又能在包目录里写一个同名文件**，谁就能在插件加载时执行代码，并拿到**活的**插件
  //     上下文 `ctx` 与本包的配置。**0.7.6 没有这个面** —— 这是本版本新增的，
  //     也是它**将来必须被删掉**的原因之一。
  //     为把默认暴露面**降到零**，v0.8.1 给它加了配置开关 `probeMount`（**默认 `false`**）：
  //     不开就不会 `import` 任何文件 ⇒ 只有**显式打开它的人**才可能碰到上面那条路径。
  //   * ESM 的相对说明符以**本文件所在目录**为基准解析（**不是 cwd**）⇒ 它**不会**加载
  //     使用者项目里恰好同名的文件。（2026-10-07 实测两个方向：同名文件放 cwd、包目录里没有
  //     ⇒ 不加载；包目录里有 ⇒ 加载。两个方向都只认包目录。）
  //   * 它有**本机范围内**的别的用途，**该用途不在本项目的范围内**，此处不作说明。
  //   * 🔻 **将来会移除**：现在还在，是因为它对应的那份本机工作尚未收尾；
  //     移除 = 删掉下面这几行 import（连同本段注释）。
  // ─────────────────────────────────────────────────────────────────────
  note(`loaded v${VERSION} probeMountPoint=optional —— exit-check.mjs 不在发布包内，不属于本项目功能，将来移除（见 README）`);
  // ── 注入通路自检（v0.8.2）：`agent.steer` 只是"接口在"，**消息构造**还要拿到
  //    `@deepseek-ai/dsh-llm` 的 `createUserMessage` —— 而它是 **dsh 内部包**，
  //    `link:` 装的插件**未必在解析路径上够得着**（2026-10-07 实测：测试环境 ERR_MODULE_NOT_FOUND）。
  //    ⇒ 这一行把结论直接写进日志（不必等一次真循环）；拿不到时会走**自建 UserMessage 兜底**
  //    （见 `buildSteerMessage`），日志里用 `via=` 区分走了哪条路。
  try {
    const r = typeof import.meta.resolve === 'function' ? import.meta.resolve('@deepseek-ai/dsh-llm') : '(no import.meta.resolve)';
    note(`STEER-RESOLVE ok ${String(r).slice(0, 120)}`);
  } catch (e) {
    note(`STEER-RESOLVE fail ${String(e).slice(0, 160)} ⇒ 注入将走自建 UserMessage 兜底（via=self-built）`);
  }
  if (cfg.probeMount === true) {          // ← 默认 false：不开就不加载任何东西
    import('./exit-check.mjs')
      .then((m) => m.attach(ctx, cfg, { redactSecrets }))
      .catch(() => { /* 文件不存在 = 未启用，正常路径 */ });
  }
};

export const Config = undefined;
