import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { StrKey } from "@stellar/stellar-sdk";
import { Server } from "socket.io";

const args = process.argv.slice(2);
const option = (name, fallback) => Number(args[args.indexOf(name) + 1]) || fallback;
const port = option("--port", 4310), count = option("--count", 500), rate = option("--rate", 500);
const trader = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
let serial = 0, running = false;
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/burst") {
    void burst(Number(url.searchParams.get("count")) || count, Number(url.searchParams.get("rate")) || rate);
    res.end(JSON.stringify({ success: true, data: { running: true } }));
  } else if (/^\/api\/v1\/markets\//.test(url.pathname)) {
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, data: null, error: { code: "MARKET_NOT_FOUND", message: "No metadata in the local simulator" } }));
  } else res.end(JSON.stringify({ ok: true, data: [], error: null, meta: { page: 1, limit: 12, total: 0, totalPages: 0 } }));
});
const io = new Server(server, { cors: { origin: "*" } });
async function burst(n, perSecond) {
  if (running) return;
  running = true;
  const started = performance.now();
  for (let i = 0; i < n; i++) {
    const due = started + i * 1000 / perSecond;
    if (due > performance.now()) await new Promise(resolve => setTimeout(resolve, due - performance.now()));
    serial++;
    io.emit("TRADE_EXECUTED", { eventId: `burst-${String(serial).padStart(12, "0")}`, onChainMarketId: "7", marketId: null,
      marketQuestion: "Will the test market resolve YES?", trader, direction: serial % 2 ? "YES" : "NO", isBuy: true,
      collateralRaw: "10000000", sharesRaw: "15873015", feeRaw: "200000", priceYesBps: 5000 + serial % 1000,
      txHash: serial.toString(16).padStart(64, "0"), ledger: 100000 + serial, closedAt: new Date().toISOString() });
  }
  running = false;
  console.info(`Emitted ${n} trades at ${perSecond}/s`);
}
if (!args.includes("--manual")) io.once("connection", () => setTimeout(() => void burst(count, rate), 2000));
server.listen(port, "127.0.0.1", () => console.info(`Realtime simulator: http://localhost:${port}; trader ${trader}`));
