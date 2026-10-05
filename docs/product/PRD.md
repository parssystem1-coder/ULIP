# PRD — Universal Lead Intelligence Platform

**Version:** 1.0  
**Status:** Approved Foundation  
**Product Type:** SaaS / Lead Intelligence  
**Initial Source:** Instagram  
**Architecture Goal:** Multi-Source / Provider-Agnostic / AI-Native

# 1. Product Vision

Universal Lead Intelligence Platform یک سیستم هوشمند برای:

- کشف Lead
- جمع‌آوری داده
- نرمال‌سازی
- حذف داده‌های تکراری
- تحلیل پروفایل
- تحلیل محتوای قابل دسترسی
- طبقه‌بندی کسب‌وکار
- تشخیص تخصص
- ارزیابی فعالیت
- تخمین کیفیت مخاطب
- امتیازدهی
- ارائه Evidence
- Human Review
- ساخت گروه‌های هدف
- Export / CRM

است.

سیستم نباید به Instagram وابسته باشد.

Instagram فقط اولین Data Source است.

# 2. Product Problem

روش سنتی Lead Generation معمولاً چنین است:

```text
Search
↓
Open profile
↓
Read bio
↓
Look at posts
↓
Decide manually
↓
Save
```

این فرآیند:

- زمان‌بر است.
- مقیاس‌پذیر نیست.
- تصمیم‌گیری آن یکنواخت نیست.
- امکان خطای انسانی دارد.
- مقایسه Leadها دشوار است.

محصول باید این فرآیند را به:

```text
Discover
↓
Analyze
↓
Classify
↓
Score
↓
Explain
↓
Review
```

تبدیل کند.

# 3. Target Users

## Primary User

فرد یا کسب‌وکاری که برای تبلیغات و بازاریابی نیاز به پیدا کردن مشتری/کسب‌وکار هدف دارد.

مثال:

- شرکت تبلیغاتی
- آژانس دیجیتال مارکتینگ
- فروشنده خدمات
- فروشنده B2B
- Freelancer
- تیم Sales
- Lead Generation Specialist

# 4. Primary Use Case

کاربر می‌گوید:

> آرایشگران شیراز که در رنگ و لایت تخصص دارند و فعالیت خوبی دارند.

سیستم باید بتواند:

```text
Business Type = Service Provider
Industry = Beauty
Specialty = Hair Coloring
City = Shiraz
Activity >= User Threshold
```

را استخراج و اجرا کند.

# 5. Secondary Use Cases

### وکلا

```text
Legal
├── Family
├── Criminal
├── Property
├── Immigration
└── Corporate
```

### پزشکان

```text
Medical
├── Dermatology
├── Dentistry
├── Cosmetic
└── ...
```

### املاک

```text
Real Estate
├── Residential
├── Commercial
├── Rental
└── Investment
```

Taxonomy باید Dynamic باشد.

# 6. Product Principles

## Principle 1 — Source Agnostic

Core نباید وابسته به Instagram باشد.

## Principle 2 — AI Is Not Truth

AI prediction است، نه حقیقت قطعی.

## Principle 3 — Evidence First

تصمیم‌های مهم باید قابل توضیح باشند.

## Principle 4 — Human Control

کاربر باید بتواند نتیجه AI را اصلاح کند.

## Principle 5 — Provider Independence

هیچ مدل AI نباید به‌صورت Hard Dependency وارد Core شود.

## Principle 6 — No Platform Bypass

سیستم برای دور زدن CAPTCHA، Rate Limit، Anti-Bot یا دسترسی‌های غیرمجاز طراحی نمی‌شود.

# 7. MVP Scope

## Included

- Source Management
- Instagram Connector
- Discovery
- Raw Data Storage
- Normalization
- Deduplication
- Taxonomy
- LLM Analysis
- Vision Analysis
- Jev Decision Provider
- Evidence
- Lead Scoring
- Audience Quality
- Business Activity
- Confidence
- Human Review
- Campaign
- CSV Export
- Audit Log
- AI Usage Tracking

# 8. Out of Scope MVP

- Automatic mass messaging
- GNN
- Advanced Knowledge Graph
- Full PARSE implementation
- Microservices
- Plugin Marketplace
- Autonomous Agent Swarm
- Complex CRM
- Automated sales workflow

# 9. Lead Lifecycle

```text
DISCOVERED
    ↓
NORMALIZED
    ↓
ANALYZED
    ↓
SCORED
    ↓
REVIEW_REQUIRED
    ↓
QUALIFIED
    ↓
CAMPAIGN
```

Alternative:

```text
ANALYZED
   ↓
REJECTED
```

# 10. Lead Data

هر Lead حداقل باید بتواند این اطلاعات را داشته باشد:

- Name
- Username
- Source
- External ID
- Profile URL
- Business Type
- Industry
- Specialty
- City
- Country
- Activity
- Relevance
- Audience Quality
- Confidence
- Evidence
- Status

# 11. Scoring

چهار Score اصلی:

### Lead Relevance

ارتباط Lead با هدف کاربر.

### Audience Quality

ارزیابی کیفیت احتمالی مخاطبان.

### Business Activity

میزان فعالیت کسب‌وکار.

### Data Confidence

اعتماد سیستم به داده و تحلیل.

سپس:

### Overall Priority

ترکیبی از موارد بالا.

فرمول باید Configurable باشد.

