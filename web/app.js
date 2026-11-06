const cards = document.querySelector("#cards");
const chartsContainer = document.querySelector("#charts");
const meta = document.querySelector("#meta");
const notice = document.querySelector("#notice");
const button = document.querySelector("#refresh");
const alertsButton = document.querySelector("#alerts");
const canCallApi = window.location.protocol === "http:" || window.location.protocol === "https:";
const charts = new Map();
const productionOrigin = "https://monitor-rios.operations-9ae.workers.dev";
let oneSignalClient = null;

function showServerInstructions() {
  meta.textContent = "Servidor local no iniciado";
  notice.textContent = "Para cargar los caudales, ejecuta iniciar.bat y abre http://127.0.0.1:8000.";
  notice.classList.add("error");
  button.disabled = true;
}

function formatNumber(value, digits = 2) {
  return typeof value === "number"
    ? new Intl.NumberFormat("es-PE", { maximumFractionDigits: digits }).format(value)
    : "Sin dato";
}

function formatHour(timestamp) {
  return new Date(timestamp).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.classList.toggle("info", Boolean(message) && !isError);
}

function updateAlertsButton() {
  if (!oneSignalClient) return;
  const isSubscribed = Boolean(oneSignalClient.User.PushSubscription.optedIn);
  alertsButton.textContent = isSubscribed ? "Desactivar Alertas" : "Recibir Alertas";
  alertsButton.classList.toggle("is-subscribed", isSubscribed);
  alertsButton.setAttribute("aria-pressed", String(isSubscribed));
  alertsButton.disabled = false;
}

async function toggleAlertsSubscription() {
  if (!oneSignalClient) return;
  alertsButton.disabled = true;

  try {
    if (oneSignalClient.User.PushSubscription.optedIn) {
      await oneSignalClient.User.PushSubscription.optOut();
      updateAlertsButton();
      showNotice("Dejaste de recibir alertas en este dispositivo.");
      return;
    }

    if (!oneSignalClient.Notifications.isPushSupported()) {
      showNotice("Este navegador no admite notificaciones push.", true);
      return;
    }

    if (window.Notification?.permission === "denied") {
      showNotice("El permiso está bloqueado en el navegador. Habilítalo desde los ajustes del sitio.", true);
      return;
    }

    if (window.Notification?.permission !== "granted") {
      await oneSignalClient.Notifications.requestPermission();
    }

    if (oneSignalClient.Notifications.permission || window.Notification?.permission === "granted") {
      await oneSignalClient.User.PushSubscription.optIn();
      updateAlertsButton();
      showNotice("Alertas activadas para este dispositivo.");
    } else {
      showNotice("No se activaron las alertas. Puedes intentarlo de nuevo cuando quieras.");
    }
  } catch (error) {
    console.error("No se pudo cambiar la suscripción de OneSignal:", error);
    showNotice("No se pudo actualizar la suscripción de alertas. Inténtalo nuevamente.", true);
  } finally {
    alertsButton.disabled = false;
    updateAlertsButton();
  }
}

