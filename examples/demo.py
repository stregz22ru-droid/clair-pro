#!/usr/bin/env python3
"""Demo agent for CLAIR PRO.

Shows the drop-in nature of the Gateway: the agent code looks like a regular
OpenAI call — the only difference is the base_url. Compression, caching and
logging happen inside the pipeline (Gateway → CLAIR Base → LLM).

Usage:
    python examples/demo.py [base_url]        # default http://127.0.0.1:8080/v1
"""
import json
import sys
import urllib.request

BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8080/v1"
URL = f"{BASE_URL.rstrip('/')}/chat/completions"

TASKS = [
    "Составь план автоматизации тестирования для веб-приложения на два месяца.",
    "Объясни разницу между идемпотентностью и безопасностью HTTP-методов.",
    "Придумай три идеи геймификации обучения для корпоративного курса.",
]


def chat(prompt: str) -> dict:
    body = json.dumps(
        {
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "Ты полезный ассистент. Отвечай кратко."},
                {"role": "user", "content": prompt},
            ],
        }
    ).encode()
    req = urllib.request.Request(
        URL, data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def main() -> None:
    print(f"CLAIR PRO demo agent → {URL}\n")
    for i, task in enumerate(TASKS, 1):
        answer = chat(task)
        text = answer["choices"][0]["message"]["content"]
        print(f"── Задача {i} ─{'─' * 40}")
        print(task)
        print(f"Ответ: {text[:180]}{'…' if len(text) > 180 else ''}\n")
    print("Готово. Метрики каждого запроса — в дашборде http://127.0.0.1:4000")


if __name__ == "__main__":
    main()
