const SENSOR_KEYS = [
    "boiler_coil_in",
    "dhw_out",
    "heating_return",
    "heating_supply",
    "floor_return"
];

const sensorState = {};
SENSOR_KEYS.forEach((key) => {
    sensorState[key] = { lastValid: null, errorSince: null };
});

// Настройки звука и состояния тревоги
let soundEnabled = localStorage.getItem("soundEnabled") !== "false";
let audioCtx = null;
let lastAlertSoundTime = 0;
let currentFaviconState = null;

function getTempClass(temp) {
    if (temp >= 60) return "hot";
    if (temp >= 40) return "warm";
    return "cool";
}

// 1. Динамический Favicon (встраиваемый SVG без внешних файлов)
function updateFavicon(isError) {
    const targetState = isError ? "err" : "ok";
    if (currentFaviconState === targetState) return;
    currentFaviconState = targetState;

    // Удаляем старые иконки, если они были прописаны в HTML
    document.querySelectorAll("link[rel*='icon']").forEach((el) => el.remove());

    const link = document.createElement("link");
    link.rel = "icon";
    link.type = "image/svg+xml";

    const ns = ["http:/", "www.w3.org", "2000", "svg"].join("/");

    const svgOk = `<svg xmlns="${ns}" viewBox="0 0 32 32">
        <rect width="32" height="32" rx="8" fill="#0f172a"/>
        <circle cx="16" cy="21" r="5" fill="#ef4444"/>
        <rect x="14" y="6" width="4" height="14" rx="2" fill="#ef4444"/>
        <rect x="13" y="5" width="6" height="17" rx="3" fill="none" stroke="#f8fafc" stroke-width="2"/>
    </svg>`;

    const svgErr = `<svg xmlns="${ns}" viewBox="0 0 32 32">
        <path d="M16 2 L31 29 H1 Z" fill="#facc15" stroke="#422006" stroke-width="1.5"/>
        <rect x="14.5" y="10" width="3" height="10" rx="1" fill="#0f172a"/>
        <circle cx="16" cy="24.5" r="2" fill="#0f172a"/>
    </svg>`;

    const svg = isError ? svgErr : svgOk;
    link.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    document.head.appendChild(link);
}

// 2. Звуковое оповещение через Web Audio API
function initAudio() {
    if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) {
            audioCtx = new AudioContext();
        }
    }
    if (audioCtx && audioCtx.state === "suspended") {
        audioCtx.resume();
    }
}

function playAlertBeep() {
    if (!soundEnabled) return;
    initAudio();
    if (!audioCtx || audioCtx.state !== "running") return;

    const now = audioCtx.currentTime;
    // Двойной тревожный сигнал (880 Гц -> 660 Гц)
    [880, 660].forEach((freq, idx) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();

        osc.type = "triangle";
        osc.frequency.setValueAtTime(freq, now + idx * 0.22);

        gain.gain.setValueAtTime(0.001, now + idx * 0.22);
        gain.gain.exponentialRampToValueAtTime(0.25, now + idx * 0.22 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.22 + 0.2);

        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(now + idx * 0.22);
        osc.stop(now + idx * 0.22 + 0.21);
    });
}

// 3. Кнопка управления звуком в шапке дашборда
function setupHeaderControls() {
    const header = document.querySelector("header");
    const statusEl = document.getElementById("status");
    if (!header || !statusEl || document.getElementById("sound-toggle-btn")) return;

    const controlsWrapper = document.createElement("div");
    controlsWrapper.className = "header-controls";

    const btn = document.createElement("button");
    btn.id = "sound-toggle-btn";
    btn.type = "button";
    btn.className = `sound-btn ${soundEnabled ? "active" : ""}`;
    btn.title = "Включить или отключить звуковое оповещение при аварии";

    const updateBtnText = () => {
        btn.textContent = soundEnabled ? "🔊 Звук" : "🔇 Без звука";
        btn.classList.toggle("active", soundEnabled);
    };
    updateBtnText();

    btn.addEventListener("click", () => {
        soundEnabled = !soundEnabled;
        localStorage.setItem("soundEnabled", soundEnabled);
        updateBtnText();
        if (soundEnabled) {
            initAudio();
            playAlertBeep(); // Короткий проверочный сигнал при включении
        }
    });

    header.insertBefore(controlsWrapper, statusEl);
    controlsWrapper.appendChild(btn);
    controlsWrapper.appendChild(statusEl);
}

// Разблокируем аудио при первом клике в любом месте страницы
document.addEventListener("click", initAudio, { once: true });

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
    setupHeaderControls();
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

        // Обновляем оверлей, favicon и звук при наличии критической ошибки
        if (hasAnyCriticalError) {
            overlay.classList.remove("hidden");
            updateFavicon(true);

            // Подаем звуковой сигнал сразу при возникновении ошибки и повторяем каждые 15 секунд
            if (Date.now() - lastAlertSoundTime >= 15000) {
                playAlertBeep();
                lastAlertSoundTime = Date.now();
            }
        } else {
            overlay.classList.add("hidden");
            updateFavicon(false);
            lastAlertSoundTime = 0;
        }

        const now = new Date().toLocaleTimeString("ru-RU");
        statusEl.textContent = `Обновлено в ${now}`;
        statusEl.className = "status ok";
    } catch (err) {
        statusEl.textContent = "Ошибка чтения temp.json";
        statusEl.className = "status err";
    }
}

updateFavicon(false);
fetchTemperatures();
setInterval(fetchTemperatures, 2000);
