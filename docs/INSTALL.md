# Установка CLAIR PRO

## 0. Требования

| Компонент | Версия | Проверка |
|---|---|---|
| Node.js | **20+** | `node -v` |
| npm | 10+ | `npm -v` |
| CLAIR Base | любой, с `POST /compress` + `GET /health` | каталог `c:\Clair_pilot\` |
| CLAIR Gateway | v1.1.0+ | репозиторий рядом: `..\clair-gateway` |

Docker (опционально, только для docker-compose пути): Docker Desktop 4.x / Engine 24+.

## 1. Разместить репозитории рядом

````text
<любой каталог>\
├── clair-gateway\     ← репозиторий шлюза (не изменяется)
└── clair-pro\         ← этот проект
````

Если Gateway лежит в другом месте — задайте `CLAIR_GATEWAY_DIR`.

## 2. Установить зависимости (один раз)

Windows (cmd/PowerShell):
```bat
cd clair-pro
npm install
npm install --prefix ..\clair-gateway
```

Linux / macOS:
```bash
cd clair-pro
npm install
npm install --prefix ../clair-gateway
```

## 3. Запуск

Windows: `clair-pro.bat`  •  Linux/macOS: `./clair-pro.sh`

Launcher:
1. найдёт CLAIR Base (по умолчанию `c:\Clair_pilot`, переопределяется `CLAIR_PILOT_DIR`);
2. запустит Base → Gateway (:8080, `CLAIR_BASE_URL` указывает на Base) → Dashboard (:4000);
3. дождётся `/health` от каждого;
4. откроет браузер на `http://127.0.0.1:4000`.

Если Base уже запущен кем-то — launcher переиспользует его и не станет запускать второй экземпляр.

Полезные варианты:
```bash
./clair-pro.sh --demo        # оффлайн-демо: mock Base + mock LLM
./clair-pro.sh --mock-llm    # реальный Base, LLM подменён моком
./clair-pro.sh --no-browser  # без автооткрытия браузера
```

## 4. Docker Compose (альтернатива)

```bash
cp .env.example .env
# Windows: укажите CLAIR_PILOT_DIR=c:\Clair_pilot в .env
docker compose up --build
```

- Dashboard: http://localhost:4000, Gateway: :8080, Base: :3000.
- Логи Gateway живут в named volume `gateway-logs` и видны Dashboard; логи Base читаются из `<CLAIR_PILOT_DIR>/logs`.
- Демо-режим: `LLM_PROVIDER_URL=http://llm-mock:4100 docker compose --profile demo up`.

## 5. Проверка после установки

```bash
curl http://127.0.0.1:3000/health   # Base
curl http://127.0.0.1:8080/health   # Gateway
curl http://127.0.0.1:4000/health   # Dashboard
bash examples/test_request.sh       # сквозной запрос с метриками
```

Либо целиком: `npm run smoke` — он прогоняет все проверки автоматически.

## 6. Частые проблемы

| Симптом | Причина / решение |
|---|---|
| `CLAIR Base не найден в c:\Clair_pilot` | Проверьте путь; задайте `set CLAIR_PILOT_DIR=D:\...` или запустите `--demo` |
| `Не удалось определить точку входа CLAIR Base` | Задайте явно: `set CLAIR_START_CMD=node dist\server.js` (пример) |
| Порт занят (EADDRINUSE) | Сервис уже запущен: launcher переиспользует его; если процесс чужой и «сломан» — остановите его |
| Gateway 503 `fail_closed` | CLAIR Base недоступен: проверьте :3000/health; либо поставьте `CLAIR_FAIL_STRATEGY=fail_open` в конфиге Gateway |
| Dashboard «нет данных» | Логи пустые: сделайте тестовый запрос; проверьте пути `GATEWAY_LOG_FILE`, `BASE_LOG_FILE` |
| Windows: `node` не найден в .bat | Node не в PATH текущей сессии — установите LTS и переоткройте консоль |
