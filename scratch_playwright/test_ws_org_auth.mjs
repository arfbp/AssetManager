import WebSocket from "ws";
import https from "node:https";

const agent = new https.Agent({ rejectUnauthorized: false });

function tryConnect(token) {
  return new Promise((resolve) => {
    const ws = new WebSocket("wss://127.0.0.1:8444/", {
      headers: { Authorization: `Bearer ${token}` },
      agent,
    });
    ws.on("open", () => { resolve("OPEN"); ws.close(); });
    ws.on("unexpected-response", (req, res) => resolve(`REJECTED status=${res.statusCode}`));
    ws.on("error", (err) => resolve(`ERROR ${err.message}`));
  });
}

console.log("correct legacy org token:", await tryConnect("test-token"));
console.log("wrong/old-style token:", await tryConnect("totally-wrong-token"));
console.log("empty token:", await tryConnect(""));
