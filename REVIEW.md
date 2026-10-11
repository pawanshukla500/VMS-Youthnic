# Code Review Report (GSD Code Review)

## Scope
Reviewing newly added Logistics Brandfetch Integrations, Tabbed Dashboard, Orders Hub, Claude-Design Analytics Tab, and TypeUI Foundations.

### Files Audited
- `client/src/utils/logisticsLogos.ts`
- `client/src/components/LogisticsBadges.tsx`
- `client/src/components/dashboard/DashboardOverviewTab.tsx`
- `client/src/components/dashboard/DashboardOrdersTab.tsx`
- `client/src/components/dashboard/DashboardAnalyticsTab.tsx`
- `client/src/components/dashboard/DashboardLogisticsTab.tsx`
- `client/src/pages/Dashboard.tsx`
- `client/src/pages/SyncedOrders.tsx`
- `client/src/pages/Reports.tsx`
- `client/src/tests/logisticsLogos.test.ts`

---

## Findings

### 1. [Warning] Image onError fallback looping prevention in `LogisticsBadges.tsx`
- **Location**: `client/src/components/LogisticsBadges.tsx:114`
- **Issue**: `CarrierDirectoryCard` falls back to `carrier.iconUrl` on SVG error. If `iconUrl` also fails to load, `onError` can re-fire repeatedly.
- **Fix**: Guard with `data-fallback` flag so it only attempts fallback once, then gracefully hides the broken image tag.

### 2. [Warning] Non-standard Tailwind class `shadow-2xs`
- **Location**: `client/src/components/LogisticsBadges.tsx:43,84`, `DashboardOrdersTab.tsx:180,199,214`
- **Issue**: `shadow-2xs` is a Tailwind v4 convention or custom utility; standard Tailwind v3 uses `shadow-xs` / `shadow-sm`.
- **Fix**: Replace `shadow-2xs` with `shadow-xs` or `shadow-sm` for reliable shadow rendering across all browsers.

### 3. [Warning] Missing Blue Dart courier in Carrier Registry
- **Location**: `client/src/utils/logisticsLogos.ts`
- **Issue**: Blue Dart is one of the primary parcel couriers in Indian domestic logistics alongside Delhivery and Shadowfax. It was missing from `CARRIER_REGISTRY` and `detectCarrier` (prefix `BLU` or `7...`).
- **Fix**: Add Blue Dart brand definition, official tracking URL, and prefix recognition.

### 4. [Warning] Accessible Modal Keyboard Escape Dismissal
- **Location**: `client/src/components/dashboard/DashboardOrdersTab.tsx:455`
- **Issue**: The Order Details inspection modal lacks an `Escape` key event listener for keyboard-only accessibility (WCAG 2.2 AA).
- **Fix**: Add `useEffect` listening to `Escape` keydown to close the modal.

### 5. [Info] Accessibility: Missing `role="tablist"` on sub-tab bars
- **Location**: `DashboardOrdersTab.tsx:142`, `DashboardAnalyticsTab.tsx:120`
- **Issue**: Sub-tab buttons have `role="tab"` and `aria-selected`, but the container lacks `role="tablist"` and `aria-label`.
- **Fix**: Add `role="tablist"` and descriptive `aria-label` to ensure assistive technologies recognize the tab group.

---

## Remediation Plan
Apply atomic fixes for items 1-5, rerun `npm test` and `npm run build`, and verify all tests pass.
