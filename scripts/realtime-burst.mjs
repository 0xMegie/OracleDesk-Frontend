#!/usr/bin/env node
/**
 * Dev-only burst simulator for realtime feeds (issue #41).
 *
 * Starts a local socket.io server and emits synthetic TRADE_EXECUTED payloads
 * shaped like docs/api.md. Point the app at it with
 *   NEXT_PUBLIC_API_URL=http://localhost:4100/api/v1 npm run dev
 *
 * Usage: node scripts/realtime-burst.mjs --count 500 --rate 500 [--port 4100] [--market 0]
 *
 * socket.io (the server package) is not a project dependency; install it
 * locally without saving: npm i --no-save socket.io@4.8.1
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const count = Number(arg("count", 500));
const rate = Number(arg("rate", 500));
const port = Number(arg("port", 4100));
const market = String(arg("market", "0"));

let Server;
try {
  ({ Server } = await import("socket.io"));
} catch {
  console.error("socket.io is not installed. Run: npm i --no-save socket.io@4.8.1");
  process.exit(1);
}

const http = createServer((_, res) => res.writeHead(404).end());
const io = new Server(http, { cors: { origin: "*" } });
let ledger = 1_000_000;

function payload(i) {
  const isYes = Math.random() < 0.5;
  return {
    onChainMarketId: market,
    marketId: null,
    marketQuestion: `Synthetic burst market #${market}`,
    trader: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    direction: isYes ? "YES" : "NO",
    isBuy: Math.random() < 0.8,
    collateralRaw: String(10_000_000 + Math.floor(Math.random() * 90_000_000)),
    sharesRaw: String(15_000_000 + Math.floor(Math.random() * 90_000_000)),
    feeRaw: "200000",
    priceYesBps: 3000 + Math.floor(Math.random() * 4000),
    txHash: randomBytes(32).toString("hex"),
    ledger: (ledger += i % 5 === 0 ? 1 : 0),
    eventId: `${String(ledger).padStart(19, "0")}-${String(i).padStart(10, "0")}`,
  };
}

io.on("connection", (socket) => {
  console.log(`client connected (${socket.id}); emitting ${count} events at ${rate}/s`);
  let sent = 0;
  const perTick = Math.max(1, Math.round(rate / 100));
  const timer = setInterval(() => {
    for (let k = 0; k < perTick && sent < count; k++) socket.emit("TRADE_EXECUTED", payload(sent++));
    if (sent >= count) {
      clearInterval(timer);
      console.log(`done: ${sent} events`);
    }
  }, 10);
  socket.on("disconnect", () => clearInterval(timer));
});

http.listen(port, () => console.log(`burst server on http://localhost:${port}`));