# 12. Audience Quality

سیستم نباید به‌صورت قطعی بگوید:

> 73% Followers Fake

مگر اینکه داده معتبر و روش معتبر چنین نتیجه‌ای بدهد.

خروجی استاندارد:

```text
Audience Quality: 78
Audience Risk: Medium
```

به همراه Evidence.

# 13. Content Analysis

در صورت دسترسی مجاز:

- Bio
- Captions
- Images
- Public Content Metadata
- Representative Content

تحلیل می‌شوند.

سیستم نباید الزاماً همه محتوا را پردازش کند.

# 14. AI Pipeline

```text
Raw Data
   ↓
Deterministic Rules
   ↓
LLM Extraction
   ↓
Vision Analysis
   ↓
Jev Decision
   ↓
Evidence Validation
   ↓
Scoring
   ↓
Human Review
```

# 15. Natural Language Search

کاربر بتواند به زبان طبیعی جستجو کند.

مثلاً:

> وکلای خانواده در شیراز با فعالیت بالا

سیستم باید آن را به Query ساختاری تبدیل کند.

# 16. Campaign

Campaign برای گروه‌بندی Leadها است.

مثلاً:

```text
Campaign:
Shiraz Beauty

Groups:
Hair Coloring
Keratin
Makeup
Nails
Bridal
```

# 17. Manual Outreach

MVP فقط Lead Intelligence ارائه می‌دهد.

کاربر خودش Leadهای انتخاب‌شده را برای ارتباط دستی استفاده می‌کند.

هیچ سیستم ارسال خودکار پیام در Core وجود ندارد.

# 18. Human Review

کاربر باید بتواند:

- Accept
- Reject
- Change Business Type
- Change Industry
- Change Specialty
- Change City
- Correct Score
- Mark AI Wrong

انجام دهد.

# 19. Feedback

هر اصلاح کاربر ذخیره می‌شود.

مثلاً:

```text
AI:
Hair Coloring

Human:
Balayage
```

این داده برای:

- Evaluation
- Calibration
- Prompt Improvement
- Model Comparison

استفاده می‌شود.

# 20. Search & Filtering

فیلترهای MVP:

- Source
- Business Type
- Industry
- Specialty
- City
- Country
- Activity
- Relevance
- Audience Quality
- Confidence
- Status

# 21. Dashboard

Dashboard شامل:

```text
Total Leads
New Leads
Qualified Leads
Needs Review
Rejected
High Priority
AI Usage
AI Cost
```

# 22. Export

فرمت‌های اولیه:

- CSV
- Excel
- JSON

# 23. Future Integrations

پس از MVP:

- Google Maps
- Websites
- LinkedIn
- YouTube
- Facebook
- CRM
- External APIs

# 24. Success Metrics

## Product Metrics

- Leads discovered
- Leads analyzed
- Qualified leads
- Review rate
- Export rate

## AI Metrics

- Classification accuracy
- Precision
- Recall
- F1
- Human correction rate
- Confidence calibration

## Technical Metrics

- Processing latency
- Error rate
- Cost per Lead
- Connector success rate

# 25. MVP Definition of Done

MVP زمانی Done است که:

- Source فعال باشد.
- Discovery کار کند.
- Raw Data ذخیره شود.
- Lead ساخته شود.
- Deduplication کار کند.
- Taxonomy فعال باشد.
- AI Extraction کار کند.
- Vision Analysis کار کند.
- Jev Provider قابل استفاده باشد.
- Evidence ذخیره شود.
- Scores محاسبه شوند.
- Human Review وجود داشته باشد.
- Campaign ایجاد شود.
- Export کار کند.
- Audit Log فعال باشد.
- AI Usage ثبت شود.

# 26. Long-Term Product

محصول در نهایت باید از:

> Instagram Lead Finder

به:

> Universal Lead Intelligence Platform

تبدیل شود.

Architecture باید از روز اول برای این آینده آماده باشد.

# 27. Social Actions & Outreach (ADR-026)

فاز محصولی Social Actions + Outreach به‌صورت ماژول مستقل (جدا از Discovery و
AI Analysis) اضافه شده است:

- **اکشن‌های اجتماعی**: Open Profile، Follow، Unfollow، Message — با گزارش
  قابلیت صادقانه؛ فقط اکشن‌های واقعاً پشتیبانی‌شده در UI قابل‌اجرا هستند و
  بقیه با fallback دستی (Open Profile → Copy Prepared Message → انجام دستی).
- **Outreach کمپینی**: قالب پیام، انتخاب leadها بر اساس مدل جهانی
  (Business Type → Industry → Specialty → Sub-specialty + Location)،
  پیش‌نمایش، بررسی واجد شرایطی، **تأیید صریح انسانی**، اجرای bulk به‌صورت
  **یک پیام جداگانه برای هر lead (هرگز group chat نیست)**، پیشرفت و گزارش.
- **ایمنی**: suppression همیشه برنده است؛ فاصلهٔ تماس (cool-down) جلوی پیام
  تکراری را می‌گیرد؛ retry-after پرووایدر محترم شمرده می‌شود؛ همهٔ اکشن‌ها
  tenant-scoped، permission-controlled، auditable، idempotent و retry-safe.

جزئیات: `docs/adr/ADR-026-social-actions-and-outreach.md`،
`docs/api/API.md` (§22–23)، `database/migrations/0002_social_actions_outreach`.
