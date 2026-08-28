#!/usr/bin/env bash
# Тестовый запрос к CLAIR PRO: UI→Gateway→Base→LLM, с метриками.
# Использование: bash examples/test_request.sh [текст] [порт gateway]
set -euo pipefail
TEXT="${1:-Расскажи, зачем нужна маршрутизация с сжатием промптов в LLM-агентах.}"
GW_PORT="${2:-8080}"

echo "── Отправляю запрос на Gateway :$GW_PORT ──────────────────────"
curl -s "http://127.0.0.1:${GW_PORT}/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg t "$TEXT" '{model:"gpt-4o-mini",messages:[{role:"user",content:$t}]}')" \
| jq '{answer: .choices[0].message.content}'

echo "── Последняя запись лога Gateway (метрики операции) ──────────"
tail -n 1 "$(dirname "$0")/../..//clair-gateway/logs/gateway.jsonl" 2>/dev/null \
| jq '{saved_tokens, compression_ratio, cache_hits, cache_misses, latency_ms}' \
|| echo "(лог не найден — проверьте GATEWAY_LOG_FILE)"

echo "── Совет: обновите дашборд http://127.0.0.1:4000 ────────────"
