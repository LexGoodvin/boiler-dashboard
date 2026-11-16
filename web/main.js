const SENSOR_KEYS = [
    "boiler_coil_in",
    "dhw_out",
    "heating_return",
    "heating_supply",
    "floor_return"
];

// Локальный кэш и таймеры на случай работы напрямую от файла без ESP32
const sensorState = {};
SENSOR_KEYS.forEach((key) => {
    sensorState[key] = { lastValid: null, errorSince: null };
});

function getTempClass(temp) {
    if (temp >= 60) return "hot";
    if (temp >= 40) return "warm";
    return "cool";
}

function ensureGlobalWarningOverlay() {
    let overlay = document.getElementById("global-sensor-warning");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "global-sensor-warning";
        overlay.className = "global-warning-overlay hidden";
        overlay.innerHTML = `
            <svg viewBox="0 0 24 24" class="global-warning-icon">
                <path d="M12 2L1 21h22L12 2zm0 4.5l7.5 13h-15L12 6.5zM11 10v5h2v-5h-2zm0 6.5v2h2v-2h-2z"/>
            </svg>
        `;
        document.body.appendChild(overlay);
    }
    return overlay;
}

async function fetchTemperatures() {
    const statusEl = document.getElementById("status");
    const overlay = ensureGlobalWarningOverlay();

    try {
        const response = await fetch("/api/temps");
        if (!response.ok) throw new Error("HTTP " + response.status);

        const data = await response.json();
        let hasAnyCriticalError = false;

        SENSOR_KEYS.forEach((key) => {
            const rawVal = Number(data[key]);
            const state = sensorState[key];
            const svgText = document.getElementById(`val-${key}`);
            const cardText = document.getElementById(`card-${key}`);
            const badge = document.querySelector(`.sensor-badge[data-key="${key}"]`);

            let isError = false;
            let displayVal = rawVal;

            if (!isNaN(rawVal) && Math.abs(rawVal - (-127.0)) < 0.01) {
                if (!state.errorSince) {
                    state.errorSince = Date.now();
                }
                // Если бэкенд уже прислал -127.0 (значит минута на сервере прошла) 
                // или прошла минута локально:
                if (Date.now() - state.errorSince >= 60000 || state.lastValid === null) {
                    isError = true;
                    hasAnyCriticalError = true;
                } else {
                    displayVal = state.lastValid;
                }
            } else if (!isNaN(rawVal)) {
                state.errorSince = null;
                state.lastValid = rawVal;
            }

            if (isError) {
                if (svgText) svgText.textContent = "⚠ ERR";
                if (cardText) {
                    cardText.innerHTML = `<span class="err-inline"><span class="warn-tri">⚠</span> ERR</span>`;
                }
                if (badge) {
                    badge.classList.remove("hot", "warm", "cool");
                    badge.classList.add("err");
                }
            } else {
                const formatted = isNaN(displayVal) ? "--.- °C" : `${displayVal.toFixed(1)} °C`;
                if (svgText) svgText.textContent = formatted;
                if (cardText) cardText.textContent = formatted;

                if (badge && !isNaN(displayVal)) {
                    badge.classList.remove("hot", "warm", "cool", "err");
                    badge.classList.add(getTempClass(displayVal));
                }
            }
        });

        // Показываем или скрываем большой полупрозрачный треугольник на весь экран
        if (hasAnyCriticalError) {
            overlay.classList.remove("hidden");
        } else {
            overlay.classList.add("hidden");
        }

        const now = new Date().toLocaleTimeString("ru-RU");
        statusEl.textContent = `Обновлено в ${now}`;
        statusEl.className = "status ok";
    } catch (err) {
        statusEl.textContent = "Ошибка чтения temp.json";
        statusEl.className = "status err";
    }
}

fetchTemperatures();
setInterval(fetchTemperatures, 2000);
