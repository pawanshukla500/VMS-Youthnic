import React from 'react';

export default function Support() {
  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <header className="bg-surface-container-lowest flex items-center px-gutter py-3 min-h-[64px] border-b border-border-subtle shrink-0">
        <h2 className="font-headline-1 text-headline-1 font-bold text-on-background">Support</h2>
      </header>
      <main className="flex-1 p-gutter overflow-y-auto">
        <div className="bg-surface-card border border-border-subtle rounded-lg p-6 shadow-sm max-w-3xl">
          <h3 className="font-headline-2 text-headline-2 mb-4">Operational Checklist</h3>
          <div className="space-y-3 text-on-surface">
            <p>Camera access requires Chrome or Edge permission for this local site.</p>
            <p>Queued recordings stay in IndexedDB until Firebase upload and backend metadata save both succeed.</p>
            <p>Use System Health to verify database and Firebase Storage access.</p>
          </div>
        </div>
      </main>
    </div>
  );
}
