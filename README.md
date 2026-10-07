# dsh-local-loop-fuse（原名 dsh-loop-guard，2026-10-03 改名）

> **曾用名与同名包说明**
> 本项目原名 `dsh-loop-guard`，2026-10-03 起改用现名 `dsh-local-loop-fuse`。
> ⚠️ npm 上另有一个**与本项目无关**的 `dsh-loop-guard`（作者 `carbide`）—— 本项目**没有使用、也没有派生**它的任何代码。
> **可自行复核的比对**（2026-10-03，对照它 `dsh-loop-guard@0.1.1` 的公开 tarball）：
> 非平凡行完全重合 **0** 行 · 长度 ≥ 20 的字符串常量重合 **0** 个 · 标识符交集仅 66 个通用词（`push` / `return` / `agent` …，
> 双方的专有标识符如 `REPEAT_CALL_DENIED` 与 `ABORT-VIA-CANCEL` 互不相交）· 本项目**零依赖**
> （它依赖 `@deepseek-ai/schemastery` + `@deepseek-ai/dsh-brand`）· 检测机制亦不同：它拦"同一工具调用签名重复"（工具执行前），
> 本项目检测 **assistant 文本 / 推理流的重复** 并通过请求级 `AbortSignal` 中止该 turn。
> 改名正是为了避免混淆，以及避免 `dsh plugin add dsh-loop-guard` 误装到别人的实现。请只以本包名或 `link:` 方式安装本项目。

DSH 原生插件：**输出 / 思考循环护栏**。三条线：
① 监听 assistant 流式增量，对 `reasoning-delta` / `text-delta` 做宽松重复检测（**强信号**，
累计命中达 `textStrikesBeforeCancel` ⇒ `agent.cancel({kind:'hook'},{keepInbox:true})` 掐断当前 turn）；
② 行动层 **「无进展」判据**（v0.4.0 重写：连续 `stallMinutes` 分钟**没有任何进展事件** ⇒ 判停滞）；
③ 同一会话窗口内**强信号**累计达 `strikesBeforeCancel` ⇒ 真切断。
**① 线已上膛（`dryRun=false`，2026-09-29 维护者定）**。

- 版本：**v0.8.2**（2026-10-07：**①b 线「低多样性高重复」** —— 修「带噪声的交替空转」**结构性漏报**）
  ⚠️ `0.8.0` **未发布**，⑤ 线随 `0.8.1` 一起发。
- ⚠️ **本包 `index.js` 末尾有一个可选挂载点**（不属于本项目功能，**将来会移除**）——
  见下方「关于 `index.js` 末尾的可选挂载点」一节。
- 上一版 **v0.7.6**（2026-10-04：**去掉写死的本机绝对路径** —— 公开发布后自查发现，原默认落点全是
  作者本机路径（`<workspace>/.tmp/…`、`<插件目录>/samples`），**别人装上后写日志与 dump 全部静默失效**
  （两者都在 `try{}catch{}` 里 ⇒ 不报错、不崩 —— 最坏的失败形态：以为在跑，其实什么都没记）。
  现默认改为**按本实例 `DSH_HOME` 派生**：`${DSH_HOME}/logs/dsh-local-loop-fuse/`；
  并给 `appendLine` 补了 `mkdirSync`（旧默认值指的本机目录恰好已存在，换个环境就不会写日志）；
  另把 `loaded` 行的版本号改为**动态读 `package.json`**（此前硬编码 `v0.7.1`，bump 后从不更新 ——
  2026-10-03 曾因此误判"升级没生效"）。本机行为**不变**：旧路径由 `profiles/web/cordis.patch.yml`
  的 `config:` 显式钉住。测试 19/12/14/42 全绿）
- 上一版 **v0.7.5**（2026-10-03：**修 `cancelWithHook()` 的去重键 `sid` → `sid#turn`** —— 原先一旦某会话被掐断过一次，
  它**后续所有 turn 永久不再被掐**（实测：turn 3 掐断后，turn 4 同参连击 6→23 次只报警不动作）；
  现改为"同一 turn 不重复切、**新 turn 仍可再切**"，并在 `turn/end` 清理条目；`test-cancel` 13 → 14 用例全绿。
  v0.7.2 补「兼容性」一节 + `engines.node`；v0.7.1 起包名与日志名统一为 `loop-fuse`、四线齐备；
  v0.6.0 起新增 ④线「触发即 dump 样本」；v0.5.0 起新增 ②b 线「同参调用连击」）
- 上一版 **v0.4.0**（2026-10-01：**②线判据推倒重写** —— 旧的 `maxTurnMinutes`（墙钟时长）/
  `maxStepsPerTurn`（步数）**被实测证伪、已删除**；弱信号不再直接触发 cancel；③线 cancel 参数与①线对齐。
  事故复盘见知识库 `05-issues/open/loop-fuse-kills-long-tasks.md`）
- 上一版 v0.3.3（2026-09-29：修 ① 线「检测有效但掐不死」的两层 bug，见「① 线怎么真掐断」）
- 状态：已装入 `profiles/web`（`link:`），**① 线 `dryRun=false` 已上膛**；⚠️ **重启 dsh 后生效**
  （生效判据：日志 `loaded … dryRun=false … abortViaCancel=true cancelKeepInbox=true`）
- 插件根：`<plugin-dir>/`
- 测试：`bash run-tests.sh`（检测函数 / abort / cancel / dump 四条测试全绿）

## 兼容性（Compatibility）

| 项 | 值 |
|---|---|
| **开发与实测环境** | DSH **0.1.5-rc.1**（生产）、**0.2.0-rc.1**（实验实例）、桌面版 **0.2.0-rc.2** —— 同一份代码在三者上均能 `loaded`，并实际掐断过循环 |
| **依赖的宿主原语** | `agent/request`（waterfall，取请求级 `AbortSignal`）· `agent/assistant-stream`（`reasoning-delta` / `text-delta` 增量）· `session/event`（`turn/*`、`step/*`、`tool/*`）· `Agent.cancel(cause, {keepInbox})` |
| **Node** | ≥ 20（开发环境 v22.23.2） |
| **`peerDependencies`** | **故意不声明** —— 官方插件普遍写 `^0.1.5-rc.2` 这类窄范围，宿主升到 `0.2.0-rc.1` 时会因 peer 范围不符被拒绝加载（需 `dsh plugin allow-version` 豁免）。本插件只用上述稳定原语、不绑定具体宿主版本号，故留空以跨版本可用 |

⚠️ 若宿主大版本（0.3+）改动了上述原语签名，本插件需要相应适配 —— 升级后请确认日志里出现
`loaded …` 自检行与 `EVENT-OK` 行。

---

## 为什么需要它（hook 做不到）

本地 **ftllm** 在长 agent 上下文下会陷入"思考循环"：实测 5 分钟内上下文占用从
38.7% 匀速涨到 43.7%、持续 44 t/s 不停，而 DSH 侧早已停止写日志。

先用 `@deepseek-ai/dsh-hooks-claude-code` / `-codex` 试过，**结论是做不到**：

| hook 事件 | 实测限制 |
|---|---|
| `{"continue": false}` | 被日志记录，但**无运行级效果** |
| `Stop` | 只能强制"再来一步"，不能中止 |
| `transcript_path` | 恒为空 |
| `last_assistant_message` | 不下发 → **hook 拿不到输出内容，既无法检测也无法中止** |

原生插件层可以拿到两样关键东西：

- `agent/request` → payload 带 **`signal: AbortSignal`**（该请求的中止信号）
- `agent/assistant-stream` → `frame.chunk` 含 `{ type: 'reasoning-delta' | 'text-delta', text }`

设计原则（维护者 2026-09-28 定）：

1. **保留"适当循环"** —— 正常 CoT 本来就会反复推敲，阈值必须宽松，**宁漏报不误杀**；
2. **先接受"止损偏晚"** —— 只在累计文本够长后才检测，不做激进掐断；
3. **第一版默认 `dryRun`** —— 先证明能拿到数据、能判对，再开杀。

---

## 安装

```bash
dsh plugin --profile web add link:<plugin-dir>/
sudo systemctl restart dsh
```

`dsh plugin add` 会写 `<DSH_HOME>/profiles/web/package.json` 的 `dependencies`，**并自动把包名
补进 `dsh.profile.bundles`**（`dsh/lib/plugin-*.js`）。已装状态（可核对）：

```bash
grep -n "loop-fuse" <DSH_HOME>/profiles/web/package.json
# 13:  "dsh-local-loop-fuse": "link:<plugin-dir>/"
# 32:  "dsh-local-loop-fuse"
```

卸载：`dsh plugin --profile web remove dsh-local-loop-fuse`。

### ⚠️ 必须声明 `dsh.bundle.patch`

一个包**只有自己的 `package.json` 声明了 `dsh.bundle.patch`**，才会被当作 profile bundle 加载：

```json
{
  "exports": { "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` 内容 = 往插件列表插入一行：

```yaml
- insert:
    - id: dsh-local-loop-fuse
      name: 'dsh-local-loop-fuse'
```

**踩过的坑**：曾手工把包名写进 `bundles` 而不给 `dsh.bundle` 声明 → 启动**崩溃循环**
（`cannot resolve profile bundle "dsh-local-loop-fuse"`）。手写 manifest 时两处必须成对。

---

## 配置项

配置通过插件 config 传入，与 `DEFAULTS` 合并（index.js 顶部）。
**在哪写**：该 profile 的 `cordis.patch.yml` 里加一条（`--dump-config` 可核对是否生效）：

```yaml
- id: dsh-local-loop-fuse
  config:
    logPath: /path/to/loop-fuse.log
    dumpDir: /path/to/samples
```

