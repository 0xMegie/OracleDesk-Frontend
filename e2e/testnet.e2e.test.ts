/**
 * End-to-end check against a running backend and live Stellar testnet,
 * using the frontend's own lib/stellar code. Not part of `npm test`.
 *
 *   API_URL=http://localhost:8000/api/v1 \
 *   EXPECTED_YES_BPS=5319 \          # from: stellar contract invoke … -- get_price --market_id 1 --outcome Yes
 *   DEMO_TRACE_FILE=/path/to/bytes \ # optional: exact bytes of a trace published by scripts/demo.sh
 *   DEMO_TRACE_ID=1 \
 *   npm run e2e:testnet
 *
 * Read-only: it simulates contract calls and never signs or submits.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fetchOnChainMarket } from "@/lib/hooks/useStellar";
import { marketCore, reasoningRegistry, Outcomes } from "@/lib/stellar/clients";
import { fetchAndVerifyTrace, verifyTraceHash } from "@/lib/stellar/trace";
import { read, bytesToHex } from "@/lib/stellar/typed-call";

const API_URL = process.env.API_URL ?? "http://localhost:8000/api/v1";
const MARKET_ID = process.env.MARKET_ID ?? "1";

describe("Phase D: backend + testnet", () => {
  it("1. backend markets join to on-chain data", async () => {
    const res = await fetch(`${API_URL}/markets?status=RESOLVED&onChain=true`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const linked = body.data.filter((m: { onChainMarketId: string | null }) => m.onChainMarketId !== null);
    expect(linked.length).toBeGreaterThan(0);
    for (const m of linked) {
      expect(typeof m.onChainMarketId).toBe("string");
      const view = await fetchOnChainMarket(m.onChainMarketId);
      console.log(`backend ${m.id} "${m.question}" → on-chain #${view.id}: yesBps=${view.yesBps} status=${view.market.status.tag} meta=${view.market.meta_uri} (backend currentYesProb=${m.currentYesProb})`);
      expect(view.market.category.tag).toBe(m.contractCategory);
    }
  });

  it("2. on-chain price matches market_core.get_price from the CLI", async () => {
    const view = await fetchOnChainMarket(MARKET_ID);
    const getPrice = read(await marketCore().get_price({ market_id: BigInt(MARKET_ID), outcome: Outcomes.Yes }));
    console.log(`market #${MARKET_ID}: fpmm yesBps=${view.yesBps}, binding get_price=${getPrice}, CLI get_price=${process.env.EXPECTED_YES_BPS ?? "(not given)"}`);
    expect(view.yesBps).toBe(getPrice);
    if (process.env.EXPECTED_YES_BPS) expect(view.yesBps).toBe(Number(process.env.EXPECTED_YES_BPS));
  });

  it.runIf(Boolean(process.env.DEMO_TRACE_FILE))("4. a demo.sh trace verifies, a tampered copy does not", async () => {
    const traceId = BigInt(process.env.DEMO_TRACE_ID ?? "1");
    const trace = read(
      await reasoningRegistry().get_trace({ trace_id: traceId }),
      "reasoningRegistry",
    );
    const onChainHash = bytesToHex(trace.trace_hash);
    const bytes = new Uint8Array(readFileSync(process.env.DEMO_TRACE_FILE as string));
    const tampered = new TextEncoder().encode(new TextDecoder().decode(bytes).replace("demo run", "demo rum"));

    expect(await verifyTraceHash(bytes, onChainHash)).toBe(true);
    expect(await verifyTraceHash(tampered, onChainHash)).toBe(false);

    // The same check through fetchAndVerifyTrace, serving the bytes as a gateway would.
    const serve = (b: Uint8Array) => (async () => new Response(b as BodyInit)) as typeof fetch;
    expect((await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash, serve(bytes))).status).toBe("verified");
    expect((await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash, serve(tampered))).status).toBe("mismatch");

    // The real gateway can't serve the demo's placeholder CID.
    const live = await fetchAndVerifyTrace(trace.ipfs_cid, onChainHash);
    console.log(`trace #${traceId}: on-chain hash ${onChainHash}, cid ${trace.ipfs_cid}, real gateway → ${live.status}`);
    expect(live.status).toBe("unavailable");
  });
});
