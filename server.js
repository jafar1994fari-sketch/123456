const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    system: "Bnet TV Management",
    status: "Online"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Bnet TV Management is running");
});