⚠️ **落点默认值是可移植的**（v0.7.6 起）：`logPath` / `cancelLogPath` / `dumpDir` 一律派生自
`${DSH_HOME}`（默认 `~/.dsh`）⇒ 装到哪台机器就写哪台机器的 `$DSH_HOME/logs/dsh-local-loop-fuse/`，
**不需要额外配置**；要改位置再用上面那段覆盖。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时 `apply()` 直接返回 |
| `probeMount` | `false` | **可选挂载点**：`true` 时 `index.js` 末尾会 import 一个**本地文件**（作者本机用它挂实验探针）。默认关闭 ⇒ 本包默认**不加载任何本地文件**；见文末「关于 `index.js` 末尾的可选挂载点」 |
| `dryRun` | `false` | `false` = 命中即**掐断**（走 `agent.cancel`，v0.3.3 **已上膛**）；`true` = 只记日志。⚠️ ①c 的**注入**不受它控制（注入看 `p1bEnabled`）——「先注入、后掐断」是两条独立的动作 |
| `minChars` | `2000` | 累计输出达此长度才**开始**检测（保护正常短回答） |
| `window` | `600` | 比对用的特征窗口（字符），取缓冲区**末尾** `window` 个字符（2026-09-30 降敏：300→600）|
| `history` | `4000` | 回溯范围（字符），在末尾之前这段里数重复次数 |
| `repeats` | `3` | 同一窗口在回溯范围内出现 ≥ 此数 ⇒ 判定循环（tail 自身算 1 次） |
| `textStrikesBeforeCancel` | `2` | **① 线命中达几次才真掐断**（2026-09-30 降敏：首次命中只 `STRIKE-PENDING`，第二次才掐）|
| `lowDivDetect` | `true` | **①b 总开关**（`false` = 退回只有 ① 线精确匹配的行为）|
| `lowDivWindow` | `2000` | ①b 末窗口径：统计窗口（字符，取末尾）|
| `lowDivNgram` | `24` | ①b/①c 共用的片段长度（字符）|
| `lowDivMaxUniq` | `45` | ①b 末窗内**唯一字符数**上限（低于它才算"用词贫乏"）|
| `lowDivMinRepeat` | `10` | ①b 同一 `lowDivNgram` 片段在**末窗**内出现次数下限 |
| `lowDivSlideDetect` | `true` | **①b-2 滑窗支总开关**（`false` = 退回只有末窗口径 ⇒ 局部循环永远漏）|
| `lowDivSlideWin` | `400` | 滑窗窗口（字符）|
| `lowDivSlideStep` | `100` | 滑窗步长（字符）；**末尾不足一步时额外补一个「以 buf 末尾结尾」的窗**（尾部补偿，见下）|
| `lowDivSlideUniq` | `30` | 滑窗内唯一字符数上限。⚠️ **不能沿用末窗的 45**（滑窗 400 下 45 误报 17%）|
| `lowDivSlideMinRepeat` | `3` | 滑窗内 k-gram 重复次数下限（**窗口内**计算，不跨窗）。曾取 2，2026-10-07 实测 `2→3` 免费（召回仍 5/5）⇒ 取 3 换误报余量 |
| `p1bEnabled` | `false`（作者本机显式 `true`）| **①c 总开关**：① 线命中时向 agent 注入一句「停止推理」提示（见 v0.8.2 ①c 节）。⚠️ 默认 `false` 是**刻意**的：它替使用者自动发消息 |
| `p1bInjectAtHit` | `1` | **预注册**：第几次 ① 线命中后注入（1 = 首次命中即注入）|
| `p1bObserveChars` | `2000` | **预注册 N**：注入后再观察多少字符才出观测结论 |
| `p1bSuccessDropPct` | `50` | **预注册成功阈值**：`k24` 降到 ≤ 注入前的 50% **且** ① 线不再命中 ⇒ 判"有效" |
| `p1bSteerMaxPerSession` | `2` | **每会话注入上限**（🔴 安全属性，别删）：`attempt` = 一个 step ⇒ 光靠 attempt 内的去重挡不住跨 step 循环（实测一会话 6 条，且每条**永久进会话存档**）|
| `p1bEpisodeWindowMinutes` | `10` | **注入额度的计数窗口**：距上次注入超过它 ⇒ 视为新的「循环 episode」，额度归零。⚠️ 额度单位必须是 **episode** —— 会话终身制会让样本天花板 = `p1bSteerMaxPerSession`（2），**低于统计脚本自己要求的 n≥5** |
| `p1bHint` | （见 `DEFAULTS`）| 注入的提示文本（⚠️ 会作为**用户消息**进入会话，等同替使用者发话）|
| `checkEvery` | `200` | 每新增这么多字符检查一次 |
| `abortViaCancel` | `true` | **① 线真掐断的主路径**：调 `agent.cancel({kind:'hook',reason})`（v0.3.3 新增，见下节「为什么不能 `signal.abort()`」）|
| `cancelKeepInbox` | `true` | 掐断时**保留排队消息** —— 只终止这场跑飞的 turn，不牵连用户排队输入（v0.3.3 新增）|
| `signalMaxAgeMinutes` | `10` | 保存的 `AbortSignal` 超过此时长视为**陈旧** ⇒ 不走兜底 abort（v0.3.3 新增）|
| ~~`maxTurnMinutes`~~ | ~~15~~ | ⛔ **v0.4.0 已删除**（墙钟时长被实测证伪：2026-10-01 两个正常长 turn 被它误杀）。**不要再加回来** |
| ~~`maxStepsPerTurn`~~ | ~~60~~ | ⛔ **v0.4.0 已删除**（步数无区分度：正常会话 max=52 连击） |
| `stallMinutes` | `10` | **② 行动层**：连续**没有任何进展事件**达此分钟数 ⇒ 判停滞（v0.4.0 新增，替代上面两个旧判据）|
| `stallMinutesWithTool` | `45` | 有**未返回的 `tool/call`** 在跑时改用这条更长的线（容忍 30 分钟级长工具，同时兜住"工具挂死"）（v0.4.0 新增）|
| `progressEvents` | `step/start,step/end,tool/call,tool/result,assistant/message,assistant/attempt` | 视为"有进展"的会话事件；**流式吐字（`agent/assistant-stream` 增量）也算有进展**（v0.4.0 新增）|
| `repeatCallLimit` | `6` | **②b 线（v0.5.0）**：连续 N 次 `(tool + arguments)` **完全相同** ⇒ 判循环 |
| `repeatCallCancel` | `true` | ②b 线是否**立即掐**（`false` = 只记 strike，交给③线累计）|
| `repeatCallExemptTools` | `job_output, job_list` | **合法轮询豁免**：等后台任务时本就会连调同参 |
| `emptyTurnDetect` | `true` | **⑤ 线总开关**：整个 turn 只有思考、正文一个字都没有 ⇒ 检出（判别式只看**结构**，不落思考正文）|
| `emptyTurnLimit` | `1` | 同一会话**连续** N 个零正文 turn 才触发（中间有正常 turn 即归零）|
| `emptyTurnAction` | `'log'`（作者本机显式 `'steer'`）| `'log'` = 只记日志 + 落结构样本；`'steer'` = **另自动补一句「你没输出正文」提示**。⚠️ 与 ①c 同一条原则：**替使用者发消息的动作，发布包默认关闭** |
| `emptyTurnSteerMax` | `3` | `action='steer'` 时**每会话**最多补救几次（防"补救本身变成新循环"）|
| `emptyTurnHint` | （见 `DEFAULTS`）| ⑤ 线注入的提示文本 |
| `watchIntervalSec` | `60` | 行动层定时扫描间隔（秒） |
| `strikesBeforeCancel` | `2` | **③ 累积止损**：同一会话**窗口内**强信号达此数 ⇒ **真切断**（v0.3 新增；v0.4.0 起**只收强信号**）|
| `strikeWindowMinutes` | `120` | strike 时效窗口 —— 超过此时长的旧 strike **不计入**（v0.3.1 新增） |
| `cancelOnStrikes` | `true` | `false` = 只记 `CANCEL-DRY` 不真切断（试阈值时用）（v0.3 新增） |
| `dumpSamples` | `true` | **④线（v0.6.0）**：判中即把证据落一条样本到 `dumpDir`（含**弱命中**，那是误杀候选）；`false` = 一个文件都不写 |
| `dumpDir` | `${DSH_HOME}/logs/dsh-local-loop-fuse/samples` | 样本落点（v0.7.6 起可移植；作者本机仍指 `<插件目录>/samples`，由 `cordis.patch.yml` 钉住） |
| `dumpMaxChars` | `8000` | 单条样本正文上限（**保尾部** —— 判据窗口在尾部） |
| `dumpKeep` | `30` | 目录内最多保留条数（超了按 mtime 删最旧，防病态循环写爆盘） |
| `dumpRedact` | `true` | 脱敏（api key / Bearer / JWT / `password=` / `token=` / 64 位 hex）⚠️ 除非明确知道在干什么，不要关 |
| `dumpDenylistPath` | `${DSH_HOME}/storages/recall-denylist.json` | 会话**在禁检索名单内 ⇒ 不落盘**（日志记 `DUMP-SKIP`）；避免"把判为污染的内容又抄一份" |
| `logPath` | `${DSH_HOME}/logs/dsh-local-loop-fuse/loop-fuse.log` | 日志落点（v0.7.6 起可移植；目录会自动创建） |
| `cancelLogPath` | `${DSH_HOME}/logs/dsh-local-loop-fuse/loop-fuse-cancels.log` | **切断专账**（v0.4.0 新增）：只记"切了谁、为什么、keepInbox 是什么"，方便事后一眼核对 |

### 判定逻辑（`isLooping` = 三条判据的 **OR**）

