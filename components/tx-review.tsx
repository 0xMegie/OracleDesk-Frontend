"use client";

import { useEffect, useRef, useState } from "react";
import type { ReviewModel } from "@/lib/stellar/tx-decode";

const SKIP_REVIEW_KEY = "oracledesk_skip_tx_review";

export function shouldSkipTxReview(): boolean {
  try {
    return window.localStorage.getItem(SKIP_REVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSkipTxReview(skip: boolean): void {
  try {
    if (skip) window.localStorage.setItem(SKIP_REVIEW_KEY, "1");
    else window.localStorage.removeItem(SKIP_REVIEW_KEY);
  } catch {
    // Storage may be disabled; the current review still works normally.
  }
}

export function TxReviewPreferenceControl() {
  return (
    <button
      type="button"
      className="text-xs text-on-surface-variant underline hover:text-primary"
      onClick={() => setSkipTxReview(false)}
    >
      Always review transactions
    </button>
  );
}

interface TxReviewProps {
  model: ReviewModel;
  changedFrom?: ReviewModel;
  confirming?: boolean;
  onConfirm(): void;
  onCancel(): void;
}

function formatBound(value: string | null): string {
  if (!value || value === "0") return "Not set";
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toLocaleString() : value;
}

function changed(previous: string | null | undefined, current: string | null | undefined): boolean {
  return previous !== current;
}

export function TxReview({ model, changedFrom, confirming = false, onConfirm, onCancel }: TxReviewProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [skipReview, setSkipReview] = useState(false);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onCancel]);

  const changedLabels = new Set(
    (changedFrom?.args ?? [])
      .filter((oldArg) => model.args.find((arg) => arg.label === oldArg.label)?.raw !== oldArg.raw)
      .map((arg) => arg.label),
  );

  const changedClass = (isChanged: boolean) =>
    isChanged ? "rounded bg-amber-100 px-1 text-amber-950 ring-1 ring-amber-400" : "";

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-on-background/60 p-4" data-testid="tx-review-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tx-review-heading"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-outline-variant bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-outline-variant px-6 py-4">
          <div>
            <p className="font-label-caps text-[10px] uppercase tracking-wider text-primary">Transaction review</p>
            <h2 id="tx-review-heading" ref={headingRef} tabIndex={-1} className="font-headline-md text-headline-md">
              Check before signing
            </h2>
          </div>
          <button type="button" aria-label="Cancel transaction review" onClick={onCancel} className="p-2 text-outline hover:text-error">
            <span aria-hidden="true" className="material-symbols-outlined">close</span>
          </button>
        </header>

        <div className="space-y-6 overflow-y-auto px-6 py-5">
          <section aria-labelledby="tx-review-action">
            <h3 id="tx-review-action" className="mb-3 font-label-caps text-label-caps text-on-surface">What you&apos;re doing</h3>
            <dl className="space-y-2">
              <div className="grid grid-cols-[9rem_1fr] gap-3">
                <dt className="text-sm text-on-surface-variant">Contract</dt>
                <dd className="break-all text-sm font-medium">
                  {model.contractName} <span className="font-data-mono text-xs text-on-surface-variant">{model.contractId}</span>
                </dd>
              </div>
              <div className="grid grid-cols-[9rem_1fr] gap-3">
                <dt className="text-sm text-on-surface-variant">Function</dt>
                <dd className="font-data-mono text-sm">{model.fn}</dd>
              </div>
              {model.args.map((arg) => (
                <div key={arg.label} className="grid grid-cols-[9rem_1fr] gap-3">
                  <dt className="text-sm text-on-surface-variant">{arg.label}</dt>
                  <dd className={`min-w-0 break-all text-sm ${changedClass(changedLabels.has(arg.label))}`}>
                    <span className="font-medium">{arg.display}</span>
                    <span className="ml-2 font-data-mono text-xs text-on-surface-variant">({arg.type})</span>
                    {arg.derivedFrom && <span className="mt-1 block text-xs text-primary">From quote: {arg.derivedFrom}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="tx-review-network">
            <h3 id="tx-review-network" className="mb-3 font-label-caps text-label-caps text-on-surface">Network details</h3>
            <dl className="space-y-2">
              <Row label="Network" value={model.network} />
              <Row label="Source account" value={model.source} changed={changed(changedFrom?.source, model.source)} />
              <Row label="Sequence" value={model.sequence} changed={changed(changedFrom?.sequence, model.sequence)} />
              <Row label="Fee" value={model.fee} changed={changed(changedFrom?.fee, model.fee)} />
              <Row label="Valid from" value={formatBound(model.validFrom)} changed={changed(changedFrom?.validFrom, model.validFrom)} />
              <Row label="Valid until" value={formatBound(model.validUntil)} changed={changed(changedFrom?.validUntil, model.validUntil)} />
            </dl>
          </section>

          <section aria-labelledby="tx-review-hash">
            <h3 id="tx-review-hash" className="mb-2 font-label-caps text-label-caps text-on-surface">Transaction hash</h3>
            <p className={`break-all font-data-mono text-xs ${changedClass(changed(changedFrom?.hash, model.hash))}`}>{model.hash}</p>
            <p className="mt-1 text-xs text-on-surface-variant">Before your wallet signs; your wallet may change the final hash.</p>
          </section>
        </div>

        <footer className="space-y-4 border-t border-outline-variant px-6 py-4">
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            <input type="checkbox" checked={skipReview} onChange={(event) => setSkipReview(event.target.checked)} />
            Don&apos;t show this review again
          </label>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onCancel} disabled={confirming} className="rounded-lg border border-outline-variant px-4 py-2 font-label-caps text-sm">
              Cancel
            </button>
            <button
              type="button"
              disabled={confirming}
              onClick={() => {
                setSkipTxReview(skipReview);
                onConfirm();
              }}
              className="rounded-lg bg-primary px-4 py-2 font-label-caps text-sm text-on-primary disabled:opacity-50"
            >
              {confirming ? "Preparing…" : "Confirm in wallet"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Row({ label, value, changed: isChanged = false }: { label: string; value: string; changed?: boolean }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3">
      <dt className="text-sm text-on-surface-variant">{label}</dt>
      <dd className={`break-all font-data-mono text-sm ${isChanged ? "rounded bg-amber-100 px-1 text-amber-950 ring-1 ring-amber-400" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
