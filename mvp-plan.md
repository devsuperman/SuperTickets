# Minimal Ticket MVP Plan

## Goal

Model the smallest realistic ticket-selling flow: an admin creates an event, a customer browses and buys tickets, payment is simulated, and a ticket confirmation is generated. Business rules and scope live here; architecture and stack choices live in [tech-plan.md](tech-plan.md).

## Scope reduction

Keep the MVP focused on a single business flow:

- Admin creates a simple event
- Customer views available events
- Customer buys tickets
- Payment is simulated
- Order success triggers async processing
- Ticket confirmation is generated

Remove everything that is not necessary for that flow:

- No multi-tenant organizers
- No coupons or discounts
- No seat maps
- No refunds for v1
- No complex admin dashboard
- No real payment provider integration
- No email provider integration
- No tax/VAT logic
- No multi-event organizer management

## Business rules

### Event management

1. Admin can create an event with:
   - name
   - date
   - venue
   - total available tickets
   - price per ticket

2. A published event must have:
   - a valid name
   - a valid date in the future
   - a valid venue
   - available quantity greater than zero
   - a valid price

3. Admin can update event information before the event starts.

4. Admin cannot reduce the ticket quantity below the number already sold.

### Customer actions

1. A customer can search and list available events.
2. A customer can view event details.
3. A customer can add tickets to a cart.
4. A customer can place an order for one or more tickets.
5. A customer can only buy tickets that are still available.

### Inventory rules

1. Available tickets = total tickets - sold tickets.
2. If stock is zero, the event is not purchasable.
3. Two customers cannot buy the last ticket at the same time.
4. If payment fails, reserved inventory must be released.

### Payment flow

1. The system receives the order.
2. Inventory is checked and reserved.
3. Payment is simulated successfully or fails.
4. Order status moves from pending to paid or cancelled.

### Messaging and processing

1. When an order is created, the system publishes an OrderCreated event.
2. A payment worker consumes the event and simulates payment processing.
3. If payment succeeds, it publishes PaymentSucceeded.
4. If payment fails, it publishes PaymentFailed and releases inventory.
5. A notification worker consumes the success event and sends a confirmation message.

### Ticket generation

1. After successful payment, the system generates ticket records.
2. Each ticket contains:
   - ticket id
   - event id
   - customer id or guest reference
   - status: valid, used, cancelled
