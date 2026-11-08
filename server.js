
const express = require("express");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const TEST_CONTROL_TOKEN = process.env.TEST_CONTROL_TOKEN;

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Temporary test room for the first receiver.
const LIVEKIT_TEST_ROOM = "bnet-tv-test-1";

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

let gatewaySocket = null;
let connectedAt = null;
let lastSeen = null;

const devices = new Map();
const pendingRequests = new Map();

app.get("/api/status", (req, res) => {
    res.json({
        system: "Bnet TV Management",
        status: "Online",
        gateway:
            gatewaySocket &&
            gatewaySocket.readyState === WebSocket.OPEN
                ? "Connected"
                : "Disconnected",
        connectedAt,
        lastSeen,
        deviceCount: devices.size,
        devices: Array.from(devices.values())
    });
});

app.get("/api/devices", (req, res) => {
    res.json(Array.from(devices.values()));
});

// Temporary test access protection.
function checkTestAccess(req, res, next) {
    const supplied = req.headers["x-test-token"];

    if (!TEST_CONTROL_TOKEN || !supplied) {
        return res.status(401).json({
            error: "Test access is not configured"
        });
    }

    const a = Buffer.from(String(supplied));
    const b = Buffer.from(TEST_CONTROL_TOKEN);

    if (
        a.length !== b.length ||
        !crypto.timingSafeEqual(a, b)
    ) {
        return res.status(403).json({
            error: "Invalid test access token"
        });
    }

    next();
}

// Create a temporary LiveKit viewer token.
app.post(
    "/api/test/livekit-token",
    checkTestAccess,
    async (req, res) => {
        try {
            if (
                !LIVEKIT_URL ||
                !LIVEKIT_API_KEY ||
                !LIVEKIT_API_SECRET
            ) {
                return res.status(503).json({
                    error: "LiveKit is not configured"
                });
            }

            if (
                !LIVEKIT_URL.startsWith("wss://") &&
                !LIVEKIT_URL.startsWith("https://")
            ) {
                return res.status(503).json({
                    error: "Invalid LiveKit server URL"
                });
            }

            const identity = `viewer-${crypto.randomUUID()}`;

            const accessToken = new AccessToken(
                LIVEKIT_API_KEY,
                LIVEKIT_API_SECRET,
                {
                    identity,
                    ttl: "10m"
                }
            );

            accessToken.addGrant({
                roomJoin: true,
                room: LIVEKIT_TEST_ROOM,
                canSubscribe: true,
                canPublish: false,
                canPublishData: false
            });

            const token = await accessToken.toJwt();

            res.set("Cache-Control", "no-store");

            res.json({
                success: true,
                serverUrl: LIVEKIT_URL,
                roomName: LIVEKIT_TEST_ROOM,
                participantToken: token,
                expiresIn: 600
            });

        } catch (error) {
            console.error(
                "LiveKit token error:",
                error.message
            );

            res.status(500).json({
                error: "Could not create LiveKit viewer token"
            });
        }
    }
);

// Send a request through the existing Gateway connection.
function sendGatewayRequest(type, payload = {}) {
    return new Promise((resolve, reject) => {
        if (
            !gatewaySocket ||
            gatewaySocket.readyState !== WebSocket.OPEN
        ) {
            return reject(
                new Error("Gateway is disconnected")
            );
        }

        const requestId = crypto.randomUUID();

        const timer = setTimeout(() => {
            pendingRequests.delete(requestId);
            reject(
                new Error("Gateway request timed out")
            );
        }, 15000);

        pendingRequests.set(requestId, {
            resolve,
            reject,
            timer
        });

        gatewaySocket.send(
            JSON.stringify({
                type,
                requestId,
                ...payload
            }),
            error => {
                if (error) {
                    clearTimeout(timer);
                    pendingRequests.delete(requestId);
                    reject(error);
                }
            }
        );
    });
}

// Request a screenshot from the test TV.
app.get(
    "/api/test/screenshot",
    checkTestAccess,
    async (req, res) => {
        try {
            const result = await sendGatewayRequest(
                "device_screenshot"
            );

            if (!result.image) {
                throw new Error("Empty screenshot");
            }

            const image = Buffer.from(
                result.image,
                "base64"
            );

            res.set({
                "Content-Type": "image/png",
                "Cache-Control": "no-store"
            });

            res.send(image);

        } catch (error) {
            res.status(503).json({
                error: error.message
            });
        }
    }
);

