import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { AssembledTransaction, Spec } from "@stellar/stellar-sdk/contract";
import { CONTRACTS, NETWORK_LABEL } from "./config";
import { formatUsdc, shortAddress } from "./units";

export interface ReviewField {
  label: string;
  type: string;
  display: string;
  raw: string;
  derivedFrom?: string;
}

export interface ReviewModel {
  network: string;
  source: string;
  sequence: string;
  fee: string;
  validFrom: string | null;
  validUntil: string | null;
  contractId: string;
  contractName: string;
  fn: string;
  args: ReviewField[];
  hash: string;
}

export type DerivedFields = Record<string, { value: bigint; from: string }>;

const ARG_LABELS: Record<string, string> = {
  trader: "Source account",
  holder: "Source account",
  market_id: "Market id",
  outcome: "Outcome",
  collateral_in: "Collateral in (USDC)",
  min_shares_out: "Minimum shares out",
  collateral_out: "Collateral out (USDC)",
  max_shares_in: "Maximum shares in",
  from: "From",
  to: "To",
  amount: "Amount (USDC)",
};

function stringValue(value: string | Buffer): string {
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

function enumCases(spec: Spec, name: string): Set<string> {
  const entry = spec.entries.find(
    (candidate) =>
      (candidate.switch().name === "scSpecEntryUdtEnumV0" &&
        stringValue(candidate.udtEnumV0().name()) === name) ||
      (candidate.switch().name === "scSpecEntryUdtUnionV0" &&
        stringValue(candidate.udtUnionV0().name()) === name),
  );
  if (!entry) return new Set();
  if (entry.switch().name === "scSpecEntryUdtEnumV0") {
    return new Set(entry.udtEnumV0().cases().map((entryCase) => stringValue(entryCase.name())));
  }
  return new Set(entry.udtUnionV0().cases().map((entryCase) => stringValue(entryCase.value().name())));
}

function enumTag(spec: Spec, name: string, native: unknown): string {
  const cases = enumCases(spec, name);
  let tag: unknown;
  if (Array.isArray(native) && native.length >= 1) tag = native[0];
  else if (native && typeof native === "object" && "tag" in native) tag = (native as { tag: unknown }).tag;
  else if (typeof native === "string") tag = native;
  if (typeof tag !== "string" || !cases.has(tag)) {
    throw new Error(`The ${name} enum value could not be decoded from the contract spec.`);
  }
  return tag;
}

function typeName(spec: Spec, definition: xdr.ScSpecTypeDef): string {
  const typeSwitch = definition.switch().name;
  if (typeSwitch === "scSpecTypeUdt") return stringValue(definition.udt().name());
  const primitive = typeSwitch.replace(/^scSpecType/, "");
  return primitive === "Address" ? primitive : primitive.toLowerCase();
}

function rawForValue(
  spec: Spec | "sac",
  type: string,
  typeDef: xdr.ScSpecTypeDef | null,
  scVal: xdr.ScVal,
): string {
  if (type === "Address") return Address.fromScVal(scVal).toString();
  const native = spec === "sac" ? scValToNative(scVal) : spec.scValToNative(scVal, typeDef as xdr.ScSpecTypeDef);
  if (typeDef?.switch().name === "scSpecTypeUdt") {
    return enumTag(spec as Spec, typeDef.udt().name().toString(), native);
  }
  if (typeof native === "bigint" || typeof native === "string" || typeof native === "number") return String(native);
  if (native && typeof native === "object" && "toString" in native) {
    return (native as { toString(): string }).toString();
  }
  throw new Error(`The ${type} argument could not be decoded.`);
}

function formatValue(name: string, type: string, raw: string): string {
  if (type === "Address") return `${raw} (${shortAddress(raw)})`;
  if (type === "i128") return `${formatUsdc(BigInt(raw), { minDecimals: 7, maxDecimals: 7 })} USDC`;
  if (type === "u64" && name === "market_id") return `#${raw}`;
  return raw;
}

function contractDisplay(contractId: string): string {
  if (contractId === CONTRACTS.marketCore) return "Market core";
  if (contractId === CONTRACTS.usdc) return "USDC token (Stellar Asset Contract)";
  return "Contract";
}

export function describeAssembled(
  tx: AssembledTransaction<unknown>,
  spec: Spec | "sac",
  derived: DerivedFields = {},
): ReviewModel {
  const built = tx.built;
  if (!built) throw new Error("The transaction must be simulated before it can be reviewed.");
  const operations = built.operations;
  if (operations.length !== 1 || operations[0].type !== "invokeHostFunction") {
    throw new Error("Only a single contract invocation can be reviewed.");
  }
  const hostFunction = operations[0].func;
  if (hostFunction.switch().name !== "hostFunctionTypeInvokeContract") {
    throw new Error("The assembled operation is not a contract invocation.");
  }
  const invocation = hostFunction.invokeContract();
  const contractId = Address.fromScAddress(invocation.contractAddress()).toString();
  const fn = stringValue(invocation.functionName());
  const args = invocation.args();

  let fields: ReviewField[];
  if (spec === "sac") {
    if (contractId !== CONTRACTS.usdc || fn !== "transfer" || args.length !== 3) {
      throw new Error("The SAC invocation does not match the known SEP-41 transfer signature.");
    }
    fields = [
      { name: "from", type: "Address", scVal: args[0] },
      { name: "to", type: "Address", scVal: args[1] },
      { name: "amount", type: "i128", scVal: args[2] },
    ].map(({ name, type, scVal }) => {
      const raw = rawForValue("sac", type, null, scVal);
      return {
        label: ARG_LABELS[name] ?? name,
        type,
        display: formatValue(name, type, raw),
        raw,
        ...(derived[name] ? { derivedFrom: derived[name].from } : {}),
      };
    });
  } else {
    const inputs = spec.getFunc(fn).inputs();
    if (inputs.length !== args.length) throw new Error("Decoded argument count does not match the contract spec.");
    fields = inputs.map((input, index) => {
      const name = stringValue(input.name());
      const typeDef = input.type();
      const type = typeName(spec, typeDef);
      const raw = rawForValue(spec, type, typeDef, args[index]);
      return {
        label: ARG_LABELS[name] ?? name,
        type,
        display: formatValue(name, type, raw),
        raw,
        ...(derived[name] ? { derivedFrom: derived[name].from } : {}),
      };
    });
  }

  const bounds = built.timeBounds;
  return {
    network: NETWORK_LABEL,
    source: built.source,
    sequence: built.sequence,
    fee: `${formatUsdc(BigInt(built.fee), { minDecimals: 7, maxDecimals: 7 })} XLM`,
    validFrom: bounds?.minTime ?? null,
    validUntil: bounds?.maxTime ?? null,
    contractId,
    contractName: contractDisplay(contractId),
    fn,
    args: fields,
    hash: built.hash().toString("hex"),
  };
}

/** Refuse to display a confirmation action if the envelope no longer matches the caller's intent. */
export function assertIntentMatches(model: ReviewModel, intent: Record<string, string>): void {
  const expectedSource = intent.trader ?? intent.holder ?? intent.from;
  if (expectedSource && model.source !== expectedSource) {
    throw new Error("The assembled transaction source account does not match the requested action.");
  }
  for (const [name, expected] of Object.entries(intent)) {
    const field = model.args.find((arg) => arg.label === (ARG_LABELS[name] ?? name));
    if (!field || field.raw !== expected) {
      throw new Error(`The assembled transaction's ${name} argument does not match the requested action.`);
    }
  }
}