v0.8.2 起，① 线由**互补判据**组成，任一命中即算：

**(a) 精确子串（`isLoopingExact`，v0.1）**
取缓冲区末尾 `w = window` 个字符作为 `tail`，在它之前 `history` 个字符里数 `tail` 出现次数；
**只计不重叠的命中**（相邻命中至少相隔一个窗口宽）——否则一片连续低熵文本
（如 500 个相同字符）会被误判为循环。`repeats - 1` 次历史命中即返回 `true`。
✅ 抓「**逐字**重放同一段」（历史两次真实掐断都是这种，如反复引用同一段配置）。
❌ **结构上抓不到**「带噪声的交替打转」——见 (b)/(c) 与 v0.8.2 改造记录。

**(b) 低多样性高重复 · 末窗口径（`isLowDivTail`，v0.8.2）**
取**末尾** `lowDivWindow`(2000) 字符，要求**同时**满足：
① 唯一字符数 < `lowDivMaxUniq`(45)（"用词极度贫乏"）；
② 同一 `lowDivNgram`(24) 片段在该窗内出现 ≥ `lowDivMinRepeat`(10) 次。
两个都要，缺一即误杀。
🔄 **2026-10-07 归因更正（拾遗 round2 实测 · 我方已复现）**：原文写「模板化列表靠 ① 挡」——**写反了**：
④b 的末窗 `uniq=29` **通过** ①(45) 门槛，真正拦下它的是 **②(`k24=1 < 10`)** ⇒ **① 对这个形态毫无区分度**。
⚠️ 且这个分隔是**编号递增的副产品**：数字归一化后 ④b 的 `k24` 立刻跳到 **90**（已复现）
⇒ 任何"先归一化数字再比对"的改动都会误杀。
⚠️ **更严重**：**固定段再长 3–5 字符就翻** —— 拾遗构造的 3 个"正常但模板化"变体已被 **`(b)` 末窗支判 `true`**
（**破口在 (b)、不在 (c)**）。⇒ 这条比阈值调参重要，详见 `07-experiments/2026-10-07-loopfuse-round2-round1.md`。
❌ 盲区：只看末尾 2000 字符 ⇒ **"正常推理里夹一段空转"会被正常部分的词汇稀释而漏掉**。

**(c) 低多样性高重复 · 滑窗口径（`isLowDivSliding`，2026-10-07 加）**
**滑窗**（窗 `lowDivSlideWin`(400) · 步 `lowDivSlideStep`(100) · **末尾不足一步时补一个以 buf 末尾结尾的窗**）扫全文，**任一窗口**同时满足：
① 唯一字符数 < `lowDivSlideUniq`(30)；② 该窗内 k-gram(24) 重复 ≥ `lowDivSlideMinRepeat`(**3**)。
✅ 抓 (b) 抓不到的「**局部循环 + 整段词汇丰富**」（真实事故 `seq 14872`：整段 `uniq=247`，
滑窗最小 `29`）。
⚠️ **② 的门槛必须低**：局部循环每轮夹噪声，窗内 `k24` 实测真循环 `2/3/3/5/9` vs
**模板化列表 `1`** ⇒ 2 就能分开；实测 `2→3` 免费（召回仍 5/5）⇒ **取 3 换一档误报余量**，
但**别再抬高**（真悬崖在 4，会漏 `14872`）。
⚠️ **尾部补偿（2026-10-07 加）**：步进窗的最后一个终点是 `win + n*step`，因此**最后 `< step`
个字符从不属于任何窗**；与 `checkEvery:200` 叠加可造成最多 ~99 字符的**检测延迟**
（不是漏报，是延迟）⇒ 额外补一个以 `buf` 末尾结尾的窗（拾遗 round2 §1.6 实测）。
⚠️ **(b) 与 (c) 的阈值必须各自配套、不可互换**：末窗(2000) 下 45 可用；
**滑窗(400) 下 45 误报 850/5,013 块（17%）**，滑窗需 `<30`。
开关：`lowDivDetect: false` 关整条 ①b；`lowDivSlideDetect: false` 只关滑窗支。

短文本保护：`buf.length < minChars` 或 `w < 40` 直接返回 `false`（三条判据共用 `minChars` 门槛）。

### ① 线怎么真掐断（v0.3.3 —— 两层 bug 的教训）

2026-09-29 实测：① 线**检测一直有效**（真实命中 7 次：12:15 企微 1 条 + 19:58 本会话 6 条，
`len` 从 19,533 涨到 22,764、`hits` 1→6），但日志同时是 `turn=undefined hasSignal=false`
⇒ **检测到却掐不死**。根因有两层，缺一不可：

| 层 | Bug | 证据 | 修法 |
|---|---|---|---|
| ① | `AbortSignal` 按 `frame.turn` 索引保存，而 `agent/assistant-stream` 的 frame **没有 `turn` 字段**（turn 只在 `attemptId` 里，形如 `session-xxx:17`）| `signals.get(agent).get(undefined)` ⇒ `hasSignal=false` | 改 `WeakMap<agent, {signal,turn,at}>`，直接存"最近一次请求的 signal" |
| ② | **`AbortSignal` 实例没有 `abort` 方法** —— 只有 `AbortController` 有；而 `agent/request` payload 只有 `{agent, turn, step, signal}`，**不给 controller** | `typeof new AbortController().signal.abort === 'undefined'` | 改走官方原语 **`agent.cancel(cause, options)`** |

> ⚠️ 第 ② 层是关键认知：**即使把第 ① 层修好（signal 取得到），`sig.abort` 依然不是函数、照样掐不死**
> —— 原先"修两行就够了"的估计是错的。
> 能 abort 的那个 controller 藏在 `dsh-agent-loop` 内部（`cancel()` 里执行 `phase.abort.abort(cause)`），
> 外部**无法从 signal 反查**它。所以唯一可靠路径是 `agent.cancel()`。

因此 v0.3.3 的行为是：

1. **主路径**：`agent.cancel({kind:'hook', reason:'loop-fuse: output loop detected'}, {keepInbox: true})`
   —— `kind:'hook'` 是 `AgentCancelCause` 的合法值之一（仅 `user`/`parent`/`hook`/`disposed`），
   语义最贴（插件/hook 层判定循环），且带 `reason` 便于日志区分；
   `keepInbox: true` ⇒ **只终止这场跑飞的 turn，不丢弃用户排队消息**（比 ③ 线的"丢弃"更温和）；
2. **兜底路径**：若将来 DSH 递下可 abort 的 signal/controller，`signal.abort()` 自动生效（无需改码）；
3. **去抖**：同一 attempt 只掐一次（`st.canceled`），命中 11 次也只 `cancel` 一次；
4. **打不动就喊**：两条路都不通时写 `ABORT-SKIP …`（而不是静默什么都不做）；
5. **日志节流**：同一 attempt 只在 `hits` = 1 / 6 / 11 … 时记 `DETECT`（原实现一次命中写一行）。

---

## 第二种判定线：行动层循环（v0.4.0 **重写：无进展判据**）

> ### ⛔ v0.4.0（2026-10-01）：下面这套"时长 / 步数"判据**已删除**
> **原因**：2026-10-01 晚 ComfyUI 批量出图，两个**全程在推进**的 turn（15.7 / 15.6 min、每张图都落盘、
> 每步都有 `tool/result`）被 `duration` 判据记 strike ⇒ **②线弱信号触发了③线强动作** ⇒
> `cancel({kind:'user'})` 掐断正常任务 **并清空排队消息**（维护者的消息被吞）。
> 复盘：知识库 `05-issues/open/loop-fuse-kills-long-tasks.md`。**旧判据不要再加回来。**
>
> **新判据（A：无进展）**：只看**有没有进展** —— `step/start`·`step/end`·`tool/call`·`tool/result`·
> `assistant/message`·`assistant/attempt` 事件，以及**流式吐字增量**（`agent/assistant-stream`）都会刷新
> `lastProgressAt`；连续 `stallMinutes`(10) 分钟零进展 ⇒ 判 `stalled`。
> **长工具豁免**：有未返回的 `tool/call`（`pendingTools>0`）时改用 `stallMinutesWithTool`(45)
> —— 既容忍 30 分钟级长工具，又能兜住"工具挂死"。
> **弱信号不进 cancel 池（B）**：③线只收 `text-loop`（①线）与 `stalled`（②线）两种强信号。
> **②线与③线的 cancel 参数对齐（C）**：`{kind:'hook', reason}` + `{keepInbox:true}`，并写 `cancelLogPath` 专账。
>
> ⚠️ **已知抓不到（如实标注）**：「反复失败重试」型行动层循环（企微那次 6 次 `curl` 全败仍重试）
> 有持续 `tool/result` ⇒ 在"无进展"判据下**永远算有进展**。当初试过的「同指纹连击 / 连续失败结果」
> 两个判据都**无区分度**（正常会话 max=52 连击、实测连续失败仅 1 次），故不采用。

### 为什么需要它

2026-09-29 企微会话实测：**turn 6 跑了 19 步**、turn 7 连续 **6 次 `curl`** 抓标普 500 全失败仍重试，
上下文 81.8%（69,713 tokens）、**每轮全量 prefill ≈77 秒**、GPU 双卡 95%+，**烧了 12 分钟**。

而 `isLooping` **完全看不见它** —— 每步返回内容都不同，文本层面没有任何"重复"。
这是**结构性的盲区**，不是阈值没调好。详见知识库 `01-infra/output-loop-containment.md`
「第二种循环形态：行动层循环」。

### 数据来源与阈值来历

行动层数据来自 **`session/event`** 扩展点（⚠️ 同步 emit，handler 签名是 **`(session, event)`** 两个参数，
不是单个 payload）。事件：`turn/start{turn}` · `step/start{turn,step}` · `turn/end{turn}`。

