/* CLAIR PRO Dashboard — vanilla JS, no build step, zero external requests. */
(() => {
  "use strict";

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmtInt = (n) => (n ?? 0).toLocaleString("ru-RU");
  const fmtRatio = (n) => `×${(n ?? 1).toFixed(2)}`;
  const fmtMs = (n) => (n === null || n === undefined ? "—" : `${fmtInt(n)} мс`);
  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  };

  let toastTimer = null;
  const toast = (msg) => {
    const el = $("toast");
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  };

  // ── Theme ────────────────────────────────────────────────────────────────────
  const THEME_KEY = "clair-theme";
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    $("btn-theme").textContent = t === "dark" ? "🌙" : "☀️";
    localStorage.setItem(THEME_KEY, t);
    Object.assign(Chart.defaults, {
      color: cssVar("--text-dim"),
      borderColor: cssVar("--grid"),
    });
    if (state.data) renderCharts(state.data.stats); // re-tint charts
  };
  $("btn-theme").addEventListener("click", () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  );

  // ── State ────────────────────────────────────────────────────────────────────
  const state = { data: null, charts: {}, timer: null };

  const filterQuery = (extra = {}) => {
    const p = new URLSearchParams();
    const session = $("f-session").value;
    const cache = $("f-cache").value;
    const source = $("f-source").value;
    const q = $("f-q").value.trim();
    if (session) p.set("session", session);
    if (cache) p.set("cache", cache);
    if (source) p.set("source", source);
    if (q) p.set("q", q);
    p.set("limit", $("f-limit").value);
    for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
    return p.toString();
  };

  // ── Data loading ─────────────────────────────────────────────────────────────
  async function load() {
    try {
      const res = await fetch(`/api/data?${filterQuery()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
      renderKPIs(state.data.stats);
      renderCharts(state.data.stats);
      renderTable(state.data);
      renderFileMeta(state.data.files);
      $("live-indicator").classList.remove("off");
    } catch (err) {
      $("live-indicator").classList.add("off");
      toast(`Не удалось получить данные: ${err.message}`);
    }
  }

  // ── KPI ──────────────────────────────────────────────────────────────────────
  function renderKPIs(stats) {
    const t = stats.totals;
    $("kpi-requests").textContent = fmtInt(t.requests);
    $("kpi-requests-hint").textContent = `${stats.byModel.length > 0 ? `моделей: ${stats.byModel.length}` : "источник: логи"}`;
    $("kpi-saved").textContent = fmtInt(t.savedTokens);
    const savedPct = t.originalTokens > 0 ? Math.round((t.savedTokens / t.originalTokens) * 100) : 0;
    $("kpi-saved-hint").textContent = `−${savedPct}% от исходных ${fmtInt(t.originalTokens)}`;
    $("kpi-ratio").textContent = fmtRatio(t.avgRatio);
    const ch = stats.cache;
    const counted = ch.HIT + ch.PARTIAL + ch.MISS + ch.BYPASS;
    const hitRate = counted > 0 ? Math.round(((ch.HIT + ch.PARTIAL) / counted) * 100) : null;
    $("kpi-cache").textContent = hitRate === null ? "—" : `${hitRate}%`;
    $("kpi-cache-hint").textContent = counted > 0 ? `HIT ${ch.HIT} · PARTIAL ${ch.PARTIAL} · MISS ${ch.MISS} · BYP ${ch.BYPASS}` : "кэш не зафиксирован";
    $("kpi-latency").textContent = stats.latency.samples ? fmtMs(stats.latency.avg) : "—";
    $("kpi-latency-hint").textContent = stats.latency.samples ? `p95: ${fmtMs(stats.latency.p95)} · n=${stats.latency.samples}` : "нет данных gateway";
  }

  // ── Charts ───────────────────────────────────────────────────────────────────
  function chartColors() {
    return {
      dim: cssVar("--text-dim"),
      grid: cssVar("--grid"),
      accent: cssVar("--accent"),
      good: cssVar("--good"),
      warn: cssVar("--warn"),
      bad: cssVar("--bad"),
    };
  }

  function upsertChart(id, config) {
    if (state.charts[id]) {
      state.charts[id].data = config.data;
      state.charts[id].options = config.options;
      state.charts[id].update();
      return;
    }
    state.charts[id] = new Chart($(id), config);
  }

  function renderCharts(stats) {
    const col = chartColors();
    Chart.defaults.font.family = cssVar("--font");

    // 1. Token savings per hour (line/area)
    upsertChart("chart-saved", {
      type: "line",
      data: {
        labels: stats.byHour.map((b) => b.key.slice(11, 16) === "00:00" ? b.key.slice(5, 16) : b.key.slice(11, 16)),
        datasets: [
          {
            label: "сэкономлено токенов",
            data: stats.byHour.map((b) => b.savedTokens),
            borderColor: col.accent,
            backgroundColor: col.accent + "33",
            fill: true,
            tension: 0.35,
            pointRadius: 2.5,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: col.grid }, ticks: { maxTicksLimit: 12 } },
          y: { grid: { color: col.grid }, beginAtZero: true },
        },
      },
    });

    // 2. Sessions: saved tokens per session (bar)
    const sessions = stats.bySession.slice().sort((a, b) => b.savedTokens - a.savedTokens);
    upsertChart("chart-sessions", {
      type: "bar",
      data: {
        labels: sessions.map((b) => b.key),
        datasets: [
          {
            label: "сэкономлено",
            data: sessions.map((b) => b.savedTokens),
            backgroundColor: col.accent + "cc",
            borderRadius: 6,
          },
          {
            label: "запросов",
            data: sessions.map((b) => b.requests),
            backgroundColor: col.dim + "55",
            borderRadius: 6,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { boxWidth: 12 } } },
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: col.grid }, beginAtZero: true },
        },
      },
    });

    // 3. Cache outcomes (doughnut)
    const ch = stats.cache;
    upsertChart("chart-cache", {
      type: "doughnut",
      data: {
        labels: ["HIT", "PARTIAL", "MISS", "BYPASS", "без кэша"],
        datasets: [
          {
            data: [ch.HIT, ch.PARTIAL, ch.MISS, ch.BYPASS, ch.none],
            backgroundColor: [col.good, col.warn, col.bad, col.dim, col.grid],
            borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: "62%",
        plugins: { legend: { position: "right", labels: { boxWidth: 12 } } },
      },
    });

    // 4. Latency per hour (line)
    upsertChart("chart-latency", {
      type: "line",
      data: {
        labels: stats.byHour.map((b) => b.key),
        datasets: [
          {
            label: "средняя задержка, мс",
            data: stats.byHour.map((b) => b.avgLatencyMs),
            borderColor: col.good,
            backgroundColor: col.good + "22",
            fill: true,
            tension: 0.3,
            pointRadius: 2.5,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: col.grid }, ticks: { maxTicksLimit: 12 } },
          y: { grid: { color: col.grid }, beginAtZero: true },
        },
      },
    });
  }

  // ── Table ────────────────────────────────────────────────────────────────────
  const CACHE_CHIP = { HIT: "chip good", PARTIAL: "chip warn", MISS: "chip bad", BYPASS: "chip" };

  function renderTable(data) {
    const tbody = $("requests-table").querySelector("tbody");
    tbody.innerHTML = "";
    for (const e of data.entries) {
      const tr = document.createElement("tr");
      const cells = [
        fmtTime(e.ts),
        `<span class="src ${e.source}">${e.source}</span>`,
        esc(e.session),
        esc(e.model ?? e.mode ?? "—"),
        `<td class="num">${fmtInt(e.original)} → ${fmtInt(e.compressed)}</td>`,
        `<td class="num">${e.saved > 0 ? `<span class="accent">−${fmtInt(e.saved)}</span>` : "0"}</td>`,
        `<td class="num">${fmtRatio(e.ratio)}</td>`,
        e.cacheState ? `<td><span class="${CACHE_CHIP[e.cacheState]}">${e.cacheState}</span></td>` : `<td><span class="muted">—</span></td>`,
        `<td class="num">${fmtMs(e.latencyMs)}</td>`,
        `<td class="num">${e.status ?? "—"}</td>`,
        `<td class="note-cell" title="${esc(e.note ?? "")}">${esc(e.note ?? "—")}</td>`,
      ];
      // splice numeric cells into place (they carry their own td markup)
      tr.innerHTML = `<td>${cells[0]}</td><td>${cells[1]}</td><td>${cells[2]}</td><td>${cells[3]}</td>${cells.slice(4).join("")}`;
      tbody.appendChild(tr);
    }
    $("table-count").textContent = `показано ${data.entries.length} из ${data.matched}`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  function renderFileMeta(files) {
    if (!Array.isArray(files)) return;
    $("file-meta").textContent = files
      .map((f) => `${f.exists ? "✔" : "✖"} ${f.path} (${f.lines} строк${f.corruptedLines ? `, повреждено ${f.corruptedLines}` : ""})`)
      .join("  ·  ");
  }

  // ── Filters ──────────────────────────────────────────────────────────────────
  function fillSessionOptions(sessions, selected) {
    const sel = $("f-session");
    const current = selected ?? sel.value;
    sel.innerHTML = `<option value="">все сессии</option>` + sessions.map((s) => `<option${s === current ? " selected" : ""}>${esc(s)}</option>`).join("");
  }

  for (const id of ["f-session", "f-cache", "f-source", "f-limit"]) {
    $(id).addEventListener("change", load);
  }
  let searchDebounce = null;
  $("f-q").addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(load, 350);
  });
  $("btn-reset").addEventListener("click", () => {
    $("f-session").value = "";
    $("f-cache").value = "";
    $("f-source").value = "";
    $("f-q").value = "";
    load();
  });

  // ── Refresh controls ─────────────────────────────────────────────────────────
  $("btn-refresh").addEventListener("click", load);
  $("auto-refresh").addEventListener("change", (ev) => {
    clearInterval(state.timer);
    if (ev.target.checked) state.timer = setInterval(load, 5000);
  });
  if ($("auto-refresh").checked) state.timer = setInterval(load, 5000);

  // ── Exports ──────────────────────────────────────────────────────────────────
  $("btn-csv").addEventListener("click", () => (window.location.href = `/api/export.csv?${filterQuery()}`));
  $("btn-json").addEventListener("click", () => (window.location.href = `/api/export.json?${filterQuery()}`));

  // ── Real-time (SSE) ──────────────────────────────────────────────────────────
  let sseDebounce = null;
  try {
    const es = new EventSource("/api/events");
    es.addEventListener("update", () => {
      clearTimeout(sseDebounce);
      sseDebounce = setTimeout(load, 400);
    });
    es.onerror = () => $("live-indicator").classList.add("off");
  } catch {
    $("live-indicator").classList.add("off");
  }

  // ── Test request ─────────────────────────────────────────────────────────────
  $("btn-send").addEventListener("click", async () => {
    const btn = $("btn-send");
    const text = $("test-text").value.trim();
    if (!text) {
      toast("Введите текст запроса");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Ждём LLM…";
    try {
      const res = await fetch("/api/test-request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          model: $("test-model").value,
          session: $("test-session").value,
        }),
      });
      const json = await res.json();
      $("test-result").classList.remove("hidden");
      if (!json.ok) {
        $("test-answer").textContent = `Ошибка: ${json.error ?? `HTTP ${json.status}`}`;
        $("test-metrics").innerHTML = "";
        toast(json.error ?? `Gateway вернул ${json.status}`);
      } else {
        const answer = json.gateway?.choices?.[0]?.message?.content ?? JSON.stringify(json.gateway, null, 2);
        $("test-answer").textContent = answer;
        const m = json.metrics;
        $("test-metrics").innerHTML = m
          ? [
              `<span class="chip good">сэкономлено ${fmtInt(m.saved)} ток.</span>`,
              `<span class="chip">коэф. ${fmtRatio(m.ratio)}</span>`,
              m.cacheState ? `<span class="${CACHE_CHIP[m.cacheState]}">кэш: ${m.cacheState}</span>` : "",
              `<span class="chip">${fmtMs(m.latencyMs)}</span>`,
              `<span class="chip">модель: ${esc(m.model ?? "—")}</span>`,
            ].join("")
          : `<span class="muted">Метрики появятся в таблице через мгновение.</span>`;
        setTimeout(load, 700);
      }
    } catch (err) {
      toast(`Ошибка запроса: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Отправить ▸";
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────────
  const savedTheme = localStorage.getItem(THEME_KEY) ?? "dark";
  if (window.Chart) applyTheme(savedTheme);
  load();
})();
