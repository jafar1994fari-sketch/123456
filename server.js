
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

app.get("/api/status", (req, res) => {
  res.json({
    system: "Bnet TV Management",
    status: "Online",
    gateway: "Waiting for connection"
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
  console.log("NOC Gateway connected");

  ws.on("message", (message) => {
    console.log("Gateway message received:", message.toString());
  });

  ws.on("close", () => {
    console.log("NOC Gateway disconnected");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Bnet TV Management is running");
});
