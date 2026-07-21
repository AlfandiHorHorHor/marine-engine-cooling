/**
 * Cooling System Monitor - Server (Production - Railway)
 * ------------------------------------------------------
 * Node.js + WebSocket backend for the ship engine room cooling system.
 *
 * Two kinds of WebSocket clients connect here:
 *   - The ESP32 device connects to  ws://<host>:PORT/esp32
 *     and streams telemetry JSON.
 *   - The web dashboard connects to ws://<host>:PORT/dashboard
 *     and receives live telemetry + device status updates.
 *
 * The server keeps the last known telemetry in memory and immediately
 * sends it to any dashboard that connects, so the UI is never empty.
 */

const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8080;

const app = express();

// Trust Railway proxy
app.set("trust proxy", 1);

// CORS: allow frontend from Vercel
const FRONTEND_URL = process.env.FRONTEND_URL || "*";
app.use(cors({ origin: FRONTEND_URL }));

// Health check for Railway monitoring
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime() });
});

// Root endpoint (Railway health check)
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "cooling-system-monitor" });
});

// WebSocket endpoints - respond to regular HTTP GET (for debugging)
app.get("/esp32", (req, res) => {
  res.json({ status: "ok", endpoint: "/esp32", protocol: "WebSocket only", note: "Connect via wss:// protocol" });
});

app.get("/dashboard", (req, res) => {
  res.json({ status: "ok", endpoint: "/dashboard", protocol: "WebSocket only", note: "Connect via wss:// protocol" });
});

const server = http.createServer(app);

// Railway proxy fix: extend timeouts for WebSocket
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

// Two separate WS servers on distinct paths, sharing one HTTP server.
const deviceWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const dashboardWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false });

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  console.log(`[upgrade] incoming request for: "${url}" from ${request.socket.remoteAddress}`);

  if (url === "/esp32") {
    deviceWSS.handleUpgrade(request, socket, head, (ws) => {
      deviceWSS.emit("connection", ws, request);
    });
  } else if (url === "/dashboard") {
    dashboardWSS.handleUpgrade(request, socket, head, (ws) => {
      dashboardWSS.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --------------------------------------------------------------------
// In-memory state
// --------------------------------------------------------------------
let latestTelemetry = null;
let deviceSocket = null;
let lastSeenAt = null;

const DEVICE_TIMEOUT_MS = 5000; // consider device offline if silent this long

function broadcastToDashboards(payload) {
  const message = JSON.stringify(payload);
  dashboardWSS.clients.forEach((client) => {
    if (client.readyState === client.OPEN) {
      client.send(message);
    }
  });
}

function broadcastDeviceStatus(connected) {
  broadcastToDashboards({
    type: "deviceStatus",
    connected,
    lastSeenAt,
  });
}

// --------------------------------------------------------------------
// ESP32 device connection
// --------------------------------------------------------------------
deviceWSS.on("connection", (ws) => {
  console.log("[device] ESP32 connected");
  deviceSocket = ws;
  lastSeenAt = Date.now();
  broadcastDeviceStatus(true);

  ws.on("message", (raw) => {
    lastSeenAt = Date.now();

    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (err) {
      console.warn("[device] invalid JSON:", raw.toString());
      return;
    }

    latestTelemetry = { type: "telemetry", ...data, receivedAt: lastSeenAt };
    broadcastToDashboards(latestTelemetry);
  });

  ws.on("close", () => {
    console.log("[device] ESP32 disconnected");
    if (deviceSocket === ws) deviceSocket = null;
    broadcastDeviceStatus(false);
  });

  ws.on("error", (err) => {
    console.warn("[device] socket error:", err.message);
  });

  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25000);
  ws.on("close", () => clearInterval(pingInterval));
});

// --------------------------------------------------------------------
// Dashboard (browser) connections
// --------------------------------------------------------------------
dashboardWSS.on("connection", (ws) => {
  console.log("[dashboard] client connected");

  const isDeviceConnected =
    deviceSocket !== null &&
    lastSeenAt !== null &&
    Date.now() - lastSeenAt < DEVICE_TIMEOUT_MS;

  ws.send(
    JSON.stringify({
      type: "deviceStatus",
      connected: isDeviceConnected,
      lastSeenAt,
    })
  );

  if (latestTelemetry) {
    ws.send(JSON.stringify(latestTelemetry));
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      return;
    }

    if (msg.type !== "setpoint") return;

    const { target, value } = msg;
    if (
      (target !== "engine" && target !== "room") ||
      typeof value !== "number" ||
      Number.isNaN(value)
    ) {
      return;
    }

    if (deviceSocket && deviceSocket.readyState === deviceSocket.OPEN) {
      deviceSocket.send(JSON.stringify({ type: "setpoint", target, value }));
      console.log(`[command] forwarded setpoint -> ${target}: ${value}`);
      ws.send(JSON.stringify({ type: "setpointAck", target, value, ok: true }));
    } else {
      ws.send(JSON.stringify({ type: "setpointAck", target, value, ok: false }));
    }
  });

  ws.on("close", () => {
    console.log("[dashboard] client disconnected");
  });
});

// --------------------------------------------------------------------
// Watchdog: mark device offline if it stops sending data without a
// clean disconnect (e.g. WiFi drop, power loss).
// --------------------------------------------------------------------
setInterval(() => {
  if (
    deviceSocket &&
    lastSeenAt &&
    Date.now() - lastSeenAt > DEVICE_TIMEOUT_MS
  ) {
    console.log("[device] timed out, marking offline");
    broadcastDeviceStatus(false);
    deviceSocket = null;
  }
}, 2000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cooling system monitor server running on http://localhost:${PORT}`);
  console.log(`  Dashboard : open the URL above in your browser`);
  console.log(`  ESP32     : connect to ws://<this-computer-ip>:${PORT}/esp32`);
});
