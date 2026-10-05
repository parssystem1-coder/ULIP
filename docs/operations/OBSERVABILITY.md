# Observability

## Traces

Trace API request → application use case → queue job → connector/AI → persistence.

## Metrics

### API
- request count
- latency
- 4xx/5xx rate

### Discovery
- candidates discovered
- success/partial/failure
- processing duration

### AI
- calls by provider/model/task
- latency
- token/usage metadata
- estimated cost
- schema failure rate
- fallback rate

### Review
- review volume
- acceptance/correction rate
- disagreement by taxonomy

### Queue
- depth
- active
- failed
- retry count
- oldest waiting job

## Logs

Structured JSON logs with request/job/tenant identifiers. Never log secrets or unnecessary raw personal/source content.
