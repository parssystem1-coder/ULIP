# Universal Lead Intelligence Platform

## Complete Architecture & Engineering Documentation Package

**Version:** 1.0  
**Status:** Foundation / Architecture Blueprint  
**Product:** Universal Lead Intelligence Platform (ULIP / Lead Intelligence Core)  
**Initial Data Source:** Instagram (provider-agnostic architecture)  
**Primary Goal:** Discovery, normalization, analysis, classification, scoring, evidence, human review, campaigns and export.

### Package contents

- `docs/00-master-architecture-spec.md` — complete high-level architecture specification
- `docs/01-prd.md` — Product Requirements Document
- `docs/architecture/02-technical-architecture-and-adr.md` — technical architecture and ADR decisions
- `docs/database/03-database-erd.md` — database entities, relationships, indexes and versioning
- `docs/api/04-api-contract.md` — REST/OpenAPI-oriented API contract
- `prompts/05-master-prompt-claude-code.md` — full implementation prompt for Claude Code
- `docs/implementation/06-repository-file-tree.md` — proposed implementation repository/file structure
- `docs/07-documentation-map.md` — documentation map and implementation order

### Important scope note

The package contains the complete architecture/design documents created in the conversation. It does **not** claim that the actual application source code has already been implemented. The Claude Code master prompt is an implementation instruction set; the repository file tree is the planned blueprint for the eventual codebase.

### Core architectural principle

The product is **not** an Instagram scraper. Instagram is the first connector. The core is designed as a provider-agnostic Lead Intelligence Platform so new data sources and AI providers can be added without rewriting the Domain Core.
