"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export default function BuyNoDemoPage() {
  const [amount, setAmount] = useState<string>("1000.00");
  const [isModalOpen, setIsModalOpen] = useState(true);

  const price = 0.68;
  const shares = (parseFloat(amount) || 0) / price;
  const fee = (parseFloat(amount) || 0) * 0.01;
  const priceImpact = Math.min(0.99, shares ? ((parseFloat(amount) || 0) / Math.max(shares, 1)) * 0.002 : 0);
  const potentialPayout = shares; // Since it's a binary outcome usually 1 USDC per share

  return (
    <div className="min-h-screen bg-surface font-body-md text-on-surface antialiased overflow-x-hidden">
      {/* Header Navigation Shell */}
      <header className="bg-surface dark:bg-on-background border-b border-outline-variant dark:border-outline h-16 w-full fixed top-0 z-50">
        <div className="flex justify-between items-center w-full h-16 px-gutter max-w-container-max-width mx-auto">
          <div className="flex items-center gap-8">
            <span className="font-headline-md text-headline-md font-bold text-on-surface dark:text-surface-bright">OracleDesk</span>
            <nav className="hidden md:flex items-center gap-6">
              <Link className="text-on-surface-variant dark:text-surface-variant font-medium hover:text-primary dark:hover:text-primary-fixed-dim transition-colors duration-200 cursor-pointer active:opacity-80" href="#">Markets</Link>
              <Link className="text-on-surface-variant dark:text-surface-variant font-medium hover:text-primary dark:hover:text-primary-fixed-dim transition-colors duration-200 cursor-pointer active:opacity-80" href="#">Reasoning</Link>
              <Link className="text-on-surface-variant dark:text-surface-variant font-medium hover:text-primary dark:hover:text-primary-fixed-dim transition-colors duration-200 cursor-pointer active:opacity-80" href="#">Portfolio</Link>
              <Link className="text-on-surface-variant dark:text-surface-variant font-medium hover:text-primary dark:hover:text-primary-fixed-dim transition-colors duration-200 cursor-pointer active:opacity-80" href="#">Stats</Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="material-symbols-outlined text-on-surface-variant cursor-pointer hidden sm:inline">notifications</span>
            <button className="bg-primary text-on-primary px-4 py-2 font-label-caps text-label-caps rounded hover:opacity-90 transition-opacity whitespace-nowrap">Connect Wallet</button>
          </div>
        </div>
      </header>

      {/* Main Content Canvas (Blurred Background Context) */}
      <main className={`pt-24 px-gutter max-w-container-max-width mx-auto min-h-screen transition-all duration-300 ${isModalOpen ? 'blur-sm grayscale-[0.2]' : ''}`}>
        <div className="grid grid-cols-12 gap-6 opacity-40 select-none pointer-events-none">
          {/* Background Mock UI */}
          <div className="col-span-12 lg:col-span-8 space-y-6">
            <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded-xl">
              <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-6">
                <span className="bg-secondary-container text-on-secondary-container text-[10px] font-bold px-2 py-0.5 rounded uppercase w-fit">Politics</span>
                <h1 className="font-headline-md text-headline-md lg:text-2xl">Will the proposed tax bill pass before Q3?</h1>
              </div>
              <div className="h-48 sm:h-64 bg-surface-container rounded-lg mb-4"></div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="h-32 bg-surface-container-low border border-outline-variant rounded-xl"></div>
              <div className="h-32 bg-surface-container-low border border-outline-variant rounded-xl"></div>
            </div>
          </div>
          <div className="col-span-12 lg:col-span-4 space-y-6">
            <div className="h-[400px] lg:h-96 bg-surface-container-lowest border border-outline-variant rounded-xl"></div>
          </div>
        </div>
      </main>

      {/* Modal Backdrop */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-on-background/40 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          {/* BUY NO Modal (Institutional Styling) */}
          <div className="bg-surface-container-lowest w-full max-w-[480px] rounded-xl shadow-2xl overflow-hidden border border-outline-variant animate-in fade-in zoom-in duration-300">
            {/* Modal Header */}
            <div className="p-4 sm:p-6 border-b border-outline-variant flex justify-between items-center bg-surface-container-low">
              <div>
                <span className="font-label-caps text-label-caps text-tertiary uppercase tracking-widest block mb-1">Execution Terminal</span>
                <h2 className="font-headline-sm text-headline-sm text-on-surface">Buy <span className="text-tertiary">NO</span> Shares</h2>
              </div>
              <button 
                onClick={() => setIsModalOpen(false)}
                className="text-on-surface-variant hover:text-on-surface transition-colors p-2"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Probability Bar */}
            <div className="px-4 sm:px-6 py-4 bg-surface-container-lowest">
              <div className="flex justify-between font-label-caps text-label-caps mb-2 text-[10px] sm:text-xs">
                <span className="text-secondary font-bold">YES 32%</span>
                <span className="text-tertiary font-bold">NO 68%</span>
              </div>
              <div className="h-1.5 w-full bg-surface-container rounded-full flex overflow-hidden">
                <div className="h-full bg-secondary transition-all duration-700" style={{ width: '32%' }}></div>
                <div className="h-full bg-tertiary transition-all duration-700" style={{ width: '68%' }}></div>
              </div>
            </div>

            {/* Trade Form */}
            <div className="p-4 sm:p-6 space-y-6">
              {/* Input Section */}
              <div className="space-y-2">
                <div className="flex justify-between items-end">
                  <label className="font-label-caps text-label-caps text-on-surface-variant">Investment Amount</label>
                  <span className="text-[10px] sm:text-[11px] text-on-surface-variant">Available: <span className="font-data-mono font-bold text-on-surface">24,500.00 USDC</span></span>
                </div>
                <div className="relative">
                  <input 
                    className="w-full bg-surface-container-low border border-outline-variant focus:border-tertiary focus:ring-1 focus:ring-tertiary rounded-lg px-4 py-3 sm:py-4 font-headline-md text-xl sm:text-headline-md text-on-surface outline-none transition-all placeholder:text-outline-variant" 
                    placeholder="0.00" 
                    type="number" 
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2">
                    <span className="font-label-caps text-label-caps text-on-surface-variant hidden xs:inline">USDC</span>
                    <button className="text-[10px] font-bold bg-surface-variant text-on-surface-variant px-2 py-1 rounded hover:bg-outline-variant transition-colors">MAX</button>
                  </div>
                </div>
              </div>

              {/* Transaction Details (High Density) */}
              <div className="bg-surface-container-low rounded-lg p-4 space-y-3 border border-outline-variant">
                <div className="flex justify-between items-center text-sm sm:text-base">
                  <span className="font-body-md text-on-surface-variant">Estimated Shares</span>
                  <span className="font-data-mono font-bold text-on-surface">{shares.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div className="flex justify-between items-center text-sm sm:text-base">
                  <span className="font-body-md text-on-surface-variant">Trading fee</span>
                  <span className="font-data-mono font-bold text-on-surface">{fee.toFixed(2)} USDC</span>
                </div>
                <div className="flex justify-between items-center text-sm sm:text-base">
                  <span className="font-body-md text-on-surface-variant">Estimated price impact</span>
                  <span className="font-data-mono font-bold text-on-surface">{(priceImpact * 100).toFixed(2)}%</span>
                </div>
                <div className="flex justify-between items-center text-sm sm:text-base">
                  <span className="font-body-md text-on-surface-variant">Avg. Purchase Price</span>
                  <span className="font-data-mono font-bold text-on-surface">0.68 USDC</span>
                </div>
                <div className="h-px bg-outline-variant/30"></div>
                <div className="flex justify-between items-center">
                  <span className="font-body-md text-sm sm:text-base text-on-surface-variant">Potential Payout</span>
                  <div className="text-right">
                    <span className="font-data-mono font-bold text-secondary text-sm sm:text-base">{potentialPayout.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC</span>
                    <span className="block text-[10px] text-secondary font-bold">+47.06% Return</span>
                  </div>
                </div>
              </div>

              {/* Reasoning Insight (Subtle AI Branding) */}
              <div className="bg-tertiary/5 border border-tertiary/10 rounded-lg p-3 flex gap-3">
                <span className="material-symbols-outlined text-tertiary text-lg flex-shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>insights</span>
                <p className="font-body-md text-[12px] sm:text-[13px] text-on-surface-variant leading-tight">
                  <span className="font-bold text-tertiary">Oracle Insight:</span> Market sentiment has shifted 4% toward &apos;NO&apos; in the last hour following the latest legislative session report.
                </p>
              </div>

              {/* Action Button */}
              <button className="w-full bg-tertiary text-white py-3 sm:py-4 rounded-lg font-headline-sm text-lg sm:text-headline-sm hover:bg-tertiary-container active:scale-[0.98] transition-all shadow-lg shadow-tertiary/20 flex items-center justify-center gap-2">
                <span>BUY NO</span>
                <span className="material-symbols-outlined text-xl">trending_down</span>
              </button>
              <p className="text-center font-label-caps text-[9px] sm:text-[10px] text-on-surface-variant uppercase tracking-tighter">
                Orders are final and cannot be cancelled once executed on-chain.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Footer Shell */}
      <footer className="bg-surface-container-low dark:bg-on-background border-t border-outline-variant dark:border-outline fixed bottom-0 w-full z-40">
        <div className="flex flex-col md:flex-row justify-between items-center w-full py-4 px-gutter max-w-container-max-width mx-auto gap-4">
          <span className="font-label-caps text-label-caps font-black text-on-surface-variant">ORACLEDESK INSTITUTIONAL</span>
          <div className="hidden sm:flex gap-6">
            <Link className="font-body-md text-body-md text-on-surface-variant dark:text-surface-variant hover:text-primary transition-colors" href="#">System Status</Link>
            <Link className="font-body-md text-body-md text-on-surface-variant dark:text-surface-variant hover:text-primary transition-colors" href="#">API Docs</Link>
            <Link className="font-body-md text-body-md text-on-surface-variant dark:text-surface-variant hover:text-primary transition-colors" href="#">Legal</Link>
          </div>
          <span className="font-body-md text-body-md text-on-surface-variant text-[12px]">© 2026 OracleDesk Institutional.</span>
        </div>
      </footer>
    </div>
  );
}
