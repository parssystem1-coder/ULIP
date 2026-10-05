# Universal Lead Intelligence Platform
## مستند معماری جامع محصول، سیستم و هوش مصنوعی

**نسخه:** 1.0  
**وضعیت:** Architecture Draft / Foundation Specification  
**نوع محصول:** SaaS / Lead Intelligence Platform  
**تمرکز اولیه:** کشف، تحلیل، طبقه‌بندی و اولویت‌بندی لیدها  
**منابع اولیه:** Instagram و منابع عمومی/مجاز  
**طراحی:** Multi-Source / Provider-Agnostic / AI-Native

---

# 1. چشم‌انداز محصول

هدف این پروژه ساخت یک پلتفرم هوشمند برای **کشف، جمع‌آوری، تحلیل، طبقه‌بندی، ارزیابی و اولویت‌بندی لیدهای تجاری** است.

سیستم نباید به یک پلتفرم خاص وابسته باشد.

برای مثال، Instagram فقط یکی از منابع داده است:

- Instagram
- Google Maps
- LinkedIn
- Facebook
- YouTube
- وب‌سایت‌ها
- دایرکتوری‌های کسب‌وکار
- CSV / Excel
- APIهای شخص ثالث
- منابع دیگری که در آینده اضافه خواهند شد

هسته سیستم تمام این منابع را به یک مدل داده استاندارد تبدیل می‌کند.

بنابراین:

```text
Source
   ↓
Connector
   ↓
Raw Data
   ↓
Normalization
   ↓
AI Analysis
   ↓
Classification
   ↓
Scoring
   ↓
Evidence
   ↓
Lead Intelligence
   ↓
Human Review
   ↓
Campaign / Export / CRM
```

---

# 2. مسئله‌ای که سیستم حل می‌کند

فرض کنیم کاربر می‌خواهد برای تبلیغات خود، آرایشگران شهر شیراز را پیدا کند.

جستجوی ساده فقط ممکن است تعدادی صفحه پیدا کند.

اما سیستم ما باید بتواند تشخیص دهد:

```text
آرایشگر
 ├── رنگ و لایت
 ├── کراتین
 ├── میکاپ
 ├── شینیون
 ├── ناخن
 ├── مژه
 ├── ابرو
 └── خدمات عروس
```

و سپس مثلاً نتیجه بدهد:

```text
نام: Example Beauty
Username: @example
شهر: شیراز
دسته: Beauty
تخصص: Hair Coloring / Balayage

Lead Relevance: 94
Business Activity: 91
Audience Quality: 82
Data Confidence: 96

Priority: High
Status: Ready for Review
```

همین سیستم باید برای حوزه‌های دیگر نیز کار کند:

```text
Legal
 ├── Family
 ├── Criminal
 ├── Property
 ├── Immigration
 ├── Corporate
 └── Commercial
```

Taxonomy نباید Hardcoded باشد.

---

# 3. اصل معماری اصلی

مهم‌ترین اصل پروژه:

> Core نباید بداند داده از کدام پلتفرم آمده است.

به‌عنوان مثال Core نباید منطق خاصی مانند:

```text
if Instagram:
   ...
```

داشته باشد.

در عوض:

```text
InstagramConnector
GoogleMapsConnector
LinkedInConnector
WebsiteConnector
CsvConnector
```

هرکدام داده را به مدل استاندارد تبدیل می‌کنند.

---

# 4. معماری High-Level

```text
                         ┌───────────────────────┐
                         │       Frontend        │
                         │   Next.js / React     │
                         └───────────┬───────────┘
                                     │
                                     ↓
                         ┌───────────────────────┐
                         │       API Layer       │
                         │       NestJS          │
                         └───────────┬───────────┘
                                     │
             ┌───────────────────────┼────────────────────────┐
             ↓                       ↓                        ↓
      Source Manager           Lead Intelligence        Campaigns
             │                       │                        │
             ↓                       ↓                        ↓
       Connectors              AI Gateway               Export/API
             │                       │
      ┌──────┼──────┐         ┌─────┼─────────┐
      ↓      ↓      ↓         ↓     ↓         ↓
 Instagram Google  CSV       LLM  Vision     Jev
          ...                 │
                              ↓
                         Embeddings
                              │
                              ↓
                       Evidence Engine
                              │
                              ↓
                       Scoring Engine
                              │
                              ↓
                         Lead Database
```

---

# 5. لایه‌های اصلی سیستم

سیستم به بخش‌های زیر تقسیم می‌شود:

## 5.1 Source Layer

مدیریت منابع داده.

مسئولیت‌ها:

- تعریف Source
- فعال/غیرفعال کردن Source
- احراز هویت Connector در صورت نیاز
- مدیریت وضعیت Connector
- اجرای Discovery
- دریافت Raw Data
- مدیریت خطا
- Rate Limit داخلی
- ثبت Source Metadata

---

## 5.2 Connector Layer

هر پلتفرم یک Connector مستقل است.

Interface عمومی:

```typescript
interface LeadSourceConnector {
  getMetadata(): SourceMetadata;

  search(request: SearchRequest): Promise<SearchResult>;

  fetchEntity(
    identifier: string
  ): Promise<RawEntity | null>;

  healthCheck(): Promise<HealthStatus>;
}
```

Connector نباید منطق AI داشته باشد.

وظیفه Connector فقط:

```text
Discover
Fetch
Normalize basic fields
Return data
```

است.

---

# 6. Source Provider Architecture

