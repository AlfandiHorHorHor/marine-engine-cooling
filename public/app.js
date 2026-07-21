// ======================================================================
// Engine Room Cooling Monitor — dashboard client (Production / Vercel)
// Connects to the Node.js server over WebSocket and renders live
// telemetry from the ESP32 (or the simulator, during development).
//
// window.__BACKEND_URL__ must be set before this script loads.
// Example: "wss://your-app.up.railway.app"
// If empty, falls back to same-origin (local development).
// ======================================================================

const WS_PATH = "/dashboard";
const BACKEND_URL = window.__BACKEND_URL__ || "";

// ---------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------
function tickClock() {
  const el = document.getElementById("clock");
  el.textContent = new Date().toLocaleTimeString("id-ID", { hour12: false });
}
tickClock();
setInterval(tickClock, 1000);

// ---------------------------------------------------------------------
// Gauges (SVG arc, ~270°)
// ---------------------------------------------------------------------
class Gauge {
  constructor(rootEl) {
    this.root = rootEl;
    this.min = Number(rootEl.dataset.min);
    this.max = Number(rootEl.dataset.max);
    this.danger = Number(rootEl.dataset.danger);
    this.valuePath = rootEl.querySelector(".gauge__value");
    this.numberEl = rootEl.querySelector(".gauge__number");
    this.length = this.valuePath.getTotalLength();
    this.valuePath.style.strokeDasharray = `${this.length}`;
    this.valuePath.style.strokeDashoffset = `${this.length}`;
  }

  set(value) {
    if (value === null || value === undefined || Number.isNaN(value)) {
      this.numberEl.textContent = "—";
      return;
    }
    const clamped = Math.max(this.min, Math.min(this.max, value));
    const fraction = (clamped - this.min) / (this.max - this.min);
    const offset = this.length * (1 - fraction);
    this.valuePath.style.strokeDashoffset = `${offset}`;
    this.valuePath.classList.toggle("is-danger", value >= this.danger);
    this.numberEl.textContent = value.toFixed(1);
  }
}

const gauges = {
  inlet: new Gauge(document.getElementById("gauge-inlet")),
  outlet: new Gauge(document.getElementById("gauge-outlet")),
  room: new Gauge(document.getElementById("gauge-room")),
};

// ---------------------------------------------------------------------
// History chart (dibuat aman: kalau Chart.js gagal dimuat dari CDN,
// bagian ini di-skip saja, tidak menghentikan koneksi WebSocket)
// ---------------------------------------------------------------------
const MAX_POINTS = 60; // ~5 minutes at 1 sample / 5s render throttle

let historyChart = null;

try {
  if (typeof Chart === "undefined") {
    throw new Error("Chart.js gagal dimuat (cek koneksi internet / CDN diblokir)");
  }

  historyChart = new Chart(document.getElementById("historyChart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Inlet Mesin",
          data: [],
          borderColor: "#E8935A",
          backgroundColor: "rgba(232,147,90,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          fill: true,
        },
        {
          label: "Outlet Mesin",
          data: [],
          borderColor: "#F4B583",
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.35,
          borderDash: [4, 3],
        },
        {
          label: "Ruangan",
          data: [],
          borderColor: "#4FD1C5",
          backgroundColor: "rgba(79,209,197,0.08)",
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.35,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          ticks: { color: "#7C93A8", maxTicksLimit: 8, font: { family: "JetBrains Mono", size: 10 } },
          grid: { color: "#16283A" },
        },
        y: {
          ticks: { color: "#7C93A8", font: { family: "JetBrains Mono", size: 10 } },
          grid: { color: "#16283A" },
          suggestedMin: 15,
          suggestedMax: 80,
        },
      },
      plugins: {
        legend: {
          labels: { color: "#E7EEF5", font: { family: "Inter", size: 11 }, boxWidth: 12 },
        },
      },
    },
  });
} catch (err) {
  console.warn("[chart] dinonaktifkan:", err.message);
  const historyBox = document.getElementById("historyChart");
  if (historyBox) {
    historyBox.outerHTML = '<p style="color:#7C93A8;font-size:12px;">Grafik riwayat tidak tersedia (Chart.js gagal dimuat).</p>';
  }
}

let lastChartPush = 0;
function pushHistory(engine, room) {
  if (!historyChart) return; // chart tidak aktif, skip diam-diam

  const now = Date.now();
  if (now - lastChartPush < 5000) return; // throttle to every 5s
  lastChartPush = now;

  const label = new Date(now).toLocaleTimeString("id-ID", { hour12: false });
  const d = historyChart.data;
  d.labels.push(label);
  d.datasets[0].data.push(engine.inletTemperature ?? null);
  d.datasets[1].data.push(engine.outletTemperature ?? null);
  d.datasets[2].data.push(room.temperature ?? null);

  if (d.labels.length > MAX_POINTS) {
    d.labels.shift();
    d.datasets.forEach((ds) => ds.data.shift());
  }
  historyChart.update("none");
}