阈值**不是拍脑袋**，是拿 **114 个历史会话**算出来的：

| 候选判据 | 历史分布（单会话极值） | 可用性 |
|---|---|---|
| 单 turn 最大 `step` | max=**82**，中位 **6** | ❌ 单用会误杀长任务 —— **本次循环才 19，在正常分布内** |
| 同指纹工具调用最长连击 | max=**52**，中位 4 | ❌ 正常会话有 52 连击，**本次循环只有 6** |
| 连续"失败"工具结果 | 启发式判定不稳 | ❌ 本次实测只得 **1**，不可用 |
| **单 turn 持续时长** | 中位 **3.9 min** / P90 12.7 / **P95 18.8** / max 87 | ✅ **唯一有区分度**（>15 min 仅 8/114 个会话） |

⇒ 取**时长为主**（15 min，2026-09-29 由 20 下调）、**step 数为兜底**（60），两条都刻意宽松。

### 判定逻辑（`checkTurn`）

```js
checkTurn(st, cfg, nowMs) → 'steps' | 'duration' | null
```
- `st.step > cfg.maxStepsPerTurn` ⇒ `'steps'`
- `nowMs - st.startedAt ≥ cfg.maxTurnMinutes * 60000` ⇒ `'duration'`

扫不出问题就返回 `null`。**纯函数、可单测**（见 `test-islooping.mjs` 的 ⑦–⑪）。

### ⚠️ 必须知道的限制

1. ~~只报警不中止~~ → **v0.3 起可以真切断**（见下节「累积止损」）。用的是官方 `Agent.cancel({kind})`
   —— 它会**中止当前 turn 并清空排队消息**，比"abort 下一次请求"彻底（卡住的 turn 可能根本不再发请求）。
   ⚠️ 但**文本重复线（①）仍是只记录**（`dryRun=true`），两条线的动作开关是分开的。
2. **它是"事后止损"，不是"当场识破"。** 认知测试用例 ⑧ 明写着：本次循环的 turn 6（19 步 / 8 分钟）
   **按任何"量"的判据都抓不到** —— 只有拖长到 15 分钟后才会被时长线命中。
3. **需要 turn 不再有新事件时才靠轮询。** `turn` 卡在长工具调用里不会有新 `step/start`，
   所以用 `setInterval`（默认 60 s）主动扫描，而不是纯事件驱动。

日志行形如：
```
2026-09-29 09:20:xx+08:00 EVENT-OK 事件通道已接通（首个事件 type=turn/start session=xxx）
2026-09-29 09:42:xx+08:00 TURN-WARN reason=duration session=gateway-xxx-gw turn=7 step=8 elapsed=22.3min strikes=1/2
2026-09-29 10:05:xx+08:00 TURN-WARN reason=duration session=gateway-xxx-gw turn=9 step=4 elapsed=21.7min strikes=2/2
2026-09-29 10:05:xx+08:00 CANCEL session=gateway-xxx-gw turn=9 step=4 strikes=2 cause=user ← 判定"反复卡住"，已中止该 turn 并丢弃排队消息
```

---

## 第三种能力：累积止损（v0.3 · 真切断）

**语义**（按维护者要求「一旦出现多次重复就切断」）：同一个会话**累计**报警到
`strikesBeforeCancel`（默认 **2**）次 ⇒ 调 `agent.cancel({ kind: 'user' })` **真中止**。

```
第 1 次卡住  → TURN-WARN strikes=1/2       （留痕，不动手）
第 2 次卡住  → TURN-WARN strikes=2/2  +  CANCEL   ← 切断
第 3 次（若还有）→ 被 killed 标记挡住，不重复切
```

**关键实现点**：

| 点 | 说明 |
|---|---|
| `Agent` 从哪来 | `agent/request` 的 payload 里有 `agent`，且 `agent.session` 是官方字段 ⇒ 每次请求顺手登记 `sessionId → Agent` 映射。turn 开始必然先有一次 LLM 请求，所以卡住时映射已就绪 |
| 为什么用 `cancel()` 而不是 abort | `agent/request` 的 `signal` **只在请求期间有效**；卡住的 turn 很可能**根本不再发请求**，abort 无从下手 |
| ~~`cause` 取值~~ | ⛔ 旧实现 `{ kind: 'user' }` —— **v0.4.0 已改为 `{kind:'hook', ...}`**（见下表）|
| 排队消息 | **v0.4.0 起默认保留**（传 `{keepInbox:true}`）—— 旧实现不传 ⇒ **清空用户排队消息**，2026-10-01 实测把维护者的消息吞了 |
| cancel 的 cause | **v0.4.0 起为 `{kind:'hook', reason:'loop-fuse: stalled turn — no progress for N min'}`** —— 旧实现用 `{kind:'user'}`，日志里与"用户手动取消"同类、复盘会误记 |
| 防重复 | `killed` 集合，同一会话只切一次 |

### ⚠️ 这是**破坏性**开关，务必知道

- `cancelOnStrikes: true` 是**默认值**（维护者明确要切断）。它**会真的中止用户的会话**。
- **误报代价（准确表述）**：**不是"一个 40 分钟的任务会被切"** —— 单个 turn 再长也**只贡献 1 个 strike**
  （扫描器里 `if (st.warned) continue` 保证每 turn 只报一次），所以**一个跑满 40 分钟的长 turn 不会被切**。
  真正会被切的是：**同一会话在 `strikeWindowMinutes`（默认 120 分钟）内出现 2 个各自 ≥15 分钟的 turn**。
  ⚠️ **v0.3 初版写错过**：当时 strikes 只存计数且**永不过期** ⇒ "上周卡过一次 + 今天卡过一次"也会凑够 2 次
  把今天的正常会话切断 —— 那显然不是"反复卡住"的语义。**v0.3.1 已加时效窗口并补了回归用例 ⑤。**
- **想先看不动手**：把 `cancelOnStrikes` 改成 `false`（只打 `CANCEL-DRY`），改完要**重启 dsh**。
- **验证状态（诚实）**：`test-cancel.mjs` 的 **5/5** 集成测试证明了**调用路径正确**
  （假 agent 确实在 strikes=2 时收到 `cancel({kind:'user'})`，且 killed 防重复、过期 strike 不累计）；
  但 **`cancel()` 在真实 DSH 里的效果（turn 是否真停、企微侧表现如何）尚未实测** —— 要等第一次真实触发。

### ✅ 切断后还能复盘吗？—— 能，而且很完整（2026-09-29 实测）

维护者关心：切完停止后，**对话内容和思考信息还在不在**。答案：**在**。拿那个被中断的循环会话
`gateway-mulfck7j43f4ld-gw` 逐项核对：

| 关心点 | 实测证据 |
|---|---|
| **turn 会不会被丢** | ❌ 没丢 —— `turn/start` `[1..8]` 与 `turn/end` `[1..8]` **全部闭合**；中断的 turn 由 DSH 自动收尾（末尾还有 `session/end-seed`）|
| **中断有没有留痕** | ✅ `turn/end reason={kind:'aborted', reason:{kind:'user'}}` × **2** —— 中断被**显式记录**，cause 就是 `user` |
| **被中断的消息** | ✅ 保留，带 `interrupted: true` 标记（`assistant/message(interrupted)` × 2）|
| **思考（reasoning）** | ✅ **完整落盘** —— 39 个 `assistant/message` **全部带 `stream` 流记录**，其中 **152 条含 reasoning**（如 `{"type":"chunk","chunk":{"type":"block-start","blockType":"reasoning"}}`）|
| **工具调用过程** | ✅ `tool/call` / `tool/result` 逐条在案 —— 我们正是靠它数出「turn 6 = 19 步、turn 7 连 6 次 `curl`」|

**原理**：DSH 的会话日志是**每条事件即时追加**（`session.v3.jsonl.zstd`），`cancel()` 只中止**运行**、
不删**已记录的事件**，甚至会给未完成的 turn 补一个 `turn/end` 收尾。

⚠️ **唯一真正丢的东西**：`cancel()` 默认**丢弃排队中、尚未开始**的消息（`keepInbox: false`）——
它们**从未进入会话**，所以不算"丢记录"。想保留就传 `{ keepInbox: true }`。

📖 **复盘方法**：

```bash
# 最全：直接读原始事件流（含思考）
zstd -dc <DSH_HOME>/sessions/<工作区转义目录>/gateway-xxx-gw/session.v3.jsonl.zstd | tail -30
```
```
# 读成对话（recall 工具）
recall_read(sessionId='gateway-xxx-gw', tail=100)
```

**顺带一个对账**：本插件用的 `cancel({ kind: 'user' })` 与 DSH **自己**的中断记录格式一致
（`turn/end reason={kind:'aborted', reason:{kind:'user'}}`）—— 护栏切断在日志里与"用户手动取消"同类，
**不会产生格式异常或半截记录**。

> 🔎 **`EVENT-OK` 是重启后的"通道自检"**（只打一次）—— 用来消除一种**不可证伪状态**：
> 若插件在 15 分钟超时前毫无输出，你**无法区分**「事件通道没接上」和「还没超时」。
> 2026-09-29 的 v0.1 就卡在这个状态里（dryRun 零命中，不知死活）。
> **重启 dsh 后先看有没有 `EVENT-OK`**：有 = 通道通；没有 = handler 根本没被调用，别等超时才排查。

---

## 日志

```bash
# v0.7.6 起的默认落点（可移植：跟着本实例的 DSH_HOME 走）
tail -20 "$DSH_HOME/logs/dsh-local-loop-fuse/loop-fuse.log"
```