ساختار پیشنهادی:

```text
SourceManager
    │
    ├── InstagramProvider
    ├── GoogleMapsProvider
    ├── LinkedInProvider
    ├── FacebookProvider
    ├── YouTubeProvider
    ├── WebsiteProvider
    ├── CsvProvider
    └── FutureProvider
```

هر Provider باید مستقل باشد.

بنابراین حذف یک Provider نباید Core را خراب کند.

---

# 7. Instagram Connector

Instagram اولین Connector پروژه خواهد بود.

وظایف:

- دریافت داده‌های قابل دسترسی و مجاز
- دریافت Profile Information
- دریافت محتوای قابل تحلیل در صورت دسترسی
- استخراج Metadata
- تحویل داده به Normalizer

سیستم نباید برای:

- دور زدن CAPTCHA
- دور زدن Rate Limit
- سرقت Session
- استخراج Cookie
- عبور از سیستم‌های Anti-Bot
- دور زدن محدودیت‌های دسترسی

طراحی شود.

اگر داده‌ای قابل دسترسی نیست، Connector باید همان محدودیت را گزارش کند.

مثلاً:

```json
{
  "status": "PARTIAL",
  "reason": "DATA_NOT_AVAILABLE",
  "source": "instagram"
}
```

---

# 8. Raw Data Layer

داده اولیه هرگز نباید مستقیماً روی داده نهایی نوشته شود.

دو لایه داریم:

```text
Raw Data
   ↓
Normalized Data
```

مثلاً:

```text
RawInstagramProfile
```

و سپس:

```text
Lead
```

این موضوع برای Debugging و Reprocessing بسیار مهم است.

---

# 9. Lead Entity

مدل اصلی:

```text
Lead
```

نمونه:

```json
{
  "id": "lead_123",
  "source": "instagram",
  "externalId": "abc123",
  "username": "example",
  "displayName": "Example Beauty",
  "description": "...",
  "location": {
    "city": "Shiraz",
    "country": "Iran"
  },
  "category": {
    "id": "beauty"
  },
  "status": "ACTIVE"
}
```

---

# 10. Lead Identity و Deduplication

یک کسب‌وکار ممکن است در چند منبع وجود داشته باشد.

مثلاً:

```text
Instagram
Google Maps
Website
Facebook
```

نباید چهار Lead مستقل ساخته شود.

سیستم باید:

```text
Entity Resolution
+
Deduplication
```

داشته باشد.

مدل پیشنهادی:

```text
Business Entity
      │
      ├── Instagram Identity
      ├── Google Identity
      ├── Website Identity
      └── LinkedIn Identity
```

---

# 11. Normalization

هدف Normalization تبدیل داده‌های مختلف به یک ساختار واحد است.

مثلاً:

```text
Hairdresser
Hair Salon
Beauty Salon
آرایشگاه زنانه
سالن زیبایی
```

ممکن است همه به:

```text
Beauty > Hair
```

متصل شوند.

Normalization شامل:

- نام
- شهر
- کشور
- دسته
- تخصص
- زبان
- شماره تلفن در صورت مجاز بودن
- Website
- Social Links
- Content Metadata

است.

---

# 12. Taxonomy Engine

Taxonomy یکی از مهم‌ترین بخش‌های سیستم است.

Taxonomy باید:

- Dynamic
- Hierarchical
- Versioned
- قابل توسعه
- قابل ویرایش توسط Admin

باشد.

مثلاً:

```text
Beauty
 ├── Hair
 │   ├── Hair Coloring
 │   ├── Balayage
 │   ├── Keratin
 │   └── Hair Extensions
 │
 ├── Makeup
 │   ├── Bridal Makeup
 │   └── Professional Makeup
 │
 ├── Nails
 ├── Eyelashes
 └── Eyebrows
```

و:

```text
Legal
 ├── Family
 ├── Criminal
 ├── Property
 ├── Immigration
 ├── Corporate
 └── Commercial
```

کاربر نیز بتواند Taxonomy جدید بسازد.

---

# 13. Content Analysis

سیستم فقط Bio را تحلیل نمی‌کند.

در صورت دسترسی مجاز، می‌تواند نمونه‌ای از Content را بررسی کند:

```text
Profile
   ↓
Bio
   ↓
Recent Posts
   ↓
Images
   ↓
Captions
   ↓
Video Metadata / Frames
```

اما نباید الزاماً تمام محتوا را تحلیل کند.

---

# 14. Sampling Strategy

به جای:

```text
Analyze 1000 posts
```

سیستم می‌تواند:

```text
Bio
+
Recent 5 posts
+
Representative posts
+
Relevant visual samples
```

را بررسی کند.

اگر نتیجه Confidence پایین باشد:

```text
Additional Analysis
```

فعال شود.

این باعث کاهش هزینه AI می‌شود.

---

# 15. Multimodal AI

برای تحلیل Content از ترکیب:

```text
Text LLM
+
Vision Model
```

استفاده می‌شود.

مثلاً عکس می‌تواند نشانه‌هایی از:

- رنگ مو
- بالیاژ
- کراتین
- میکاپ
- ناخن
- شینیون

داشته باشد.

اما مدل نباید صرفاً بر اساس یک تصویر، ادعای قطعی ایجاد کند.

---

# 16. Structured Extraction

AI نباید فقط متن آزاد تولید کند.

خروجی باید Structured باشد.

مثلاً:

