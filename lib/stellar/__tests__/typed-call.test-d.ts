import { describe, expectTypeOf, it } from "vitest";
import { read } from "../typed-call";
import type { MarketCoreClient, RegistryClient, Value } from "../typed-call";
import { marketCore, reasoningRegistry } from "../clients";
import type { Market, Position, Outcome } from "../generated/market-core";
import type { Trace } from "../generated/reasoning-registry";

type MC = MarketCoreClient;
type RR = RegistryClient;

describe("Type inference for binding return types via Value<C, K>", () => {
  it("pins return types of all binding methods used by the application", () => {
    expectTypeOf<Value<MC, "market_count">>().toEqualTypeOf<bigint>();
    expectTypeOf<Value<MC, "get_market">>().toEqualTypeOf<Market>();
    expectTypeOf<Value<MC, "get_position">>().toEqualTypeOf<Position>();
    expectTypeOf<Value<MC, "quote_buy">>().toEqualTypeOf<bigint>();
    expectTypeOf<Value<MC, "buy">>().toEqualTypeOf<bigint>();
    expectTypeOf<Value<MC, "sell">>().toEqualTypeOf<bigint>();
    expectTypeOf<Value<MC, "redeem">>().toEqualTypeOf<bigint>();
    expectTypeOf<Value<MC, "get_price">>().toEqualTypeOf<number>();
    expectTypeOf<Value<RR, "get_trace">>().toMatchTypeOf<{
      trace_hash: Uint8Array;
      ipfs_cid: string;
      market_id: bigint;
      agent: string;
      action: string;
      published_at: bigint;
    }>();
    expectTypeOf<Value<RR, "get_trace">>().toEqualTypeOf<Trace>();
  });

  it("guards against inference collapsing to any", () => {
    expectTypeOf<Value<MC, "market_count">>().not.toBeAny();
    expectTypeOf<Value<MC, "get_market">>().not.toBeAny();
    expectTypeOf<Value<MC, "get_position">>().not.toBeAny();
    expectTypeOf<Value<MC, "quote_buy">>().not.toBeAny();
    expectTypeOf<Value<MC, "buy">>().not.toBeAny();
    expectTypeOf<Value<MC, "sell">>().not.toBeAny();
    expectTypeOf<Value<MC, "redeem">>().not.toBeAny();
    expectTypeOf<Value<MC, "get_price">>().not.toBeAny();
    expectTypeOf<Value<RR, "get_trace">>().not.toBeAny();
  });

  it("pins argument shapes for every contract write", () => {
    expectTypeOf<Parameters<MC["buy"]>[0]>().toEqualTypeOf<{
      trader: string;
      market_id: bigint;
      outcome: Outcome;
      collateral_in: bigint;
      min_shares_out: bigint;
    }>();

    expectTypeOf<Parameters<MC["sell"]>[0]>().toEqualTypeOf<{
      trader: string;
      market_id: bigint;
      outcome: Outcome;
      collateral_out: bigint;
      max_shares_in: bigint;
    }>();

    expectTypeOf<Parameters<MC["redeem"]>[0]>().toEqualTypeOf<{
      holder: string;
      market_id: bigint;
    }>();
  });

  it("infers return types directly when calling read() without type arguments", async () => {
    const marketCount = read(await marketCore().market_count());
    expectTypeOf(marketCount).toEqualTypeOf<bigint>();
    expectTypeOf(marketCount).not.toBeAny();

    const market = read(await marketCore().get_market({ market_id: 0n }));
    expectTypeOf(market).toEqualTypeOf<Market>();
    expectTypeOf(market).not.toBeAny();

    const position = read(
      await marketCore().get_position({ market_id: 0n, holder: "" }),
    );
    expectTypeOf(position).toEqualTypeOf<Position>();
    expectTypeOf(position).not.toBeAny();

    const trace = read(
      await reasoningRegistry().get_trace({ trace_id: 0n }),
      "reasoningRegistry",
    );
    expectTypeOf(trace).toEqualTypeOf<Trace>();
    expectTypeOf(trace.trace_hash).toEqualTypeOf<Buffer>();
    expectTypeOf(trace).not.toBeAny();
  });
});
