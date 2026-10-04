# samples/ —— loop-fuse 自动 dump 的**真实循环样本**

**平时是空的**（这里没有任何预置样本）。目录会被 `dsh-local-loop-fuse` v0.6.0 起在**判中循环的那一刻**
自动写入 —— 见 `../index.js` 的 ④线「触发即 dump 样本」。

## 为什么要有它

`tools/loop-detect.py` 的回归夹具原本**全是人工构造**的。2026-10-03 想用**真实**污染样本验证它时发现：
当初那条污染会话的正文**已不可逆清除**（主日志 / 投影缓存 / FTS5 索引 / 两份备份，逐处实测全 0）
⇒ **真实夹具再也拿不到了**。

⇒ 唯一出路：**让判中的那一刻自己把证据存下来**。这样以后每遇到一次真循环（或一次误判），
就自动攒一个真实样本，不用再等人手抄。

## 文件形态

一条样本 = 一个 JSON：

```json
{
  "v": 1,
  "at": "2026-10-03T07:43:49.000Z",
  "atLocal": "2026-10-03 07:43:49+08:00",
  "kind": "text-loop",          // text-loop | repeat-call | stalled
  "session": "session-…",
  "turn": 9,
  "attemptId": "session-…:9",
  "why": "isLooping hit #1（window=600 repeats=3 history=4000）",
  "acted": false,               // false = **只记 strike 没掐断**（调阈值时最值钱的误杀候选）
  "chars": 2148,
  "truncated": true,
  "text": "……",                 // 仅 text-loop 有：已脱敏、已限长、**保尾部**
  "evidence": { "hits": 1, "period": 600, "occurrences": 4, "…": "…" }
}
```

- `kind=text-loop` —— ①线文本重复。**唯一带连续正文**的，能直接喂 `loop-detect.py`。
- `kind=repeat-call` —— ②b线同参调用连击。带 `arguments`（工具参数原文），没有连续正文。
- `kind=stalled` —— ②线停滞。**没有正文**（"停滞"本身就是"没有事件"），只有该 turn 的状态账。

## 三道自保闸（缺一不可）

dump 的初衷是"留证据"，但**把刚判为污染的内容原样再抄一份落盘**会与「清除」自相矛盾。所以：

| 闸 | 配置 | 作用 |
|---|---|---|
| 脱敏 | `dumpRedact` | api key / Bearer / JWT / `password=` / `token=` / 64 位 hex 一律替换 |
| 限长 | `dumpMaxChars` | 只留判据窗口及附近（**保尾部**，因为判据窗口在尾部），不 dump 整段输出 |
| 禁名单 | `dumpDenylistPath` | 会话在 `recall-denylist.json` 里 ⇒ **不落盘**，日志记 `DUMP-SKIP` |

另加两条防爆：`dumpKeep`（条数上限，超了按 mtime 删最旧）与 `(session,turn,kind)` 去重
（同一 turn 的同类命中只留第一次，那时的证据最干净）。

## 怎么用

```bash
# 看有哪些可提升的样本
bash /mnt/models/dsh-workspace/tools/dsh-local-loop-fuse/promote-sample.sh

# 把最新一条提升为 loop-detect 回归夹具（写 ../loop-detect-fixtures/，并打印 README 该加的那一行）
bash /mnt/models/dsh-workspace/tools/dsh-local-loop-fuse/promote-sample.sh --latest

# 只看会写什么
bash /mnt/models/dsh-workspace/tools/dsh-local-loop-fuse/promote-sample.sh --dry-run --latest
```

⚠️ **提升后必须人工确认「期望值」再填 README 表**：自动 dump 只保证「loop-fuse 当时判它是循环」，
而真正要查的可能恰恰是它**判错了**（误杀）—— 那种样本是**负例**，价值比正例更高。

## 边界（诚实的）

- **抓不到"反复失败重试"型循环**（有持续 `tool/result`，两条判据都认为"有进展"）⇒ 那种循环不产生样本。
  详见 `../README.md` 的「已知边界」。
- 样本是**判据的输出**，不是判据的**真值**。它记录"当时的判定 + 当时的证据"，
  不记录"这次到底是不是真循环" —— 后者永远要人看。
