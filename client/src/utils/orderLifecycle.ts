/**
 * Order Lifecycle State Machine & Workflow Trail Engine
 * Models the complete 38-node e-commerce order lifecycle:
 * - Prepaid payment gateway verification (GoKwik / Easebuzz / PhonePe) vs COD confirmation
 * - Pre-dispatch cancellations & instant automated refunds
 * - Warehouse pick / pack / dispatch
 * - Delhivery courier tracking & delivery vs RTO reconciliation
 * - COD courier remittance vs Prepaid gateway settlement
 * - Customer returns, warehouse QC inspection, and refund processing
 */

import {
  detectPaymentGateway,
  detectCarrier,
  getPaymentGateway,
  PaymentGatewayBrand,
  CarrierBrand,
  PAYMENT_GATEWAY_REGISTRY,
  CARRIER_REGISTRY,
} from './logisticsLogos';

export type LifecycleNodeCategory =
  | 'inflow'
  | 'payment'
  | 'dispatch'
  | 'logistics'
  | 'settlement'
  | 'rto'
  | 'returns'
  | 'cancellation'
  | 'terminal';

export type LifecycleNodeType = 'action' | 'decision' | 'terminal';

export interface LifecycleNode {
  id: string;
  label: string;
  category: LifecycleNodeCategory;
  type: LifecycleNodeType;
  description: string;
  iconName: string;
  stepNumber?: number;
}

export interface LifecycleEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
  isPositive?: boolean;
}

