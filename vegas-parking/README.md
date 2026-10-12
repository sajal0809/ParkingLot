# Park Vegas

Responsive customer and operator websites based on the supplied 15-spot sketch (A1–A5, B1–B5, C1–C5).

## Manual UPI payment workflow

1. Customer chooses an exact spot and supplies name and vehicle registration.
2. The server atomically holds it as `pending` and creates a payment request. No parking pass exists yet.
3. The customer opens the `upi://pay` link for ₹15 to `sajal.sameer12345@oksbi`, or copies the UPI ID into a payment app.
4. The customer submits the UPI transaction reference. This changes only the report status, not payment confirmation.
5. The operator independently checks the receiving bank/UPI account, enters the received transaction reference, and confirms the ₹15 credit.
6. An atomic approval creates a parking pass and changes the spot to reserved. Check-in requires that approval.
7. Only the operator can confirm vacancy after checking the spot and restoring its cone.

The website has no bank integration and cannot determine whether money moved. Approval is the operator's attestation. Opening the payment app or submitting a reference never issues a pass. No real transfer was made during implementation tests.

## Authorization

Sites sign-in supplies trusted identity. Operator actions and the operator data view are restricted server-side to `sajal.sameer12345@gmail.com`. The loopback development identity is allowed only in non-production code. Customer reads conceal other customers' booking and payment data. Customer payment reports require ownership.

The site remains owner-private; it has not been made public. Existing demo bookings are not considered paid and cannot pass the new check-in gate. Operator cancellation can clear an empty legacy spot.

## Operational limits

Pending requests remain held until the operator resolves/cancels them; there is no automatic deadline or expiry in this version. On cancellation the operator must reconcile any received/pending payment and issue any refund outside the website. No automatic refund is sent. UPI app opening depends on the customer's browser, device and payment app; the copyable UPI ID provides a fallback. The supplied UPI destination has not been validated through a real transfer.

## Data integrity

D1 holds spot state, payment records and activity. Conditional version updates prevent concurrent allocation. Each batch uses a per-operation mutation marker so a losing request cannot create an orphan payment or audit event. Approval, pass issuance and audit commit together. A unique receiving transaction reference prevents reusing a receipt, including after departure or cancellation. Financial records remain after the physical spot is released.

## Development and verification

Use Node >=22.13 and the locked dependencies. Run `npm run dev`, generate migrations with `npm run db:generate`, and apply pending migrations to local D1 before preview. Sites owns production migration application and publication.

`node --experimental-sqlite tests/payment-flow.cjs` tests the actual route handlers against isolated SQLite transactions with mocked identities. It covers concurrent allocation, pass gating, non-operator denial, cross-customer access denial, manual approval, correction, duplicate receipt races and rollback, check-in, vacancy, ledger retention, and UPI link parameters. These tests use synthetic references and do not contact any payment app or bank.
