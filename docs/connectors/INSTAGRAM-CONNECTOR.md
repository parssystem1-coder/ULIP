# Instagram Connector Boundary

## Scope

The Instagram connector is the first source adapter. It should implement only the access paths actually available and authorized for the deployment.

## Expected conceptual capabilities

Depending on the approved integration method, the connector may support some subset of:

- profile search/discovery
- profile fetch
- supported content retrieval
- supported metadata

Capability availability must be discovered at runtime/configuration time rather than assumed.

## Normalized mapping

Potential mappings:

```text
source external id → LeadIdentity.external_id
handle/username → LeadIdentity.username
profile URL → LeadIdentity.profile_url
profile description → source/raw profile text
available location → Business.city/country with provenance
available content → LeadContent
```

## Missing fields

Do not manufacture email, phone, city, follower quality, or business specialty when the source does not provide them.

## Content sampling

The connector may provide a set of accessible content references. The analysis policy decides which items to process.

## Platform boundary

Do not add techniques whose purpose is to bypass authentication barriers, CAPTCHA, anti-bot controls, rate limits or other platform security/access controls.

## Error mapping

Source-specific errors should map into stable internal categories such as:

- temporary unavailable
- permission denied
- unsupported capability
- rate limited
- invalid request
- not found
