import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { marketCore } from "./clients";
import { CONTRACTS, RPC_URL } from "./config";
import { settleValue, type Settlement } from "./generated/fpmm";
import type { Market, Position } from "./generated/market-core";

export const REDEEM_ALL_STORAGE_KEY = "oracledesk_redeem_all:";
export const LEDGER_ENTRY_CHUNK_SIZE = 200;
export const MAX_REDEEM_SCAN_MARKETS = 20_000n;

export interface Redeemable {
  marketId: bigint;
  settlement: Settlement;
  yes: bigint;
  no: bigint;
  expectedPayout: bigint;
  archived: boolean;
}

export interface RedeemDiscovery {
  redeemables: Redeemable[];
  scannedMarkets: bigint;
  totalMarkets: bigint;
  scanLimited: boolean;
}

export type ItemState =
  | { s: "queued" }
  | { s: "signing" }
  | { s: "submitting"; hash?: string }
  | { s: "redeemed"; payout: bigint; hash: string | null; note?: string }
  | { s: "skipped" }
  | { s: "failed"; error: string };

export interface RedeemAllResume {
  holder: string;
  ids: string[];
  states: Record<string, ItemState>;
}

const rpcServer = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith("http://") });

export function marketLedgerKey(marketId: bigint): xdr.LedgerKey {
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Market"), nativeToScVal(marketId, { type: "u64" })]);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACTS.marketCore).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function positionLedgerKey(marketId: bigint, holder: string): xdr.LedgerKey {
  const key = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Position"),
    nativeToScVal(marketId, { type: "u64" }),
    new Address(holder).toScVal(),
  ]);
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACTS.marketCore).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

function chunks<T>(values: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let i = 0; i < values.length; i += size) output.push(values.slice(i, i + size));
  return output;
}

function readUdt<T>(name: string, scVal: xdr.ScVal): T {
  const type = xdr.ScSpecTypeDef.scSpecTypeUdt(new xdr.ScSpecTypeUdt({ name }));
  return marketCore().spec.scValToNative<T>(scVal, type);
}

function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") return false;
  const position = value as Record<string, unknown>;
  return typeof position.yes === "bigint" && typeof position.no === "bigint";
}

function isMarket(value: unknown): value is Market {
  if (!value || typeof value !== "object") return false;
  const market = value as Record<string, unknown>;
  const status = market.status;
  const validStatus =
    (Array.isArray(status) && ["Open", "Resolved", "Void"].includes(String(status[0]))) ||
    Boolean(status && typeof status === "object" && "tag" in status &&
      ["Open", "Resolved", "Void"].includes(String((status as { tag: unknown }).tag)));
  return (
    typeof market.close_time === "bigint" &&
    typeof market.sets_minted === "bigint" &&
    typeof market.reserve_yes === "bigint" &&
    typeof market.reserve_no === "bigint" &&
    validStatus
  );
}

function settlementOf(status: Market["status"]): Settlement | null {
  const parts = Array.isArray(status)
    ? status
    : status && typeof status === "object" && "tag" in status
      ? [status.tag, ...("values" in status && Array.isArray(status.values) ? status.values : [])]
      : [];
  if (parts[0] === "Void") return "void";
  if (parts[0] !== "Resolved") return null;
  const outcome = parts[1];
  const tag =
    typeof outcome === "string"
      ? outcome
      : Array.isArray(outcome)
        ? outcome[0]
        : outcome && typeof outcome === "object" && "tag" in outcome
          ? outcome.tag
          : null;
  if (tag === "Yes") return "yes";
  if (tag === "No") return "no";
  return null;
}

function isItemState(value: unknown): value is ItemState {
  if (!value || typeof value !== "object" || !("s" in value)) return false;
  const state = value as Record<string, unknown>;
  if (state.s === "queued" || state.s === "signing" || state.s === "skipped") return true;
  if (state.s === "submitting") return state.hash === undefined || typeof state.hash === "string";
  if (state.s === "redeemed") {
    return typeof state.payout === "bigint" && (state.hash === null || typeof state.hash === "string");
  }
  return state.s === "failed" && typeof state.error === "string";
}

