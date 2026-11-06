const SITE_ROOT = "https://www.senamhi.gob.pe/";
const TABLE_URL = new URL("include/ajax-informacion-diaria-chirilu.php", SITE_ROOT);
const GRAPH_URL = new URL("include/ajax-idesep-chirilu.php", SITE_ROOT);
const SOURCE_PAGE = "https://www.senamhi.gob.pe/?dp=piura&p=monitoreo-chirilu";
const REQUEST_TIMEOUT_MS = 25_000;
const LIMA_OFFSET_MS = 5 * 60 * 60 * 1000;

const STATIONS = {
  ANTAPUCRO: { rio: "Lurín", estacion: "Antapucro", graphKey: "antapucro_m" },
  CHOSICA: { rio: "Rímac", estacion: "Chosica", graphKey: "chosica_m" },
  OBRAJILLO: { rio: "Chillón", estacion: "Obrajillo", graphKey: "obrajillo_m" },
};

const INITIAL_STATE = {
  datos: [],
  consultado_en: null,
  error: "Aún no hay datos descargados.",
};

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function limaClock(now = new Date()) {
  const lima = new Date(now.getTime() - LIMA_OFFSET_MS);
  const pad = (value) => String(value).padStart(2, "0");
  return {
    date: `${lima.getUTCFullYear()}-${pad(lima.getUTCMonth() + 1)}-${pad(lima.getUTCDate())}`,
    hour: lima.getUTCHours(),
    timestamp: now.getTime(),
    iso: `${lima.toISOString().slice(0, 19)}-05:00`,
  };
}