function drawSparklines(rows) {
  for (const chart of charts.values()) chart.destroy();
  charts.clear();

  chartsContainer.innerHTML = rows.map((item, index) => {
    const level = item.nivel || "sin_umbral";
    const history = item.historial_caudales || [];
    const times = history.length
      ? `<div class="chart-times"><span>${formatHour(history[0].timestamp)}</span><span>${formatHour(history.at(-1).timestamp)}</span></div>`
      : "";
    return `
      <article class="trend-panel level-${level}">
        <div class="trend-panel-header">
          <div>
            <h3>Río ${item.rio}</h3>
            <p>Estación ${item.estacion}</p>
          </div>
          <strong>${formatNumber(item.caudal)} <span>m³/s</span></strong>
        </div>
        <div class="chart-wrap">
          ${history.length ? `<canvas id="flow-chart-${index}" role="img" aria-label="Tendencia horaria del río ${item.rio}"></canvas>` : '<span class="chart-empty">Historial no disponible</span>'}
        </div>
        <div class="chart-caption">${history.length} observaciones horarias ${times}</div>
      </article>`;
  }).join("");

  if (!window.Chart) return;

  rows.forEach((item, index) => {
    const canvas = document.querySelector(`#flow-chart-${index}`);
    const history = item.historial_caudales || [];
    if (!canvas || history.length === 0) return;

    const colors = {
      normal: "#188354",
      amarillo: "#bd8500",
      naranja: "#e16a12",
      peligro: "#bb3028",
      sin_umbral: "#60716a",
    };
    const chart = new Chart(canvas, {
      type: "line",
      data: {
        labels: history.map((point) => formatHour(point.timestamp)),
        datasets: [{
          data: history.map((point) => point.caudal),
          borderColor: colors[item.nivel] || colors.sin_umbral,
          backgroundColor: `${colors[item.nivel] || colors.sin_umbral}1A`,
          borderWidth: 2,
          pointRadius: 0,
          pointHitRadius: 8,
          fill: true,
          tension: 0.35,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { legend: { display: false }, tooltip: { displayColors: false } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { maxTicksLimit: 4 } },
        },
      },
    });
    charts.set(index, chart);
  });
}

function render(state) {
  showNotice(state.error || "", Boolean(state.error));
  const fetched = state.consultado_en
    ? new Date(state.consultado_en).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
    : "pendiente";
  meta.innerHTML = `Última consulta a SENAMHI: <strong>${fetched}</strong><br>Consulta automática cada 20 minutos`;

  if (!state.datos || state.datos.length === 0) {
    for (const chart of charts.values()) chart.destroy();
    charts.clear();
    cards.innerHTML = '<div class="empty">Todavía no hay lecturas disponibles. Se volverá a intentar automáticamente.</div>';
    chartsContainer.innerHTML = "";
    return;
  }

  cards.innerHTML = state.datos.map((item) => {
    const level = item.nivel || "sin_umbral";
    return `
      <article class="card level-${level}">
        <h2 class="river">Río ${item.rio}</h2>
        <p class="station">Estación ${item.estacion}</p>
        <p class="flow">${formatNumber(item.caudal)} <span class="unit">m³/s</span></p>
        <span class="badge">${item.estado}</span>
        <p class="details">
          Umbral amarillo (75%): <strong>${formatNumber(item.umbral_amarillo)} m³/s</strong><br>
          Umbral naranja (90%): <strong>${formatNumber(item.umbral_naranja)} m³/s</strong><br>
          Umbral rojo: <strong>${formatNumber(item.umbral_rojo)} m³/s</strong>
        </p>
      </article>`;
  }).join("");
  drawSparklines(state.datos);
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer el estado local.");
    render(await response.json());
  } catch (error) {
    showNotice(canCallApi
      ? error.message
      : "Para cargar los caudales, ejecuta iniciar.bat y abre http://127.0.0.1:8000.", true);
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Consultando…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    if (!response.ok) throw new Error("No se pudo actualizar la información de los ríos.");
    render(await response.json());
  } catch (error) {
    showNotice(canCallApi
      ? error.message
      : "", true);
  } finally {
    button.disabled = false;
    button.textContent = "Actualizar ahora";
  }
});

alertsButton.addEventListener("click", toggleAlertsSubscription);

if (window.location.origin === productionOrigin) {
  window.OneSignalDeferred = window.OneSignalDeferred || [];
  window.OneSignalDeferred.push(async (OneSignal) => {
    try {
      const sdk = window.OneSignal || OneSignal;
      await sdk.init({
        appId: "361a6fe4-20bc-4624-8603-3ceebb5bb4b7",
        safari_web_id: "web.onesignal.auto.2cd5950f-b486-4c84-8005-0f30059d0b0c",
        notifyButton: { enable: false },
      });
      oneSignalClient = sdk;
      sdk.User.PushSubscription.addEventListener("change", updateAlertsButton);
      sdk.Notifications.addEventListener("permissionChange", updateAlertsButton);
      updateAlertsButton();
    } catch (error) {
      console.error("No se pudo inicializar OneSignal:", error);
      alertsButton.disabled = true;
      showNotice("No se pudo cargar el servicio de alertas.", true);
    }
  });
} else {
  alertsButton.disabled = true;
  alertsButton.title = "La suscripción de OneSignal está habilitada en la web publicada.";
}

if (canCallApi) {
  loadStatus();
  setInterval(loadStatus, 60_000);
} else {
  showServerInstructions();
}
