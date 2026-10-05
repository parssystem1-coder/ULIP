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

## Social action capabilities (ADR-026)

Action capabilities are advertised ONLY when the authorized integration
genuinely performs them. For the currently authorized Instagram boundary:

| Action | Status | Notes |
| --- | --- | --- |
| `OPEN_PROFILE` | **SUPPORTED** | Opening a profile is a navigation to the lead's public profile URL — no mutation, no bypass. |
| `FOLLOW_PROFILE` | **NOT_SUPPORTED** | No authorized follow API in the current integration → `NOT_SUPPORTED` + manual fallback. |
| `UNFOLLOW_PROFILE` | **NOT_SUPPORTED** | Same boundary as follow. |
| `SEND_MESSAGE` | **NOT_SUPPORTED** | No authorized DM API in the current integration → `NOT_SUPPORTED` + manual fallback. |
| `BULK_SEND_MESSAGE` | **NOT_SUPPORTED** | Orchestration of an unsupported capability. |

If the authorized integration later gains a genuine, documented follow/DM API
(official Graph-API paths under an approved permission set), the connector may
start advertising the capability and implement it through that API only. Until
then the manual fallback applies:

```text
Open Profile → Copy Prepared Message → user performs the action manually → mark completed
```

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
