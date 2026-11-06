# Remaining work for Quick Print

This document defines the remaining product work as vertical slices. Each slice is a complete end-to-end feature with the minimum frontend, backend and database work needed to satisfy it. Do not start the next slice until the current slice is fully implemented and verified.

## Rule for execution

1. Build one slice at a time.
2. Include only the work required for that slice.
3. Keep tests real and behaviour-focused.
4. Verify the slice end-to-end before asking for the next one.
5. Do not broaden scope or redesign unrelated UX while a slice is in progress.

---

## Completed baseline

The project already contains the following working core:

- anonymous browser session creation and persistence
- cart persistence for the active session
- order creation and ownership enforcement
- file upload metadata storage and permission checks
- secure cookie, rate-limit, and upload-size protections
- demo payment flow
- printer registration and assignment flow
- order status lifecycle including ready + handover
- production-ready backend test coverage for the above

The remaining work is the production feature pipeline below.

---

## Slice 1: Document upload and conversion

### Goal
Allow the customer to upload all supported print formats and convert them into a print-ready PDF before printing begins.

### Included work

#### Frontend
- update upload picker to accept all supported file types
- show helpful per-file validation messages
- show processing status while converting
- support preview for PDFs and images, and safe fallback for office files
- prevent invalid or oversized files from entering the cart

#### Backend
- accept uploaded files from the browser
- validate type, size, and content
- process supported formats:
  - PDF
  - JPG / JPEG
  - PNG
  - DOC / DOCX
  - PPT / PPTX
- convert office files to PDF using a controlled conversion service or library
- convert images into printable PDF pages using approved sizing/orientation rules
- determine actual page count after conversion
- keep files private and generate safe storage keys
- clean up failed or partial conversions

#### Database / storage
- add fields for uploaded file state, original file metadata, and converted PDF metadata
- track conversion status: uploaded, converting, converted, failed
- store page count after conversion
- store file retention and cleanup metadata if required

### Acceptance criteria
- one valid file of each supported format can be uploaded
- invalid format is rejected with a clear message
- oversized file is rejected
- corrupt files are rejected
- conversion failure is tracked and surfaced to the UI
- the final output is a print-ready PDF with a confirmed page count

### Verification
- run file upload tests for each supported format
- run conversion failure tests
- verify page count matches the actual converted document

---

## Slice 2: Per-document print configuration

### Goal
Allow each uploaded document to have independent print settings and validate those settings server-side.

### Included work

#### Frontend
- all pages vs some pages
- page range editing and validation
- black & white vs colour
- single-sided vs double-sided
- copies per document
- independent settings per doc
- immediate validation errors next to the document

#### Backend
- validate page numbers and ranges against actual converted page count
- reject invalid ranges and overlapping/duplicate errors when required
- enforce colour/duplex constraints
- validate copies limits
- store print configuration with each document segment

#### Database / storage
- add per-document print configuration records
- persist document segments or print settings in a structured form
- keep final settings tied to the order document, not only the browser state

### Acceptance criteria
- document-level settings can be modified without affecting other docs
- invalid ranges are blocked
- duplex on a single-page document is rejected if disallowed
- backend validation matches the UI behaviour

### Verification
- custom range tests
- invalid syntax tests
- out-of-range tests
- multiple-doc tests with different settings

---

## Slice 3: Authoritative cart and quote

### Goal
The backend must calculate the final price using server-owned logic, not browser assumptions.

### Included work

#### Frontend
- show the current quote breakdown
- allow document edits without losing other selections
- show a final total that is derived from backend price calculation

#### Backend
- calculate page counts, prints, sheets, and total cost from configured documents
- store quote or price snapshot for the cart/order
- reject stale or tampered quote submissions
- maintain pricing rules in the backend, not in the browser

#### Database / storage
- persist cart items and their settings
- persist quote data or version metadata
- store monetary values in safe integer or decimal representation

### Acceptance criteria
- the browser total is never treated as the source of truth
- quote is recalculated after changes
- stale quotes are rejected
- a tampered price cannot be accepted

### Verification
- add multiple files and edit one without affecting other docs
- tampered browser price fails
- stale quote fails
- concurrent cart updates do not corrupt state

---

## Slice 4: Real payment flow

### Goal
Complete payment using a real provider only after the owner confirms the merchant setup and integration details.

### Included work

#### Frontend
- keep the payment UX but connect to the verified backend payment flow
- handle pending, success, and failure states clearly
- avoid exposing secrets

#### Backend
- create provider payment intent or order session from the server quote
- verify provider response and signature
- verify amount, currency, provider reference, and order association
- block duplicate payment attempts
- update order status only after successful verification

#### Database / storage
- store payment result, provider reference, and verification status
- keep payment rows idempotent and auditable
- record failed or uncertain payment states separately

### Acceptance criteria
- payment is completed only after backend verification
- a fake browser-only success cannot mark the order as paid
- duplicate payment or duplicate webhooks are ignored safely
- failed or cancelled payment does not move the order into printing