// ---------------------------------------------------------------------
// LED + state helpers
// ---------------------------------------------------------------------
function setLed(id, isOn) {
  document.getElementById(id).classList.toggle("is-on", Boolean(isOn));
}

function stateLabel(state) {
  const map = {
    SYSTEM_OFF: "OFF",
    SYSTEM_MANUAL: "MANUAL",
    SYSTEM_AUTO: "AUTO",
    SYSTEM_ALARM: "ALARM",
  };
  return map[state] || state || "—";
}

// ---------------------------------------------------------------------
// Render telemetry
// ---------------------------------------------------------------------
function renderTelemetry(payload) {
  const { engine = {}, room = {} } = payload;

  // Engine panel
  gauges.inlet.set(engine.inletTemperature);
  gauges.outlet.set(engine.outletTemperature);
  document.getElementById("engineState").textContent = stateLabel(engine.state);
  document.getElementById("engineFlow").textContent =
    engine.flowRate !== undefined ? engine.flowRate.toFixed(2) : "—";
  document.getElementById("enginePressure").textContent =
    engine.pressure !== undefined ? engine.pressure.toFixed(2) : "—";
  document.getElementById("engineSetpoint").textContent =
    engine.pidSetpoint !== undefined ? engine.pidSetpoint.toFixed(1) : "—";
  document.getElementById("engineFanValue").textContent =
    engine.fanPWM !== undefined ? `${engine.fanPWM} / 255` : "—";
  document.getElementById("engineFanBar").style.width = engine.fanPWM
    ? `${(engine.fanPWM / 255) * 100}%`
    : "0%";

  setLed("led-engine-running", engine.running);
  setLed("led-engine-overheat", engine.overheatAlarm);
  setLed("led-engine-pressure", engine.highPressureAlarm);
  ["led-engine-overheat", "led-engine-pressure"].forEach((id) =>
    document.getElementById(id).classList.add("is-alarm")
  );

  // Room panel
  gauges.room.set(room.temperature);
  document.getElementById("roomState").textContent = stateLabel(room.state);
  document.getElementById("roomSetpoint").textContent =
    room.pidSetpoint !== undefined ? room.pidSetpoint.toFixed(1) : "—";
  document.getElementById("roomFanValue").textContent =
    room.fanPWM !== undefined ? `${room.fanPWM} / 255` : "—";
  document.getElementById("roomFanBar").style.width = room.fanPWM
    ? `${(room.fanPWM / 255) * 100}%`
    : "0%";
  setLed("led-room-running", room.running);

  // Alarm banner
  const banner = document.getElementById("alarmBanner");
  if (engine.alarm) {
    const reasons = [];
    if (engine.overheatAlarm) reasons.push("Overheat");
    if (engine.highPressureAlarm) reasons.push("High Pressure");
    document.getElementById("alarmBannerText").textContent =
      `ALARM AKTIF — ${reasons.join(" · ") || "Periksa sistem"}`;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  pushHistory(engine, room);
  renderActuators(payload);
}

// ---------------------------------------------------------------------
// Device connection status
// ---------------------------------------------------------------------
function renderDeviceStatus(connected) {
  const el = document.getElementById("deviceStatus");
  el.dataset.state = connected ? "online" : "offline";
  el.querySelector(".device-status__label").textContent = connected
    ? "ESP32 Terhubung"
    : "ESP32 Terputus";
}

// ---------------------------------------------------------------------
// Aktuator status display
// ---------------------------------------------------------------------
function setActuatorStatus(id, isActive) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle("is-active", Boolean(isActive));
    el.textContent = isActive ? "ON" : "OFF";
  }
}

function renderActuators(payload) {
  const { actuators = {} } = payload;
  
  setActuatorStatus("actuator-pump", actuators.pump);
  setActuatorStatus("actuator-valve", actuators.valve);
  setActuatorStatus("actuator-radiator-fan", actuators.radiatorFan);
  setActuatorStatus("actuator-suction-fan", actuators.suctionFan);
  setActuatorStatus("actuator-exhaust-fan", actuators.exhaustFan);
}

// Reference untuk WebSocket (untuk komunikasi status saja, tidak ada setpoint)
let activeWS = null;

// ---------------------------------------------------------------------
// WebSocket connection to the server (with auto-reconnect)
// ---------------------------------------------------------------------
function connect() {
  let url;

  if (BACKEND_URL) {
    // Production: connect ke Railway backend
    url = BACKEND_URL.replace(/\/$/, "") + WS_PATH;
  } else {
    // Local development: same-origin
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    url = `${protocol}//${window.location.host}${WS_PATH}`;
  }

  console.log("[ws] connecting to:", url);
  const ws = new WebSocket(url);
  activeWS = ws;

  ws.addEventListener("open", () => {
    console.log("[ws] connected to server");
  });

  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      return;
    }

    if (msg.type === "telemetry") {
      renderTelemetry(msg);
    } else if (msg.type === "deviceStatus") {
      renderDeviceStatus(msg.connected);
    }
  });

  ws.addEventListener("close", () => {
    renderDeviceStatus(false);
    setTimeout(connect, 1500);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

connect();