- 本插件写的是**本地时间**（带 `+08:00` 偏移，见 `stamp()`），故 **`hotlog` 对它不是必需的**
  （`hotlog` 是给 dsh-hot-installer **UTC** 日志用的）。
- ⚠️ 作者本机钉住了旧路径（`<workspace>/.tmp/loop-fuse.log`，见该机 `cordis.patch.yml`）——
  读日志前先看一眼 `loaded` 行里的 `logPath` / `dumpDir`，别照抄别人的路径。
- 加载行：`loaded enabled=… dryRun=… minChars=… window=… repeats=… history=… signalMaxAgeMinutes=… abortViaCancel=… cancelKeepInbox=… maxTurnMinutes=… …`
- 命中行（**v0.3.3 起节流**：同一 attempt 只在 `hits`=1/6/11… 记录）：
  `DETECT attempt=… turn=… len=… kind=… hits=… hasSignal=… stale=… canCancel=… dryRun=…`
- 真掐断：`ABORT-VIA-CANCEL session=… turn=… len=… hits=… keepInbox=… cause=hook ← …`
  （兜底路径为 `ABORT-VIA-SIGNAL …`；调 `cancel()` 抛错为 `CANCEL-FAIL …`）
- **两条路都不通时**（升级到不再提供 `Agent.cancel` 的版本等）：
  `ABORT-SKIP attempt=… turn=… —— 检测到循环但没有可用中止原语（canCancel=… hasAbortableSignal=…）`
  —— 这条是刻意加的：**宁可吵，也不要静默掐不死**（v0.3.2 就是死在静默上）。

---

## 测试

```bash
cd <plugin-dir>/
bash run-tests.sh          # 推荐：跑全部 + 机械校验 samples/ 未被污染（约 1 min）

node test-islooping.mjs    # 28/28 · 纯函数：重复判定（含 ①b/①b-2）+ checkStall 阈值 + 调用指纹
node test-abort.mjs        # 12/12 · 集成：① 线"检测 ⇒ 真 cancel"（v0.3.3 新增，回归本次两层 bug）
node test-cancel.mjs       # 14/14 · 集成：③ 线 strike ⇒ cancel（约 35 s）
node test-dump.mjs         # 42/42 · v0.6.0 ④线：脱敏 / 取证切片 / 三条线落盘 / 去重 / 禁名单守卫 / 上限（约 8 s）
node test-empty-turn.mjs   # 19/19 · v0.8.0 ⑤线：零正文判据 + 上膛路径（约 1 s）
node test-p1b.mjs          # 25/25 · v0.8.2 ①c：注入 / 跨 attempt 观测 / DEFER / episode 上限 / FAIL 占额度 / 默认值钉住（约 4 s）
```

⚠️ **写集成测试时务必 `dumpSamples: false`**（或把 `dumpDir` 指到临时目录）——
`test-cancel.mjs` 用 `...DEFAULTS` 起 `apply()`，v0.6.0 之后不加这一条**跑一次回归就往真
`samples/` 塞 6 条假样本**（2026-10-03 实际踩到）。测试污染生产目录是静默的。

`test-abort.mjs` 是**这轮 bug 的回归防线**：它用假 ctx / 假 agent 驱动真实 `apply()`，直接断言
`agent.cancel()` 被调用、`cause.kind === 'hook'`、`keepInbox === true`、且**同一 attempt 只掐一次**；
另含防误杀（8 段正常文本不 cancel）、兜底路径、陈旧 signal、以及
**⑫ "Node 的 AbortSignal 没有 abort 方法"** 这条现场证据 —— 谁把实现改回 `signal.abort()`
这条用例就会红。

`test-islooping.mjs`：**直接 import 插件的真实 `isLooping` / `DEFAULTS` / `checkTurn`**（不复刻逻辑）：

- 正样本：病态循环（同一 3,720 字符段落 ×120）→ 触发；
- 负样本：**57,067 字符真实模型输出**不误报；长但正常的重复推敲不误报。

> ⚠️ 设计陷阱（已修）：**别把"同一段重复 30 次"当负样本** —— 那本身就是循环。
> 也别用 2,500 个相同字符当"正常长文本"，那不现实。
> ⚠️ 写测试脚本时 `python3 - <<'PYEOF'` 配管道会**抢走 stdin**（提取 0 条），要写 `python3 -c '…'`。

---

## 状态与后续

- **v0.8.2（2026-10-07 · 待发布）**：①b 末窗支 + ①b-2 滑窗支（尾部补偿）+ ①c P1-b 注入与观测 +
  能力自检 + **四个测试抓到的 bug + 两轮独立审阅推翻的八条设计/口径**（见上）。**测试 140 项全绿**
  （islooping 28 · abort 12 · cancel 14 · dump 42 · empty-turn 19 · **p1b 25** · `samples/` 未污染）。
  ⚠️ **重启 dsh 后必核三行**：`STEER-RESOLVE …` → `P1B-CAPABILITY …` → 真命中时的 `P1B-INJECT … via=…`；
  其中**自建兜底（`via=self-built`）已被独立审阅端到端验证**（append → deriveMessages → durable 回放全通、
  与官方构造器逐字段等价 ⇒ 见 `07-experiments/2026-10-07-p1b-inject-round1.md` §1）。
- **v0.3.3（2026-09-29 夜）**：① 线"检测有效但掐不死"的**两层 bug 已修 + 有回归测试**
  （`test-abort.mjs` 12/12）；**① 线已上膛 `dryRun=false`** —— **重启 dsh 后生效**。
- 生效判据：`loaded … dryRun=false … abortViaCancel=true cancelKeepInbox=true`。
- 回到观测模式：`DEFAULTS.dryRun` 改回 `true` + 重启 dsh。
- 下一次真实循环出现时应看到：`DETECT … canCancel=true` → `ABORT-VIA-CANCEL … cause=hook`
  → 会话事件流里 `turn/end reason={kind:'aborted', reason:{kind:'hook', reason:'loop-fuse: …'}}`。
  ⚠️ 这最后一步（真实 DSH 里的端到端效果）**仍未实测**，等第一次真实触发核对。
  ⚠️ 若只看到 `ABORT-SKIP …`：说明当前 DSH 不提供可用中止原语，需回来改实现（日志会明说原因）。
- ⚠️ **`link:` + ESM 模块缓存**：改 `index.js` 后 `hot-installer` 打印 `hot-applied` **不等于**换掉代码，
  必须 `sudo systemctl restart dsh`。用日志里的 `loaded …` 行确认新代码真的在跑。

---

## ⚠️ 扩展点语义（血的教训）

`agent/request` 是 **waterfall（瀑布）**扩展点，handler 必须写成：

```js
ctx.on('agent/request', async (payload, next) => {
  const resolved = await next();
  // …自己的逻辑…
  return resolved;          // ← 必须原样透传下游结果
});
```

v0.1 写成 `(payload) => { … }`（既无 `next`、也不 `return`）→ **瀑布链在本监听器处终止**，
下游 `dsh-agent` 拿到 `resolved === undefined`，抛出实测错误：

```
Cannot destructure property 'reasoningEffort' of 'resolved' as it is undefined
```

**这才是那次"本轮运行失败"的真实根因**（当时误判为 `settings.yaml` 缺字段，排查绕了远路）。

其他相关扩展点：`agent/pre-step`、`agent/request-error`、`agent/turn-stopping` 同样带
`AbortSignal`，如需更早/更细的中止控制可从这些点入手。

---

## v0.8.2 改造记录（2026-10-07 · **① 线结构性漏报 · ①c 注入 · 三个"测试才看得见"的 bug**）

**触发（有目击者的真实事故）**：本机 1.5 上，白露在 reasoning 里空转三次
（`（停）→（调用）→（结束）→（停）…` 反复铺满，偶尔插 `d`），**护栏三次都没有任何反应**
（`loop-fuse.log` 在 `15:20–15:30` 连 `DETECT` 都没有）；第一次自己脱困、第二次靠机主叫停。
机主原话：「你刚才循环了 然后自己脱困了」。

**定性（先回放、再改代码）**：把三段真实循环文本从会话日志取出、直接喂给判据 ⇒
`isLoopingExact` **全程 false**。根因不是阈值，是**匹配方式**：
(a) 要求末尾 600 字符**原样出现**在 history 里，而事故文本每个约 30 字符的周期都夹着噪声
⇒ 精确匹配**永远失败**。（先前的假设「不重叠规则把相邻命中滤掉了」被这次回放**证伪**。）

**修法**：新增判据 (b)（见上节），与 (a) **OR**、**不改 (a) 行为** ⇒ 零回归、可分别关闭。

**误报验证【实测】**：8 个真实会话日志共 **504 条**长文本（≥2500 字符，reasoning + text 块）
⇒ (b) 命中 **3 条，而这 3 条正是三段真实循环** ⇒ **召回 3/3 · 误报 0/504**。
判别力来自两个特征的组合（单看任一个都不行）：

| 样本 | 唯一字符数 | 同 24-gram 最高重复 |
|---|---|---|
| 三段真实循环（末尾 2000 字符） | 32 / 35 / 35 | 26 / 15 / 15 |
| 504 条真实长文本（正常，中位） | ~200 | ~1–6 |
| 模板化列表 `第 N 项：检查完成…`×160（负样本） | 29 | **1**（而 k16 = 84 ⇒ 只能靠 uniq 挡） |
| 病态同段重复 ×120（负样本，该命中） | 30 | 64 |

**⚠️ 诚实边界**：阈值是在这 504 条（**8 个会话、同一模型家族**）上定的，**样本量有限**；
全部参数可配、默认偏保守（**宁可漏也不误杀** —— 机主明确要「保留适当循环」）。
上膛前建议再攒样本；回退只需 `lowDivDetect: false`。

