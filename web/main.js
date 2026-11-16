const SENSOR_KEYS = [
    "boiler_coil_in",
    "dhw_out",
    "heating_return",
    "heating_supply",
    "floor_return"
];

function getTempClass(temp) {
    if (temp >= 60) return "hot";
    if (temp >= 40) return "warm";
    return "cool";
}

async function fetchTemperatures() {
    const statusEl = document.getElementById("status");
    try {
        const response = await fetch("/api/temps");
        if (!response.ok) throw new Error("HTTP " + response.status);

        const data = await response.json();

        SENSOR_KEYS.forEach((key) => {
            const val = Number(data[key]);
            const formatted = isNaN(val) ? "--.- °C" : `${val.toFixed(1)} °C`;

            const svgText = document.getElementById(`val-${key}`);
            const cardText = document.getElementById(`card-${key}`);
            const badge = document.querySelector(`.sensor-badge[data-key="${key}"]`);

            if (svgText) svgText.textContent = formatted;
            if (cardText) cardText.textContent = formatted;

            if (badge && !isNaN(val)) {
                badge.classList.remove("hot", "warm", "cool");
                badge.classList.add(getTempClass(val));
            }
        });

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
