---
name: state-machine
description: Renders every state of a component you choose on a workbench page, with mock data and a switcher, so you can test each state.
---

# State Machine

This skill takes a component or workflow and models every state it can be in. Mock and real data feeds each state, and an interactive switcher flips between them.

## 1. Scope the workflow / component
Define the workflow in one sentence: what it models, where it renders, and where its state transitions originate.

## 2. Model the states
Identify every valid branch in the workflow:
- Initial / Intake: New Order Received, Create Order Trail
- Decision branches: Payment Mode (Prepaid vs COD), Pre-dispatch Cancel, Shipment Outcome (Delivered vs RTO), Return Requests
- Active processing: Gateway Verification (GoKwik / Easebuzz / PhonePe), Pick / Pack / Dispatch, Delhivery Tracking, Warehouse QC
- Terminal outcomes: Order Closed, COD Financially Closed, Prepaid Settlement Reconciled, Refund Reconciled, Return Exception

## 3. Feed each state at the data boundary
Supply realistic e-commerce and logistics data (tracking AWBs, order amounts, gateway transaction IDs, courier remittance statuses).

## 4. Provide state switching
Allow testing every lifecycle state with instant visual and interactive feedback.
