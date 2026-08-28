# 🧊 CLAIR PRO — Unified Experience

[![CI](https://github.com/stregz22ru-droid/clair-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/stregz22ru-droid/clair-pro/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Единый, готовый к использованию продукт поверх трёх независимых компонентов:

| Компонент | Порт | Роль | Границы |
|---|---|---|---|
| **CLAIR Base** | 3000 | неизменное ядро сжатия | **IMMUTABLE** — только HTTP-вызовы и чтение логов |
| **CLAIR Gateway** | 8080 | прокси-шлюз: сжатие + кэш промптов | подключается «как есть», не модифицируется |
| **Visual Dashboard** | 4000 | веб-интерфейс с метриками | новый код этого репозитория |

```
┌─────────────────────────────────────────────────────────┐
│                  CLAIR PRO (Unified)                    │
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ CLAIR Base   │  │   Gateway    │  │  Dashboard   │  │
│  │   (immutable)│◄─│  (сжатие+кэш)│  │   (Web UI)   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │      Orchestration Layer (launcher.js / Docker)  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

Компоненты не знают друг о друге, кроме чётких интерфейсов: HTTP API и JSONL-логи. CLAIR Base — двигатель, Gateway — коробка передач, Dashboard — приборная панель.

---

## 🚀 Быстрый старт (одна команда)

### Windows
```bat
npm install
npm install --prefix ..\clair-gateway
clair-pro.bat
```

### Linux / macOS
```bash
npm install
npm install --prefix ../clair-gateway
./clair-pro.sh
```

Запускается всё одной командой: launcher проверит CLAIR Base, поднимет сервисы в правильном порядке (Base → Gateway → Dashboard), дождётся health checks и откроет браузер на `http://127.0.0.1:4000`.

### Демо без интернета и ключей
```bash
./clair-pro.sh --demo
```
Поднимает mock CLAIR Base (с тем же контрактом `POST /compress` и записью реального формата лога) и mock-LLM на :4100 — полный цикл сжатия виден оффлайн.

---

## 📦 Что умеет Dashboard

- **KPI-карточки**: запросы, сэкономленные токены, средний коэффициент сжатия, hit-rate кэша, средняя задержка.
- **Графики** (Chart.js, локальная копия — работает без интернета):
  - экономия токенов по часам;
  - эффективность сессий (ChatGPT / DeepSeek / Qwen / … — поле `session` из логов);
  - соотношение кэша HIT / PARTIAL / MISS / BYPASS;
  - средняя задержка по времени.
- **Таблица последних запросов** (по умолчанию 100, до 500) с фильтрами: сессия, статус кэша, источник (gateway/base), поиск по тексту.
- **Тестовый запрос через Gateway**: UI → `POST /v1/chat/completions` → сжатие → LLM; под ответом — чипы метрик (сэкономлено, коэффициент, статус кэша, задержка).
- **Экспорт** отфильтрованных данных в CSV (Excel-совместимый, UTF-8 BOM) и JSON.
- **Real-time**: SSE-поток `/api/events` — новые записи в логах появляются мгновенно + автообновление каждые 5 с.
- **Тёмная / светлая тема**, адаптивная вёрстка. Ноль внешних запросов: всё работает локально.

Dashboard читает два JSONL-лога и приводит их к единой схеме:

| Лог | Файл | Поля |
|---|---|---|
| CLAIR Gateway | `<clair-gateway>/logs/gateway.jsonl` | `timestamp, session, model, original_tokens, compressed_tokens, saved_tokens, compression_ratio, cache_hits, cache_misses, latency_ms, status, note` |
| CLAIR Base | `<Clair_pilot>/logs/clair_pilot.log.jsonl` | `timestamp, session, mode, input_tokens, output_tokens, tokens_saved, compression_ratio` |

---

## 🎛️ Режимы и параметры запуска

| Флаг / переменная | Назначение |
|---|---|
| `--demo` | mock Base + mock LLM, оффлайн-демо без ключей |
| `--mock-llm` | реальный Base, но LLM подменён локальным моком (:4100) |
| `--no-browser` | не открывать браузер автоматически |
| `CLAIR_PILOT_DIR` | путь к CLAIR Base (по умолчанию `c:\Clair_pilot` на Windows) |
| `CLAIR_GATEWAY_DIR` | путь к clair-gateway (по умолчанию `../clair-gateway`) |
| `CLAIR_START_CMD` | явная команда запуска Base, если автоопределение не сработало |
| `BASE_PORT / GATEWAY_PORT / DASHBOARD_PORT / LLM_MOCK_PORT` | порты (3000 / 8080 / 4000 / 4100) |

Особенности оркестратора:
- **переиспользование**: если сервис уже отвечает на своём порту, второй экземпляр не запускается;
- **health checks**: UI открывается только после того, как все сервисы ответили `/health`;
- **понятные ошибки**: если Base не найден — подсказка, что делать (проверить путь / задать `CLAIR_PILOT_DIR` / запустить `--demo`);
- **graceful shutdown**: `Ctrl+C` аккуратно закрывает все дочерние процессы (POSIX process groups / Windows `taskkill /T`), не оставляя зомби;
- **аварийная остановка**: падение любого сервиса останавливает весь стек.

## 🐳 Docker Compose

```bash
cp .env.example .env   # укажите CLAIR_PILOT_DIR (например, c:\Clair_pilot)
docker compose up --build
```

Сервисы: `clair-base` (монтаж каталога Base), `gateway` (образ из clair-gateway, `depends_on` c health check), `dashboard` (свой образ, читает логи через общие volumes). Демо-LLM: `docker compose --profile demo up` + `LLM_PROVIDER_URL=http://llm-mock:4100`.

> ⚠️ Монтирование Windows-путей в Docker Desktop иногда капризно. Если с volume возникнут проблемы — используйте Node-лаунчер: он делает то же самое без Docker.

---

## 📂 Структура проекта

```
clair-pro/
├── launcher.js                # кроссплатформенное ядро оркестрации
├── clair-pro.bat              # Windows-обёртка (3 строки)
├── clair-pro.sh               # Linux/Mac-обёртка (3 строки)
├── docker-compose.yml         # оркестрация через Docker
├── dashboard/
│   ├── src/
│   │   ├── server.ts          # backend: API, SSE, экспорт, прокси
│   │   ├── config.ts          # конфигурация из env
│   │   ├── stats.ts           # парсинг JSONL + агрегации (тестируемое ядро)
│   │   └── public/            # vanilla UI + vendored Chart.js
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── mocks/clair-base-mock.mjs  # демо-двойник Base (контракт + формат лога)
├── examples/                  # test_request.sh, demo.py
├── tests/
│   ├── dashboard.test.ts      # 14 юнит-тестов API
│   └── orchestration.test.ts  # 6 e2e-тестов полного стека
├── docs/
│   ├── INSTALL.md             # установка под Windows/Linux
│   ├── ARCHITECTURE.md        # схема, границы, потоки данных
│   ├── WINDOWS_CHECKLIST.md   # приёмка на Windows (по шагам)
│   └── VIDEO_SCRIPT.md        # сценарий видео-демо на 6 минут
└── scripts/smoke.sh           # авто-проверка «всё живое» на реальном стеке
```

## 🧪 Тесты

```bash
npm test          # 14 тестов Dashboard API (данные, фильтры, экспорт, прокси)
npm run test:e2e  # 6 e2e-тестов: полный стект via launcher --demo на изолированных портах
npm run smoke     # смоук живого стека (кроме Docker): healths, запрос, логи, экспорт
```

E2e покрывает сценарии приёмки: старт одной командой, health всех сервисов, сквозной запрос со сжатием и записью в оба лога, агрегация в Dashboard, экспорт, graceful shutdown без «зомби» на портах.

## 🔒 Соблюдение границ

- В `c:\Clair_pilot\` не добавлено ни одного файла и не изменён ни один байт: Base вызывается по HTTP (`POST /compress`, `GET /health`), его лог читается read-only.
- CLAIR Gateway подключается из соседнего каталога без изменений кода; его Docker-образ собирается из его же репозитория.
- Все новые файлы живут внутри `clair-pro/`.
- Никаких внешних сетевых вызовов: Chart.js завендорен, логи никуда не отправляются, БД не используются — только чтение JSONL.