**测试**：`bash run-tests.sh` 全绿（islooping **26/26** · abort 12/12 · cancel 14/14 · dump 42/42 ·
empty-turn 19/19，`samples/` 未被污染）。新增 ⑦/⑦b 两条**合成**回归样本
（复现事故形态，**不含真实对话原文**）；⑦b 专门断言 `exact=false 且 lowDiv=true`
—— 防「哪天改回旧版还显示全绿」。

**生效方式**：`link:` + ESM 模块缓存 ⇒ **改完必须重启 dsh**。

### 🔴 当日追加：机主定调两处默认值（2026-10-07 16:4x）

**机主原话**：「**先做5线 · 阈值可以先给45 · 慢慢调整 · 实践的样本永远是最好的**」⇒ 已改默认值：

| 配置 | 原 | 新 | 依据 / 边界 |
|---|---|---|---|
| `emptyTurnAction` | `'log'` | **`'steer'`**（当轮定调）| 事故当时 ⑤ 线**已经看到 3 次**（turn 310/311/313）却只 `log` ⇒ **缺的是动作、不是检测**；拾遗**独立**得出同一结论（`reasoning.log:992`）。限次：`emptyTurnSteerMax: 3` / 会话。<br>⚠️ **v0.8.2 收口时又改回包默认 `'log'`**（与 ①c 同一条「替使用者发消息 ⇒ 保守默认」原则），**本机由 profile patch 钉 `'steer'`** ⇒ 本机行为不变 |
| `lowDivMaxUniq` | `40` | **`45`** | 拾遗在 **159 会话**样本上测：`45` = 10/10 召回 · 0 误报。⚠️ 白露在 **160 会话 / 5,013 块**上复测：45 与 40 结果**相同**（都召回 3/5，漏 `14856`/`14872`）；且"误报"里混着**未标注的真循环**（`aed7127e` 的 do-it 循环）⇒ **该数字待"真循环标注集"建好后重验**。机主定"先用 45、慢慢调整" |

⚠️ **三条重要边界**

1. **两处都要重启 dsh 才生效**（`link:` + ESM 模块缓存）。
2. ⚠️ **`steer` 的"真能注入"没有实测证据** —— `test-empty-turn.mjs` 只断言「不会抛 + 留下 SKIP 说明」
   （注释里写明的**已知盲区**：link 插件可能 import 不到 dsh 内部包）⇒ **重启后必须看日志判定**：
   `EMPTY-TURN-STEER`（✅ 真注入）· `EMPTY-TURN-STEER-SKIP`（❌ 拿不到能力 ⇒ 上膛无效）·
   `EMPTY-TURN-STEER-FAIL`（❌ 出错）。
3. ✅ **只改阈值不解决「局部循环」**（`seq 14872` 整段 `uniq=247`）—— 已在**下面「当日追加②」**里
   改成**滑窗**（机主授权）；原提案见 `tasks/loopfuse-proposal-P1-inject-stopword.md` 的 P1-a。

**测试**：`bash run-tests.sh` 全绿（islooping **28/28** · abort 12/12 · cancel 14/14 · dump 42/42 ·
empty-turn 19/19，`samples/` 未被污染）。

### 🔴 当日追加②：滑窗支（①b-2）—— 修「局部循环」盲区（2026-10-07 · 机主授权）

**机主原话**：「**继续改你说的滑窗**」⇒ 已实现（见「判定逻辑 (c)」）：

| 参数 | 值 | 依据 |
|---|---|---|
| `lowDivSlideWin` / `lowDivSlideStep` | 400 / 100 | 实测 `seq 14872` 滑窗最小 `uniq=29` |
| `lowDivSlideUniq` | **30** | ⚠️ **不是 45** —— 滑窗(400) 下 45 误报 **850/5,013 块（17%）**，30 才回到可用区。**阈值必须与口径配套** |
| `lowDivSlideMinRepeat` | **3** | **测试逼出来的**：同一窗口内 `k24` 真循环 `2/3/3/5/9` vs **模板列表 `1`**；拾遗 round2 实测 `2→3` **免费**（召回仍 5/5）⇒ 取 3 换一档误报余量（真悬崖在 4）|
| `lowDivSlideStep` 的**尾部补偿** | 补一个以缓冲区末尾结尾的窗 | 步进窗的最后一个终点是 `win + n*step` ⇒ **最后 `< step` 个字符从不属于任何窗**；与 `checkEvery:200` 叠加最多 ~99 字符**检测延迟**（是延迟、不是漏报）|

**全量验证【实测】**（160 会话 · **5,025** 长文本块，**直接用生产代码**跑、非复刻）：

- **真循环命中 `5/5`** ✅（含此前两个盲区：`14856` 末窗 `uniq=56`、`14872` 整段 `uniq=247`）
- 其余命中 **17 块（0.34%）** —— ⚠️ **未甄别真假**：其中 `aed7127e` 的 3 块**已确认是真循环**
  （`do it.` / `（输出）` 交替）⇒ **真实误报率低于 0.34%**，精确值仍待「真循环标注集」。

**测试**：新增 **⑧ / ⑧b**：合成「局部循环」样本，⑧b 断言「**关掉滑窗支必须 `false`**」
⇒ 防「改回只有末窗的版本还显示全绿」。
📌 本支 ② 的门槛是**测试逼出来的**：初版「只看 `uniq`」时，`④b 模板化列表` 被判 `true`（**误杀**）。

### 🔴 当日追加③：①c P1-b —— ① 线命中时**注入「停止」类词**（2026-10-07 定「加」）

**它是什么**：① 线命中达 `p1bInjectAtHit`(1) 次时，用 `agent.steer()` 往会话里注入 `p1bHint`
（一句「你在原地重复 ⇒ 停止推理、直接给结论」）。**注入是温和动作，先于掐断**：掐断仍按
`textStrikesBeforeCancel` 走，两者互相独立（`dryRun: true` 只停掐断、不停注入，见配置项表）。

**为什么要"按能出结论的方式"加**（本项争议过，结论必须落在判据上）：
一方判"不该做"（有样本显示注入后仍循环）；复核方判"证伪不成立"（那两例**结构上碰不到注入通路**
—— ① 线命中走的是 `cancel`、⑤ 线判据要求零正文），但她用另一段样本**加强了方向**
（使用者**亲自发的「停」已送达** + 模型逐字引用规则，随后仍循环 ~100 行）。
⇒ 结论：**可以加，但必须先让它可被证伪**。四条设计（逐条对应上面的反对意见）：

| 设计 | 做法 | 为什么 |
|---|---|---|
| **预注册** | `p1bInjectAtHit` / `p1bObserveChars` / `p1bSuccessDropPct` 全部配置化，**并在注入行里打印** | 没有预注册 ⇒ 事后总能挑一个好看的口径 |
| **双读数** | ① `k24Max`（窗口内 24-gram 最高重复）② `isLooping`（注入后 ① 线是否仍命中）| 单臂前后测**没有反事实** |
| **不数「停」字** | 读数用结构量 `k24`，**不统计「停」字密度** | 注入文本**自己含"停"字**，被模型抄回后**只抬高处理臂**的密度 ⇒ 不对称偏差 |
| **基础率对照** | 日志与统计脚本都写明**基础自愈率 2/6 ≈ 33%** | 单次"注入后它停了"不算证据 |

**观测判据**（`P1B-OBSERVE`）：`k24` 降到 ≤ `(1-dropPct)` **且** 读数 2 为"不再循环" ⇒ `有效`；
**仍循环** ⇒ `无效`；其余 ⇒ `不确定`；**turn 结束仍未攒满 N ⇒ `观察中断`**（也必须留一行）。每行都带基础率提醒。
⚠️ **读数 2 的口径 = 「注入之后、新 attempt 的累计文本」**（两项都踩过坑）：
- **不是整个缓冲区**：注入点之前那段循环**永久留在缓冲区**里 ⇒ `line1StillHits` 恒真；
- **也不是注入所在 attempt 的尾巴**：`attempt` = 一次模型请求 = 一个 **step**，而 `steer` 要到
  **下一个 step 边界**才进 prompt ⇒ 同 attempt 内的文本是注入**不可能影响**的
  （那部分只计入 `blindChars`，不进读数）。
两处都是实测推翻后才改的，见文末「测试抓到的四个 bug + 审阅推翻的两条」。

**能力自检**（`P1B-CAPABILITY`）：注入依赖 `agent.steer`，而它"能不能用"原先**只能等一次真循环**
才知道（当天是 0 次触发 ⇒ 等于没法验证）。现在**任何一次 LLM 请求**时就地探测、每会话只打一行：
`P1B-CAPABILITY session=… steer=<bool> cancel=<bool> inbox=<type>`。
它只回答「**能力在不在**」，**不回答**「注入有没有用」—— 后者要真循环 + 观测，两者别混。

> ⚠️ **这一行是机器可读行**：`steer=<bool> cancel=<bool>` 的格式必须保持，且**说明文字里不能再出现
> 布尔字面量** —— 首版写了 `steer=false ⇒ …`，统计脚本的宽正则在**同一行上数了两次**，报出假的
> `1/2 = 50%` 与一条假 🚩。这正是本仓库反复出现的那族毛病：**判据比被检查的东西宽**。

