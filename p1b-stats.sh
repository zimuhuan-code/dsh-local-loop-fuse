#!/usr/bin/env bash
# p1b-stats.sh —— 聚合「注入能力」与「注入效果」，**出概率**（2026-10-07 定）
#
# 起因（原话）：「**先解决能不能注入**，之后才是误杀和有没有用 …… 误杀允许存在，
#   注入可以没用，**概率是多少要统计出来**」
# ⇒ 本脚本只做一件事：把 loop-fuse 日志里的 P1-b / ⑤ 线事件**累加成率**，
#   并在样本不足时**明说不足**（不把 n=1 当结论）。
#
# 两段分开看（顺序不能颠倒）：
#   ① 能不能注入 = CAPABILITY / INJECT 成功 vs SKIP/FAIL      ← **先看这段**
#   ② 有没有用   = OBSERVE 的 verdict 分布 + ⑤ 线效果         ← 有样本了再看
#
# ⚠️ 为什么「先解决能不能注入」：注入路径有**两关** ——
#   (a) `agent.steer` 在不在（`P1B-CAPABILITY`，任何一次 LLM 请求时就地探测）；
#   (b) 构造消息要的 `@deepseek-ai/dsh-llm` 能不能解析（`STEER-RESOLVE`；解析不到时走
#       **自建兜底**，日志里 `via=self-built`）。两关都过才有 `P1B-INJECT`。
#
# 用法：
#   bash p1b-stats.sh                     # 用默认落点（按 DSH_HOME 派生）
#   bash p1b-stats.sh /path/to/loop-fuse.log
set -uo pipefail
DEFAULT_LOG="${DSH_HOME:-$HOME/.dsh}/logs/dsh-local-loop-fuse/loop-fuse.log"
LOG="${1:-$DEFAULT_LOG}"
if [ ! -f "$LOG" ]; then
  echo "❌ 日志不存在：$LOG"
  echo
  echo "   ⚠️ 很多实例会用 cordis.patch.yml 把 logPath 钉到别处（默认值只是**可移植的兜底**）。"
  echo "   先看本实例实际写在哪儿，再把它作为参数传进来："
  echo "     grep -rn -A3 'dsh-local-loop-fuse' \"\${DSH_HOME:-\$HOME/.dsh}/profiles/*/cordis.patch.yml\" | grep logPath"
  echo "     bash $0 <上面那行的路径>"
  exit 1
fi

c() { grep -ac -- "$1" "$LOG" 2>/dev/null | head -1; }
pct() { awk -v a="$1" -v b="$2" 'BEGIN{ if (b+0==0) printf "—"; else printf "%.0f%%", a*100/b }'; }
line() { # $1 标签 $2 分子 $3 分母
  local mark=""; [ "${3:-0}" -lt 5 ] && mark="   ⚠️ n<5 不足以下结论"
  printf '   %-30s %4s/%-4s = %-5s%s\n' "$1" "$2" "${3:-0}" "$(pct "${2:-0}" "${3:-0}")" "$mark"
}