export interface OrderLifecycleAuditTrailEvent {
  nodeId: string;
  timestamp: string;
  title: string;
  description: string;
  actor: string;
  system: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface OrderInputState {
  orderId: string;
  orderNumber?: string;
  paymentMode: 'prepaid' | 'cod';
  paymentGateway?: 'gokwik' | 'easebuzz' | 'phonepe' | 'razorpay' | 'cashfree' | 'paytm' | string;
  paymentSuccessful?: boolean;
  codConfirmed?: boolean;
  cancelledBeforeDispatch?: boolean;
  paymentCaptured?: boolean;
  cancelRefundInitiated?: boolean;
  cancelRefundVerified?: boolean;
  isDispatched?: boolean;
  trackingId?: string;
  carrierCode?: string;
  shipmentOutcome?: 'in_transit' | 'delivered' | 'rto';
  rtoReceived?: boolean;
  rtoRefundInitiated?: boolean;
  rtoRefundVerified?: boolean;
  delhiveryRemittanceVerified?: boolean;
  gatewaySettlementVerified?: boolean;
  returnRequested?: boolean;
  returnInTransit?: boolean;
  warehouseQcPassed?: boolean;
  returnRefundInitiated?: boolean;
  returnRefundVerified?: boolean;
  createdAt?: string;
  totalAmount?: number;
}

export interface LifecycleEvaluationResult {
  currentNodeId: string;
  currentNode: LifecycleNode;
  visitedNodeIds: string[];
  activeCategory: LifecycleNodeCategory;
  stateLabel: string;
  stateVariant: 'success' | 'warning' | 'error' | 'info' | 'purple' | 'neutral';
  paymentGateway: PaymentGatewayBrand | null;
  carrier: CarrierBrand | null;
  auditEvents: OrderLifecycleAuditTrailEvent[];
  suggestedActions: Array<{
    id: string;
    label: string;
    description: string;
    actionType: 'primary' | 'secondary' | 'critical';
  }>;
  progressPercent: number;
}

/**
 * All 38 Lifecycle Nodes from the official workflow diagram
 */
export const LIFECYCLE_NODES: Record<string, LifecycleNode> = {
  // Inflow
  A_NEW_ORDER: {
    id: 'A_NEW_ORDER',
    label: 'New Order Received',
    category: 'inflow',
    type: 'action',
    description: 'Order placed on marketplace / storefront and received by system.',
    iconName: 'ShoppingBag',
    stepNumber: 1,
  },
  B_CREATE_TRAIL: {
    id: 'B_CREATE_TRAIL',
    label: 'Create Order Trail',
    category: 'inflow',
    type: 'action',
    description: 'Order audit trail initialized with timestamp and idempotency key.',
    iconName: 'GitCommit',
    stepNumber: 2,
  },
  C_DECISION_PAYMENT_MODE: {
    id: 'C_DECISION_PAYMENT_MODE',
    label: 'Payment Mode?',
    category: 'payment',
    type: 'decision',
    description: 'Determine order payment rail: Prepaid online vs Cash on Delivery (COD).',
    iconName: 'CreditCard',
    stepNumber: 3,
  },

  // Prepaid Verification
  D_VERIFY_PAYMENT: {
    id: 'D_VERIFY_PAYMENT',
    label: 'Verify Payment: GoKwik / Easebuzz / PhonePe',
    category: 'payment',
    type: 'action',
    description: 'Query gateway webhook / API to confirm settlement authorization.',
    iconName: 'ShieldCheck',
    stepNumber: 4,
  },
  F_DECISION_PAYMENT_SUCCESS: {
    id: 'F_DECISION_PAYMENT_SUCCESS',
    label: 'Payment Successful?',
    category: 'payment',
    type: 'decision',
    description: 'Check if payment gateway webhook confirms captured payment.',
    iconName: 'HelpCircle',
    stepNumber: 5,
  },
  G_PAYMENT_FAILED: {
    id: 'G_PAYMENT_FAILED',
    label: 'Pending / Failed Payment',
    category: 'payment',
    type: 'terminal',
    description: 'Payment authorization failed or abandoned. Order flagged pending.',
    iconName: 'AlertTriangle',
    stepNumber: 6,
  },

  // COD Branch
  E_COD_CONFIRMATION: {
    id: 'E_COD_CONFIRMATION',
    label: 'COD Order Confirmation',
    category: 'payment',
    type: 'action',
    description: 'Send WhatsApp / SMS OTP verification to prevent fake / fraudulent orders.',
    iconName: 'MessageSquare',
    stepNumber: 4,
  },
  I_DECISION_CUSTOMER_CONFIRMS: {
    id: 'I_DECISION_CUSTOMER_CONFIRMS',
    label: 'Customer Confirms?',
    category: 'payment',
    type: 'decision',
    description: 'Validate customer response or automated confirmation bot status.',
    iconName: 'UserCheck',
    stepNumber: 5,
  },
  J_CANCEL_BEFORE_DISPATCH_COD: {
    id: 'J_CANCEL_BEFORE_DISPATCH_COD',
    label: 'Cancel Before Dispatch',
    category: 'cancellation',
    type: 'terminal',
    description: 'Unconfirmed COD order cancelled before picking. No financial refund needed.',
    iconName: 'XCircle',
    stepNumber: 6,
  },

  // Processing & Pre-dispatch Cancellation
  H_READY_FOR_PROCESSING: {
    id: 'H_READY_FOR_PROCESSING',
    label: 'Ready for Processing',
    category: 'dispatch',
    type: 'action',
    description: 'Order validated, payment confirmed, allocated to warehouse pick queue.',
    iconName: 'CheckCircle2',
    stepNumber: 7,
  },
  K_DECISION_CANCELLED_PRE_DISPATCH: {
    id: 'K_DECISION_CANCELLED_PRE_DISPATCH',
    label: 'Cancelled Before Dispatch?',
    category: 'cancellation',
    type: 'decision',
    description: 'Check if buyer cancelled order or inventory out-of-stock occurred.',
    iconName: 'HelpCircle',
    stepNumber: 8,
  },
  L_DECISION_PAYMENT_CAPTURED: {
    id: 'L_DECISION_PAYMENT_CAPTURED',
    label: 'Payment Captured?',
    category: 'cancellation',
    type: 'decision',
    description: 'Was money received from customer prior to cancellation?',
    iconName: 'DollarSign',
    stepNumber: 9,
  },
  M_INITIATE_AUTO_REFUND_PRE: {
    id: 'M_INITIATE_AUTO_REFUND_PRE',
    label: 'Initiate Automatic Refund',
    category: 'cancellation',
    type: 'action',
    description: 'Trigger instant refund API via Easebuzz / GoKwik / PhonePe gateway.',
    iconName: 'RotateCcw',
    stepNumber: 10,
  },
  O_VERIFY_REFUND_SUCCESS_PRE: {
    id: 'O_VERIFY_REFUND_SUCCESS_PRE',
    label: 'Verify Refund Success',
    category: 'cancellation',
    type: 'action',
    description: 'Gateway refund ARN reference confirmed and posted to ledger.',
    iconName: 'CheckCheck',
    stepNumber: 11,
  },
  N_CLOSE_CANCELLED_ORDER: {
    id: 'N_CLOSE_CANCELLED_ORDER',
    label: 'Close Cancelled Order',
    category: 'terminal',
    type: 'terminal',
    description: 'Order fully closed with zero open liabilities.',
    iconName: 'Archive',
    stepNumber: 12,
  },

  // Fulfillment & Logistics
  P_PICK_PACK_DISPATCH: {
    id: 'P_PICK_PACK_DISPATCH',
    label: 'Pick / Pack / Dispatch',
    category: 'dispatch',
    type: 'action',
    description: 'Warehouse barcode scan, parcel packing video capture, and handover to carrier.',
    iconName: 'PackageCheck',
    stepNumber: 9,
  },
  Q_DELHIVERY_TRACKING: {
    id: 'Q_DELHIVERY_TRACKING',
    label: 'Delhivery Tracking',
    category: 'logistics',
    type: 'action',
    description: 'Real-time Delhivery tracking webhook sync across transit hubs.',
    iconName: 'Truck',
    stepNumber: 10,
  },
  R_DECISION_SHIPMENT_OUTCOME: {
    id: 'R_DECISION_SHIPMENT_OUTCOME',
    label: 'Shipment Outcome?',
    category: 'logistics',
    type: 'decision',
    description: 'Courier outcome: Delivered to customer vs Return-to-Origin (RTO).',
    iconName: 'MapPin',
    stepNumber: 11,
  },

  // RTO Path
  T_RTO_RECEIVED: {
    id: 'T_RTO_RECEIVED',
    label: 'RTO Received & Reconciled',
    category: 'rto',
    type: 'action',
    description: 'Undelivered parcel returned to warehouse, barcode scanned, inventory restored.',
    iconName: 'PackageX',
    stepNumber: 12,
  },
  U_DECISION_RTO_PREPAID: {
    id: 'U_DECISION_RTO_PREPAID',
    label: 'Prepaid?',
    category: 'rto',
    type: 'decision',
    description: 'Determine if customer already paid online for this RTO order.',
    iconName: 'CreditCard',
    stepNumber: 13,
  },
  V_INITIATE_AUTO_REFUND_RTO: {
    id: 'V_INITIATE_AUTO_REFUND_RTO',
    label: 'Initiate Automatic Refund',
    category: 'rto',
    type: 'action',
    description: 'Initiate automated refund for prepaid RTO order to original payment method.',
    iconName: 'RotateCcw',
    stepNumber: 14,
  },
  X_VERIFY_REFUND_SUCCESS_RTO: {
    id: 'X_VERIFY_REFUND_SUCCESS_RTO',
    label: 'Verify Refund Success',
    category: 'rto',
    type: 'action',
    description: 'Confirm gateway refund success ARN and notify customer.',
    iconName: 'CheckCheck',
    stepNumber: 15,
  },
  W_CLOSE_COD_RTO: {
    id: 'W_CLOSE_COD_RTO',
    label: 'Close COD RTO',
    category: 'terminal',
    type: 'terminal',
    description: 'Uncollected COD shipment closed. Inventory restocked with freight fee recorded.',
    iconName: 'Archive',
    stepNumber: 14,
  },
  Y_CLOSE_RTO_COMPLETED: {
    id: 'Y_CLOSE_RTO_COMPLETED',
    label: 'Close RTO Completed',
    category: 'terminal',
    type: 'terminal',
    description: 'Prepaid RTO fully reconciled and refunded to customer.',
    iconName: 'CheckCircle2',
    stepNumber: 16,
  },

  // Delivered Path & Financial Reconciliation
  S_DECISION_DELIVERED_PAYMENT_MODE: {
    id: 'S_DECISION_DELIVERED_PAYMENT_MODE',
    label: 'Payment Mode?',
    category: 'settlement',
    type: 'decision',
    description: 'Split financial settlement validation by COD remittance vs Gateway payout.',
    iconName: 'Split',
    stepNumber: 12,
  },
  Z_VERIFY_DELHIVERY_REMITTANCE: {
    id: 'Z_VERIFY_DELHIVERY_REMITTANCE',
    label: 'Verify Delhivery Remittance',
    category: 'settlement',
    type: 'action',
    description: 'Reconcile Delhivery cash collected against bank remittance reports.',
    iconName: 'Landmark',
    stepNumber: 13,
  },
  AA_VERIFY_GATEWAY_SETTLEMENT: {
    id: 'AA_VERIFY_GATEWAY_SETTLEMENT',
    label: 'Verify Gateway Settlement',
    category: 'settlement',
    type: 'action',
    description: 'Reconcile gateway nodal settlement account (GoKwik / Easebuzz / PhonePe).',
    iconName: 'Building2',
    stepNumber: 13,
  },
  AB_COD_FINANCIALLY_CLOSED: {
    id: 'AB_COD_FINANCIALLY_CLOSED',
    label: 'COD Financially Closed',
    category: 'settlement',
    type: 'action',
    description: 'Delhivery COD remittance credited to merchant bank account.',
    iconName: 'FileCheck2',
    stepNumber: 14,
  },
  AC_PREPAID_SETTLEMENT_RECONCILED: {
    id: 'AC_PREPAID_SETTLEMENT_RECONCILED',
    label: 'Prepaid Settlement Reconciled',
    category: 'settlement',
    type: 'action',
    description: 'Prepaid payment gateway MDR fee deducted and net amount settled.',
    iconName: 'FileCheck2',
    stepNumber: 14,
  },

  // Returns & QC Check
  AD_DECISION_CUSTOMER_RETURN: {
    id: 'AD_DECISION_CUSTOMER_RETURN',
    label: 'Customer Requests Return?',
    category: 'returns',
    type: 'decision',
    description: 'Did buyer submit return / exchange request within the 7-day window?',
    iconName: 'CornerDownLeft',
    stepNumber: 15,
  },
  AE_ORDER_CLOSED_SETTLED: {
    id: 'AE_ORDER_CLOSED_SETTLED',
    label: 'Order Closed & Settled',
    category: 'terminal',
    type: 'terminal',
    description: 'Order fully delivered, settled, and return window expired. Order complete.',
    iconName: 'Trophy',
    stepNumber: 16,
  },
  AF_RETURN_TRANSIT_TRACKING: {
    id: 'AF_RETURN_TRANSIT_TRACKING',
    label: 'Return Transit Tracking',
    category: 'returns',
    type: 'action',
    description: 'Reverse pickup booked via Delhivery with return AWB tracking.',
    iconName: 'Truck',
    stepNumber: 16,
  },
  AG_WAREHOUSE_RETURN_QC: {
    id: 'AG_WAREHOUSE_RETURN_QC',
    label: 'Warehouse Return QC Check',
    category: 'returns',
    type: 'action',
    description: 'Warehouse returns team inspects garment quality, tags, and packing video.',
    iconName: 'ShieldAlert',
    stepNumber: 17,
  },
  AH_DECISION_QC_PASSED: {
    id: 'AH_DECISION_QC_PASSED',
    label: 'QC Passed / Refund Approved?',
    category: 'returns',
    type: 'decision',
    description: 'Verify if returned item passes quality check or is rejected.',
    iconName: 'HelpCircle',
    stepNumber: 18,
  },
  AI_INITIATE_AUTO_REFUND_RET: {
    id: 'AI_INITIATE_AUTO_REFUND_RET',
    label: 'Initiate Automatic Refund',
    category: 'returns',
    type: 'action',
    description: 'Approve refund payout to customer bank/UPI or store credit.',
    iconName: 'RotateCcw',
    stepNumber: 19,
  },
  AJ_RETURN_REJECTED_DISPUTE: {
    id: 'AJ_RETURN_REJECTED_DISPUTE',
    label: 'Return Rejected / Dispute / Exception',
    category: 'terminal',
    type: 'terminal',
    description: 'Return rejected due to damage or used item. Evidence uploaded.',
    iconName: 'AlertOctagon',
    stepNumber: 19,
  },
  AK_VERIFY_REFUND_SUCCESS_RET: {
    id: 'AK_VERIFY_REFUND_SUCCESS_RET',
    label: 'Verify Refund Success',
    category: 'returns',
    type: 'action',
    description: 'Confirm automated payout confirmation from banking API.',
    iconName: 'CheckCheck',
    stepNumber: 20,
  },
  AL_ORDER_RETURN_CLOSED: {
    id: 'AL_ORDER_RETURN_CLOSED',
    label: 'Order Return Closed',
    category: 'terminal',
    type: 'terminal',
    description: 'Return process fully completed and closed.',
    iconName: 'CheckCircle2',
    stepNumber: 21,
  },
};

/**
 * All Directed Graph Edges matching the Mermaid diagram
 */
export const LIFECYCLE_EDGES: LifecycleEdge[] = [
  { from: 'A_NEW_ORDER', to: 'B_CREATE_TRAIL' },
  { from: 'B_CREATE_TRAIL', to: 'C_DECISION_PAYMENT_MODE' },

  // Payment Mode branch
  { from: 'C_DECISION_PAYMENT_MODE', to: 'D_VERIFY_PAYMENT', label: 'Prepaid', condition: 'prepaid' },
  { from: 'C_DECISION_PAYMENT_MODE', to: 'E_COD_CONFIRMATION', label: 'COD', condition: 'cod' },

  // Prepaid verification
  { from: 'D_VERIFY_PAYMENT', to: 'F_DECISION_PAYMENT_SUCCESS' },
  { from: 'F_DECISION_PAYMENT_SUCCESS', to: 'G_PAYMENT_FAILED', label: 'No', isPositive: false },
  { from: 'F_DECISION_PAYMENT_SUCCESS', to: 'H_READY_FOR_PROCESSING', label: 'Yes', isPositive: true },

  // COD confirmation
  { from: 'E_COD_CONFIRMATION', to: 'I_DECISION_CUSTOMER_CONFIRMS' },
  { from: 'I_DECISION_CUSTOMER_CONFIRMS', to: 'J_CANCEL_BEFORE_DISPATCH_COD', label: 'No', isPositive: false },
  { from: 'I_DECISION_CUSTOMER_CONFIRMS', to: 'H_READY_FOR_PROCESSING', label: 'Yes', isPositive: true },

  // Ready for Processing & Pre-dispatch check
  { from: 'H_READY_FOR_PROCESSING', to: 'K_DECISION_CANCELLED_PRE_DISPATCH' },
  { from: 'K_DECISION_CANCELLED_PRE_DISPATCH', to: 'L_DECISION_PAYMENT_CAPTURED', label: 'Yes', isPositive: false },
  { from: 'K_DECISION_CANCELLED_PRE_DISPATCH', to: 'P_PICK_PACK_DISPATCH', label: 'No', isPositive: true },

  // Pre-dispatch cancellation refund
  { from: 'L_DECISION_PAYMENT_CAPTURED', to: 'M_INITIATE_AUTO_REFUND_PRE', label: 'Yes', isPositive: true },
  { from: 'L_DECISION_PAYMENT_CAPTURED', to: 'N_CLOSE_CANCELLED_ORDER', label: 'No', isPositive: false },
  { from: 'M_INITIATE_AUTO_REFUND_PRE', to: 'O_VERIFY_REFUND_SUCCESS_PRE' },
  { from: 'O_VERIFY_REFUND_SUCCESS_PRE', to: 'N_CLOSE_CANCELLED_ORDER' },

  // Warehouse & Logistics
  { from: 'P_PICK_PACK_DISPATCH', to: 'Q_DELHIVERY_TRACKING' },
  { from: 'Q_DELHIVERY_TRACKING', to: 'R_DECISION_SHIPMENT_OUTCOME' },

  // Outcome: Delivered vs RTO
  { from: 'R_DECISION_SHIPMENT_OUTCOME', to: 'S_DECISION_DELIVERED_PAYMENT_MODE', label: 'Delivered', isPositive: true },
  { from: 'R_DECISION_SHIPMENT_OUTCOME', to: 'T_RTO_RECEIVED', label: 'RTO', isPositive: false },

  // RTO Sub-branch
  { from: 'T_RTO_RECEIVED', to: 'U_DECISION_RTO_PREPAID' },
  { from: 'U_DECISION_RTO_PREPAID', to: 'V_INITIATE_AUTO_REFUND_RTO', label: 'Yes', isPositive: true },
  { from: 'U_DECISION_RTO_PREPAID', to: 'W_CLOSE_COD_RTO', label: 'No', isPositive: false },
  { from: 'V_INITIATE_AUTO_REFUND_RTO', to: 'X_VERIFY_REFUND_SUCCESS_RTO' },
  { from: 'X_VERIFY_REFUND_SUCCESS_RTO', to: 'Y_CLOSE_RTO_COMPLETED' },

  // Delivered Settlement Sub-branch
  { from: 'S_DECISION_DELIVERED_PAYMENT_MODE', to: 'Z_VERIFY_DELHIVERY_REMITTANCE', label: 'COD' },
  { from: 'S_DECISION_DELIVERED_PAYMENT_MODE', to: 'AA_VERIFY_GATEWAY_SETTLEMENT', label: 'Prepaid' },
  { from: 'Z_VERIFY_DELHIVERY_REMITTANCE', to: 'AB_COD_FINANCIALLY_CLOSED' },
  { from: 'AA_VERIFY_GATEWAY_SETTLEMENT', to: 'AC_PREPAID_SETTLEMENT_RECONCILED' },

  // Customer Return Sub-branch
  { from: 'AB_COD_FINANCIALLY_CLOSED', to: 'AD_DECISION_CUSTOMER_RETURN' },
  { from: 'AC_PREPAID_SETTLEMENT_RECONCILED', to: 'AD_DECISION_CUSTOMER_RETURN' },
  { from: 'AD_DECISION_CUSTOMER_RETURN', to: 'AE_ORDER_CLOSED_SETTLED', label: 'No', isPositive: true },
  { from: 'AD_DECISION_CUSTOMER_RETURN', to: 'AF_RETURN_TRANSIT_TRACKING', label: 'Yes', isPositive: false },

  // Return QC & Refund
  { from: 'AF_RETURN_TRANSIT_TRACKING', to: 'AG_WAREHOUSE_RETURN_QC' },
  { from: 'AG_WAREHOUSE_RETURN_QC', to: 'AH_DECISION_QC_PASSED' },
  { from: 'AH_DECISION_QC_PASSED', to: 'AI_INITIATE_AUTO_REFUND_RET', label: 'Yes', isPositive: true },
  { from: 'AH_DECISION_QC_PASSED', to: 'AJ_RETURN_REJECTED_DISPUTE', label: 'No', isPositive: false },
  { from: 'AI_INITIATE_AUTO_REFUND_RET', to: 'AK_VERIFY_REFUND_SUCCESS_RET' },
  { from: 'AK_VERIFY_REFUND_SUCCESS_RET', to: 'AL_ORDER_RETURN_CLOSED' },
];

/**
 * Evaluates the active node, traversed path, and audit events for any order
 */
export function evaluateOrderLifecycle(order: OrderInputState): LifecycleEvaluationResult {
  const visited: string[] = ['A_NEW_ORDER', 'B_CREATE_TRAIL', 'C_DECISION_PAYMENT_MODE'];
  let currentNodeId = 'C_DECISION_PAYMENT_MODE';

  const isPrepaid = order.paymentMode === 'prepaid';
  const resolvedGateway =
    (order.paymentGateway ? getPaymentGateway(order.paymentGateway) : null) ||
    detectPaymentGateway(order.paymentGateway) ||
    PAYMENT_GATEWAY_REGISTRY.gokwik;

  const resolvedCarrier =
    (order.carrierCode ? CARRIER_REGISTRY[order.carrierCode.toLowerCase()] : null) ||
    (order.trackingId ? detectCarrier(order.trackingId) : null) ||
    CARRIER_REGISTRY.delhivery;

  // Branch 1: Payment mode
  if (isPrepaid) {
    visited.push('D_VERIFY_PAYMENT');
    visited.push('F_DECISION_PAYMENT_SUCCESS');

    if (order.paymentSuccessful === false) {
      currentNodeId = 'G_PAYMENT_FAILED';
      visited.push('G_PAYMENT_FAILED');
      return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
    }

    currentNodeId = 'H_READY_FOR_PROCESSING';
    visited.push('H_READY_FOR_PROCESSING');
  } else {
    // COD branch
    visited.push('E_COD_CONFIRMATION');
    visited.push('I_DECISION_CUSTOMER_CONFIRMS');

    if (order.codConfirmed === false) {
      currentNodeId = 'J_CANCEL_BEFORE_DISPATCH_COD';
      visited.push('J_CANCEL_BEFORE_DISPATCH_COD');
      return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
    }

    currentNodeId = 'H_READY_FOR_PROCESSING';
    visited.push('H_READY_FOR_PROCESSING');
  }

  // Pre-dispatch cancellation branch
  visited.push('K_DECISION_CANCELLED_PRE_DISPATCH');

  if (order.cancelledBeforeDispatch) {
    visited.push('L_DECISION_PAYMENT_CAPTURED');
    if (order.paymentCaptured || isPrepaid) {
      visited.push('M_INITIATE_AUTO_REFUND_PRE');
      if (order.cancelRefundVerified) {
        visited.push('O_VERIFY_REFUND_SUCCESS_PRE');
        visited.push('N_CLOSE_CANCELLED_ORDER');
        currentNodeId = 'N_CLOSE_CANCELLED_ORDER';
      } else {
        currentNodeId = 'M_INITIATE_AUTO_REFUND_PRE';
      }
    } else {
      visited.push('N_CLOSE_CANCELLED_ORDER');
      currentNodeId = 'N_CLOSE_CANCELLED_ORDER';
    }
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  // Dispatched branch
  if (!order.isDispatched) {
    currentNodeId = 'H_READY_FOR_PROCESSING';
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  visited.push('P_PICK_PACK_DISPATCH');
  visited.push('Q_DELHIVERY_TRACKING');
  currentNodeId = 'Q_DELHIVERY_TRACKING';

  if (!order.shipmentOutcome || order.shipmentOutcome === 'in_transit') {
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  visited.push('R_DECISION_SHIPMENT_OUTCOME');

  // Outcome: RTO
  if (order.shipmentOutcome === 'rto') {
    visited.push('T_RTO_RECEIVED');
    visited.push('U_DECISION_RTO_PREPAID');

    if (isPrepaid) {
      visited.push('V_INITIATE_AUTO_REFUND_RTO');
      if (order.rtoRefundVerified) {
        visited.push('X_VERIFY_REFUND_SUCCESS_RTO');
        visited.push('Y_CLOSE_RTO_COMPLETED');
        currentNodeId = 'Y_CLOSE_RTO_COMPLETED';
      } else {
        currentNodeId = 'V_INITIATE_AUTO_REFUND_RTO';
      }
    } else {
      visited.push('W_CLOSE_COD_RTO');
      currentNodeId = 'W_CLOSE_COD_RTO';
    }
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  // Outcome: Delivered
  visited.push('S_DECISION_DELIVERED_PAYMENT_MODE');

  if (isPrepaid) {
    visited.push('AA_VERIFY_GATEWAY_SETTLEMENT');
    if (order.gatewaySettlementVerified) {
      visited.push('AC_PREPAID_SETTLEMENT_RECONCILED');
      currentNodeId = 'AC_PREPAID_SETTLEMENT_RECONCILED';
    } else {
      currentNodeId = 'AA_VERIFY_GATEWAY_SETTLEMENT';
      return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
    }
  } else {
    // COD Delivered
    visited.push('Z_VERIFY_DELHIVERY_REMITTANCE');
    if (order.delhiveryRemittanceVerified) {
      visited.push('AB_COD_FINANCIALLY_CLOSED');
      currentNodeId = 'AB_COD_FINANCIALLY_CLOSED';
    } else {
      currentNodeId = 'Z_VERIFY_DELHIVERY_REMITTANCE';
      return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
    }
  }

  // Returns branch
  visited.push('AD_DECISION_CUSTOMER_RETURN');

  if (!order.returnRequested) {
    visited.push('AE_ORDER_CLOSED_SETTLED');
    currentNodeId = 'AE_ORDER_CLOSED_SETTLED';
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  // Customer Return requested
  visited.push('AF_RETURN_TRANSIT_TRACKING');
  visited.push('AG_WAREHOUSE_RETURN_QC');
  visited.push('AH_DECISION_QC_PASSED');

  if (order.warehouseQcPassed === false) {
    visited.push('AJ_RETURN_REJECTED_DISPUTE');
    currentNodeId = 'AJ_RETURN_REJECTED_DISPUTE';
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  if (order.warehouseQcPassed === true) {
    visited.push('AI_INITIATE_AUTO_REFUND_RET');
    if (order.returnRefundVerified) {
      visited.push('AK_VERIFY_REFUND_SUCCESS_RET');
      visited.push('AL_ORDER_RETURN_CLOSED');
      currentNodeId = 'AL_ORDER_RETURN_CLOSED';
    } else {
      currentNodeId = 'AI_INITIATE_AUTO_REFUND_RET';
    }
    return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
  }

  currentNodeId = 'AG_WAREHOUSE_RETURN_QC';
  return buildResult(order, currentNodeId, visited, resolvedGateway, resolvedCarrier);
}

function buildResult(
  order: OrderInputState,
  currentNodeId: string,
  visited: string[],
  gateway: PaymentGatewayBrand | null,
  carrier: CarrierBrand | null
): LifecycleEvaluationResult {
  const currentNode = LIFECYCLE_NODES[currentNodeId] || LIFECYCLE_NODES.A_NEW_ORDER;

  let stateVariant: 'success' | 'warning' | 'error' | 'info' | 'purple' | 'neutral' = 'info';
  if (
    currentNodeId === 'AE_ORDER_CLOSED_SETTLED' ||
    currentNodeId === 'Y_CLOSE_RTO_COMPLETED' ||
    currentNodeId === 'AL_ORDER_RETURN_CLOSED'
  ) {
    stateVariant = 'success';
  } else if (currentNodeId === 'G_PAYMENT_FAILED' || currentNodeId === 'AJ_RETURN_REJECTED_DISPUTE') {
    stateVariant = 'error';
  } else if (
    currentNodeId === 'J_CANCEL_BEFORE_DISPATCH_COD' ||
    currentNodeId === 'N_CLOSE_CANCELLED_ORDER' ||
    currentNodeId === 'W_CLOSE_COD_RTO'
  ) {
    stateVariant = 'neutral';
  } else if (currentNodeId.includes('QC') || currentNodeId.includes('RETURN')) {
    stateVariant = 'purple';
  } else if (currentNodeId.includes('DELHIVERY') || currentNodeId.includes('DISPATCH')) {
    stateVariant = 'info';
  } else {
    stateVariant = 'warning';
  }

  // Generate realistic audit events
  const auditEvents = generateAuditEvents(visited, order, gateway, carrier);

  // Derive suggested operator actions
  const suggestedActions = deriveSuggestedActions(currentNodeId, order, gateway, carrier);

  // Progress percentage
  let progressPercent = Math.min(100, Math.round((visited.length / 14) * 100));
  if (
    currentNodeId === 'AE_ORDER_CLOSED_SETTLED' ||
    currentNodeId === 'Y_CLOSE_RTO_COMPLETED' ||
    currentNodeId === 'AL_ORDER_RETURN_CLOSED'
  ) {
    progressPercent = 100;
  }

  return {
    currentNodeId,
    currentNode,
    visitedNodeIds: Array.from(new Set(visited)),
    activeCategory: currentNode.category,
    stateLabel: currentNode.label,
    stateVariant,
    paymentGateway: gateway,
    carrier,
    auditEvents,
    suggestedActions,
    progressPercent,
  };
}

function deriveSuggestedActions(
  nodeId: string,
  order: OrderInputState,
  gateway: PaymentGatewayBrand | null,
  carrier: CarrierBrand | null
) {
  const actions: Array<{
    id: string;
    label: string;
    description: string;
    actionType: 'primary' | 'secondary' | 'critical';
  }> = [];

  const gatewayName = gateway?.name || 'Payment Gateway';
  const carrierName = carrier?.name || 'Delhivery';

  if (nodeId === 'G_PAYMENT_FAILED') {
    actions.push({
      id: 'send_payment_link',
      label: `Send ${gatewayName} Payment Link`,
      description: 'Send payment retry link to buyer via WhatsApp and SMS.',
      actionType: 'primary',
    });
    actions.push({
      id: 'cancel_order',
      label: 'Cancel Order',
      description: 'Close abandoned cart after 24-hour timeout window.',
      actionType: 'critical',
    });
  } else if (nodeId === 'E_COD_CONFIRMATION' || nodeId === 'I_DECISION_CUSTOMER_CONFIRMS') {
    actions.push({
      id: 'call_confirm',
      label: 'Trigger WhatsApp Confirmation Bot',
      description: 'Ping customer with order summary and confirm/cancel buttons.',
      actionType: 'primary',
    });
    actions.push({
      id: 'manual_verify',
      label: 'Manual Phone Verification',
      description: 'Call customer to confirm address and delivery readiness.',
      actionType: 'secondary',
    });
  } else if (nodeId === 'H_READY_FOR_PROCESSING') {
    actions.push({
      id: 'generate_awb',
      label: `Assign ${carrierName} AWB & Generate Label`,
      description: 'Book shipment manifested on Delhivery logistics network.',
      actionType: 'primary',
    });
    actions.push({
      id: 'print_pick_list',
      label: 'Print Warehouse Pick List',
      description: 'Send SKU routing to packing station scanner.',
      actionType: 'secondary',
    });
  } else if (nodeId === 'M_INITIATE_AUTO_REFUND_PRE' || nodeId === 'V_INITIATE_AUTO_REFUND_RTO') {
    actions.push({
      id: 'instant_refund',
      label: `Trigger Instant Refund via ${gatewayName}`,
      description: `Disburse ₹${order.totalAmount || 899} back to original payment rail.`,
      actionType: 'primary',
    });
  } else if (nodeId === 'Z_VERIFY_DELHIVERY_REMITTANCE') {
    actions.push({
      id: 'reconcile_remittance',
      label: 'Reconcile Delhivery Remittance UTR',
      description: 'Cross-check bank credit statement against Delhivery COD payout.',
      actionType: 'primary',
    });
  } else if (nodeId === 'AA_VERIFY_GATEWAY_SETTLEMENT') {
    actions.push({
      id: 'verify_settlement',
      label: `Verify ${gatewayName} Payout`,
      description: 'Audit merchant settlement balance and fee schedule.',
      actionType: 'primary',
    });
  } else if (nodeId === 'AG_WAREHOUSE_RETURN_QC') {
    actions.push({
      id: 'qc_pass',
      label: 'Approve Return QC (Unopened / Good Condition)',
      description: 'Restock SKU into live inventory and approve instant refund.',
      actionType: 'primary',
    });
    actions.push({
      id: 'qc_reject',
      label: 'Reject QC & Raise Dispute',
      description: 'Upload video evidence of damaged / swapped garment.',
      actionType: 'critical',
    });
  }

  return actions;
}

function generateAuditEvents(
  visited: string[],
  order: OrderInputState,
  gateway: PaymentGatewayBrand | null,
  carrier: CarrierBrand | null
): OrderLifecycleAuditTrailEvent[] {
  const baseDate = order.createdAt ? new Date(order.createdAt) : new Date(Date.now() - 48 * 3600 * 1000);
  const events: OrderLifecycleAuditTrailEvent[] = [];

  let minuteOffset = 0;

  for (const nodeId of visited) {
    const node = LIFECYCLE_NODES[nodeId];
    if (!node) continue;

    // Only add milestone events (avoid duplicate decision nodes in visual log)
    if (node.type === 'decision' && !['C_DECISION_PAYMENT_MODE'].includes(nodeId)) {
      continue;
    }

    minuteOffset += 18;
    const eventTime = new Date(baseDate.getTime() + minuteOffset * 60 * 1000).toISOString();

    let actor = 'Automated System';
    let system = 'VMS Workflow Engine';

    if (node.category === 'payment') {
      system = gateway?.name || 'Payment Gateway';
      actor = 'Payment Rails';
    } else if (node.category === 'logistics') {
      system = carrier?.name || 'Delhivery API';
      actor = 'Courier EDI Hub';
    } else if (node.category === 'dispatch') {
      system = 'Warehouse Station';
      actor = 'Packing Operator';
    } else if (node.category === 'returns' || node.category === 'rto') {
      system = 'Returns & QC Terminal';
      actor = 'Warehouse Inspector';
    }

    events.push({
      nodeId,
      timestamp: eventTime,
      title: node.label,
      description: node.description,
      actor,
      system,
    });
  }

  return events;
}

/**
 * Pre-configured interactive mock scenarios for the `state-machine` skill pattern.
 * Enables live testing of every path through the workbench switcher.
 */
export const MOCK_LIFECYCLE_SCENARIOS: Record<
  string,
  {
    name: string;
    description: string;
    order: OrderInputState;
  }
> = {
  PREPAID_PHONEPE_SETTLED: {
    name: 'Prepaid PhonePe → Delivered → Gateway Settled',
    description: 'Happy path online prepaid order verified via PhonePe, delivered by Delhivery, settled and closed.',
    order: {
      orderId: 'ORD-9021-PP',
      orderNumber: '9021',
      paymentMode: 'prepaid',
      paymentGateway: 'phonepe',
      paymentSuccessful: true,
      cancelledBeforeDispatch: false,
      isDispatched: true,
      trackingId: '1490842015571145',
      carrierCode: 'delhivery',
      shipmentOutcome: 'delivered',
      gatewaySettlementVerified: true,
      returnRequested: false,
      totalAmount: 1499,
      createdAt: '2026-10-09T08:30:00.000Z',
    },
  },
  COD_CONFIRMED_DELIVERED_REMITTANCE: {
    name: 'COD Confirmed → Delhivery Delivered → Cash Remittance',
    description: 'COD confirmed by buyer via WhatsApp, delivered by Delhivery courier, cash remitted to bank.',
    order: {
      orderId: 'ORD-8842-COD',
      orderNumber: '8842',
      paymentMode: 'cod',
      paymentGateway: 'gokwik',
      codConfirmed: true,
      cancelledBeforeDispatch: false,
      isDispatched: true,
      trackingId: '1490987123450912',
      carrierCode: 'delhivery',
      shipmentOutcome: 'delivered',
      delhiveryRemittanceVerified: true,
      returnRequested: false,
      totalAmount: 1899,
      createdAt: '2026-10-08T11:15:00.000Z',
    },
  },
  PREPAID_EASEBUZZ_PRE_CANCEL_REFUNDED: {
    name: 'Prepaid Easebuzz → Pre-dispatch Cancel → Auto-Refunded',
    description: 'Customer cancels order before picking. Automated instant refund initiated and verified via Easebuzz.',
    order: {
      orderId: 'ORD-7612-EB',
      orderNumber: '7612',
      paymentMode: 'prepaid',
      paymentGateway: 'easebuzz',
      paymentSuccessful: true,
      cancelledBeforeDispatch: true,
      paymentCaptured: true,
      cancelRefundInitiated: true,
      cancelRefundVerified: true,
      isDispatched: false,
      totalAmount: 2490,
      createdAt: '2026-10-10T14:20:00.000Z',
    },
  },
  COD_UNCONFIRMED_CANCELLED: {
    name: 'COD Order → Customer Unconfirmed → Cancelled',
    description: 'Buyer did not confirm COD OTP within 12 hours. Cancelled before packing with zero financial liability.',
    order: {
      orderId: 'ORD-6541-COD',
      orderNumber: '6541',
      paymentMode: 'cod',
      paymentGateway: 'gokwik',
      codConfirmed: false,
      isDispatched: false,
      totalAmount: 999,
      createdAt: '2026-10-11T09:00:00.000Z',
    },
  },
  PREPAID_GOKWIK_RTO_AUTO_REFUND: {
    name: 'Prepaid GoKwik → Delhivery RTO → Reconciled & Refunded',
    description: 'Prepaid parcel returned to origin by Delhivery. Restocked at warehouse, auto-refund verified.',
    order: {
      orderId: 'ORD-5432-GK',
      orderNumber: '5432',
      paymentMode: 'prepaid',
      paymentGateway: 'gokwik',
      paymentSuccessful: true,
      isDispatched: true,
      trackingId: '1490716253449102',
      carrierCode: 'delhivery',
      shipmentOutcome: 'rto',
      rtoReceived: true,
      rtoRefundInitiated: true,
      rtoRefundVerified: true,
      totalAmount: 1299,
      createdAt: '2026-10-06T16:45:00.000Z',
    },
  },
  COD_DELHIVERY_RTO_CLOSED: {
    name: 'COD Order → Delhivery RTO → Restocked & Closed',
    description: 'Customer unavailable for COD delivery. Delhivery returns package to warehouse, closed without refund.',
    order: {
      orderId: 'ORD-4321-COD',
      orderNumber: '4321',
      paymentMode: 'cod',
      paymentGateway: 'gokwik',
      codConfirmed: true,
      isDispatched: true,
      trackingId: '1490112233445566',
      carrierCode: 'delhivery',
      shipmentOutcome: 'rto',
      rtoReceived: true,
      totalAmount: 1750,
      createdAt: '2026-10-05T10:30:00.000Z',
    },
  },
  RETURN_QC_APPROVED_REFUNDED: {
    name: 'Delivered → Customer Return → QC Passed → Auto-Refunded',
    description: 'Customer requests size return. Reverse pickup completed, warehouse QC passes, auto-refund verified.',
    order: {
      orderId: 'ORD-3210-RET',
      orderNumber: '3210',
      paymentMode: 'prepaid',
      paymentGateway: 'easebuzz',
      paymentSuccessful: true,
      isDispatched: true,
      trackingId: '1490998877665544',
      carrierCode: 'delhivery',
      shipmentOutcome: 'delivered',
      gatewaySettlementVerified: true,
      returnRequested: true,
      returnInTransit: true,
      warehouseQcPassed: true,
      returnRefundInitiated: true,
      returnRefundVerified: true,
      totalAmount: 3200,
      createdAt: '2026-10-01T12:00:00.000Z',
    },
  },
  RETURN_QC_REJECTED_DISPUTE: {
    name: 'Delivered → Customer Return → QC Failed (Damaged)',
    description: 'Customer returned worn/damaged garment. Warehouse inspector flags dispute with video evidence.',
    order: {
      orderId: 'ORD-2109-DISP',
      orderNumber: '2109',
      paymentMode: 'prepaid',
      paymentGateway: 'phonepe',
      paymentSuccessful: true,
      isDispatched: true,
      trackingId: '1490443322110099',
      carrierCode: 'delhivery',
      shipmentOutcome: 'delivered',
      gatewaySettlementVerified: true,
      returnRequested: true,
      returnInTransit: true,
      warehouseQcPassed: false,
      totalAmount: 2199,
      createdAt: '2026-10-02T15:00:00.000Z',
    },
  },
  PREPAID_PAYMENT_FAILED: {
    name: 'Prepaid GoKwik → Gateway Authorization Failed',
    description: 'UPI transaction timed out at payment gateway. Order held in pending status awaiting retry.',
    order: {
      orderId: 'ORD-1098-FAIL',
      orderNumber: '1098',
      paymentMode: 'prepaid',
      paymentGateway: 'gokwik',
      paymentSuccessful: false,
      isDispatched: false,
      totalAmount: 849,
      createdAt: '2026-10-11T16:00:00.000Z',
    },
  },
};