export async function discoverRedeemable(
  holder: string,
  totalMarkets: bigint,
  server: rpc.Server = rpcServer,
): Promise<RedeemDiscovery> {
  const scannedMarkets = totalMarkets > MAX_REDEEM_SCAN_MARKETS ? MAX_REDEEM_SCAN_MARKETS : totalMarkets;
  const startId = totalMarkets - scannedMarkets;
  const ids = Array.from({ length: Number(scannedMarkets) }, (_, index) => startId + BigInt(index));
  const positionKeys = ids.map((id) => ({ id, key: positionLedgerKey(id, holder) }));
  const positions = new Map<string, { id: bigint; position: Position; liveUntilLedgerSeq?: number }>();

  for (const positionChunk of chunks(positionKeys, LEDGER_ENTRY_CHUNK_SIZE)) {
    const response = await server.getLedgerEntries(...positionChunk.map(({ key }) => key));
    const idByKey = new Map(positionChunk.map(({ id, key }) => [key.toXDR("base64"), id]));
    for (const entry of response.entries) {
      const id = idByKey.get(entry.key.toXDR("base64"));
      if (id === undefined || id < 0n) continue;
      const position = readUdt<unknown>("Position", entry.val.contractData().val());
      if (!isPosition(position) || (position.yes === 0n && position.no === 0n)) continue;
      positions.set(entry.key.toXDR("base64"), { id, position, liveUntilLedgerSeq: entry.liveUntilLedgerSeq });
    }
  }

  const candidatePositions = [...positions.values()];
  const marketKeys = candidatePositions.map((entry) => marketLedgerKey(entry.id));
  const markets = new Map<string, { market: Market; liveUntilLedgerSeq?: number }>();
  let latestLedger = 0;
  for (const keyChunk of chunks(marketKeys, LEDGER_ENTRY_CHUNK_SIZE)) {
    const response = await server.getLedgerEntries(...keyChunk);
    latestLedger = Math.max(latestLedger, response.latestLedger);
    for (const entry of response.entries) {
      const key = entry.key.toXDR("base64");
      const market = readUdt<unknown>("Market", entry.val.contractData().val());
      if (isMarket(market)) markets.set(key, { market, liveUntilLedgerSeq: entry.liveUntilLedgerSeq });
    }
  }

  const redeemables: Redeemable[] = [];
  for (const item of candidatePositions) {
    const marketEntry = markets.get(marketLedgerKey(item.id).toXDR("base64"));
    if (!marketEntry) continue;
    const settlement = settlementOf(marketEntry.market.status);
    if (!settlement) continue;
    const archived =
      (item.liveUntilLedgerSeq !== undefined && item.liveUntilLedgerSeq < latestLedger) ||
      (marketEntry.liveUntilLedgerSeq !== undefined && marketEntry.liveUntilLedgerSeq < latestLedger);
    redeemables.push({
      marketId: item.id,
      settlement,
      yes: item.position.yes,
      no: item.position.no,
      expectedPayout: settleValue(settlement, item.position.yes, item.position.no),
      archived,
    });
  }
  return { redeemables, scannedMarkets, totalMarkets, scanLimited: totalMarkets > scannedMarkets };
}

export function loadRedeemAllResume(holder: string): RedeemAllResume | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const value = sessionStorage.getItem(`${REDEEM_ALL_STORAGE_KEY}${holder}`);
    if (!value) return null;
    const parsed: unknown = JSON.parse(value, (key, item: unknown) => {
      if (key === "payout" && typeof item === "string") return BigInt(item);
      return item;
    });
    if (!parsed || typeof parsed !== "object") throw new Error("Stored redemption progress is malformed.");
    const resume = parsed as Partial<RedeemAllResume>;
    if (
      resume.holder !== holder ||
      !Array.isArray(resume.ids) ||
      !resume.ids.every((id) => typeof id === "string" && /^\d+$/.test(id)) ||
      !resume.states ||
      typeof resume.states !== "object" ||
      Array.isArray(resume.states) ||
      !resume.ids.every((id) => Object.hasOwn(resume.states as object, id)) ||
      !Object.entries(resume.states).every(([id, state]) => /^\d+$/.test(id) && isItemState(state))
    ) {
      throw new Error("Stored redemption progress does not match this wallet.");
    }
    return resume as RedeemAllResume;
  } catch (error) {
    throw new Error(`Could not restore redemption progress: ${String(error)}`);
  }
}

export function saveRedeemAllResume(value: RedeemAllResume): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      `${REDEEM_ALL_STORAGE_KEY}${value.holder}`,
      JSON.stringify(value, (key, item: unknown) => (key === "payout" && typeof item === "bigint" ? item.toString() : item)),
    );
  } catch (error) {
    throw new Error(`Could not save redemption progress: ${String(error)}`);
  }
}