```json
{
  "profession": "beauty",
  "specialties": [
    "hair_coloring",
    "balayage"
  ],
  "city": "Shiraz",
  "business_activity": 0.91,
  "confidence": 0.94
}
```

Schema باید با JSON Schema / Pydantic اعتبارسنجی شود.

---

# 17. Evidence System

هر نتیجه AI باید Evidence داشته باشد.

مثلاً:

```text
Specialty = Hair Coloring

Evidence:
- Bio: "رنگ و لایت تخصصی"
- Post #17: visual evidence
- Caption: "نمونه کار رنگ مو"
```

مدل:

```text
Evidence
 ├── source
 ├── type
 ├── content
 ├── location
 ├── timestamp
 ├── modelVersion
 └── confidence
```

اصل مهم:

> هیچ تصمیم مهمی نباید بدون Evidence قابل بررسی باشد.

---

# 18. AI Gateway

تمام مدل‌های AI از یک Gateway عبور می‌کنند.

```text
AI Gateway
 ├── LLM Provider
 ├── Vision Provider
 ├── Jev Provider
 ├── Embedding Provider
 └── Future Providers
```

بنابراین Core نباید مستقیماً به OpenAI، Anthropic، Gemini، Jev و غیره وابسته شود.

---

# 19. LLM Adapter

Interface:

```typescript
interface LLMProvider {
  classify(input: ClassificationInput): Promise<ClassificationResult>;

  extract(
    input: ExtractionInput
  ): Promise<StructuredExtraction>;

  analyze(
    input: AnalysisInput
  ): Promise<AnalysisResult>;
}
```

Providerهای آینده:

```text
Anthropic
OpenAI
Gemini
GLM
Local Models
Other Providers
```

---

# 20. Vision Adapter

```typescript
interface VisionProvider {
  analyzeImage(
    image: ImageInput
  ): Promise<VisualAnalysis>;

  analyzeImages(
    images: ImageInput[]
  ): Promise<VisualAnalysis[]>;
}
```

---

# 21. Jev Decision Layer

Jev نباید جایگزین LLM باشد.

تقسیم وظایف:

```text
LLM
→ Understanding

Vision
→ Visual Understanding

Jev
→ Bounded Decision

Code
→ Deterministic Logic
```

مثلاً LLM می‌گوید:

```text
Possible specialties:
Hair Coloring
Balayage
Hair Styling
```

Jev می‌تواند در یک Decision Space مشخص تصمیم بگیرد:

```text
Which specialty is most likely?

A = Hair Coloring
B = Balayage
C = Hair Styling
D = Unknown
```

خروجی:

```json
{
  "A": 0.62,
  "B": 0.29,
  "C": 0.07,
  "D": 0.02
}
```

---

# 22. Jev Cascade

برای همه لیدها نباید همه مراحل AI اجرا شود.

Pipeline:

```text
Deterministic Filter
       ↓
High Confidence?
   ├── YES → Accept
   └── NO
        ↓
       Jev
        ↓
High Confidence?
   ├── YES → Accept
   └── NO
        ↓
     Strong LLM
        ↓
Human Review
```

این معماری هزینه را کاهش می‌دهد.

---

# 23. Deterministic Rules

AI نباید کاری را انجام دهد که Code بهتر انجام می‌دهد.

مثلاً:

```text
followers < 100
```

یا:

```text
city != Shiraz
```

یا:

```text
last_activity > X days
```

اگر قانون قطعی است:

```text
Code
```

باید تصمیم بگیرد.

نه LLM.

---

# 24. Lead Relevance

این امتیاز نشان می‌دهد این Lead چقدر برای هدف کاربر مناسب است.

مثلاً:

```text
Lead Relevance = 92/100
```

ممکن است از این عوامل ساخته شود:

```text
Business Type Match
+
Industry Match
+
Specialty Match
+
Location Match
+
Business Activity
+
Content Relevance
```

---

# 25. Audience Quality

Audience Quality با Lead Relevance متفاوت است.

مثلاً:

```text
Lead A

Relevance: 95
Audience Quality: 65
```

ممکن است کسب‌وکار کاملاً مرتبط باشد، اما کیفیت مخاطبان پایین‌تر ارزیابی شود.

برعکس:

```text
Relevance: 65
Audience Quality: 94
```

یعنی مخاطبان خوب هستند ولی این کسب‌وکار برای هدف فعلی مناسب نیست.

---

# 26. Audience Risk

سیستم نباید ادعا کند:

```text
73% followers are fake
```

مگر اینکه منبع معتبر و روش معتبر چنین داده‌ای را ارائه کند.

بهتر است:

```text
Audience Quality: 78
Audience Risk: Medium
```

و Evidence ذخیره شود.

مثلاً:

```text
Suspicious growth pattern
Unusual engagement ratio
Low comment authenticity
Follower/following anomaly
```

---

# 27. Business Activity Score

فعال بودن کسب‌وکار جداگانه محاسبه شود.

عوامل احتمالی:

```text
Recent Posts
Posting Frequency
Recent Stories if available
Recent Engagement
Profile Completeness
Recent Content
```

خروجی:

```text
Business Activity: 87/100
```

---

# 28. Data Confidence

این امتیاز نشان می‌دهد سیستم چقدر به تحلیل خود اطمینان دارد.

مثلاً:

```text
Data Confidence: 93/100
```

اگر:

```text
Bio واضح
+
چند Post مرتبط
+
City واضح
+
Category واضح
```

باشد، Confidence بالا می‌رود.

---

