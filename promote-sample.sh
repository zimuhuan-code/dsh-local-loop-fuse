#!/usr/bin/env bash
# promote-sample.sh —— 把 loop-fuse 落下的**真实样本**提升为 loop-detect 回归夹具
#
# 为什么需要它：`loop-detect.py` 原先只有**人工构造**的夹具 —— 2026-10-03 想用真实污染样本
#   回归时发现那条会话正文已不可逆清除，真实夹具**再也拿不到**。于是给 loop-fuse 加了
#   「触发即 dump 样本」（v0.6.0，落 `tools/dsh-local-loop-fuse/samples/`）。
#   本脚本负责把 dump **机械地**变成夹具 + 打印要往 README 表里加的那一行，
#   省掉「手工复制、猜编号、再手抄结果」三步（那三步正是夹具腐化的来源）。
#
# 用法：
#   bash promote-sample.sh                # 列出可提升的样本（按时间倒序）
#   bash promote-sample.sh --latest       # 提升最新一条带正文的样本
#   bash promote-sample.sh <sample.json>  # 提升指定样本
#   bash promote-sample.sh --dry-run <s>  # 只看会写什么，不落盘
#
# ⚠️ 只提升 `kind=text-loop` 的样本 —— 只有它带 `text` 正文字段，才喂得动 `loop-detect.py`。
#    `repeat-call` / `stalled` 是**判据账本**（没有连续正文），留着人工看，不进这个夹具目录。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SAMPLES="$HERE/samples"
export FIXTURES="$HERE/../loop-detect-fixtures"
export DETECT="$HERE/../loop-detect.py"
export DRY=0
export ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) export DRY=1; shift ;;
    --latest)  export ARG="__LATEST__"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) export ARG="$1"; shift ;;
  esac
done

python3 - <<'PY'
import json, os, pathlib, re, subprocess, sys

samples  = pathlib.Path(os.environ["SAMPLES"])
fixtures = pathlib.Path(os.environ["FIXTURES"])
detect   = os.environ["DETECT"]
dry      = os.environ["DRY"] == "1"
arg      = os.environ["ARG"]

if not samples.is_dir():
    print(f"❌ 样本目录不存在：{samples}")
    print("   （loop-fuse v0.6.0 起才会产生样本；还没触发过循环就是空的）")
    sys.exit(1)

def load():
    rows = []
    for p in sorted(samples.glob("*.json")):
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        if j.get("kind") != "text-loop" or not j.get("text"):
            continue
        ev = j.get("evidence") or {}
        rows.append({
            "path": p, "at": j.get("atLocal", "?"), "turn": j.get("turn"),
            "chars": j.get("chars", 0), "period": ev.get("period"),
            "occ": ev.get("occurrences"), "acted": j.get("acted"),
            "session": j.get("session"), "text": j["text"],
        })
    rows.sort(key=lambda r: r["path"].stat().st_mtime, reverse=True)
    return rows

rows = load()

if not arg:
    if not rows:
        print("可用样本（kind=text-loop 且带正文）：")
        print("  （暂无 —— 要么还没触发过文本循环，要么样本已被 dumpKeep 上限清掉）")
        sys.exit(0)
    print("可用样本（kind=text-loop 且带正文，按时间倒序）：")
    for r in rows:
        print(f"  {r['path']}")
        print(f"      at={r['at']}  turn={r['turn']}  chars={r['chars']}  "
              f"period={r['period']}  occ={r['occ']}  acted={r['acted']}  session={r['session']}")
    print()
    print("提升某条：bash promote-sample.sh <上面的路径>")
    print("提升最新：bash promote-sample.sh --latest")
    sys.exit(0)

if arg == "__LATEST__":
    if not rows:
        print("❌ 没有可提升的样本")
        sys.exit(1)
    rec = rows[0]
    print(f"ℹ️  最新样本：{rec['path']}")
else:
    p = pathlib.Path(arg)
    if not p.is_file():
        print(f"❌ 找不到文件：{p}")
        sys.exit(1)
    rec = next((r for r in rows if r["path"] == p), None)
    if rec is None:
        j = json.loads(p.read_text(encoding="utf-8"))
        if j.get("kind") != "text-loop":
            print(f"❌ 该样本 kind={j.get('kind')} —— 只有 text-loop 带正文、能当夹具")
            sys.exit(1)
        print("⚠️  该样本不在当前样本目录内（仍尝试提升）")
        rec = {"path": p, "text": j.get("text", ""), "session": j.get("session"),
               "at": j.get("atLocal", "?"), "turn": j.get("turn"),
               "chars": j.get("chars", 0)}

nums = [int(m.group(1)) for f in fixtures.glob("*.txt") if (m := re.match(r"^(\d+)_", f.name))]
nxt = f"{(max(nums) + 1) if nums else 1:02d}"
sid = (rec.get("session") or "nosid")[:12]
name = f"{nxt}_real_{sid}.txt"
target = fixtures / name
body = rec["text"]

if dry:
    print(f"ℹ️  --dry-run：将写入 {target}（{len(body)} 字符）")
    print("--- 正文前 300 字符 ---")
    print(body[:300])
    print("\n（dry-run：未落盘、未改 README）")
    sys.exit(0)

target.write_text(body, encoding="utf-8")
print(f"✅ 已写出夹具：{target}（{len(body)} 字符）")

print()
print("── 用 loop-detect.py 跑一遍，拿到「实测」列（直接抄进 README 表）──")
r = subprocess.run([sys.executable, detect, str(target)], capture_output=True, text=True)
print("\n".join(r.stdout.splitlines()[:12]))
if r.stderr.strip():
    print(r.stderr.strip()[:400])

print()
print(f"── 往 {fixtures}/README.md 的表里加这一行 ──")
print(f"| `{name}` | **真实样本**（loop-fuse v0.6.0 自动 dump，session=`{sid}…`，turn={rec.get('turn')}） "
      f"| ⬜ 待人工确认 | ⬜ 待填 |")
print()
print("⚠️ 真实样本的「期望值」必须**由人确认**后再填 —— 自动 dump 只保证「loop-fuse 当时判它是循环」，")
print("   而真正要查的可能恰恰是它**判错了**（误杀）。先人工看一眼正文，再决定这一行算检出还是负例。")
sys.exit(r.returncode)
PY