function latestSourceSlot(now = new Date()) {
  const local = limaClock(now);
  const slotHour = Math.floor(local.hour / 6) * 6;
  return { fecha: local.date, hora: `${String(slotHour).padStart(2, "0")}:00` };
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort("SENAMHI request timeout"), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function senamhiHeaders(contentType) {
  const headers = {
    accept: "application/json, text/html;q=0.9, */*;q=0.8",
    referer: SOURCE_PAGE,
  };
  if (contentType) headers["content-type"] = contentType;
  return headers;
}

async function readJsonResponse(response, context) {
  if (!response.ok) throw new Error(`${context}: SENAMHI respondió HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`${context}: respuesta JSON inválida (${error.message}).`);
  }
}

async function readThresholds(now) {
  const slot = latestSourceSlot(now);
  const response = await fetchWithTimeout(TABLE_URL, {
    method: "POST",
    headers: senamhiHeaders("application/x-www-form-urlencoded; charset=UTF-8"),
    body: new URLSearchParams(slot),
  });
  const result = await readJsonResponse(response, "No se pudieron leer los umbrales");
  if (!result?.success) {
    throw new Error(result?.message || "No se pudieron leer los umbrales.");
  }

  const thresholds = {};
  for (const item of Object.values(result.content || {})) {
    const station = String(item?.nomEsta || "").trim().toUpperCase();
    if (Object.hasOwn(STATIONS, station)) {
      const rawThreshold = item.umbralRojo;
      const value = rawThreshold === null || rawThreshold === undefined || rawThreshold === ""
        ? Number.NaN
        : Number(rawThreshold);
      thresholds[station] = Number.isFinite(value) ? value : null;
    }
  }
  return thresholds;
}

function extractChartData(html) {
  const marker = "var data = ";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error("No se encontró la serie de datos del gráfico de SENAMHI.");
  }

  const start = markerIndex + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let position = start; position < html.length; position += 1) {
    const char = html[position];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = position + 1;
        break;
      }
    }
  }

  if (end < 0) throw new Error("No se pudo delimitar la serie horaria del gráfico.");
  try {
    return JSON.parse(html.slice(start, end));
  } catch (error) {
    throw new Error(`La serie horaria no tiene formato JSON válido (${error.message}).`);
  }
}

async function getCachedChartPath(db, graphKey) {
  const row = await db
    .prepare("SELECT chart_path FROM chart_paths WHERE station_key = ?1")
    .bind(graphKey)
    .first();
  return row?.chart_path || null;
}

async function setCachedChartPath(db, graphKey, chartPath) {
  await db
    .prepare(
      `INSERT INTO chart_paths (station_key, chart_path, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(station_key) DO UPDATE SET
         chart_path = excluded.chart_path,
         updated_at = excluded.updated_at`,
    )
    .bind(graphKey, chartPath, new Date().toISOString())
    .run();
}

async function deleteCachedChartPath(db, graphKey) {
  await db.prepare("DELETE FROM chart_paths WHERE station_key = ?1").bind(graphKey).run();
}

async function fetchChartPath(db, graphKey, stationLabel) {
  const response = await fetchWithTimeout(GRAPH_URL, {
    method: "POST",
    headers: senamhiHeaders("application/x-www-form-urlencoded; charset=UTF-8"),
    body: new URLSearchParams({ estacion: graphKey }),
  });
  const chartPath = await readJsonResponse(response, `No se pudo obtener el gráfico de ${stationLabel}`);
  if (typeof chartPath !== "string" || !chartPath.trim()) {
    throw new Error(`SENAMHI no devolvió el gráfico de ${stationLabel}.`);
  }
  await setCachedChartPath(db, graphKey, chartPath);
  return chartPath;
}

async function fetchChartSeries(chartPath, stationLabel) {
  // La ruta de SENAMHI puede incluir un espacio antes de &variable.
  const encodedPath = chartPath.replaceAll(" ", "%20");
  const chartUrl = new URL(encodedPath, SITE_ROOT);
  const response = await fetchWithTimeout(chartUrl, { headers: senamhiHeaders() });
  if (!response.ok) {
    throw new Error(`No se pudo descargar el gráfico de ${stationLabel}: HTTP ${response.status}.`);
  }
  return extractChartData(await response.text());
}

function latestObservations(series, nowTimestamp, stationLabel) {
  const observations = [];
  for (const point of series.dato || []) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const timestamp = Number(point[0]);
    const flow = Number(point[1]);
    if (Number.isFinite(timestamp) && Number.isFinite(flow) && timestamp <= nowTimestamp) {
      observations.push([timestamp, flow]);
    }
  }
  if (!observations.length) {
    throw new Error(`El gráfico de ${stationLabel} no contiene caudales horarios válidos.`);
  }
  observations.sort((a, b) => a[0] - b[0]);
  return observations.slice(-12).map(([timestamp, caudal]) => ({ timestamp, caudal }));
}

async function readHourlyStation(db, stationKey, now) {
  const { rio, estacion, graphKey } = STATIONS[stationKey];
  let chartPath = await getCachedChartPath(db, graphKey);
  let series;

  if (chartPath) {
    try {
      series = await fetchChartSeries(chartPath, estacion);
    } catch {
      // Una ruta vencida o una respuesta inválida elimina la caché y permite
      // obtener una ruta nueva; la descarga se reintenta una sola vez.
      await deleteCachedChartPath(db, graphKey);
      chartPath = await fetchChartPath(db, graphKey, estacion);
      series = await fetchChartSeries(chartPath, estacion);
    }
  } else {
    chartPath = await fetchChartPath(db, graphKey, estacion);
    series = await fetchChartSeries(chartPath, estacion);
  }

  const historial = latestObservations(series, now.getTime(), estacion);
  return {
    rio,
    estacion,
    caudal: historial.at(-1).caudal,
    historial_caudales: historial,
    unidad: series.unidad || "m³/s",
    umbral_rojo: null,
    umbral_naranja: null,
    umbral_amarillo: null,
    nivel: "sin_umbral",
    estado: "Sin umbral disponible",
  };
}

async function readState(db) {
  const row = await db.prepare("SELECT state_json, historial_caudales FROM app_state WHERE id = 1").first();
  if (!row?.state_json) return { ...INITIAL_STATE };
  try {
    const state = JSON.parse(row.state_json);
    const histories = JSON.parse(row.historial_caudales || "{}");
    state.datos = (state.datos || []).map((item) => {
      const station = Object.values(STATIONS).find((value) => value.estacion === item.estacion);
      return {
        ...item,
        historial_caudales: histories[station?.graphKey] || item.historial_caudales || [],
      };
    });
    return { ...INITIAL_STATE, ...state };
  } catch {
    return { ...INITIAL_STATE, error: "El estado guardado en D1 no tiene JSON válido." };
  }
}

async function writeState(db, state) {
  const histories = Object.fromEntries(
    (state.datos || []).map((item) => {
      const station = Object.values(STATIONS).find((value) => value.estacion === item.estacion);
      return [station?.graphKey || item.estacion, item.historial_caudales || []];
    }),
  );
  const stateWithoutHistories = {
    ...state,
    datos: (state.datos || []).map(({ historial_caudales: _history, ...item }) => item),
  };
  await db
    .prepare(
      `INSERT INTO app_state (id, state_json, historial_caudales, updated_at)
       VALUES (1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET
         state_json = excluded.state_json,
         historial_caudales = excluded.historial_caudales,
         updated_at = excluded.updated_at`,
    )
    .bind(JSON.stringify(stateWithoutHistories), JSON.stringify(histories), new Date().toISOString())
    .run();
}

async function refreshData(env) {
  const previous = await readState(env.DB);
  const now = new Date();

  try {
    // El umbral y las tres estaciones son independientes y se descargan a la vez.
    const [thresholds, ...rows] = await Promise.all([
      readThresholds(now),
      ...Object.keys(STATIONS).map((stationKey) => readHourlyStation(env.DB, stationKey, now)),
    ]);

    for (let index = 0; index < rows.length; index += 1) {
      const stationKey = Object.keys(STATIONS)[index];
      const threshold = thresholds[stationKey] ?? null;
      const flow = rows[index].caudal;
      rows[index].umbral_rojo = threshold;
      rows[index].umbral_amarillo = threshold === null ? null : threshold * 0.75;
      rows[index].umbral_naranja = threshold === null ? null : threshold * 0.9;
      if (threshold === null) {
        rows[index].nivel = "sin_umbral";
        rows[index].estado = "Sin umbral disponible";
      } else if (flow >= threshold) {
        rows[index].nivel = "peligro";
        rows[index].estado = "Peligro";
      } else if (flow >= rows[index].umbral_naranja) {
        rows[index].nivel = "naranja";
        rows[index].estado = "Precaución";
      } else if (flow >= rows[index].umbral_amarillo) {
        rows[index].nivel = "amarillo";
        rows[index].estado = "Precaución";
      } else {
        rows[index].nivel = "normal";
        rows[index].estado = "Normal";
      }
    }

    const local = limaClock(now);
    const state = { datos: rows, consultado_en: local.iso, error: null };
    await writeState(env.DB, state);
    return state;
  } catch (error) {
    const state = {
      ...previous,
      error: `No se pudo actualizar desde SENAMHI: ${error?.message || String(error)}`,
    };
    await writeState(env.DB, state);
    return state;
  }
}

function limaScheduleParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Lima",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
}

function flowForMessage(item) {
  return `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(item.caudal)} m³/s`;
}

async function sendDailySummary(env, localDate, localTime, testMode = false) {
  if (!env.ONESIGNAL_REST_API_KEY) {
    console.warn("Resumen diario omitido: falta configurar ONESIGNAL_REST_API_KEY como secreto de Wrangler.");
    return;
  }

  const claimDate = testMode ? "__forced_push_total_subscriptions_once__" : localDate;
  const claimTime = testMode ? "once" : localTime;
  const claim = await env.DB
    .prepare("INSERT OR IGNORE INTO daily_digest_runs (local_date, local_hour, status) VALUES (?1, ?2, 'pending')")
    .bind(claimDate, claimTime)
    .run();
  if (!claim.meta?.changes) return;

  try {
    const state = await readState(env.DB);
    if ((!testMode && state.error) || !state.datos?.length) {
      throw new Error("No hay lecturas actuales válidas para el resumen diario.");
    }
    const byRiver = new Map(state.datos.map((item) => [item.rio, item]));
    const orderedRows = ["Rímac", "Chillón", "Lurín"]
      .map((river) => byRiver.get(river))
      .filter(Boolean);
    const levels = orderedRows.map((item) => `${item.rio} (${flowForMessage(item)})`).join(", ");
    if (!levels) throw new Error("No se encontraron caudales para el resumen diario.");
    const precautions = orderedRows.filter(
      (item) => item.umbral_amarillo !== null && item.umbral_amarillo !== undefined && item.caudal >= item.umbral_amarillo,
    );
    const content = precautions.length
      ? `Posible aumento del caudal del río ${precautions.map((item) => item.rio).join(", ")}. Tomen sus precauciones. Niveles: ${levels}`
      : `Todo tranquilo por ahora. Niveles: ${levels}`;
    const contentEn = precautions.length
      ? `Possible rise in river flow: ${precautions.map((item) => item.rio).join(", ")}. Please take precautions. Levels: ${levels}`
      : `All calm for now. Levels: ${levels}`;

    const payload = {
      app_id: env.ONESIGNAL_APP_ID,
      target_channel: "push",
      name: testMode ? `Prueba única de caudales ${localDate} ${localTime}` : `Resumen de caudales ${localDate} ${localTime}`,
      headings: {
        en: testMode ? "Notification test" : "River flow summary",
        es: testMode ? "Prueba de notificación" : "Resumen de caudales de los ríos",
      },
      contents: { en: contentEn, es: content },
      included_segments: ["Total Subscriptions"],
    };
    console.log("--- INICIANDO PUSH DE PRUEBA ---");
    console.log("App ID leído:", env.ONESIGNAL_APP_ID);
    console.log("Segmentos incluidos:", payload.included_segments);
    const response = await fetchWithTimeout("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        authorization: `Key ${env.ONESIGNAL_REST_API_KEY}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    const responseText = await response.text();
    console.log("Status OneSignal:", response.status);
    console.log("Respuesta OneSignal:", responseText);
    console.log("--------------------------------");
    const result = (() => {
      try { return JSON.parse(responseText); } catch { return {}; }
    })();
    console.log("Destinatarios reportados:", result.recipients);
    if (result.errors) console.log("Errores reportados:", result.errors);
    if (!response.ok || result.errors?.length || !result.id) {
      throw new Error(`OneSignal respondió HTTP ${response.status}: ${responseText}`);
    }

    await env.DB
      .prepare("UPDATE daily_digest_runs SET status = 'sent', sent_at = ?3 WHERE local_date = ?1 AND local_hour = ?2")
      .bind(claimDate, claimTime, new Date().toISOString())
      .run();
  } catch (error) {
    await env.DB.prepare("DELETE FROM daily_digest_runs WHERE local_date = ?1 AND local_hour = ?2 AND status = 'pending'")
      .bind(claimDate, claimTime)
      .run();
    throw error;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/status" && request.method === "GET") {
      try {
        return jsonResponse(await readState(env.DB));
      } catch {
        return jsonResponse(INITIAL_STATE, 503);
      }
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      try {
        return jsonResponse(await refreshData(env));
      } catch (error) {
        return jsonResponse(
          { ...INITIAL_STATE, error: `No se pudo leer D1: ${error?.message || String(error)}` },
          503,
        );
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return jsonResponse({ error: "No encontrado" }, 404);
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const state = await refreshData(env);
      const local = limaScheduleParts(new Date(controller.scheduledTime));
      const localTime = `${local.hour}:${local.minute}`;
      if (["07:00", "15:20", "22:00"].includes(localTime) && !state.error) {
        try {
          await sendDailySummary(env, `${local.year}-${local.month}-${local.day}`, localTime);
        } catch (error) {
          console.error("No se pudo enviar el resumen diario de OneSignal:", error);
        }
      }
    })());
  },
};