// Allow only specific remote-control actions.
app.post(
    "/api/test/command",
    checkTestAccess,
    async (req, res) => {
        const { action, x, y } = req.body || {};

        const allowedKeys = [
            "BACK",
            "HOME",
            "DPAD_UP",
            "DPAD_DOWN",
            "DPAD_LEFT",
            "DPAD_RIGHT",
            "DPAD_CENTER",
            "ENTER",
            "MENU",
            "VOLUME_UP",
            "VOLUME_DOWN"
        ];

        let command = {};

        if (action === "tap") {
            if (
                !Number.isInteger(x) ||
                !Number.isInteger(y) ||
                x < 0 || x >= 1280 ||
                y < 0 || y >= 720
            ) {
                return res.status(400).json({
                    error: "Invalid coordinates"
                });
            }

            command = { action, x, y };

        } else if (allowedKeys.includes(action)) {
            command = { action };

        } else {
            return res.status(400).json({
                error: "Unsupported action"
            });
        }

        try {
            const result = await sendGatewayRequest(
                "device_command",
                command
            );

            res.json({
                success: true,
                result: result.message ||
                    "Command completed"
            });

        } catch (error) {
            res.status(503).json({
                error: error.message
            });
        }
    }
);

const wss = new WebSocket.Server({
    noServer: true
});

server.on("upgrade", (request, socket, head) => {
    if (
        request.url !== "/gateway" ||
        !GATEWAY_TOKEN
    ) {
        socket.destroy();
        return;
    }

    if (
        request.headers.authorization !==
        `Bearer ${GATEWAY_TOKEN}`
    ) {
        socket.destroy();
        return;
    }

    wss.handleUpgrade(
        request,
        socket,
        head,
        ws => {
            wss.emit("connection", ws, request);
        }
    );
});

wss.on("connection", ws => {
    if (
        gatewaySocket &&
        gatewaySocket.readyState === WebSocket.OPEN
    ) {
        gatewaySocket.close();
    }

    gatewaySocket = ws;
    connectedAt = new Date().toISOString();
    lastSeen = connectedAt;

    ws.isAlive = true;

    console.log("NOC Gateway connected");

    ws.on("pong", () => {
        ws.isAlive = true;
        lastSeen = new Date().toISOString();
    });

    ws.on("message", message => {
        lastSeen = new Date().toISOString();

        try {
            const data = JSON.parse(
                message.toString()
            );

            if (data.type === "gateway_connected") {
                console.log("Gateway registered");
            }

            if (
                data.type === "device_update" &&
                data.serial
            ) {
                devices.set(data.serial, {
                    serial: data.serial,
                    model: data.model || "Unknown",
                    android: data.android || "Unknown",
                    adbAddress: data.adbAddress || null,
                    status: "Online",
                    lastSeen: new Date().toISOString()
                });
            }

            if (
                data.type === "screenshot_result" ||
                data.type === "command_result"
            ) {
                const pending = pendingRequests.get(
                    data.requestId
                );

                if (pending) {
                    clearTimeout(pending.timer);
                    pendingRequests.delete(
                        data.requestId
                    );

                    if (data.success) {
                        pending.resolve(data);
                    } else {
                        pending.reject(
                            new Error(
                                data.error ||
                                "Device command failed"
                            )
                        );
                    }
                }
            }

        } catch {
            console.log(
                "Invalid Gateway message received"
            );
        }
    });

    ws.on("close", () => {
        console.log("NOC Gateway disconnected");

        if (gatewaySocket === ws) {
            gatewaySocket = null;

            for (const [serial, device] of devices) {
                devices.set(serial, {
                    ...device,
                    status: "Offline"
                });
            }

            for (const [id, pending] of pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(
                    new Error("Gateway disconnected")
                );
                pendingRequests.delete(id);
            }
        }
    });

    ws.on("error", err => {
        console.log(
            "Gateway WebSocket error:",
            err.message
        );
    });
});

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
    console.log(
        "Bnet TV Management is running"
    );
});

process.on("SIGTERM", () => {
    clearInterval(heartbeat);
    server.close();
});