echo "════ 注入统计（$LOG）════"
echo "更新时刻：$(stat -c %y "$LOG" 2>/dev/null | cut -c1-19) · 日志行数：$(wc -l < "$LOG")"
echo
echo "【① 能力层 —— 先解决这个】"
# ⚠️ 正则必须**锚到 `steer=true cancel=`**（实测踩坑：那行日志的后半句说明文字里
#   还含 `steer=false ⇒ …` ⇒ 宽正则会**在同一行上数两次**，报出假的 `1/2 = 50%` 与一条假 🚩。
#   这正是本仓库反复出现的那族毛病：**判据比被检查的东西宽**。现在那半句已改成中文描述，
#   但**锚定正则保留** —— 它才是真防线。）
cap_y=$(c 'P1B-CAPABILITY .*steer=true cancel='); cap_n=$(c 'P1B-CAPABILITY .*steer=false cancel=')
line 'steer 可用（会话数）' "$cap_y" "$((cap_y + cap_n))"
[ "$cap_n" -gt 0 ] && echo "   🚩 有 $cap_n 个会话 steer 不可用 ⇒ P1-b 与 ⑤ 线**都注入不了**（先解决这层，不是调参）"
# 第二关：构造消息要 `@deepseek-ai/dsh-llm`（dsh 内部包）—— `link:` 插件未必解析得到
rs_y=$(c 'STEER-RESOLVE ok'); rs_n=$(c 'STEER-RESOLVE fail')
printf '   %-30s %s\n' '注入通路 · 解析成功（进程数）' "$rs_y"
[ "$rs_n" -gt 0 ] && echo "   ⚠️ 有 $rs_n 个进程只用**自建兜底**（解析不到 @deepseek-ai/dsh-llm ⇒ via=self-built）"
echo
echo "【② 注入层 —— P1-b（① 线命中触发）】"
ij=$(c 'P1B-INJECT session'); isk=$(c 'P1B-INJECT-SKIP'); ifa=$(c 'P1B-INJECT-FAIL')
line 'P1-b 注入成功' "$ij" "$((ij + isk + ifa))"
line '  └ SKIP（拿不到能力）' "$isk" "$((ij + isk + ifa))"
line '  └ FAIL（抛错）' "$ifa" "$((ij + isk + ifa))"
line '  └ 其中 via=dsh-llm' "$(c 'P1B-INJECT .*via=dsh-llm')" "$ij"
line '  └ 其中 via=self-built' "$(c 'P1B-INJECT .*via=self-built')" "$ij"
echo
echo "【③ 效果层 —— 注入后观测（双读数 · **只看注入成功的样本**）】"
# ⚠️ 必须按 `injected=true` 过滤（拾遗第 3 轮 §2.2 实测）：早期实现里 SKIP/FAIL 也会产出 verdict
#   ⇒ 有效率的分母被"根本没注入"的样本污染。现在代码侧已修（未注入不建观测），
#   这里再过滤一次是**对历史日志的防御**。
v_ok=$(c 'P1B-OBSERVE.*injected=true.*verdict=有效')
v_no=$(c 'P1B-OBSERVE.*injected=true.*verdict=无效')
v_un=$(c 'P1B-OBSERVE.*injected=true.*verdict=不确定')
v_cut=$(c 'P1B-OBSERVE.*verdict=观察中断')
v_tot=$((v_ok + v_no + v_un))
line '有效（k24 降 & 注入后不再循环）' "$v_ok" "$v_tot"
line '无效（注入后仍循环）' "$v_no" "$v_tot"
line '不确定' "$v_un" "$v_tot"
printf '   %-30s %s\n' '观察中断（turn 结束未满 N）' "$v_cut"
printf '   %-30s %s\n' '带进下一个 turn 观察（DEFER）' "$(c 'P1B-OBSERVE-DEFER')"
printf '   %-30s %s\n' '注入未确认（窗口在、steer 未 resolve）' "$(c 'P1B-OBSERVE.*verdict=注入未确认')"
printf '   %-30s %s\n' '观测自身出错（OBSERVE-FAIL）' "$(c 'P1B-OBSERVE-FAIL')"
# §1-7：`blindChars` = 注入所在 attempt 内、steer 尚不可能影响的那段字符数
#   ⇒ 它是**干预延迟**唯一可用的健康指标，也是**下界**（从"决定注入"到"窗口存在"之间的字符没算）。
bl=$(grep -ao 'blindChars=[0-9]*' "$LOG" 2>/dev/null | cut -d= -f2 | sort -n)
if [ -n "$bl" ]; then
  n=$(echo "$bl" | wc -l); med=$(echo "$bl" | awk -v n="$n" 'NR==int((n+1)/2){print; exit}')
  printf '   %-30s %s\n' 'blindChars 中位 / 最大' "$med / $(echo "$bl" | tail -1)   （n=$n · 下界）"
fi
printf '   %-30s %s\n' '撞 episode 上限（INJECT-QUOTA）' "$(c 'P1B-INJECT-QUOTA')"
echo "   📌 对照基线：本簇真循环的**基础自愈率 = 2/6 ≈ 33%**（307/308 自愈 · 309/311/313 被按停）"
echo "      ⇒ 注入有效率**必须与它比**；单次有效不作证据。"
echo "   📌 「观察中断」是**必须看**的一栏：它高 ⇒ 说明观测窗口（p1bObserveChars，默认 2000）"
echo "      有效率的分母会偏小（只有跑满 N 的那些算数）。"
echo
echo "【④ ⑤ 线（零正文 turn）—— 同一 steer API】"
e_ok=$(c 'EMPTY-TURN-STEER session'); e_sk=$(c 'EMPTY-TURN-STEER-SKIP'); e_fa=$(c 'EMPTY-TURN-STEER-FAIL')
line '⑤ 线 steer 成功' "$e_ok" "$((e_ok + e_sk + e_fa))"
line '  └ SKIP / FAIL' "$((e_sk + e_fa))" "$((e_ok + e_sk + e_fa))"
echo
echo "【⑤ 检测层（仅计数，不作结论）】"
printf '   %-30s %s\n' '① 线 DETECT 行' "$(c 'DETECT attempt')"
printf '   %-30s %s\n' '① 线 STRIKE-PENDING 行' "$(c 'STRIKE-PENDING')"
printf '   %-30s %s\n' '③ 线真掐断 ABORT-VIA-CANCEL' "$(c 'ABORT-VIA-CANCEL')"
printf '   %-30s %s\n' 'EMPTY-TURN 记录（含旧 log 期）' "$(c 'EMPTY-TURN session')"