# 29. Overall Priority

در نهایت:

```text
Lead Relevance
Audience Quality
Business Activity
Data Confidence
```

ترکیب می‌شوند.

مثلاً:

```text
Lead Relevance      91
Audience Quality    78
Business Activity   87
Data Confidence     93
-----------------------
Overall Priority    88
```

فرمول باید Configurable باشد.

---

# 30. Human-in-the-Loop

هر تصمیمی نباید کاملاً خودکار باشد.

سه وضعیت:

```text
ACCEPT
REVIEW
REJECT
```

مثلاً:

```text
Confidence >= 90
→ ACCEPT

70 <= Confidence < 90
→ REVIEW

Confidence < 70
→ REVIEW / REJECT
```

Thresholdها باید قابل تنظیم باشند.

---

# 31. Review Queue

کاربر باید صفحه‌ای داشته باشد:

```text
Review Queue
```

و بتواند ببیند:

```text
Lead
AI Classification
Evidence
Confidence
Reasons
```

و انتخاب کند:

```text
Accept
Reject
Change Category
Change Specialty
Change City
Mark as Correct
Mark as Incorrect
```

---

# 32. Feedback Learning

اصلاحات کاربر نباید از بین بروند.

مثلاً AI گفت:

```text
Hair Coloring
```

کاربر اصلاح کرد:

```text
Balayage
```

این Feedback ذخیره شود.

ساختار:

```text
Prediction
+
Human Correction
+
Timestamp
+
Model Version
```

این داده بعدها برای:

- Evaluation
- Prompt Improvement
- Calibration
- Fine-tuning
- Taxonomy Optimization

قابل استفاده خواهد بود.

---

# 33. Evaluation Dataset

سیستم باید Dataset داخلی داشته باشد.

مثلاً:

```text
1000 labeled leads
```

با:

```text
Business Type
Industry
Specialty
City
Relevant / Not Relevant
Activity
Audience Quality
```

این Dataset برای مقایسه مدل‌ها استفاده می‌شود.

---

# 34. Model Benchmark

هیچ مدل AI نباید صرفاً به دلیل ادعا انتخاب شود.

باید مقایسه شود:

```text
LLM Only
Jev Only
LLM → Jev
Jev → LLM
LLM → Human
```

و معیارها:

```text
Accuracy
Precision
Recall
F1
Confidence Calibration
Cost
Latency
Human Review Rate
```

بررسی شوند.

---

# 35. PARSE-Style Schema Optimization

در نسخه‌های بعدی می‌توان از ایده PARSE برای بهینه‌سازی Schema استفاده کرد.

MVP:

```text
Pydantic
+
JSON Schema
+
Validation
+
Grounding
```

بعد:

```text
Schema Optimization
+
Reflection
+
Retry Optimization
```

اضافه شود.

نباید از روز اول کل سیستم پیچیده شود.

---

# 36. Search Engine

کاربر باید بتواند جستجو کند:

```text
Business Type = Service Provider
Industry = Beauty
Specialty = Hair Coloring
City = Shiraz
Activity >= 70
Relevance >= 80
Audience Quality >= 60
```

یا:

```text
آرایشگران شیراز که در رنگ و لایت تخصص دارند و فعالیت خوبی دارند
```

و سیستم Query را به Filterهای ساختاری تبدیل کند.

---

# 37. Natural Language Search

کاربر بتواند بنویسد:

> آرایشگران شیراز که در رنگ و لایت تخصص دارند و فعالیت خوبی دارند

سیستم آن را تبدیل کند:

```json
{
  "profession": "beauty",
  "specialty": "hair_coloring",
  "city": "shiraz",
  "business_activity": {
    "min": 70
  }
}
```

---

# 38. Campaign

Campaign فقط برای مدیریت گروه لیدها است.

مثلاً:

```text
Campaign:
Shiraz Beauty - Hair Coloring
```

فیلتر:

```text
City = Shiraz
Specialty = Hair Coloring
Relevance > 80
```

سپس کاربر لیدها را انتخاب می‌کند.

---

# 39. Manual Outreach

نسخه پایه سیستم نباید پیام تبلیغاتی را به‌صورت خودکار ارسال کند.

سیستم فقط:

```text
Discover
Analyze
Classify
Score
Group
Export
```

می‌کند.

کاربر خودش:

```text
Review
Select
Contact
```

را انجام می‌دهد.

---

# 40. Export

فرمت‌ها:

```text
CSV
Excel
JSON
API
```

نمونه:

```text
Username
Name
Business Type
Industry
Specialty
City
Relevance
Audience Quality
Activity
Confidence
Source
Status
```

---

# 41. Dashboard

Dashboard اصلی:

```text
Total Leads
New Leads
Reviewed Leads
High Priority
Needs Review
Rejected
Sources
AI Cost
AI Accuracy
```

---

# 42. Source Dashboard

مثلاً:

```text
Instagram
Status: Connected
Last Sync: ...
Leads Found: 12,430
Successful: 11,820
Partial: 410
Failed: 200
```

برای هر Connector.

---

# 43. AI Dashboard

نمایش:

```text
LLM Calls
Vision Calls
Jev Calls
Average Cost
Average Latency
Error Rate
Review Rate
Accuracy
```

---

# 44. Queue Architecture

کارهای سنگین نباید داخل HTTP Request انجام شوند.

استفاده:

```text
Redis
+
BullMQ
```

مثلاً:

```text
Discovery Queue
Analysis Queue
Vision Queue
Decision Queue
Scoring Queue
Export Queue
```

---

# 45. Processing Pipeline

```text
Search
 ↓
Discovery Job
 ↓
Raw Storage
 ↓
Normalization Job
 ↓
Dedup Job
 ↓
Basic Filter
 ↓
Analysis Job
 ↓
Vision Job
 ↓
Jev Job
 ↓
Scoring Job
 ↓
Evidence Job
 ↓
Lead Ready
```

---

# 46. Retry Strategy

هر Job باید:

```text
attempts
backoff
timeout
dead-letter
```

داشته باشد.

مثلاً:

```text
Attempt 1
↓
30 sec
↓
Attempt 2
↓
2 min
↓
Attempt 3
↓
Dead Letter Queue
```

---

# 47. Idempotency

اگر یک Job دوبار اجرا شد نباید Lead دوبار ساخته شود.

مثلاً:

```text
source + externalId
```

باید Unique Constraint داشته باشد.

---

# 48. Database

پیشنهاد:

```text
PostgreSQL
```

ساختار منطقی:

```text
sources
source_accounts
raw_entities
businesses
leads
lead_identities
lead_contents
lead_analyses
lead_scores
audience_quality
evidence
decisions
taxonomy_nodes
campaigns
campaign_leads
ai_runs
model_versions
human_reviews
feedback
jobs
audit_logs
```

---

# 49. مهم‌ترین جداول

## leads

```text
id
business_id
status
created_at
updated_at
```

## lead_identities

```text
id
lead_id
source_id
external_id
username
profile_url
```

## lead_analyses

```text
id
lead_id
profession
specialties
city
confidence
model_version
created_at
```

## lead_scores

```text
lead_id
relevance_score
audience_quality_score
activity_score
confidence_score
priority_score
```

## evidence

```text
id
lead_id
type
source
content
confidence
created_at
```

---

# 50. Versioning

AI نتایج باید Version داشته باشند.

مثلاً:

```text
Analysis Version:
2026.10.01

LLM:
Model-X

Vision:
Model-Y

Jev:
Version-Z

Taxonomy:
v12
```

اگر مدل تغییر کرد بتوان نتیجه قدیمی را با نتیجه جدید مقایسه کرد.

---

# 51. Reprocessing

مثلاً مدل جدید بهتر شده است.

کاربر بتواند بگوید:

```text
Re-analyze selected leads
```

سیستم:

```text
Old Analysis
+
New Analysis
```

را نگه دارد.

---

# 52. Audit Log

تمام تغییرات مهم:

```text
Who
What
When
Before
After
Source
```

ذخیره شوند.

مثلاً:

```text
User changed:
Specialty
Hair Coloring → Balayage
```

---

# 53. Security

اصول:

- Encryption in transit
- Secret management
- API Key isolation
- Role-Based Access
- Tenant isolation
- Audit Logs
- Data retention policies
- Secure webhook handling
- Input validation
- Output validation

---

# 54. Multi-Tenant SaaS

در صورت تبدیل پروژه به SaaS:

```text
Tenant
 ├── Users
 ├── Sources
 ├── Leads
 ├── Campaigns
 ├── AI Usage
 └── Settings
```

هر Tenant داده خودش را می‌بیند.

---

# 55. Usage Metering

موارد قابل اندازه‌گیری:

```text
Leads Discovered
AI Calls
Vision Calls
Jev Calls
Images Analyzed
Exports
Storage
```

مثلاً:

```text
Starter
10,000 leads/month
2,000 AI analyses
```

و غیره.

---

# 56. Plugin Architecture

در آینده Sourceها می‌توانند Plugin باشند.

مثلاً:

```text
Instagram Plugin
Google Maps Plugin
LinkedIn Plugin
Website Crawler Plugin
```

هر Plugin:

```text
manifest
connector
configuration
permissions
capabilities
version
```

دارد.

---

# 57. Connector Contract

هر Connector باید اعلام کند:

```json
{
  "name": "instagram",
  "version": "1.0.0",
  "capabilities": [
    "profile_search",
    "profile_fetch",
    "content_fetch"
  ]
}
```

ممکن است یک Connector همه قابلیت‌ها را نداشته باشد.

---

# 58. Capability-Based Design

به جای فرض کردن قابلیت:

```text
Instagram همیشه Profile Search دارد
```

سیستم باید بررسی کند:

```text
supports("profile_search")
```

این طراحی باعث می‌شود Connectorهای مختلف بدون مشکل کار کنند.

---

# 59. Search Provider Abstraction

```typescript
interface DiscoveryProvider {
  search(
    query: DiscoveryQuery
  ): Promise<DiscoveryResult>;
}
```

مثلاً:

```text
InstagramDiscoveryProvider
GoogleMapsDiscoveryProvider
DirectoryDiscoveryProvider
```

---

# 60. Data Availability

هر فیلد باید وضعیت دسترسی داشته باشد.

مثلاً:

```text
AVAILABLE
PARTIAL
UNAVAILABLE
INFERRED
```

این بسیار مهم است.

مثلاً:

```text
City:
INFERRED

Followers:
AVAILABLE

Email:
UNAVAILABLE
```

---

# 61. AI نباید Data Availability را مخفی کند

اگر شهر مشخص نیست:

بد:

```text
City = Shiraz
```

خوب:

```text
City = Shiraz
Confidence = 0.71
Evidence = inferred from profile content
```

---

# 62. Evidence Graph

