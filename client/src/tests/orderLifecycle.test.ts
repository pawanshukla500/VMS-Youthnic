import { describe, it, expect } from 'vitest';
import {
  LIFECYCLE_NODES,
  LIFECYCLE_EDGES,
  MOCK_LIFECYCLE_SCENARIOS,
  evaluateOrderLifecycle,
} from '../utils/orderLifecycle';

describe('orderLifecycle Engine', () => {
  it('contains all 38 nodes from the official workflow diagram', () => {
    expect(Object.keys(LIFECYCLE_NODES).length).toBe(38);
    expect(LIFECYCLE_NODES.A_NEW_ORDER).toBeDefined();
    expect(LIFECYCLE_NODES.D_VERIFY_PAYMENT.label).toContain('GoKwik / Easebuzz / PhonePe');
    expect(LIFECYCLE_NODES.Q_DELHIVERY_TRACKING.label).toContain('Delhivery Tracking');
    expect(LIFECYCLE_NODES.AE_ORDER_CLOSED_SETTLED.type).toBe('terminal');
    expect(LIFECYCLE_NODES.AL_ORDER_RETURN_CLOSED.type).toBe('terminal');
  });

  it('contains directed edges covering all diagram transitions', () => {
    expect(LIFECYCLE_EDGES.length).toBeGreaterThanOrEqual(30);

    const fromPaymentMode = LIFECYCLE_EDGES.filter((e) => e.from === 'C_DECISION_PAYMENT_MODE');
    expect(fromPaymentMode).toHaveLength(2);
    expect(fromPaymentMode.map((e) => e.to)).toEqual(
      expect.arrayContaining(['D_VERIFY_PAYMENT', 'E_COD_CONFIRMATION'])
    );

    const fromOutcome = LIFECYCLE_EDGES.filter((e) => e.from === 'R_DECISION_SHIPMENT_OUTCOME');
    expect(fromOutcome.map((e) => e.to)).toEqual(
      expect.arrayContaining(['S_DECISION_DELIVERED_PAYMENT_MODE', 'T_RTO_RECEIVED'])
    );
  });

  it('evaluates prepaid happy path to settled completion', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.PREPAID_PHONEPE_SETTLED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('AE_ORDER_CLOSED_SETTLED');
    expect(result.stateVariant).toBe('success');
    expect(result.visitedNodeIds).toContain('D_VERIFY_PAYMENT');
    expect(result.visitedNodeIds).toContain('Q_DELHIVERY_TRACKING');
    expect(result.visitedNodeIds).toContain('AC_PREPAID_SETTLEMENT_RECONCILED');
    expect(result.paymentGateway?.code).toBe('PHONEPE');
    expect(result.carrier?.code).toBe('DELHIVERY');
    expect(result.progressPercent).toBe(100);
    expect(result.auditEvents.length).toBeGreaterThan(5);
  });

  it('evaluates COD order to remittance closed', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.COD_CONFIRMED_DELIVERED_REMITTANCE;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('AE_ORDER_CLOSED_SETTLED');
    expect(result.visitedNodeIds).toContain('E_COD_CONFIRMATION');
    expect(result.visitedNodeIds).toContain('Z_VERIFY_DELHIVERY_REMITTANCE');
    expect(result.visitedNodeIds).toContain('AB_COD_FINANCIALLY_CLOSED');
  });

  it('evaluates prepaid pre-dispatch cancellation with auto-refund', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.PREPAID_EASEBUZZ_PRE_CANCEL_REFUNDED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('N_CLOSE_CANCELLED_ORDER');
    expect(result.visitedNodeIds).toContain('M_INITIATE_AUTO_REFUND_PRE');
    expect(result.visitedNodeIds).toContain('O_VERIFY_REFUND_SUCCESS_PRE');
    expect(result.paymentGateway?.code).toBe('EASEBUZZ');
  });

  it('evaluates unconfirmed COD cancellation before dispatch', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.COD_UNCONFIRMED_CANCELLED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('J_CANCEL_BEFORE_DISPATCH_COD');
    expect(result.stateVariant).toBe('neutral');
    expect(result.visitedNodeIds).not.toContain('P_PICK_PACK_DISPATCH');
  });

  it('evaluates prepaid RTO auto refund reconciliation', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.PREPAID_GOKWIK_RTO_AUTO_REFUND;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('Y_CLOSE_RTO_COMPLETED');
    expect(result.visitedNodeIds).toContain('T_RTO_RECEIVED');
    expect(result.visitedNodeIds).toContain('V_INITIATE_AUTO_REFUND_RTO');
    expect(result.visitedNodeIds).toContain('X_VERIFY_REFUND_SUCCESS_RTO');
  });

  it('evaluates COD RTO closed without refund', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.COD_DELHIVERY_RTO_CLOSED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('W_CLOSE_COD_RTO');
    expect(result.visitedNodeIds).not.toContain('V_INITIATE_AUTO_REFUND_RTO');
  });

  it('evaluates customer return with QC pass and refund', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.RETURN_QC_APPROVED_REFUNDED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('AL_ORDER_RETURN_CLOSED');
    expect(result.visitedNodeIds).toContain('AG_WAREHOUSE_RETURN_QC');
    expect(result.visitedNodeIds).toContain('AI_INITIATE_AUTO_REFUND_RET');
    expect(result.visitedNodeIds).toContain('AK_VERIFY_REFUND_SUCCESS_RET');
  });

  it('evaluates customer return with QC failure and dispute flag', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.RETURN_QC_REJECTED_DISPUTE;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('AJ_RETURN_REJECTED_DISPUTE');
    expect(result.stateVariant).toBe('error');
    expect(result.visitedNodeIds).not.toContain('AI_INITIATE_AUTO_REFUND_RET');
  });

  it('evaluates payment authorization failure at gateway', () => {
    const scenario = MOCK_LIFECYCLE_SCENARIOS.PREPAID_PAYMENT_FAILED;
    const result = evaluateOrderLifecycle(scenario.order);

    expect(result.currentNodeId).toBe('G_PAYMENT_FAILED');
    expect(result.stateVariant).toBe('error');
    expect(result.suggestedActions.some((a) => a.id === 'send_payment_link')).toBe(true);
  });
});
