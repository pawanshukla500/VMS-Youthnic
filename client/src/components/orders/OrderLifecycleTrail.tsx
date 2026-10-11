import React, { useState, useMemo } from 'react';
import toast from 'react-hot-toast';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CornerDownLeft,
  CreditCard,
  ExternalLink,
  Eye,
  GitCommit,
  HelpCircle,
  Info,
  PackageCheck,
  PackageX,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  Sliders,
  Sparkles,
  Split,
  Truck,
  Workflow,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  evaluateOrderLifecycle,
  LIFECYCLE_NODES,
  LIFECYCLE_EDGES,
  MOCK_LIFECYCLE_SCENARIOS,
  OrderInputState,
  LifecycleEvaluationResult,
  LifecycleNode,
} from '../../utils/orderLifecycle';
import { PaymentGatewayBadge, CarrierBadge } from '../LogisticsBadges';
import { PAYMENT_GATEWAY_REGISTRY, CARRIER_REGISTRY } from '../../utils/logisticsLogos';

interface OrderLifecycleTrailProps {
  order?: OrderInputState;
  showScenarioWorkbench?: boolean;
  className?: string;
  defaultView?: 'trail' | 'map' | 'workbench';
}

export function OrderLifecycleTrail({
  order: propOrder,
  showScenarioWorkbench = true,
  className = '',
  defaultView = 'trail',
}: OrderLifecycleTrailProps) {
  const [selectedScenarioKey, setSelectedScenarioKey] = useState<string>('PREPAID_PHONEPE_SETTLED');
  const [customOrder, setCustomOrder] = useState<OrderInputState | null>(null);
  const [viewMode, setViewMode] = useState<'trail' | 'map' | 'workbench'>(defaultView);
  const [selectedNodeDetails, setSelectedNodeDetails] = useState<LifecycleNode | null>(null);
  const [copiedText, setCopiedText] = useState<string | null>(null);

  // Active order is either propOrder (if passed and no workbench override), customOrder, or selectedScenario
  const activeOrder: OrderInputState = useMemo(() => {
    if (customOrder) return customOrder;
    if (propOrder) return propOrder;
    return MOCK_LIFECYCLE_SCENARIOS[selectedScenarioKey]?.order || MOCK_LIFECYCLE_SCENARIOS.PREPAID_PHONEPE_SETTLED.order;
  }, [propOrder, customOrder, selectedScenarioKey]);

  // Evaluate order state through the lifecycle state machine
  const evaluation: LifecycleEvaluationResult = useMemo(() => {
    return evaluateOrderLifecycle(activeOrder);
  }, [activeOrder]);

  const copyValue = (val: string, label: string) => {
    navigator.clipboard.writeText(val);
    setCopiedText(label);
    toast.success(`Copied ${label} to clipboard`);
    setTimeout(() => setCopiedText(null), 2000);
  };

  const handleActionClick = (action: { id: string; label: string; description: string }) => {
    toast.success(`Action Triggered: ${action.label}`, {
      icon: '⚡',
      duration: 3500,
    });
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Top Banner & Control Bar */}
      <div className="bg-white border border-border-subtle rounded-2xl p-5 shadow-2xs">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-primary/10 text-primary border border-primary/20">
                <Workflow className="w-3.5 h-3.5" />
                Order Workflow Trail
              </span>

              {/* Status Badge */}
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold border ${
                  evaluation.stateVariant === 'success'
                    ? 'bg-success/10 text-success border-success/20'
                    : evaluation.stateVariant === 'error'
                    ? 'bg-critical/10 text-critical border-critical/20'
                    : evaluation.stateVariant === 'purple'
                    ? 'bg-accent/10 text-accent border-accent/20'
                    : evaluation.stateVariant === 'neutral'
                    ? 'bg-surface-container text-secondary border-border-subtle'
                    : 'bg-primary/10 text-primary border-primary/20'
                }`}
              >
                <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                {evaluation.stateLabel}
              </span>

              {/* Progress Chip */}
              <span className="text-[11px] font-mono font-medium text-secondary tabular-nums">
                {evaluation.progressPercent}% lifecycle traversed
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-headline font-bold text-lg text-on-surface">
                Order #{activeOrder.orderNumber || activeOrder.orderId}
              </h3>

              <div className="flex items-center gap-2">
                {/* Brandfetch Payment Gateway Badge */}
                <PaymentGatewayBadge
                  gatewayCode={activeOrder.paymentGateway}
                  paymentMethod={activeOrder.paymentMode}
                  variant="full"
                  linkable={true}
                  size="sm"
                />

                {/* Delhivery Carrier Badge */}
                <CarrierBadge
                  trackingId={activeOrder.trackingId || '1490842015571145'}
                  carrierCode={activeOrder.carrierCode || 'delhivery'}
                  linkable={true}
                  size="sm"
                />
              </div>

              {activeOrder.totalAmount && (
                <span className="font-mono text-xs font-bold text-on-surface bg-surface-container-low px-2 py-0.5 rounded border border-border-subtle tabular-nums">
                  ₹{activeOrder.totalAmount.toLocaleString('en-IN')}
                </span>
              )}
            </div>
          </div>

          {/* View Mode Toggle Buttons */}
          <div className="flex items-center gap-1 bg-surface-container-low p-1 rounded-xl border border-border-subtle self-start lg:self-auto">
            <button
              type="button"
              onClick={() => setViewMode('trail')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                viewMode === 'trail'
                  ? 'bg-white text-primary shadow-2xs font-bold'
                  : 'text-secondary hover:text-on-surface'
              }`}
            >
              <GitCommit className="w-3.5 h-3.5" />
              Audit Trail
            </button>

            <button
              type="button"
              onClick={() => setViewMode('map')}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                viewMode === 'map'
                  ? 'bg-white text-primary shadow-2xs font-bold'
                  : 'text-secondary hover:text-on-surface'
              }`}
            >
              <Workflow className="w-3.5 h-3.5" />
              Workflow Map
            </button>

            {showScenarioWorkbench && (
              <button
                type="button"
                onClick={() => setViewMode('workbench')}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all ${
                  viewMode === 'workbench'
                    ? 'bg-white text-primary shadow-2xs font-bold'
                    : 'text-secondary hover:text-on-surface'
                }`}
              >
                <Sliders className="w-3.5 h-3.5" />
                State Workbench
              </button>
            )}
          </div>
        </div>

        {/* Suggested Next Operational Actions Bar */}
        {evaluation.suggestedActions.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border-subtle flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-surface-bg/50 p-3 rounded-xl">
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary shrink-0" />
              <span className="text-xs font-semibold text-on-surface">Suggested Operator Action:</span>
              <span className="text-xs text-secondary hidden md:inline">
                {evaluation.suggestedActions[0].description}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {evaluation.suggestedActions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => handleActionClick(action)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 active:scale-[0.98] cursor-pointer shadow-2xs ${
                    action.actionType === 'critical'
                      ? 'bg-critical text-white hover:bg-critical/90'
                      : action.actionType === 'secondary'
                      ? 'bg-white text-on-surface border border-border-heavy hover:border-primary/40'
                      : 'bg-primary text-white hover:bg-primary/90'
                  }`}
                >
                  <Play className="w-3 h-3 fill-current" />
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* VIEW 1: Step-by-Step Audit Trail */}
      {viewMode === 'trail' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Visual Stepper (2 Cols) */}
          <div className="lg:col-span-2 bg-white border border-border-subtle rounded-2xl p-6 shadow-2xs">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h4 className="font-headline font-bold text-base text-on-surface">
                  Execution Milestones & Event Log
                </h4>
                <p className="text-secondary text-xs mt-0.5">
                  Chronological lifecycle progression from store order creation to financial settlement
                </p>
              </div>
              <span className="text-xs font-mono text-secondary tabular-nums">
                {evaluation.auditEvents.length} events logged
              </span>
            </div>

            <div className="relative pl-6 space-y-6 before:absolute before:left-2.5 before:top-3 before:bottom-3 before:w-0.5 before:bg-border-subtle">
              {evaluation.auditEvents.map((evt, idx) => {
                const isCurrent = evt.nodeId === evaluation.currentNodeId;
                const node = LIFECYCLE_NODES[evt.nodeId];

                return (
                  <div key={idx} className="relative group">
                    {/* Stepper Dot */}
                    <div
                      className={`absolute -left-6 top-1 w-5 h-5 rounded-full flex items-center justify-center border-2 transition-all ${
                        isCurrent
                          ? 'bg-primary border-white ring-4 ring-primary/20 text-white scale-110'
                          : 'bg-white border-primary text-primary'
                      }`}
                    >
                      {isCurrent ? (
                        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                      ) : (
                        <Check className="w-3 h-3 stroke-[3]" />
                      )}
                    </div>

                    <div
                      className={`p-4 rounded-xl border transition-all ${
                        isCurrent
                          ? 'bg-primary/5 border-primary/40 shadow-xs'
                          : 'bg-white border-border-subtle hover:border-primary/20'
                      }`}
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-headline font-bold text-sm text-on-surface">
                            {evt.title}
                          </span>
                          {isCurrent && (
                            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-primary text-white uppercase tracking-wider">
                              Active State
                            </span>
                          )}
                        </div>
                        <span className="font-mono text-[11px] text-secondary tabular-nums">
                          {new Date(evt.timestamp).toLocaleString('en-IN', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </div>

                      <p className="text-secondary text-xs leading-relaxed mb-3">
                        {evt.description}
                      </p>

                      <div className="flex flex-wrap items-center gap-3 text-[11px] text-secondary border-t border-border-subtle/70 pt-2.5">
                        <span className="flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3 text-primary" />
                          System: <strong className="text-on-surface font-medium">{evt.system}</strong>
                        </span>
                        <span className="text-border-subtle">•</span>
                        <span>
                          Actor: <strong className="text-on-surface font-medium">{evt.actor}</strong>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Operational Details Card (1 Col) */}
          <div className="space-y-6">
            {/* Payment Verification Card */}
            <div className="bg-white border border-border-subtle rounded-2xl p-5 shadow-2xs space-y-4">
              <div className="flex items-center justify-between">
                <h5 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-primary" />
                  Payment Verification
                </h5>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold uppercase bg-surface-container-low text-secondary border border-border-subtle">
                  {activeOrder.paymentMode.toUpperCase()}
                </span>
              </div>

              {activeOrder.paymentMode === 'prepaid' ? (
                <div className="space-y-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Gateway Provider:</span>
                    <PaymentGatewayBadge
                      gatewayCode={activeOrder.paymentGateway}
                      variant="full"
                      linkable={true}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Authorization:</span>
                    <span
                      className={`font-semibold ${
                        activeOrder.paymentSuccessful !== false ? 'text-success' : 'text-critical'
                      }`}
                    >
                      {activeOrder.paymentSuccessful !== false ? 'Captured & Verified' : 'Failed / Abandoned'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Settlement Cycle:</span>
                    <span className="font-mono text-on-surface font-medium">
                      {evaluation.paymentGateway?.settlementCycle || 'T+1 Days'}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">COD Confirmation:</span>
                    <span
                      className={`font-semibold ${
                        activeOrder.codConfirmed !== false ? 'text-success' : 'text-warning'
                      }`}
                    >
                      {activeOrder.codConfirmed !== false ? 'Buyer Confirmed' : 'Awaiting OTP'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-secondary">Cash Remittance:</span>
                    <span className="font-medium text-on-surface">
                      {activeOrder.delhiveryRemittanceVerified ? 'Remitted to Bank' : 'Pending Delivery'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Courier Logistics Card */}
            <div className="bg-white border border-border-subtle rounded-2xl p-5 shadow-2xs space-y-4">
              <div className="flex items-center justify-between">
                <h5 className="font-headline font-bold text-sm text-on-surface flex items-center gap-2">
                  <Truck className="w-4 h-4 text-primary" />
                  Logistics & Tracking
                </h5>
                <CarrierBadge
                  trackingId={activeOrder.trackingId}
                  carrierCode={activeOrder.carrierCode || 'delhivery'}
                />
              </div>

              <div className="space-y-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-secondary">Delhivery AWB:</span>
                  <div className="flex items-center gap-1">
                    <span className="font-mono font-bold text-on-surface tabular-nums">
                      {activeOrder.trackingId || '1490842015571145'}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyValue(activeOrder.trackingId || '1490842015571145', 'AWB')}
                      className="text-secondary hover:text-primary p-0.5"
                      title="Copy AWB"
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-secondary">Shipment Outcome:</span>
                  <span className="font-semibold text-on-surface capitalize">
                    {activeOrder.shipmentOutcome || (activeOrder.isDispatched ? 'In Transit' : 'Manifested')}
                  </span>
                </div>

                <div className="pt-2 border-t border-border-subtle">
                  <a
                    href={
                      evaluation.carrier?.trackingUrl(activeOrder.trackingId || '1490842015571145') ||
                      'https://www.delhivery.com'
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="w-full py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-primary font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors"
                  >
                    Track on Delhivery Portal <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: Interactive Workflow Map */}
      {viewMode === 'map' && (
        <div className="bg-white border border-border-subtle rounded-2xl p-6 shadow-2xs space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 className="font-headline font-bold text-base text-on-surface">
                Order Lifecycle State Machine Map
              </h4>
              <p className="text-secondary text-xs mt-0.5">
                Full 38-node flowchart graph representation. Traversed nodes highlighted in primary blue.
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-primary" /> Traversed
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-primary ring-2 ring-primary/30 animate-pulse" /> Current
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full bg-surface-container border border-border-subtle" /> Pending
              </span>
            </div>
          </div>

          {/* Node Clusters Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.values(LIFECYCLE_NODES).map((node) => {
              const isVisited = evaluation.visitedNodeIds.includes(node.id);
              const isCurrent = evaluation.currentNodeId === node.id;

              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedNodeDetails(node)}
                  className={`p-4 rounded-xl border transition-all cursor-pointer relative ${
                    isCurrent
                      ? 'bg-primary/10 border-primary shadow-sm ring-2 ring-primary/20'
                      : isVisited
                      ? 'bg-white border-primary/40 shadow-2xs hover:border-primary'
                      : 'bg-surface-bg/40 border-border-subtle opacity-60 hover:opacity-100 hover:bg-white'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-bold font-mono uppercase tracking-wider ${
                        node.category === 'inflow'
                          ? 'bg-sky-500/10 text-sky-700'
                          : node.category === 'payment'
                          ? 'bg-indigo-500/10 text-indigo-700'
                          : node.category === 'dispatch'
                          ? 'bg-amber-500/10 text-amber-700'
                          : node.category === 'logistics'
                          ? 'bg-blue-500/10 text-blue-700'
                          : node.category === 'rto'
                          ? 'bg-orange-500/10 text-orange-700'
                          : node.category === 'returns'
                          ? 'bg-purple-500/10 text-purple-700'
                          : node.category === 'settlement'
                          ? 'bg-emerald-500/10 text-emerald-700'
                          : 'bg-surface-container text-secondary'
                      }`}
                    >
                      {node.category}
                    </span>

                    {isCurrent ? (
                      <span className="flex h-2.5 w-2.5 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary"></span>
                      </span>
                    ) : isVisited ? (
                      <CheckCircle2 className="w-4 h-4 text-primary" />
                    ) : null}
                  </div>

                  <h5 className="font-headline font-bold text-xs text-on-surface mb-1">
                    {node.label}
                  </h5>
                  <p className="text-secondary text-[11px] line-clamp-2 leading-relaxed">
                    {node.description}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Node detail drawer modal if clicked */}
          {selectedNodeDetails && (
            <div className="p-4 rounded-xl bg-surface-container-low border border-border-heavy flex items-center justify-between gap-4">
              <div>
                <span className="text-[10px] font-mono font-bold uppercase text-primary">
                  Node Inspector: {selectedNodeDetails.id}
                </span>
                <h5 className="font-headline font-bold text-sm text-on-surface">
                  {selectedNodeDetails.label}
                </h5>
                <p className="text-secondary text-xs mt-0.5">{selectedNodeDetails.description}</p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedNodeDetails(null)}
                className="px-3 py-1.5 rounded-lg bg-white border border-border-subtle text-xs font-semibold hover:border-primary/40 text-on-surface transition-colors"
              >
                Close Inspector
              </button>
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: State Machine Workbench (Pattern from state-machine skill) */}
      {viewMode === 'workbench' && showScenarioWorkbench && (
        <div className="bg-white border border-border-subtle rounded-2xl p-6 shadow-2xs space-y-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sliders className="w-4 h-4 text-primary" />
              <h4 className="font-headline font-bold text-base text-on-surface">
                Interactive State Machine Workbench
              </h4>
            </div>
            <p className="text-secondary text-xs">
              Test and simulate all 9 branches of the order workflow state machine with 1 click.
            </p>
          </div>

          {/* Scenario Grid Switcher */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Object.entries(MOCK_LIFECYCLE_SCENARIOS).map(([key, item]) => {
              const isSelected = selectedScenarioKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setSelectedScenarioKey(key);
                    setCustomOrder(null);
                    toast.success(`Switched to scenario: ${item.name}`);
                  }}
                  className={`text-left p-4 rounded-xl border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-primary/5 border-primary shadow-xs ring-2 ring-primary/20'
                      : 'bg-white border-border-subtle hover:border-primary/30 hover:bg-surface-bg/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-headline font-bold text-xs text-on-surface line-clamp-1">
                      {item.name}
                    </span>
                    {isSelected && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                  </div>
                  <p className="text-secondary text-[11px] leading-relaxed line-clamp-2">
                    {item.description}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Scenario Inspector Summary */}
          <div className="p-4 rounded-xl bg-surface-container-low border border-border-subtle space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-on-surface uppercase tracking-wider">
                Scenario JSON Parameters
              </span>
              <button
                type="button"
                onClick={() => copyValue(JSON.stringify(activeOrder, null, 2), 'Scenario JSON')}
                className="text-xs font-medium text-primary hover:underline flex items-center gap-1"
              >
                <Copy className="w-3 h-3" /> Copy JSON
              </button>
            </div>
            <pre className="font-mono text-xs bg-white p-3 rounded-lg border border-border-subtle overflow-x-auto text-on-surface">
              {JSON.stringify(activeOrder, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
