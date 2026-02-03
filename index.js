const express = require("express");
const app = express();

app.get("/", (req, res) => {
  res.send("Postly backend alive");
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