**注入通路本身也有坑（v0.8.2 写测试时抓到）**：`agent.steer()` 要一条 **UserMessage**，
官方构造器 `createUserMessage` 在 **dsh 内部包** `@deepseek-ai/dsh-llm` 里，而**本包零依赖**
（`index.js` 只 import `node:path` / `node:fs`，五个候选 `node_modules` 目录全不存在）
⇒ 解析**必然失败**（`ERR_MODULE_NOT_FOUND`；注意：**不是** `link:` 的锅，任何零依赖插件都一样）。
⇒ 现在按优先级两条路（`buildSteerMessage()`），日志用 `via=` 区分：
`via=dsh-llm`（官方构造器，装了 `peerDependencies` 的环境会走这条）·
`via=self-built`（**自建兜底**：`{id, role, content, source}` + 深冻结）。
✅ **自建消息已被独立审阅端到端验证可用**：真 dsh 的 `Session.append` → `deriveMessages` →
**durable 回放**全通，与官方构造器**逐字段 `deepEqual`**、四层均 frozen、回放侧四条 invariant 全过
（`07-experiments/2026-10-07-p1b-inject-round1.md` §1，探针 `.review-scratch/probe{2,3}.mjs`）。
⚠️ 形状错了**不会当场炸**（live append 不校验），要到**回放会话存档**才抛 ⇒ 测试 ⑮ 固化那四条 invariant。

**把概率统计出来**（`p1b-stats.sh`，仓库根 · **不在 npm 包里**）：
```bash
bash p1b-stats.sh                      # 默认读 ${DSH_HOME}/logs/dsh-local-loop-fuse/loop-fuse.log
# ⚠️ 该路径是**可移植兜底**：很多实例用 cordis.patch.yml 把 logPath 钉到别处 ⇒ 找不到时
#    脚本会打印「去哪儿找」的可执行提示（不会闷声失败）
bash p1b-stats.sh /path/to/loop-fuse.log
```
分两段、**顺序不能颠倒**：① **能力层**（`CAPABILITY` / `INJECT` 成功 vs SKIP/FAIL，外加
`STEER-RESOLVE` 那关）→ ② **效果层**（`OBSERVE` 的 verdict 分布，**只统计 `injected=true`**，
并把 `观察中断` 与 `INJECT-QUOTA` 单列）。`n<5` 一律标「不足以下结论」。

**发布默认值**：`p1bEnabled` **默认 `false`** —— 本项会**替使用者自动发消息**
（以用户身份注入一句话），与 0.8.1 的 `probeMount` 同一套做法：**默认可移植/保守 + 本机覆盖**。
要用的人自行在 `cordis.patch.yml` 里打开；作者本机就是显式 `p1bEnabled: true`。

### 🔴 第 2 轮审阅后的收口（2026-10-07 · 又一次「测试/审阅才看得见」）

| # | 发现（她的实测） | 改法 |
|---|---|---|
| 1 | 🔴 **默认参数下注入与掐断互相拆台**：`hit#1` 注入、`hit#2` 掐断，同 attempt 内相隔约 200 字符；而 `cancel(keepInbox)` **不清 inbox**、掐断后**不会自动开新 turn** ⇒ steer 要等用户下次发言才进 prompt ⇒ **观测永远只有 `segLen=0 / 观察中断`，真正消费它的那个 turn 一行都不测** | turn/end 时若 `segLen===0` 且 reason=`aborted` ⇒ **窗口带进下一个 turn**（≤1 次），日志 `P1B-OBSERVE-DEFER … turnsSpanned=1` |
| 2 | 🔴 额度是**会话终身制** ⇒ 常驻会话样本天花板 2（脚本自己要求 n≥5 ⇒ 永远出不了结论）| 计数单位改 **episode**（`p1bEpisodeWindowMinutes` 衰减）；⑤ 线同款缺陷一并改 |
| 3 | 建窗在 `.then` 里 ⇒ 与 turn/end **竞态** ⇒ 窗口成孤儿 ⇒ 可能出**假「有效」** | **同步建窗**（`steerHint` 之前）、`injected` 只作标志；未确认 ⇒ `verdict=注入未确认`（不进分母）；顺带修「上限只挡成功不挡尝试」 |
| 4 | `segLen=0` 时 `drop=100%`（**假满分**）；两个 k24 窗口长度不可比 | 只在两窗等长时才给 `drop`，否则打 `—`；并打印 `k24BeforeWin/k24AfterWin` |
| 5 | 新参数**没有 load-time 特征串**（违反本仓库自己立的规矩）| `loaded` 行加 `p1bEnabled / injectAtHit / observeN / steerMaxPerSession / episodeWinMin / dropPct / emptyTurnAction` |
| 6 | **默认值没有测试钉住**（这条原则已被翻过一次）| `test-p1b.mjs` ⑰ 直接断言 `p1bEnabled=false` / `emptyTurnAction=log` / `probeMount=false` |

📌 这也解释了「为什么重启后可能仍是 0 个有效样本」：改 1/2 之前，观测在**出厂参数下结构上**出不了一次可用结论。

**生效方式**：`link:` + ESM 缓存 ⇒ 改完**必须重启 dsh**；重启后核对三行：
`STEER-RESOLVE …`（解析成败）· `P1B-CAPABILITY …`（能力在不在）· 真命中时的 `P1B-INJECT … via=…`。

### 🐞 v0.8.2：测试抓到的四个 bug + 审阅推翻的两条设计

`test-p1b.mjs`（**20/20**）是本节的防线。

**A. 写测试时当场抓到的四个缺陷**（都已修）：

| # | 缺陷 | 为什么危险 | 修法 |
|---|---|---|---|
| 1 | **`createUserMessage` 从未 import** | 每次注入都 `ReferenceError`（`P1B-INJECT-FAIL`）⇒ 能力自检却显示"steer 可用"，**看着是好的**。⚠️ 分级：这是**代码阅读可得**的缺陷；**生产日志里 `P1B-INJECT*` = 0 行 ⇒ 从未触发过**（独立审阅纠正了我"上线即失效"的措辞）| 抽 `buildSteerMessage()` 统一构造（含自建兜底），两条注入路径共用 |
| 2 | **内部包解析不到** | 零依赖插件 import `@deepseek-ai/dsh-llm` 必然失败 ⇒ 即使修好 #1 也注入不了 | 自建 UserMessage 兜底（已被审阅端到端验证）+ 可选 `peerDependencies` |
| 3 | **观测读数 2 口径过宽** | 用**整个缓冲区**调 `isLooping` ⇒ 注入点之前那段循环永久在缓冲里 ⇒ `line1StillHits` **恒真** ⇒ verdict 永远"无效" | 只对**注入点之后、新 attempt** 的累计文本判定 |
| 4 | **会二次注入** | 观测结束把状态置回 `null`，命中持续时条件又成立 ⇒ 同一 attempt 反复注入 | 加 `p1bDone`（attempt 内去重）|

**B. 独立审阅（拾遗第 3 轮 · `07-experiments/2026-10-07-p1b-inject-round1.md`）推翻的两条设计**：

| # | 原设计 | 为什么错（她的实测） | 改法 |
|---|---|---|---|
| 5 | 观测窗口**只在同一 attempt 内** | `attempt` = 一次模型请求 = 一个 step，而 `steer` 到**下一个 step** 才进 prompt ⇒ 读数覆盖的是**注入不可能影响**的文本；跨 step 时更糟：**连一行都不留**（实测 `steer=6 / OBSERVE=0`），而"注入成功"的样本更容易落进这种情形 ⇒ 效果率被系统性拉向"无效" | 观测搬到 **session/turn 级**：注入后**新 attempt** 才累计，本 attempt 尾巴记 `blindChars`，turn 结束未满 N ⇒ 补 `verdict=观察中断` |
| 6 | 注入**没有次数上限** | `attempt` 级去重挡不住跨 step 循环 ⇒ 实测一个会话注入 **6 条**，且每条都**永久写进 durable transcript** | 加 `p1bSteerMaxPerSession`（默认 2）+ `P1B-INJECT-QUOTA` 日志 |

📌 ⑦ 用例还固化了一条容易被忽略的事实：**① 线的精确子串判据不接受重叠命中** ⇒
周期文本要长到"末尾窗口里有 ≥2 个不重叠接缝"才判得出来（实测量级 ~4.6k 字符）。

## v0.8.1 改造记录（2026-10-05 · **指纹只认「动作」**）

**触发**：排查一次"检测线在真实环境里毫无反应"时发现，②b 线（同参调用连击）的指纹口径把
**模型给调用的自注**也算了进去 —— 三次 `echo <同一条命令>`，只有 `description` 措辞不同，
**老口径判成三个不同调用**，连击计数永远停在 1，循环就漏判了。

**改动**：新增 `canonicalArgs()`，`callFingerprint(name, args)` 改为对**规范化后的动作参数**取指纹：

- `arguments` 是**原始 JSON 字符串** ⇒ 先解析；解析失败（非 JSON）⇒ **原串返回**，退化为精确比较、不误伤；
- **剔除 `description`**（见 `VOLATILE_ARG_KEYS`）；
- **顶层键排序** ⇒ 键序无关（同参的两种写法此前也会被算成不同调用）。

**为什么算修 bug 而不是调参**：指纹的语义是「**动作是否同一**」，`description` 是模型写给人看的说明、
不属于动作。语义错了就修，不必"等自然症状出现再说"。

**实测证据**：新单测（islooping ⑳–㉔）覆盖 —— 换 description ⇒ 同指纹 · command 差一个字符 ⇒ 仍不同 ·
键序无关 · 非 JSON 退化 · 「同命令 + 换措辞 ×3」实况回归。
另用**真实会话日志回放**同一份记录（93 turn / 802 次工具调用）：老口径命中 1 个 turn，
新口径命中 2 个 —— **多出来的那个正是「同命令、只换措辞」形态**。

**测试**：`bash run-tests.sh` 全绿（islooping 24/24 · abort 12/12 · cancel 14/14 · dump 42/42 · empty-turn 19/19，
且 `samples/` 未被测试污染）。

**生效方式**：`link:` + ESM 模块缓存 ⇒ **改完必须重启 dsh**。

---

