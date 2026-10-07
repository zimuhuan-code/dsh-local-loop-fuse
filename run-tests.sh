#!/usr/bin/env bash
# run-tests.sh —— 跑 dsh-local-loop-fuse 全部测试，**并守住 samples/ 目录不被测试污染**
#
# 为什么要有这条守卫：v0.6.0 给插件加了「判中即落样本」的**默认行为**，而集成测试
#   （test-abort / test-cancel）是用 `...DEFAULTS` 起 `apply()` 的 ⇒ **跑一次回归就往真
#   `samples/` 写 5–6 条假样本**（session 名是 sess-test / sess-win …）。
#   2026-10-03 实际踩到：只"在文档里写一句注意"是不够的 —— 下次加默认行为还会再犯。
#   ⇒ 这里做**机械检查**（跑前跑后对目录取指纹，变了就红），不靠人记得。
#
# 用法：bash run-tests.sh
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SAMPLES="samples"
snapshot() { ls -A "$SAMPLES" 2>/dev/null | sort | md5sum | cut -c1-12; }

before="$(snapshot)"
echo "── samples/ 指纹（跑前）：$before ──"
echo

fail=0
TMP="$(mktemp)"
for t in test-islooping.mjs test-abort.mjs test-cancel.mjs test-dump.mjs test-empty-turn.mjs; do
  printf '═══ %s ═══\n' "$t"
  node "$t" >"$TMP" 2>&1
  rc=$?
  grep -v 'UNDICI-EHPA\|trace-warnings' "$TMP" | grep -E '结果：|全部通过|项失败' | tail -2
  if [[ $rc -ne 0 ]]; then
    echo "   ❌ 退出码 $rc"
    grep -v 'UNDICI-EHPA\|trace-warnings' "$TMP" | grep -E '^❌' | head -5
    fail=1
  fi
  echo
done
rm -f "$TMP"

after="$(snapshot)"
echo "── samples/ 指纹（跑后）：$after ──"
if [[ "$before" == "$after" ]]; then
  echo "✅ 测试未污染 samples/（指纹一致）"
else
  echo "❌ **测试污染了 samples/！** 指纹 $before → $after"
  echo "   多半是某个测试用 \`...DEFAULTS\` 起 apply() 却没关 dumpSamples。"
  echo "   修法：在它的 apply() 配置里加 \`dumpSamples: false\`（或把 dumpDir 指到临时目录）。"
  echo "   当前 samples/ 里的 json：$(ls -A "$SAMPLES" 2>/dev/null | grep -c json)"
  fail=1
fi

echo
if [[ $fail -eq 0 ]]; then echo "✅ 全部通过（含 samples/ 不被污染）"; else echo "❌ 有失败项，见上"; fi
exit $fail
