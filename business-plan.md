# Business Plan

Smallest realistic ticket-selling flow. Architecture lives in [tech-plan.md](tech-plan.md).

## Scope

1. Admin creates an event.
2. Customer lists events and buys tickets.
3. Payment is simulated.
4. A successful order triggers async processing.
5. Tickets are generated and a confirmation is sent.

## Rules

### Events

1. An event has name, date, venue, total tickets and price.
2. Name, venue and price must be valid; date must be in the future; total tickets > 0.
3. Admin can update an event until it starts.
4. Admin cannot set total tickets below those already sold.

### Customers

1. Search and list upcoming events; view details.
2. Add tickets to a cart; order one or more tickets.
3. Only available tickets can be bought.

### Inventory

1. Available = total − sold.
2. Zero stock → not purchasable.
3. Two customers cannot buy the last ticket.
4. Failed payment releases the reservation.

### Orders and payment

1. Order received → stock reserved → payment simulated.
2. Status: `pending` → `paid` or `cancelled`.
3. A `pending` order older than N minutes is cancelled and its stock released.

### Events and processing

1. Order created → `OrderCreated`.
2. Payment worker consumes it → `PaymentSucceeded` or `PaymentFailed` (+ release stock).
3. Notification worker consumes `PaymentSucceeded` → generates tickets, sends confirmation.

### Tickets

One per ticket bought: id, event id, guest reference, status (`valid`, `used`, `cancelled`).

## MVP decisions

| Topic | Decision |
|---|---|
| Identity | No accounts. Guest identified by checkout email (the guest reference). |
| Search | Case-insensitive match on name or venue, upcoming events only. |
| Cart | Browser only, one event per cart; checkout = one order. |
| Order size | One event, 1–10 tickets. |
| Price | Displayed only; orders store no amount. |
| Admin | One shared API key. |
| "Sold" | Includes tickets reserved by pending orders. |
| N | 5 minutes, configurable. |
| Ticket status | Always created `valid`; nothing changes it in the MVP. |