### Verification
- successful payment
- cancelled payment
- wrong amount or wrong order reference rejection
- duplicate webhook rejection
- delayed webhook handling

---

## Slice 5: UID, order lifecycle, and customer status

### Goal
Once payment is confirmed, the user receives a customer-facing order UID and sees only their own order status.

### Included work

#### Frontend
- show the customer token / UID clearly
- show correct progress stage
- allow customers to follow their order without admin access

#### Backend
- generate unique order UID such as XR-XXX
- keep internal database IDs separate from customer-facing identifiers
- enforce status transitions and permissions
- prevent customer access to other customers' orders

#### Database / storage
- persist status history and timestamps
- record state changes and queue transition events
- enforce uniqueness for generated identifiers

### Acceptance criteria
- each paid order has a unique UID
- the customer can read only their own order
- invalid transitions are rejected
- repeated status updates remain safe and idempotent

### Verification
- concurrent order creation
- status transition tests
- forbidden cross-order access tests

---

## Slice 6: Queue and ETA

### Goal
Estimate the customer wait time using backend-owned queue logic and printer availability.

### Included work

#### Frontend
- display queue state and ETA
- update the customer status page when queue changes
- show honest uncertainty for busy or offline printer states

#### Backend
- calculate queue order based on paid jobs and printer availability
- support printer offline, paused, or error states
- update ETA as queue or printer state changes

#### Database / storage
- store printer availability and queue position metadata
- persist job assignment and completion times
- allow queue recalculation after printer or job changes

### Acceptance criteria
- queue is calculated on the server, not in the browser
- ETA changes when queue state changes
- offline printer does not falsely produce a normal ETA

### Verification
- empty queue
- one job queue
- multiple jobs
- printer offline and recovery paths

---

## Slice 7: Secure shopkeeper dashboard

### Goal
Protect the admin workflow and allow shop staff to manage order, payment, job, and handover actions safely.

### Included work

#### Frontend
- login screen for shopkeeper/admin
- dashboard with orders, queue, and printer states
- approved actions for order readiness and handover

#### Backend
- server-side auth and authorization
- protect every admin route
- allow only approved actions
- log admin actions and state changes

#### Database / storage
- admin user records and sessions
- action audit trail
- permissions tied to authenticated principals

### Acceptance criteria
- unauthenticated requests are rejected
- customers cannot access admin APIs
- invalid/admin action on the wrong order is rejected
- admin actions are recorded

### Verification
- admin login and logout
- unauthorized customer access blocked
- valid order status actions allowed
- wrong-state handover blocked

---

## Slice 8: Printer agent and actual printing

### Goal
The printer service can authenticate and process printing jobs in an operational, safe way.

### Included work

#### Frontend
- owner dashboard shows printed / ready / handed-over states clearly
- queue state updates are visible to shop staff and customer

#### Backend
- printer agent authentication
- job assignment and lifecycle updates
- status updates for queued, printing, ready, failed, completed
- recovery and retry logic for offline or interrupted printing

#### Database / storage
- printer jobs, status history, print attempts, and completion timestamps
- mark duplicates and retries explicitly
- support safe job reprocessing rules

### Acceptance criteria
- printer can fetch assigned jobs only if authenticated
- jobs are not duplicated or reprinted without a clear rule
- failed or interrupted jobs are visible and recoverable
- ready jobs can be handed over only with the correct state transition

### Verification
- printer registration
- job assignment
- offline and retry handling
- ready-to-handover transition guards

---

## Slice 9: Production hardening and operational readiness

### Goal
Prepare the system for deployment with operational safety, not just prototype behavior.

### Included work

#### Frontend
- keep customer UX clear for older adults and first-time users
- ensure no confusing or unsafe actions at critical points
- accessible labels and simple progress states

#### Backend
- secure secrets and environment configuration
- define backup and retention rules
- logging, monitoring, and alerting plan
- system health and recovery checks

#### Database / storage
- retention policy for uploads and logs
- backup/restore process
- auditing and cleanup for stale data

### Acceptance criteria
- deployment config is documented
- secrets are not committed
- logs do not contain sensitive data
- the app can be recovered and monitored in a real deployment environment

### Verification
- health checks
- backup process validation
- cleanup / retention flow checks
- logs and monitoring sanity checks

---

## Recommended order to execute

1. Slice 1: Document upload and conversion
2. Slice 2: Per-document print configuration
3. Slice 3: Authoritative cart and quote
4. Slice 4: Real payment flow
5. Slice 5: UID and order lifecycle
6. Slice 6: Queue and ETA
7. Slice 7: Secure shopkeeper dashboard
8. Slice 8: Printer agent and actual printing
9. Slice 9: Operational readiness

This order keeps the project moving from customer-facing upload to backend truth, then to payment, queue, admin, and final operations.

---

## Next step

Proceed with Slice 1 first, then verify it fully. Once the slice is green, we will ask for the next slice and continue in the exact same sequence.
