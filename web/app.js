const cards = document.querySelector("#cards");
const meta = document.querySelector("#meta");
const notice = document.querySelector("#notice");
const button = document.querySelector("#refresh");
const localHostnames = ["127.0.0.1", "localhost"];
const isLocalServer = localHostnames.includes(window.location.hostname);

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

function render(state) {
  notice.textContent = state.error || "";
  notice.classList.toggle("error", Boolean(state.error));
  const fetched = state.consultado_en
    ? new Date(state.consultado_en).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
    : "pendiente";
  meta.innerHTML = `Última consulta a SENAMHI: <strong>${fetched}</strong><br>Consulta automática cada 20 minutos`;

  if (!state.datos || state.datos.length === 0) {
    cards.innerHTML = '<div class="empty">Todavía no hay lecturas disponibles. Se volverá a intentar automáticamente.</div>';
    return;
  }

  cards.innerHTML = state.datos.map((item) => {
    const alert = item.estado === "Umbral rojo alcanzado";
    return `
      <article class="card">
        <h2 class="river">Río ${item.rio}</h2>
        <p class="station">Estación ${item.estacion}</p>
        <p class="flow">${formatNumber(item.caudal)} <span class="unit">m³/s</span></p>
        <span class="badge ${alert ? "red" : ""}">${item.estado}</span>
        <p class="details">
          Umbral rojo: <strong>${formatNumber(item.umbral_rojo)} m³/s</strong>
        </p>
      </article>`;
  }).join("");
}

async function loadStatus() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error("No se pudo leer el estado local.");
    render(await response.json());
  } catch (error) {
    notice.textContent = isLocalServer
      ? error.message
      : "Para cargar los caudales, ejecuta iniciar.bat y abre http://127.0.0.1:8000.";
    notice.classList.add("error");
  }
}

button.addEventListener("click", async () => {
  button.disabled = true;
  button.textContent = "Consultando…";
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    render(await response.json());
  } catch (error) {
    notice.textContent = isLocalServer
      ? error.message
      : "Para cargar los caudales, ejecuta iniciar.bat y abre http://127.0.0.1:8000.";
    notice.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "Actualizar ahora";
  }
});

if (isLocalServer) {
  loadStatus();
  setInterval(loadStatus, 60_000);
} else {
  showServerInstructions();
}