در نسخه پیشرفته‌تر:

```text
Lead
 │
 ├── Bio Evidence
 ├── Post Evidence
 ├── Image Evidence
 ├── Location Evidence
 ├── Engagement Evidence
 └── Model Decision
```

این ساختار امکان Explainability ایجاد می‌کند.

---

# 63. Explainable AI

کاربر باید بتواند ببیند:

> چرا این Lead به عنوان «رنگ و لایت» طبقه‌بندی شده؟

مثلاً:

```text
Reason:
Bio contains "رنگ و لایت"

Supporting content:
3 recent posts contain relevant visual evidence.

Confidence:
94%
```

---

# 64. Cost Optimization

اول ارزان‌ترین مرحله:

```text
Metadata
 ↓
Rules
 ↓
Cheap Model
 ↓
Jev
 ↓
Vision
 ↓
Strong LLM
 ↓
Human
```

نه اینکه برای هر Lead از قوی‌ترین مدل استفاده شود.

---

# 65. AI Routing

AI Gateway می‌تواند بر اساس Task مدل انتخاب کند.

مثلاً:

```text
Simple Classification
→ Cheap Model

Complex Text
→ Strong LLM

Image
→ Vision Model

Bounded Decision
→ Jev
```

---

# 66. Confidence Routing

مثلاً:

```text
Confidence > 0.90
→ Automatic

0.70–0.90
→ Secondary Model

< 0.70
→ Human Review
```

---

# 67. Model Fallback

اگر Provider اصلی در دسترس نبود:

```text
Provider A
   ↓ failure
Provider B
   ↓ failure
Provider C
```

اما نتیجه باید Model Version داشته باشد.

---

# 68. Observability

استفاده از:

```text
OpenTelemetry
```

برای:

- Request Trace
- AI Trace
- Job Trace
- Connector Trace
- Latency
- Error
- Cost

---

# 69. Monitoring

Metricهای مهم:

```text
Discovery Success Rate
Normalization Error Rate
Dedup Rate
AI Error Rate
Review Rate
Classification Accuracy
Average Cost / Lead
Average Processing Time
```

---

# 70. MVP

MVP نباید همه قابلیت‌ها را داشته باشد.

نسخه اول:

```text
Instagram / One Source
+
Lead Database
+
Taxonomy
+
LLM Analysis
+
Basic Vision
+
Basic Jev
+
Scoring
+
Evidence
+
Human Review
+
CSV Export
```

---

# 71. مواردی که در MVP نباید اضافه شوند

فعلاً:

```text
GNN
Complex Agent Swarm
Full PARSE
Microservices
Advanced Knowledge Graph
Automatic Outreach
Large Plugin Marketplace
```

اضافه نشوند.

این‌ها بعداً قابل اضافه شدن هستند.

---

# 72. Phase 2

بعد از اثبات MVP:

```text
Google Maps
Website
CSV Import
Advanced Audience Quality
Better Deduplication
Embeddings
Semantic Search
Advanced Dashboard
```

---

# 73. Phase 3

```text
LinkedIn
YouTube
Facebook
More Connectors
Advanced AI Routing
Model Benchmarking
Automated Taxonomy Suggestions
Advanced Evidence Graph
```

---

# 74. Phase 4

```text
Plugin Marketplace
External API
CRM Integrations
Enterprise Multi-Tenant
Advanced Analytics
GNN / Graph Intelligence
Advanced Model Training
```

---

# 75. GNN

GNN در معماری آینده قابل پیش‌بینی است اما برای MVP ضروری نیست.

زمانی مفید می‌شود که داده کافی از:

```text
Follow Graph
Interaction Graph
Comment Graph
Mention Graph
Shared Audience Signals
```

داشته باشیم.

هدف:

```text
Community Detection
Engagement Rings
Bot Clusters
Coordinated Behavior
```

است.

اما تا زمانی که Graph Data کافی نداریم، GNN فقط پیچیدگی ایجاد می‌کند.

---

# 76. Universal Lead Schema

یکی از مهم‌ترین قراردادهای سیستم:

```typescript
interface UniversalLead {
  id: string;

  source: SourceReference[];

  identity: LeadIdentity;

  business: BusinessProfile;

  taxonomy: TaxonomyClassification;

  location?: Location;

  content?: ContentSummary;

  scores: LeadScores;

  confidence: Confidence;

  evidence: Evidence[];

  status: LeadStatus;

  timestamps: LeadTimestamps;
}
```

این Schema قلب سیستم است.

---

# 77. Source Independence

اصل نهایی:

```text
Instagram
      \
Google  \
LinkedIn ---> Universal Lead ---> AI ---> Intelligence
Website /
CSV     /
```

نه:

```text
Instagram → AI
```

---

# 78. User Experience

کاربر ابتدا Source را انتخاب می‌کند:

```text
Choose Source

[Instagram]
[Google Maps]
[Website]
[CSV]
```

سپس:

```text
Business Type:
Service Provider

Industry:
Beauty

Specialty:
Hair Coloring

City:
Shiraz

Minimum Activity:
70

Minimum Relevance:
80
```

سپس:

```text
[Find Leads]
```

---

# 79. Lead Card

هر Lead:

```text
┌────────────────────────────────────┐
│ Example Beauty                     │
│ @example                           │
│                                    │
│ Beauty → Hair → Balayage           │
│ Shiraz                             │
│                                    │
│ Relevance       94                 │
│ Audience        82                 │
│ Activity        91                 │
│ Confidence      96                 │
│                                    │
│ [Evidence] [Review] [Add Campaign]│
└────────────────────────────────────┘
```

