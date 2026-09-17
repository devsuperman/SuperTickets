# Minimal Ticket MVP Plan

## Goal

Build the smallest possible ticket-selling website that still exercises the following technologies:

- Cache
- Message broker
- Load balancer
- API gateway
- Microservices

The goal is learning and testing architecture patterns, not building a full production ticket marketplace.

## Scope reduction

Keep the MVP focused on a single business flow:

- Admin creates a simple event
- Customer views available events
- Customer buys tickets
- Payment is simulated
- Order success triggers async processing
- Ticket confirmation is generated

Remove everything that is not necessary for the technology learning goals:

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

## Architecture

### Services

1. API Gateway
   - Exposes public endpoints
   - Routes traffic to the right service
   - Centralizes authentication/rate limiting if needed

2. Event Catalog Service
   - Owns event data
   - Returns event list and event details
   - Reads from a database and caches popular results

3. Inventory Service
   - Owns ticket stock
   - Handles reservation and release logic
   - Protects against overselling

4. Order Service
   - Creates orders
   - Validates request data
   - Calls inventory
   - Publishes order events

5. Payment/Notification Worker
   - Subscribes to events from the message broker
   - Simulates payment processing
   - Publishes success/failure events
   - Sends or logs notifications

### Supporting infrastructure

1. Cache: Redis
   - cache event list and details
   - show cache population and invalidation behavior

2. Message broker: RabbitMQ or Kafka
   - event-driven communication between services
   - demo async processing and decoupling

3. Load balancer: NGINX or Traefik
   - run 2 instances of one service behind one endpoint
   - demonstrate round-robin or failover behavior

4. Database: PostgreSQL
   - keep one database per service for a clean microservice example

5. Docker Compose
   - run all services locally for learning and testing

## Minimal API surface

### Public routes

- GET /events
- GET /events/{id}
- POST /orders
- GET /orders/{id}

If needed, also add:

- POST /admin/events
- PUT /admin/events/{id}

## Example request flow

1. Client calls API Gateway: GET /events
2. Gateway forwards to Catalog Service
3. Catalog Service reads from Redis cache
4. Customer calls POST /orders with event id + quantity
5. Order Service checks inventory
6. Inventory Service reserves stock
7. Order is created and OrderCreated event is published
8. Payment worker consumes the event and simulates payment
9. If payment succeeds, a confirmation event is published
10. Notification worker logs or sends the ticket confirmation

## Learning goals

This MVP should help test these concepts:

- how microservices split responsibilities
- how cache reduces read load
- how async messages decouple services
- how API gateway centralizes routing
- how a load balancer distributes traffic across service instances
- how inventory consistency is handled across services

## Success criteria

The MVP is successful if you can demonstrate:

- event listing works from the public API
- a customer can successfully buy a ticket
- two orders cannot oversell the final ticket
- an order triggers an async worker event
- cache is used for catalog reads
- requests can be balanced across service instances
- the system works through the gateway, not direct service access

## Recommended first implementation milestone

Build only this:

- one admin creates one event
- one customer buys one or more tickets
- one inventory service enforces stock
- one order service emits an event
- one payment worker consumes the event
- one catalog service uses Redis cache
- one gateway exposes the service layer
- one load balancer spreads requests to two instances of the order or catalog service

This is the smallest realistic architecture for learning.

## Next steps

1. Define the exact service contracts
2. Define the database schemas for each service
3. Create a Docker Compose file for local orchestration
4. Build the Catalog Service
5. Build the Inventory Service
6. Build the Order Service
7. Add the broker and worker
8. Add Redis cache and gateway
9. Add load balancing and test with multiple instances

## Final recommendation

Do not build a complete ticket marketplace. Build a minimal event ticket flow that proves the architecture patterns. This is the best way to learn the technologies in a realistic but manageable setup.
