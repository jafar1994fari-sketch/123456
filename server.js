
const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let gatewaySocket = null;
let connectedAt = null;
let lastSeen = null;
let gatewayDevice = null;

app.get("/api/status", (req, res) => {
    res.json({
        system: "Bnet TV Management",
        status: "Online",
        gateway: gatewaySocket &&
            gatewaySocket.readyState === WebSocket.OPEN
                ? "Connected"
                : "Disconnected",
        connectedAt,
        lastSeen,
        device: gatewayDevice
    });
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/gateway") {
        socket.destroy();
        return;
    }

    if (!GATEWAY_TOKEN) {
        socket.destroy();
        return;
    }

    const auth = request.headers.authorization;

    if (auth !== `Bearer ${GATEWAY_TOKEN}`) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
    });
});

wss.on("connection", (ws) => {
    if (gatewaySocket && gatewaySocket.readyState === WebSocket.OPEN) {
        gatewaySocket.close();
    }

    gatewaySocket = ws;
    connectedAt = new Date().toISOString();
    lastSeen = connectedAt;
    gatewayDevice = null;

    ws.isAlive = true;

    console.log("NOC Gateway connected");

    ws.on("pong", () => {
        ws.isAlive = true;
        lastSeen = new Date().toISOString();
    });

    ws.on("message", (message) => {
        lastSeen = new Date().toISOString();

        try {
            const data = JSON.parse(message.toString());

            if (data.type === "gateway_connected") {
                gatewayDevice = data.device || "Unknown";
                console.log("Gateway device registered");
            }
        } catch {
            console.log("Invalid Gateway message received");
        }
    });

    ws.on("close", () => {
        console.log("NOC Gateway disconnected");

        if (gatewaySocket === ws) {
            gatewaySocket = null;
            gatewayDevice = null;
        }
    });

    ws.on("error", (err) => {
        console.log("Gateway WebSocket error:", err.message);
    });
});

// Check the Gateway connection every 30 seconds.
const heartbeat = setInterval(() => {
    if (!gatewaySocket) return;

    if (!gatewaySocket.isAlive) {
        gatewaySocket.terminate();
        return;
    }

    gatewaySocket.isAlive = false;
    gatewaySocket.ping();
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
    console.log("Bnet TV Management is running");
});

process.on("SIGTERM", () => {
    clearInterval(heartbeat);
    server.close();
});
