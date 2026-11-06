# Quick Print Backend - Vertical Slices Plan

## 1. Product goal

This backend supports a no-login print ordering flow for anonymous users. The system must allow a user to upload a document, select print settings, pay, track order status, and receive updates without creating an account.

The frontend prototype already models this flow. The backend must replace browser-only state with persistent, production-ready services.

## 2. Core backend responsibilities

The system includes the following backend services:

1. Payment integration
2. Printer agent registration and job processing
3. Database storage for anonymous session and order lifecycle
4. File storage and upload pipeline for documents until handover
5. Anonymous user session tracking across browser close/reopen

## 3. System principle: no login, but persistent user identity

User is not authenticated by login.

Instead, a server-managed anonymous session is created for each browser/device. The session is linked to the user’s orders, and it persists even if the browser closes or the tab is closed.

This means the backend must store:
- anonymous session record
- customer reference / session token
- order-to-session mapping
- order status and lifecycle

## 4. High-level backend architecture

### Components
- Frontend app
- API gateway / backend service
- PostgreSQL database
- Redis for cache / queue / session short-term state
- Object storage for uploaded files
- Payment provider (demo payment gateway for prototype stage)
- Printer agent service
- Event / status update channel for frontend polling or websocket updates

### Core runtime flow
1. User opens site
2. Backend creates or reuses anonymous session
3. User uploads document
4. Metadata is saved in database
5. Order is created with status `draft` or `pending_payment`
6. Payment is processed
7. Order moves to `paid` / `queued`
8. Printer agent picks up job
9. Order moves through states until `handed_over`
10. User can reopen site and view order status using the same anonymous session

## 5. Required backend domains

### Domain A: Anonymous Session and Order Tracking
Responsible for:
- creating session token
- persisting browser/device identity without login
- associating orders to session
- allowing users to see all active or recent orders after browser close
- expiring stale sessions and orders

### Domain B: File Upload and Document Storage
Responsible for:
- accepting PDF uploads
- validating file type and size
- uploading to object storage fast and securely
- storing metadata in database
- maintaining document availability until order is handed over

### Domain C: Payment Flow
Responsible for:
- creating payment intent or order payment session
- verifying payment result
- locking order against duplicate payment
- updating payment status and order status
- handling demo gateway success/failure simulation

### Domain D: Printer Agent and Job Queue
Responsible for:
- printer registration
- heartbeat and health checks
- job assignment to available printers
- job updates and completion states
- order readiness and handover coordination

### Domain E: Handover and Completion
Responsible for:
- marking order as ready
- confirming handover to customer
- keeping order history for audit and support
- retention / cleanup rules

## 6. Vertical slice strategy

The backend will be built using vertical slicing. One feature slice is implemented end-to-end before moving to the next.

Each slice must include:
- API contract
- database schema changes
- validation rules
- business logic
- demo gateway / simulation integration if required
- tests for success + failure cases
- no implementation of unrelated features

### Slice order recommended
1. Anonymous session creation and retrieval
2. Order creation + order status tracking
3. File upload + document storage
4. Payment flow with demo gateway
5. Printer agent registration and queue assignment
6. Handover and completion lifecycle

This order is intentional: earlier slices create the persistent identity and order foundation that later slices depend on.

## 7. Slice details

### Slice 1: Anonymous Session Creation and Retrieval
Purpose:
- create a server-side anonymous session
- link user to their orders without login
- persist identity after browser close

Includes:
- `POST /api/sessions/create`
- `GET /api/sessions/me`
- session token generation and storage
- expiry policy
- anonymous customer record mapping
- session cleanup for expired records

Required data:
- session_id
- session_token
- device fingerprint / user agent (optional)
- created_at
- updated_at
- expires_at
- status

Questions to answer before implementation:
- Should session survive for 7 days, 30 days, or until order completion?
- Should the session be stored in a cookie or in a secure token returned to frontend?
- Is it acceptable to keep session active even if no order is present?
- Do we need a browser “resume” flow when the same browser reopens the site?

### Slice 2: Order Creation and Tracking
Purpose:
- capture the order payload
- persist it against the anonymous session
- expose order status for user retrieval later

Includes:
- `POST /api/orders`
- `GET /api/orders/:id`
- `GET /api/orders/my`
- status transitions
- order metadata such as print settings, pricing, amount, and queue info