---

# 80. Bulk Selection

کاربر بتواند:

```text
Select All
Select Filtered
Select Page
```

و سپس:

```text
Add to Campaign
Export
Mark Reviewed
```

انجام دهد.

---

# 81. Campaign Groups

مثلاً:

```text
Campaign:
Shiraz Beauty Leads

Groups:

Hair Coloring
Keratin
Makeup
Nails
Bridal
```

---

# 82. CRM Future

بعداً می‌توان Lead را به CRM منتقل کرد:

```text
New
Reviewed
Qualified
Contacted
Interested
Customer
Rejected
```

---

# 83. Outreach Boundary

سیستم فعلاً مسئول:

```text
Lead Intelligence
```

است.

نه:

```text
Mass Messaging Automation
```

این دو باید از نظر معماری جدا باشند.

اگر در آینده Outreach اضافه شد، باید یک Module مستقل باشد و فقط از روش‌های مجاز پلتفرم استفاده کند.

---

# 84. API Architecture

نمونه:

```text
/api/v1/sources
/api/v1/discovery
/api/v1/leads
/api/v1/leads/:id
/api/v1/analyses
/api/v1/scores
/api/v1/evidence
/api/v1/taxonomy
/api/v1/campaigns
/api/v1/exports
/api/v1/ai
/api/v1/reviews
```

---

# 85. Event Architecture

Eventهای پیشنهادی:

```text
lead.discovered
lead.normalized
lead.deduplicated
lead.analysis.started
lead.analysis.completed
lead.scored
lead.review.required
lead.review.completed
lead.campaign.added
export.created
```

---

# 86. Outbox

برای Eventهای مهم:

```text
Transaction
 ↓
Database
 ↓
Outbox
 ↓
Event Worker
 ↓
Consumers
```

تا Event از بین نرود.

---

# 87. Storage

برای تصاویر و Raw Content:

```text
S3-compatible Object Storage
```

Database فقط Metadata را نگه می‌دارد.

---

# 88. Retention

برای Raw Data باید Policy وجود داشته باشد.

مثلاً:

```text
Raw Data:
30/90 days

Analysis:
Long-term

Evidence:
Configurable

Audit:
Long-term
```

مدت دقیق باید بر اساس نیاز و الزامات حقوقی تعیین شود.

---

# 89. Privacy

سیستم باید فقط داده‌ای را نگهداری کند که برای هدف محصول لازم است.

اصل:

```text
Collect minimum
Store minimum
Expose minimum
```

---

# 90. Architecture Principle

اصل مهم:

> Data Source ≠ Intelligence Engine

و:

> LLM ≠ Decision System

و:

> AI ≠ Business Rules

و:

> Evidence ≠ Prediction

این جداسازی باعث می‌شود سیستم قابل اعتمادتر و قابل توسعه‌تر شود.

---

# 91. معماری نهایی پیشنهادی

```text
                  ┌───────────────┐
                  │    Next.js    │
                  └───────┬───────┘
                          │
                          ↓
                  ┌───────────────┐
                  │   NestJS API  │
                  └───────┬───────┘
                          │
          ┌───────────────┼────────────────┐
          ↓               ↓                ↓
       Sources       Intelligence       Campaigns
          │               │                │
          ↓               ↓                ↓
      Connectors      AI Gateway         Export
                          │
              ┌───────────┼────────────┐
              ↓           ↓            ↓
             LLM        Vision        Jev
       
       ↓
 Raw Data
       ↓
 Normalizer
       ↓
 Deduplication
       ↓
 Deterministic Rules
       ↓
 AI Analysis
       ↓
 Evidence
       ↓
 Decision
       ↓
 Scoring
       ↓
 Human Review
       ↓
 Universal Lead
       ↓
 Campaign / CRM / Export
```

---

# 92. Stack پیشنهادی

## Frontend

```text
Next.js
React
TypeScript
Tailwind CSS
```

## Backend

```text
NestJS
TypeScript
```

## Database

```text
PostgreSQL
JSONB
```

## Queue

```text
Redis
BullMQ
```

## Storage

```text
S3 Compatible
```

## AI

```text
AI Gateway
LLM
Vision
Jev
Embeddings
```

## Observability

```text
OpenTelemetry
```

---

# 93. اصل مهم در انتخاب معماری

در شروع:

```text
Modular Monolith
```

بهتر از Microservices است.

ساختار:

```text
apps/
  web/
  api/
  
packages/
  domain/
  ai/
  connectors/
  taxonomy/
  scoring/
  evidence/
  shared/
```

بعداً در صورت نیاز Serviceهای مستقل استخراج شوند.

---

# 94. ساختار پیشنهادی Backend

```text
src/
 ├── modules/
 │   ├── sources/
 │   ├── discovery/
 │   ├── leads/
 │   ├── taxonomy/
 │   ├── analysis/
 │   ├── ai/
 │   ├── decisions/
 │   ├── scoring/
 │   ├── evidence/
 │   ├── reviews/
 │   ├── campaigns/
 │   ├── exports/
 │   ├── usage/
 │   └── audit/
 │
 ├── infrastructure/
 │   ├── database/
 │   ├── queue/
 │   ├── storage/
 │   └── observability/
 │
 └── common/
```

---

# 95. اصل Provider Abstraction

تمام Providerهای خارجی باید پشت Interface باشند.

