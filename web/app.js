const cards = document.querySelector("#cards");
const meta = document.querySelector("#meta");
const notice = document.querySelector("#notice");
const button = document.querySelector("#refresh");

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
    const stale = item.desactualizada;
    const observedAt = item.fecha_hora_dato
      ? new Date(item.fecha_hora_dato).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" })
      : "Sin dato";
    const age = item.antiguedad_minutos >= 60
      ? `${Math.floor(item.antiguedad_minutos / 60)} h ${item.antiguedad_minutos % 60} min`
      : `${item.antiguedad_minutos} min`;
    return `
      <article class="card">
        <h2 class="river">Río ${item.rio}</h2>
        <p class="station">Estación ${item.estacion}</p>
        <p class="flow">${formatNumber(item.caudal)} <span class="unit">m³/s</span></p>
        <span class="badge ${alert ? "red" : ""}">${item.estado}</span>
        ${stale ? `<span class="badge stale">Lectura con ${age} de antigüedad</span>` : ""}
        <p class="details">
          Lectura horaria: <strong>${observedAt}</strong><br>
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
    notice.textContent = error.message;
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
    notice.textContent = error.message;
    notice.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "Actualizar ahora";
  }
});

loadStatus();
setInterval(loadStatus, 60_000);