Required data:
- order_id
- session_id
- status
- total_amount
- currency
- created_at
- updated_at
- print_settings
- file_count
- order_number

Questions to answer before implementation:
- What is the minimum order payload needed before payment?
- Which statuses are required initially: `draft`, `pending_payment`, `paid`, `queued`, `ready`, `handed_over`?
- Should the user be allowed to edit or cancel an unpaid order?
- Is order history required for support and debugging?

### Slice 3: File Upload and Document Storage
Purpose:
- accept uploaded Xerox-ready documents
- save file metadata in database
- store file securely until order is fulfilled

Supported document types:
- PDF
- JPG / JPEG
- PNG
- DOC / DOCX
- PPT / PPTX

Includes:
- signed URL generation for direct upload
- backend validation of file type and size
- object storage upload
- `order_files` metadata table
- cleanup on cancelled or expired orders

Required data:
- file_id
- order_id
- storage_key
- original_name
- file_size
- uploaded_at
- checksum/hash (optional)

Questions to answer before implementation:
- Do we allow only PDF, or also image docs?
- What is the maximum file size per document?
- Do we want direct browser-to-storage upload or server-to-storage upload?
- Should uploaded documents be deleted automatically after handover or kept for a retention period?

### Slice 4: Payment Flow with Demo Gateway
Purpose:
- lock payment data to an order
- process payment through a demonstration gateway
- verify payment status before print job creation

Includes:
- payment session creation
- payment confirmation callback/webhook
- duplicate-payment protection
- status update from `pending_payment` to `paid`

Required data:
- payment_id
- order_id
- gateway_reference
- status
- amount
- currency
- created_at
- paid_at

Questions to answer before implementation:
- Should payment happen only after the file is uploaded and order is valid?
- Do we want demo gateway simulation or a real provider in this phase?
- Is duplicate payment prevention required at the API level?
- What should happen if the payment is created but never confirmed?

### Slice 5: Printer Agent Registration and Queue Assignment
Purpose:
- register printer agents
- manage availability and health
- assign eligible orders to a printer

Includes:
- agent registration endpoint
- heartbeat API
- status updates
- queue assignment logic
- print job state transitions

Required data:
- printer_id
- agent_name
- location
- status
- last_seen_at
- supported_formats
- queue_length

Questions to answer before implementation:
- Do we need one printer or multiple printers?
- Is the agent local to the shop, or a remote network service?
- How do we indicate printer availability: online/offline/busy/maintenance?
- Should priority be first-in, first-out, or based on print job size/complexity?

### Slice 6: Handover and Completion Lifecycle
Status: implemented

Purpose:
- mark the job ready for collection
- confirm handover to customer
- maintain completion history

Includes:
- status update from `ready` to `handed_over`
- optional customer pickup code
- completion audit log
- retention policy

Questions to answer before implementation:
- Is handover confirmed by staff, by customer, or by both?
- Do we need a pickup PIN or code for anonymous users?
- Should the system delete files immediately after handover or keep them for a limited retention period?

## 8. Implementation rule for this project

Only one vertical slice will be implemented at a time.

Process:
1. Select one slice
2. Gather all missing requirements for that slice
3. Ask the required design questions
4. Implement the slice end-to-end
5. Validate with API and data checks
6. Only then move to the next slice

This prevents accidental backend sprawl and keeps the system manageable for a prototype-to-production transition.

## 9. Recommended first slice

The best starting point is:
- Slice 1: Anonymous Session Creation and Retrieval

Reason:
- it is foundational
- every later feature depends on it
- it solves the key requirement: “no login, but keep order state even after browser close”
- it is the cleanest first vertical slice and easiest to validate

## 10. Checklist before coding the first slice

Before implementation, we must confirm:
- session lifetime policy
- token storage pattern
- cookie or API token behavior
- expiry and cleanup policy
- relation between anonymous sessions and orders
- browser close/reopen behavior expectation

## 11. Acceptance criteria for the first slice

The first slice is “done” only when all of the following are true:
- A browser can create an anonymous session without login
- The backend stores the session server-side
- A unique session token is returned safely to the frontend
- The frontend can retrieve the same session later
- Orders are linked to the session
- Expired sessions are cleaned up
- The session persists beyond a browser tab close

## 12. Next step

We will now start with the first vertical slice only:
- Anonymous Session Creation and Retrieval

Before implementation, we must answer the required questions for that slice so the backend design matches the actual product behavior.
