#!/usr/bin/env bash
# CLAIR PRO smoke: проверяет живой стек на СТАНДАРТНЫХ портах.
# Ожидает, что launcher уже запущен (./clair-pro.sh [--demo]) либо запускает его сам.
# Использование: bash scripts/smoke.sh [--start-demo]
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

say_ok()  { echo "  ✓ $1"; PASS=$((PASS+1)); }
say_bad() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
check()   { if eval "$2" >/dev/null 2>&1; then say_ok "$1"; else say_bad "$1"; fi; }

# ── 0. При необходимости поднять демо-стек ───────────────────────────────────
if [[ "${1:-}" == "--start-demo" ]]; then
  echo "── Запускаю demo-стек (launcher --demo) ──"
  mkdir -p "$ROOT/logs"
  node "$ROOT/launcher.js" --demo --no-browser > "$ROOT/logs/smoke-launcher.log" 2>&1 &
  LAUNCHER_PID=$!
  echo "  launcher pid=$LAUNCHER_PID (лог: logs/smoke-launcher.log)"
  sleep 14
fi

cleanup() {
  if [[ -n "${LAUNCHER_PID:-}" ]]; then
    kill -INT "$LAUNCHER_PID" 2>/dev/null
    sleep 2
    kill -9 "$LAUNCHER_PID" 2>/dev/null
  fi
}
trap cleanup EXIT

# ── 1. Health checks ──────────────────────────────────────────────────────────
echo "── 1. Health checks ──"
check "Base      :3000 /health" "curl -sf http://127.0.0.1:3000/health | grep -q ok"
check "Gateway   :8080 /health" "curl -sf http://127.0.0.1:8080/health | grep -q ok"
check "Dashboard :4000 /health" "curl -sf http://127.0.0.1:4000/health | grep -q ok"

# ── 2. UI отдаётся ────────────────────────────────────────────────────────────
echo "── 2. Dashboard UI ──"
check "index.html содержит CLAIR PRO" "curl -sf http://127.0.0.1:4000/ | grep -q 'CLAIR'"
# NB: без -q у grep! -q закрывает stdin при первом совпадении, curl получает
# SIGPIPE на 208 КБ файле, а set -o pipefail превращает это в ошибку пайпа.
check "Chart.js завендорен (локальный файл)" "curl -sf http://127.0.0.1:4000/vendor/chart.umd.js | grep 'Chart.js v4' >/dev/null"

# ── 3. Сквозной запрос ────────────────────────────────────────────────────────
echo "── 3. Сквозной запрос через Gateway ──"
RESP=$(curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Идея автоматизации образования: аудио-визуальные ассоциации и оранжерея с эвкалиптом."}]}')
check "ответ LLM получен (choices)" "echo '$RESP' | jq -e '.choices[0].message.content'"

# ── 4. Логи выросли ───────────────────────────────────────────────────────────
echo "── 4. Логи ──"
check "gateway.jsonl содержит свежую запись" "curl -sf 'http://127.0.0.1:4000/api/data?limit=5' | jq -e '.entries | length > 0'"
check "оба файла логов существуют" "curl -sf 'http://127.0.0.1:4000/api/data' | jq -e '[.files[].exists] | all'"

# ── 5. Агрегаты и экспорт ─────────────────────────────────────────────────────
echo "── 5. Агрегаты и экспорт ──"
check "есть сэкономленные токены" "curl -sf http://127.0.0.1:4000/api/data | jq -e '.stats.totals.savedTokens > 0'"
check "CSV экспорт: заголовок на месте" "curl -sf http://127.0.0.1:4000/api/export.csv | head -1 | grep -q 'timestamp,source,session'"
check "JSON экспорт: count > 0" "curl -sf http://127.0.0.1:4000/api/export.json | jq -e '.count > 0'"

# ── Итог ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════"
echo "  SMOKE: PASS=$PASS FAIL=$FAIL"
echo "══════════════════════════════════════"
[[ $FAIL -eq 0 ]]
