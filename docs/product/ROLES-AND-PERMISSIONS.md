# Roles and Permissions

## Roles

### Owner
Full tenant administration, sources, AI configuration, taxonomy, users, billing/usage visibility, campaigns and audit access.

### Admin
Operational administration except ownership/billing-transfer functions.

### Analyst
Discovery, lead analysis, scoring inspection, review, campaigns and exports according to tenant policy.

### Reviewer
Review queue, corrections and evidence inspection. No source credentials administration.

### Viewer
Read-only access to leads/campaigns permitted by tenant policy.

## Permission namespaces

```text
sources.read
sources.manage
sources.credentials.manage

discovery.run
discovery.read

leads.read
leads.analyze
leads.edit
leads.delete

reviews.read
reviews.execute

 taxonomy.read
taxonomy.manage

campaigns.read
campaigns.manage

exports.create

ai.read
ai.manage
usage.read
audit.read
users.manage
tenant.manage
```

Permissions are checked in the application layer and never inferred from UI visibility.

Tenant ID must come from the authenticated context, not from an arbitrary user-supplied path/body value when the operation is tenant-scoped.
