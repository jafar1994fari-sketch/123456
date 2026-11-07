const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send(`
    <h1>Bnet TV Management</h1>
    <p>Server is running successfully!</p>
  `);
});

app.get("/api/status", (req, res) => {
  res.json({
    system: "Bnet TV Management",
    status: "Online"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