## v0.6.0 改造记录（2026-10-03 · **触发即 dump 样本**）

**触发**：想用**真实**污染样本给 `tools/loop-detect.py` 做回归，结果发现当初那条污染会话
（`session-xxxxxxxx` 等 4 条）的正文**已不可逆清除** —— 主日志 / 2.0 日志 / 投影缓存 / FTS5 索引
/ 两份备份**逐处实测全 0 命中**（复核表见项目内部记录）
⇒ **真实夹具再也拿不到了**。人工构造的夹具（`loop-detect-fixtures/`，5 个）验不了真实误判形态。

**做法**：三条线（①文本重复 / ②b同参连击 / ②停滞）**每次判中都落一条样本**到 `samples/`。
关键是**弱命中也要 dump** —— 只记 strike、没掐断的那些才是**误杀候选**，调阈值时比真循环更值钱。

| 项 | 内容 |
|---|---|
| 落点 | `samples/<时间戳>-<kind>-<session>-<seq>.json`（在工作区 `tools/` 下 ⇒ **进每日备份**；不放 `.tmp/`，因为样本是证据） |
| 三档 kind | `text-loop`（**唯一带连续正文**，可喂 loop-detect）· `repeat-call`（带工具参数）· `stalled`（只有状态账，无正文） |
| 三道闸 | `dumpRedact` 脱敏 · `dumpMaxChars` 限长（**保尾部**）· `dumpDenylistPath` **在禁检索名单内不落盘** |
| 两条防爆 | `dumpKeep` 条数上限（按 mtime 删最旧）· `(session,turn,kind)` 去重（同 turn 只留第一次） |
| 提升夹具 | `promote-sample.sh [--latest\|<路径>] [--dry-run]` —— 抽 `text` 写成 `loop-detect-fixtures/NN_real_*.txt`，跑一遍 loop-detect，**打印该抄进 README 表的那一行** |
| 异步 | dump 走 `import('node:fs').then(...)`，**不阻塞会话事件链**；调用即返回 |

**测试 46/46**：`test-dump.mjs` **42/42**（脱敏含 2 条**反例**：普通路径/中文/32 位 md5 不许被误脱敏；
取证切片保尾部；三条线各落一条；去重；**禁名单守卫**；`dumpKeep` 只留最新两条；总开关关掉后目录都不建）
· 回归 `test-cancel.mjs` 13/13 · `test-islooping.mjs` 20/20。

⚠️ **顺手修掉一个测试污染**：`test-cancel.mjs` 用 `...DEFAULTS` 起 `apply()`，于是 v0.6.0 之后
**跑一次回归就往真 `samples/` 写 6 条假样本**（`sess-test` / `sess-win` …）。已在它的 6 处
`apply()` 全部加 `dumpSamples: false`。**教训：新增"会写盘"的默认行为时，必须检查所有测试是否被它波及**
—— 测试污染生产目录是静默的，不看目录就发现不了。

📄 样本目录的说明另见 `samples/README.md`。

---

## v0.5.0 改造记录（2026-10-02 · 桌面版实录触发）

**触发**：主机桌面版（0.2.0-rc.2 + 本地 27B）会话 `session-xxxxxxxx` —— turn 22 找不到后台 job `pwsh-59`
的输出，于是**全盘递归搜索同一条命令**：

```
Get-ChildItem "$env:DSH_HOME" -Recurse -File | Where-Object { $_.Name -like "pwsh-5*" }
```

**到 step 44 为止连调 21 次**，每次返回 `(no output)`（它以为是"没找到，再试"）。
DSH **内置**的重复调用检测已警告 `consecutive_calls: 5` / `8`，但本地 27B 不理。

⚠️ **为什么 v0.4.0 的"无进展"判据抓不到**：每次重复调用都产生 `tool/call` + `tool/result`
⇒ 在"有没有进展"的口径下**永远算有进展**。这正是 v0.4.0 文档里如实标注的那个边界。

**v0.5.0 做法**：对 `tool/call` 的 `name + arguments` 做指纹（`callFingerprint()`，djb2 + 长度），
**连续 `repeatCallLimit`(6) 次完全相同 ⇒ 直接 `cancel({kind:'hook', keepInbox:true})`**，
并把 `repeat-call` 记进 strike 池；`job_output` / `job_list` 等**合法轮询工具豁免**。

**测试 45/45**：`test-islooping.mjs` **20/20**（新增 ⑮–⑲ 指纹用例：同参同哈希、差一字符不同、
换工具不同、20 万字符不抛、对象参数可用）· `test-cancel.mjs` **13/13**（新增 ⑦ 连调 6 次即掐、
⑦b reason 可查、⑦c keepInbox、⑧ job_output 连调 10 次**不掐**（豁免）、⑨ 交替不同命令**不掐**（计数重置））
· `test-abort.mjs` 12/12。

---

## v0.4.0 改造记录（2026-10-01，维护者定「ABD 都做」）

**触发**：长任务误杀（见上文 ⛔ 横幅 + 知识库 `05-issues/open/loop-fuse-kills-long-tasks.md`）。
维护者原话：**「现在的判据已经被证明是错的了，就不要用了」**。

| 项 | 内容 | 落地位置 |
|---|---|---|
| **A** 无进展判据 | `checkStall()` 替代 `checkTurn()`；`lastProgressAt` 由 `step/*`·`tool/*`·`assistant/*` + 流式增量刷新；新增长工具豁免（`stallMinutesWithTool`） | `index.js` 纯函数区 + `session/event` 记账 + `agent/assistant-stream` |
| **B** 弱信号解耦 | ③线 strike 只收 `text-loop`（①线）与 `stalled`（②线）；旧时长判据删除 | `recordStrike()` |
| **D** cancel 参数 | ③线改 `{kind:'hook', reason}` + `{keepInbox:true}`（与①线一致）；新增 `cancelLogPath` 切断专账 | 扫描器尾部 |
| ⛔ 删除 | `maxTurnMinutes` · `maxStepsPerTurn`（**被实测证伪**，不再使用） | `DEFAULTS` |

**测试：全绿**（⚠️ 下面各文件的项数会随用例增加而变，**以实际输出为准**）
```bash
node test-islooping.mjs   # 24/24（新增 ⑧「批量出图 25 分钟但有进展 ⇒ 不许命中」回归、⑪ 长工具豁免、⑫ 工具挂死兜底、⑬⑭ 边界）
node test-abort.mjs       # 12/12（①线回归，无改动）
node test-cancel.mjs      #  8/8（新增 ②b keepInbox、②c reason、⑥「持续有进展 ⇒ 不切断」事故回归）
```

**生效方式**：`link:` 两实例共享 ⇒ **两个 dsh 都要重启**（`sudo systemctl restart dsh` / `dsh-2.0 restart`）
—— **✅ 已于 2026-10-01 21:49 重启生效**（`dsh-2.0` 21:49:38 / `dsh` 21:49:49），
判据是日志 `loaded v0.4.0 … stallMinutes=10 stallMinutesWithTool=45`。

---

## ⚠️ 关于 `index.js` 末尾的可选挂载点（探针）

`index.js` 的最后有一小段可选挂载点：

```js
import('./exit-check.mjs')
  .then((m) => m.attach(ctx, cfg, { redactSecrets }))
  .catch(() => { /* 文件不存在 = 未启用，正常路径 */ });
```

**它对使用者意味着什么**：

> **结论**：**默认情况下它不产生任何行为。** 那个加载点由配置项 **`probeMount`** 控制，
> **默认 `false`** —— 即**根本不会去 `import` 任何文件**。干净安装、以及任何没有显式打开它的安装，
> 都属于这种情况。
> ⚠️ **一旦有人把 `probeMount` 设为 `true`**，它就会加载**包目录**下的 `exit-check.mjs`：
> 谁能打开这个开关、又能往包目录写一个同名文件（别的包的 `postinstall`、被投毒的依赖、构建脚本…），
> 谁就能在插件加载时执行代码，并拿到**活的**插件上下文与本包配置。
> **0.7.6 没有这个面** —— 这是本版本新增的，也是它**将来必须被删掉**的原因之一。
> ⇒ 在此之前，**不要在不信任依赖树的环境里打开 `probeMount`**。

- `exit-check.mjs` **不在** `package.json` 的 `files` 白名单里 ⇒ **发布包里根本没有这个文件**。
  你装到的是**一段指向不存在文件的 import**；失败后进 `.catch`，**静默跳过**
  ⇒ **不联网、不写文件、不上报、不影响本包任何功能**。
- ESM 的相对说明符以**引用它的文件所在目录**为基准解析，**不是**运行时的 cwd
  ⇒ 它**不会**去加载你项目里恰好同名的文件。
  （2026-10-07 双向实测：同名文件放在 cwd、包目录里没有 ⇒ **不加载**；
  包目录里有 ⇒ **加载**。两个方向都只认包目录。）
- 它是**维护者本机的实验代码**：**它在维护者本机有别的用途，该用途不属于本项目的范围，这里不作说明**。
- 🔻 **将来会移除**。现在还在，只是因为与它对应的那份本机工作尚未收尾；移除 = 删掉上面那几行。

> 📌 我们**选择把它写出来**，而不是默默带着它发版：它确实不属于本项目，
> 而"包里有一段你事先不知道的代码"本身就不该发生 —— 哪怕它当前不产生任何行为。

---

## 相关文档

> ⚠️ 下列 `tasks/`、`<kb>/…` 路径属于本项目**内部**交接档与知识库，**未随 npm 包发布**。

- 工作集：`<workspace>/tasks/loop-fuse-plugin.md`
- 设计分析：知识库 `01-infra/output-loop-containment.md`
- 配置生效方式：知识库 `01-infra/dsh-settings-apply-matrix.md`
