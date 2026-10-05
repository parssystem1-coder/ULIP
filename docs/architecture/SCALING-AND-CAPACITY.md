# Scaling and Capacity Strategy

## 1. Starting assumption

The first deployment can run as a modular monolith with PostgreSQL, Redis/BullMQ and object storage. Capacity decisions should be driven by measurements.

## 2. Primary load dimensions

- candidates discovered per hour
- content items per candidate
- AI calls per candidate
- average AI latency
- review throughput
- list/filter QPS
- export volume
- object-storage growth

## 3. Scaling levers

### Discovery
Add worker concurrency while respecting source constraints.

### AI
Separate queues/providers by latency/cost class. Cache or hash-identical analysis inputs where policy permits.

### Database
Indexes first; partition large append-heavy tables only when measured query/write patterns justify it.

### Object storage
Store media outside PostgreSQL.

### API
Horizontal scale web/API processes after session/transaction assumptions are stateless enough.

## 4. Backpressure

Every queue needs bounded concurrency and failure visibility. Discovery must not enqueue unlimited AI work before capacity is known.

## 5. Reliability targets

Define service objectives after baseline measurements. Do not invent a hard SLA for an MVP without production data.

## 6. Migration to services

Candidate service boundaries:

- discovery workers
- AI processing service
- export service

Extraction should happen only when operationally useful.
