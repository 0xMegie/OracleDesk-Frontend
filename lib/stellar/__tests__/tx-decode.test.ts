import { Account, Address, Keypair, nativeToScVal, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { describe, expect, it } from "vitest";
import { marketCore } from "../clients";
import { CONTRACTS, NETWORK_PASSPHRASE } from "../config";
import { formatUsdc, USDC_UNIT } from "../units";
import { assertIntentMatches, describeAssembled } from "../tx-decode";

const spec = marketCore().spec;
const trader = Keypair.random().publicKey();

function assembled(functionName: string, contractId: string, args: xdr.ScVal[]): AssembledTransaction<unknown> {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: new Address(contractId).toScAddress(),
      functionName,
      args,
    }),
  );
  const built = new TransactionBuilder(new Account(trader, "17"), {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(300)
    .build();
  return { built } as AssembledTransaction<unknown>;
}

function buyTransaction(collateralIn: bigint, minSharesOut: bigint) {
  return assembled(
    "buy",
    CONTRACTS.marketCore,
    spec.funcArgsToScVals("buy", {
      trader,
      market_id: 42n,
      outcome: { tag: "Yes", values: undefined },
      collateral_in: collateralIn,
      min_shares_out: minSharesOut,
    }),
  );
}

describe("describeAssembled", () => {
  it("decodes buy arguments using spec names and formats enum, amounts, and derived bounds", () => {
    const collateralIn = 12_345_678_901_234_567n;
    const minSharesOut = 9_876_543_210_987_654n;
    const model = describeAssembled(buyTransaction(collateralIn, minSharesOut), spec, {
      min_shares_out: { value: minSharesOut, from: "quote 10 shares, 1% slippage" },
    });

    expect(model.fn).toBe("buy");
    expect(model.source).toBe(trader);
    expect(model.sequence).toBe("18");
    expect(model.fee).toBe(`${formatUsdc(100n, { minDecimals: 7, maxDecimals: 7 })} XLM`);
    expect(model.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(model.args).toMatchObject([
      { label: "Source account", type: "Address", raw: trader },
      { label: "Market id", type: "u64", raw: "42", display: "#42" },
      { label: "Outcome", type: "Outcome", raw: "Yes", display: "Yes" },
      { label: "Collateral in (USDC)", type: "i128", raw: collateralIn.toString(), display: `${formatUsdc(collateralIn, { minDecimals: 7, maxDecimals: 7 })} USDC` },
      { label: "Minimum shares out", type: "i128", raw: minSharesOut.toString(), derivedFrom: "quote 10 shares, 1% slippage" },
    ]);
    expect(model.args[0].display).toContain(trader);
    expect(model.validUntil).not.toBeNull();
  });

  it("decodes the SEP-41 SAC transfer signature without converting i128 amounts to Number", () => {
    const recipient = Keypair.random().publicKey();
    const amount = 9_007_199_254_740_993n * USDC_UNIT;
    const tx = assembled("transfer", CONTRACTS.usdc, [
      new Address(trader).toScVal(),
      new Address(recipient).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ]);
    const model = describeAssembled(tx, "sac");

    expect(model.contractName).toBe("USDC token (Stellar Asset Contract)");
    expect(model.args).toMatchObject([
      { label: "From", raw: trader, type: "Address" },
      { label: "To", raw: recipient, type: "Address" },
      { label: "Amount (USDC)", raw: amount.toString(), display: `${formatUsdc(amount, { minDecimals: 7, maxDecimals: 7 })} USDC` },
    ]);
  });

  it("rejects mismatches between the decoded envelope and requested intent", () => {
    const model = describeAssembled(buyTransaction(10n * USDC_UNIT, 5n * USDC_UNIT), spec);
    expect(() =>
      assertIntentMatches(model, {
        trader,
        market_id: "42",
        outcome: "Yes",
        collateral_in: (11n * USDC_UNIT).toString(),
        min_shares_out: (5n * USDC_UNIT).toString(),
      }),
    ).toThrow(/collateral_in.*does not match/i);
    expect(() =>
      assertIntentMatches(model, {
        trader,
        market_id: "42",
        outcome: "Yes",
        collateral_in: (10n * USDC_UNIT).toString(),
        min_shares_out: (5n * USDC_UNIT).toString(),
      }),
    ).not.toThrow();
    expect(() =>
      assertIntentMatches({ ...model, source: Keypair.random().publicKey() }, {
        trader,
        market_id: "42",
        outcome: "Yes",
        collateral_in: (10n * USDC_UNIT).toString(),
        min_shares_out: (5n * USDC_UNIT).toString(),
      }),
    ).toThrow(/source account does not match/i);
  });
});
