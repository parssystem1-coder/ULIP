# PHASE 13 — Social Actions & Outreach (ADR-026)

> این فاز پس از فازهای 00–12 اجرا می‌شود و ماژول‌های Social Actions و Outreach
> را به‌صورت bounded context های مستقل (جدا از Discovery و AI Analysis)
> پیاده‌سازی می‌کند. مرجع‌ها: `docs/adr/ADR-026-social-actions-and-outreach.md`،
> `docs/api/API.md` §22–23، `docs/api/OPENAPI.yaml` (تگ‌های `Social Actions`
> و `Outreach`)، `database/migrations/0002_social_actions_outreach`.

## Goal

اکشن‌های اجتماعی (Open/Follow/Unfollow/Message) و outreach کمپینی با دروازهٔ
تأیید انسانی، به‌صورت provider-agnostic و صادقانه از نظر قابلیت.

## Non-goals

- هرگونه bypass (CAPTCHA، anti-bot، rate-limit evasion، cookie/session theft).
- پیام گروهی؛ bulk همیشه «یک پیام جداگانه برای هر lead» است.
- پنهان‌کردن ناتوانی: قابلیت پشتیبانی‌نشده = `NOT_SUPPORTED` + fallback دستی.

## Checklist

1. **Contracts**
   - [ ] `ActionCapability` در `@ulip/connectors`
         (`OPEN_PROFILE | FOLLOW_PROFILE | UNFOLLOW_PROFILE | SEND_MESSAGE |
         BULK_SEND_MESSAGE`) + رابط `ActionCapableConnector`.
   - [ ] `ActionProvider` port در `@ulip/social-actions` با خروجی
         `NOT_SUPPORTED` به‌جای throw برای قابلیت‌های پشتیبانی‌نشده.
2. **Social Actions service**
   - [ ] ماشین وضعیت `ACTION_TRANSITION_TABLE` (یال‌های صریح، بدون لبهٔ ضمنی).
   - [ ] Idempotency: `UNIQUE (tenant_id, idempotency_key)` + replay.
   - [ ] Guards: suppression (همیشه برنده) + cool-down تماس اخیر.
   - [ ] Attempts audit شامل `retry_after_at` (محترم، هرگز دور زده نمی‌شود).
   - [ ] Manual fallback: Open Profile → Copy Prepared Message → انجام دستی →
         `complete-manual`.
3. **Outreach**
   - [ ] قالب‌های `{{placeholder}}` با رندر سخت‌گیرانه (خطا نه پیام نصفه).
   - [ ] گیرندگان: یک ردیف به‌ازای (campaign, lead) با پیام رندرشدهٔ مخصوص خودش.
   - [ ] Eligibility: SUPPRESSED → RECENT_CONTACT → MISSING_IDENTITY →
         ACTION_NOT_SUPPORTED → LEAD_NOT_READY → TEMPLATE_ERROR.
   - [ ] جریان: Select Leads → Choose Template → Preview → Eligibility Check →
         Confirm (تطابق اعداد، وگرنه 409) → Execute → Progress → Report.
   - [ ] Retry-safe: اجرای مجدد هرگز به SENT دوباره پیام نمی‌دهد.
   - [ ] Pause/Resume/Cancel تعاونی.
4. **Database** — migration `0002_social_actions_outreach` شامل
   `social_actions`, `social_action_attempts`, `message_templates`,
   `outreach_campaigns`, `outreach_recipients`, `lead_contact_history`,
   `suppression_entries` + job type `OUTREACH` (استفاده از jobs موجود).
5. **API** — endpointهای OPENAPI.yaml (تگ‌های Social Actions و Outreach) +
   سینک `API.md`.
6. **UI** — رندر capability-aware طبق `docs/product/UX-SPEC.md` §9.
7. **Tests** — fakes فقط: `FakeActionProvider`/`FakeSocialActionPort`؛ پوشش:
   capability detection، follow/unfollow، eligibility، bulk recipients،
   idempotency، suppression، transitions، tenant isolation، provider
   failure/fallback، اکشن‌های پشتیبانی‌نشده.

## Definition of Done

```bash
cd blueprint && pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm --filter @ulip/api-contract run validate:openapi
cd ../database && npm install && npm test   # بدون Postgres: skip صادقانه
```
