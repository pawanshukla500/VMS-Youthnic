import React from 'react';
import { PageHeader, Card, CardHeader, StatusBadge } from '../components/ui';

const CHECKLIST = [
  {
    icon: 'videocam',
    title: 'Camera access',
    text: 'Camera access requires Chrome or Edge permission for this local site.',
  },
  {
    icon: 'cloud_upload',
    title: 'Queued recordings',
    text: 'Queued recordings stay in IndexedDB until Firebase upload and backend metadata save both succeed.',
  },
  {
    icon: 'monitor_heart',
    title: 'System Health',
    text: 'Use System Health to verify database and Firebase Storage access.',
  },
];

export default function Support() {
  return (
    <div className="flex-1 flex flex-col min-h-screen bg-surface-bg">
      <PageHeader
        title="Support"
        description="Day-to-day operating notes for packing stations."
        actions={<StatusBadge status="active" />}
      />
      <main className="flex-1 p-gutter overflow-y-auto">
        <div className="max-w-3xl space-y-6">
          <Card>
            <CardHeader
              icon="checklist"
              title="Operational Checklist"
              description="Keep these three checks green on every station."
            />
            <ul className="divide-y divide-border-subtle">
              {CHECKLIST.map((item) => (
                <li key={item.title} className="p-5 flex items-start gap-3 hover:bg-surface-container-low transition-colors">
                  <span className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <span className="material-symbols-outlined">{item.icon}</span>
                  </span>
                  <div className="min-w-0">
                    <p className="font-headline-2 text-headline-2 text-on-surface">{item.title}</p>
                    <p className="font-body-sm text-body-sm text-secondary mt-1">{item.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card>
            <CardHeader
              icon="help"
              title="Still stuck?"
              description="Re-check camera permissions, then verify backend access."
            />
            <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-3 text-body-sm text-secondary">
              <span className="inline-flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-container-low px-3 py-2 text-on-surface">
                <span className="material-symbols-outlined text-sm text-primary">info</span>
                Open System Health from the sidebar to run a connectivity check.
              </span>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