مثلاً:

```text
IAIProvider
IDecisionProvider
IVisionProvider
IEmbeddingProvider
IDiscoveryProvider
```

این کار باعث می‌شود:

```text
Vendor Lock-in
```

کاهش پیدا کند.

---

# 96. مهم‌ترین خروجی محصول

محصول نباید صرفاً بگوید:

> این صفحه آرایشگر است.

بلکه باید بگوید:

> این Lead برای هدف مشخص کاربر چقدر ارزشمند است، چرا این نتیجه را گرفته‌ایم، چه شواهدی داریم و چقدر به تحلیل اعتماد داریم.

بنابراین محصول واقعی:

```text
Lead Discovery
+
Lead Intelligence
+
Lead Qualification
+
Lead Prioritization
```

است.

---

# 97. نام معماری

نام پیشنهادی داخلی:

**Universal Lead Intelligence Architecture — ULIA**

یا:

**Lead Intelligence Core — LIC**

هسته اصلی:

```text
Lead Intelligence Core
```

و Connectorها:

```text
Instagram Connector
Google Maps Connector
LinkedIn Connector
...
```

---

# 98. Definition of Done برای MVP

MVP زمانی کامل محسوب می‌شود که:

- [ ] یک Source واقعی متصل باشد.
- [ ] Lead Discovery کار کند.
- [ ] Raw Data ذخیره شود.
- [ ] Normalization انجام شود.
- [ ] Deduplication وجود داشته باشد.
- [ ] Taxonomy قابل مدیریت باشد.
- [ ] LLM بتواند داده ساختاری تولید کند.
- [ ] Vision Analysis وجود داشته باشد.
- [ ] Evidence ذخیره شود.
- [ ] Jev یا Decision Provider قابل استفاده باشد.
- [ ] Lead Relevance محاسبه شود.
- [ ] Audience Quality جدا باشد.
- [ ] Business Activity محاسبه شود.
- [ ] Data Confidence محاسبه شود.
- [ ] Human Review وجود داشته باشد.
- [ ] Campaign ایجاد شود.
- [ ] CSV/Excel Export وجود داشته باشد.
- [ ] AI Cost قابل مشاهده باشد.
- [ ] Audit Log وجود داشته باشد.
- [ ] Connector و AI Provider قابل تعویض باشند.

---

# 99. تصمیمات معماری نهایی

### تصمیم 1
Instagram نباید Core سیستم باشد.

### تصمیم 2
تمام منابع از Connector استفاده می‌کنند.

### تصمیم 3
LLM فقط یکی از اجزای AI است.

### تصمیم 4
Jev برای Decisionهای محدود استفاده می‌شود، نه برای تمام تحلیل.

### تصمیم 5
Code مسئول Business Rules قطعی است.

### تصمیم 6
Evidence برای تصمیم‌های AI الزامی است.

### تصمیم 7
Lead Relevance و Audience Quality دو معیار جدا هستند.

### تصمیم 8
GNN در MVP حذف می‌شود.

### تصمیم 9
PARSE-style optimization به Phaseهای بعد منتقل می‌شود.

### تصمیم 10
Outreach خودکار در Core وجود ندارد.

### تصمیم 11
Human-in-the-Loop بخشی از معماری اصلی است.

### تصمیم 12
تمام AI Providerها قابل تعویض هستند.

---

# 100. چشم‌انداز نهایی

هدف نهایی ساخت یک:

**Universal Lead Intelligence Platform**

است که کاربر بتواند بگوید:

> «من دنبال کسب‌وکارهای X در شهر Y با تخصص Z هستم.»

و سیستم:

```text
منبع مناسب را انتخاب کند
        ↓
Leadها را پیدا کند
        ↓
داده‌ها را استاندارد کند
        ↓
تکراری‌ها را حذف کند
        ↓
پروفایل و محتوا را تحلیل کند
        ↓
تخصص را تشخیص دهد
        ↓
شهر و فعالیت را ارزیابی کند
        ↓
کیفیت احتمالی Audience را بررسی کند
        ↓
Lead را Score کند
        ↓
Evidence ارائه دهد
        ↓
موارد نامطمئن را برای Human Review بفرستد
        ↓
Leadهای ارزشمند را در Campaign قرار دهد
        ↓
برای CRM / Export آماده کند
```

و مهم‌تر از همه:

```text
             ┌────────────────────┐
             │  Lead Intelligence │
             │       Core         │
             └─────────┬──────────┘
                       │
       ┌───────────────┼────────────────┐
       ↓               ↓                ↓
   Instagram       Google Maps       LinkedIn
       ↓               ↓                ↓
       └───────────────┼────────────────┘
                       ↓
                Universal Leads
                       ↓
                    AI Core
                       ↓
              Intelligence Layer
```

بنابراین محصول از همان ابتدا برای **یک پلتفرم خاص ساخته نمی‌شود**؛ بلکه Instagram فقط اولین ورودی آن خواهد بود.

---

# نتیجه نهایی

معماری پیشنهادی باید بر پنج ستون اصلی بنا شود:

1. **Universal Data Layer**
2. **Provider/Connector Architecture**
3. **AI Intelligence Layer**
4. **Evidence + Decision + Scoring**
5. **Human Review + Feedback**

این ساختار اجازه می‌دهد سیستم از یک ابزار ساده «پیدا کردن پیج‌های اینستاگرام» به یک پلتفرم کامل **Lead Intelligence** تبدیل شود.
