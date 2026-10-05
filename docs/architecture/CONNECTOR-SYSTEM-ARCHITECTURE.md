# Connector System Architecture

## 1. Purpose

A Connector adapts a specific source into ULIP's universal contracts. It does not own lead business logic.

## 2. Connector responsibilities

- source-specific discovery where permitted
- fetching supported entity data
- mapping source identifiers
- reporting capabilities
- handling source-specific errors
- respecting access constraints
- returning RawEntity / source-native records

## 3. Connector non-responsibilities

A connector must not:

- decide final taxonomy classification
- calculate global scoring
- send campaign messages
- modify another connector's data
- bypass access/security controls

## 4. Capability model

A connector declares capabilities such as:

```text
profile_search
profile_fetch
content_fetch
location
engagement_metadata
public_business_metadata
```

The application must test capability availability rather than assuming every source supports every field.

## 5. Source identity

Every connector operation must retain:

- source type
- source account (where applicable)
- external identifier
- canonical/source URL where permitted
- collected timestamp

## 6. Partial data

Fields can be:

- AVAILABLE
- PARTIAL
- UNAVAILABLE
- INFERRED

Inference must be marked as inference and should link to evidence.

## 7. Future connector plugins

The connector registry should be capable of resolving connectors by source type and version. A future marketplace may package connectors without changing the Lead Core.
