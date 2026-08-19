# Instagram Automation System — Updated Detailed Implementation Plan

**Version:** 2.0  
**Date:** 19 August 2026  
**Scope:** Official Meta API-only Instagram publishing + comment-to-DM automation  
**Primary deployment preference:** Vercel-first  
**Core infrastructure preference:** Supabase  
**AI preference:** AWS Bedrock  
**DM foundation:** OpenReply  
**Worker preference:** Render only where a persistent worker is actually required

---

# 0. Executive summary

The system is intentionally split into **three modules**.

```text
┌──────────────────────────────────────────────────────────────┐
│  1. CONTENT ENGINE                                           │
│                                                              │
│  Input: brief / manual creative                              │
│  Output: ready-to-post folder                                │
│                                                              │
│  POST_001/                                                   │
│  ├── 1.jpg                                                   │
│  ├── 2.jpg                                                   │
│  ├── 3.jpg                                                   │
│  └── caption.md                                              │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  2. POSTING ENGINE                                           │
│                                                              │
│  Reads folder → validates media → uploads/stages media       │
│  → Meta containers → carousel → media_publish                │
│  → stores Instagram Media ID                                 │
└─────────────────────────────┬────────────────────────────────┘
                              │
                              ▼
                       INSTAGRAM POST
                              │
                     user comments on it
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  3. DM / COMMENT ENGINE                                      │
│                                                              │
│  Meta webhook → OpenReply → campaign lookup → keyword match │
│  → queue → private reply / DM                               │
└──────────────────────────────────────────────────────────────┘
```

The user experience should eventually be almost ridiculously simple:

> **Create folder → put images in it → put caption in `caption.md` → system publishes → comment trigger automatically sends the configured link/message.**

The important engineering work is hidden underneath:

- Meta authentication
- official Instagram Content Publishing API
- media hosting
- carousel container orchestration
- publishing state management
- Postgres persistence
- webhook handling
- campaign-to-post synchronisation
- Redis/BullMQ worker for DM sending
- idempotency and retries
- secure token handling

The system should **not** use:

- Instagram browser automation
- Selenium
- Playwright for Instagram actions
- password-based Instagram automation
- scraping
- unofficial private endpoints
- fake mobile clients
- session-cookie automation

Everything Instagram-facing should go through the **official Meta APIs**.

---

# 1. Final external-services stack

## Recommended production stack

| Service | Role | Required? |
|---|---|---:|
| **Meta / Instagram Graph API** | Instagram publishing, comments/webhooks, private replies | YES |
| **Supabase Postgres** | Application database | YES |
| **Supabase Storage** | Post media/object storage | YES |
| **Vercel** | Web app, dashboard, API/webhook endpoints | YES |
| **OpenReply** | Comment → DM engine | YES |
| **Redis-compatible service** | OpenReply/BullMQ queue | YES for OpenReply |
| **Render** | Persistent worker hosting | Recommended |
| **AWS Bedrock** | AI caption generation / future AI features | Optional initially |
| **Resend** | OpenReply authentication emails | Only if using OpenReply's email login flow |

### The important correction

We do **not** need:

```text
Supabase
+
AWS S3
+
Vercel
+
Render
+
Railway
```

all at once.

Supabase already provides Postgres and Storage. Supabase Storage is designed for files and provides object storage, access controls, and delivery; its metadata is integrated with Postgres. citeturn0search2turn0search3turn0search5

Therefore:

```text
Supabase
├── Postgres
└── Storage
```

is enough for our database + media storage.

---

# 2. Recommended architecture

```text
                           USER
                            │
                            │
                     uploads / creates
                            │
                            ▼
                  ┌───────────────────┐
                  │ CONTENT ENGINE    │
                  │                   │
                  │ Bedrock (optional)│
                  │ caption generation│
                  └─────────┬─────────┘
                            │
                            ▼
                    POST_001/
                    ├── 1.jpg
                    ├── 2.jpg
                    ├── 3.jpg
                    └── caption.md
                            │
                            ▼
                  ┌───────────────────┐
                  │      VERCEL       │
                  │ dashboard/API     │
                  └─────────┬─────────┘
                            │
                            ▼
                     SUPABASE STORAGE
                            │
                     public/signed URL
                            │
                            ▼
                  ┌───────────────────┐
                  │ POSTING WORKER    │
                  │                   │
                  │ Meta API client   │
                  │ validation        │
                  │ retries            │
                  └─────────┬─────────┘
                            │
                            ▼
                       META API
                            │
                            ▼
                        INSTAGRAM
                            │
                     published Media ID
                            │
                            ▼
                       SUPABASE DB
                            │
                            │ campaign mapping
                            ▼
                  ┌───────────────────┐
                  │    OPENREPLY      │
                  │                   │
                  │ webhook           │
                  │ campaign matching │
                  │ BullMQ/Redis      │
                  │ DM worker         │
                  └─────────┬─────────┘
                            │
                            ▼
                       META API
                            │
                            ▼
                     PRIVATE REPLY / DM
```

---

# 3. Module 1 — Content Engine

## V1 status

The Content Engine is **not the priority right now**.

For V1, the output is simply a folder.

Example:

```text
POST_001/
├── 1.jpg
├── 2.jpg
├── 3.jpg
├── 4.jpg
└── caption.md
```

The folder represents **one Instagram carousel post**.

The content engine's contract is:

```text
INPUT
    ↓
content creation
    ↓
OUTPUT
    ↓
POST_001/
    1.jpg
    2.jpg
    ...
    caption.md
```

The Posting Engine should not care how the content was created.

---

# 4. Content folder specification

## Required

Every folder must contain:

```text
1.jpg
2.jpg
3.jpg
...
caption.md
```

## Ordering

Files must be sorted numerically:

```text
1.jpg
2.jpg
3.jpg
10.jpg
```

NOT:

```text
1.jpg
10.jpg
2.jpg
3.jpg
```

The implementation should extract the numeric filename rather than relying on normal string sorting.

## Carousel limit

Meta's official sample states that carousel posts can contain up to **10 images, videos, or mixed media items**. citeturn0search6

Therefore V1 validation should reject:

```text
11.jpg
```

and anything beyond the supported carousel count.

---

# 5. `caption.md`

Example:

```md
This is the final caption for the Instagram post.

Discover the full collection through the link in bio.

#brand #fashion #design
```

The Posting Engine treats the contents as the final caption.

It should not rewrite it.

It should not ask an LLM for another caption.

It should publish exactly what the content folder says.

This keeps the posting service deterministic.

---

# 6. Optional future `campaign.json`

Later, we can extend:

```text
POST_001/
├── 1.jpg
├── 2.jpg
├── 3.jpg
├── caption.md
└── campaign.json
```

Example:

```json
{
  "campaign_id": "POST_001",
  "trigger_keywords": [
    "INFO",
    "LINK",
    "PRICE"
  ],
  "dm_message": "Hey! Here's the link you asked for 👇",
  "destination_url": "https://example.com/product"
}
```

This is **not required for V1**.

Initially, campaign configuration can be done through the dashboard/OpenReply.

---

# 7. AWS Bedrock — where it belongs

Bedrock should **not** be in the critical Instagram publishing path.

Its role is:

```text
Brief
  ↓
AWS Bedrock
  ↓
caption.md
```

It can eventually generate:

- captions
- CTA text
- hashtags
- campaign copy
- product descriptions
- DM templates

But once:

```text
caption.md
```

exists, the Posting Engine should not need Bedrock.

That gives us:

```text
AI failure
    ↓
does NOT prevent manual posting
```

This is desirable.

---

# 8. Important Bedrock 2026 note

AWS currently documents Bedrock as supporting a broad catalogue of foundation models and model-specific inference APIs. citeturn0search9turn0search14

For this project, use **Bedrock model inference**, not Bedrock Agents as a dependency.

AWS's current documentation states that **Bedrock Agents Classic is in maintenance mode and is no longer open to new customers after 30 July 2026**, with AWS pointing new agent workloads towards Bedrock AgentCore. citeturn0search4

We don't need Bedrock Agents anyway.

The caption generation task can simply use:

```text
Bedrock Runtime
    ↓
selected foundation model
    ↓
caption text
```

---

# 9. Module 2 — Posting Engine

This is the first module we should actually build.

Its job is deliberately simple:

```text
folder
  ↓
validate
  ↓
upload/stage media
  ↓
Meta media containers
  ↓
carousel container
  ↓
publish
  ↓
store Instagram Media ID
```

---

# 10. Meta carousel publishing flow

Meta's official sample describes carousel publishing as a three-step process:

1. Create individual item containers.
2. Create a carousel container referencing those items.
3. Publish the carousel container.

It supports up to 10 media items, and a carousel counts as one post against the publishing limit. citeturn0search6

Conceptually:

```text
1.jpg
   ↓
child container A

2.jpg
   ↓
child container B

3.jpg
   ↓
child container C

A + B + C
   ↓
carousel container
   ↓
media_publish
   ↓
Instagram Media ID
```

---

# 11. Detailed posting API flow

## Step 1 — Upload/stage media

The local files cannot simply be sent as:

```text
C:\posts\POST_001\1.jpg
```

to Meta.

The service must make the media available to Meta through an appropriate URL/upload mechanism supported by the current API.

For image carousel publishing, the implementation should use a publicly retrievable HTTPS media URL when using the `image_url` flow.

Supabase Storage can provide the media storage layer. Supabase documents file storage, buckets, direct URL access, and access policies. citeturn0search2turn0search3turn0search13

Recommended:

```text
POST_001/1.jpg
      ↓
Supabase Storage
      ↓
HTTPS media URL
      ↓
Meta
```

---

# 12. Step 2 — Create child containers

For each image:

```text
POST /{ig-user-id}/media
```

with the image URL and:

```text
is_carousel_item=true
```

Example conceptual request:

```text
POST /{ig-user-id}/media

image_url=<https-image-url>
is_carousel_item=true
```

Store:

```text
child_container_id
```

for every image.

---

# 13. Step 3 — Wait for processing

Do not assume a container is immediately ready.

The publisher should poll container status.

A useful state model is:

```text
IN_PROGRESS
FINISHED
ERROR
EXPIRED
PUBLISHED
```

The current researched API reference documents `FINISHED` as ready to publish, `IN_PROGRESS` as still processing, and `ERROR` / `EXPIRED` as failure states. citeturn0search8

The production implementation must verify the exact current status fields and API version against Meta's current documentation before deployment.

---

# 14. Step 4 — Create carousel container

Once every child is ready:

```text
POST /{ig-user-id}/media
```

with:

```text
media_type=CAROUSEL
children=<child1>,<child2>,<child3>
caption=<caption.md>
```

The children must be in the same order as:

```text
1.jpg
2.jpg
3.jpg
```

---

# 15. Step 5 — Publish

Once the carousel container is ready:

```text
POST /{ig-user-id}/media_publish
```

with:

```text
creation_id=<carousel-container-id>
```

The response gives us the published Instagram Media ID.

That ID is critical.

---

# 16. The bridge identifier

The most important piece of shared data is:

```text
campaign_id
        ↕
instagram_media_id
```

Example:

```text
campaign_id:
POST_001

instagram_media_id:
1784XXXXXXXXXXXX
```

This lets the DM engine answer:

> "Which campaign does this Instagram comment belong to?"

---

# 17. Supabase architecture

Use one Supabase project for:

```text
Postgres
Storage
```

Supabase provides a full Postgres database, and its Storage system is integrated with the database and access-control system. citeturn0search7turn0search2

Recommended buckets:

```text
instagram-media
```

Optionally:

```text
content-input
content-processed
```

For V1, one bucket is enough.

---

# 18. Supabase Storage security

Do not blindly make everything public.

Supabase Storage supports fine-grained access controls through Postgres RLS policies. citeturn0search13

We need to decide between:

### Option A — Public media URL

Simplest for Meta image fetching.

```text
Supabase Storage
      ↓
public HTTPS URL
      ↓
Meta
```

### Option B — Signed URL

More restrictive.

```text
private bucket
      ↓
short-lived signed URL
      ↓
Meta
```

The final implementation should verify that the selected Meta publishing endpoint accepts the URL form and that its lifetime is sufficient for the processing window.

For V1, the easiest path is likely a dedicated media bucket with controlled access appropriate for the publishing workflow.

---

# 19. Supabase database schema

Use Postgres for the application state.

## `posts`

```text
id
campaign_id
folder_name
caption
status
instagram_media_id
carousel_container_id
published_at
created_at
updated_at
error_message
```

Possible statuses:

```text
DISCOVERED
VALIDATING
UPLOADING
CREATING_CHILDREN
WAITING_FOR_CHILDREN
CREATING_CAROUSEL
WAITING_FOR_CAROUSEL
PUBLISHING
PUBLISHED
FAILED
```

---

# 20. `post_media`

```text
id
post_id
sequence
original_filename
storage_path
media_type
child_container_id
container_status
created_at
```

Example:

```text
post_id = POST_001
sequence = 1
original_filename = 1.jpg
child_container_id = 178...
```

---

# 21. `campaigns`

```text
id
post_id
instagram_media_id
trigger_keywords
dm_message
destination_url
enabled
created_at
updated_at
```

This is the bridge to OpenReply.

---

# 22. `webhook_events`

Useful for debugging Meta events:

```text
id
provider
event_type
external_event_id
payload
received_at
processed_at
status
error_message
```

Never depend only on application logs for webhook debugging.

Persist enough information to trace:

```text
Meta webhook
    ↓
campaign lookup
    ↓
DM job
    ↓
Meta response
```

---

# 23. Vercel's role

Vercel should be the main application surface.

Use it for:

```text
Dashboard
OAuth callback
API routes
Webhook endpoint
Post/campaign management
Status pages
Manual retry controls
```

The architecture should look like:

```text
Vercel
├── /dashboard
├── /api/posts
├── /api/campaigns
├── /api/meta/oauth
├── /api/webhooks/meta
└── /api/internal/...
```

The public Meta webhook endpoint can live on Vercel.

---

# 24. What should NOT run inside a Vercel request

Avoid putting long-running tasks directly in a request handler.

For example:

```text
Meta webhook arrives
     ↓
Vercel request
     ↓
wait 5 minutes for media processing
     ↓
publish
```

Bad design.

Instead:

```text
Webhook/request
     ↓
create DB/queue job
     ↓
return quickly
     ↓
worker processes job
```

---

# 25. Render's role

Render is useful specifically for **persistent background workers**.

Render documents background workers as continuously running services that consume work from queues, and lists media processing and third-party API interaction as common worker workloads. citeturn0search0turn0search12

Therefore the clean split is:

```text
Vercel
    ↓
API / webhook / dashboard

Render
    ↓
persistent posting worker
```

---

# 26. Do we actually need Render?

### Prototype

Possibly no.

You can start with:

```text
Vercel
+
Supabase
+
Meta API
```

if the posting workflow is small and implemented using suitable serverless/background mechanisms.

### Production

I would use:

```text
Vercel
+
Supabase
+
Render worker
```

because the worker needs to handle:

- polling
- retries
- API calls
- queue jobs
- media processing
- publishing state transitions

without depending on the lifetime of a single web request.

---

# 27. Recommended worker architecture

```text
                   VERCEL
                     │
              create job
                     │
                     ▼
               JOB QUEUE
                     │
                     ▼
             RENDER WORKER
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
      Supabase     Meta API   retries
       Storage
```

For the posting worker, we can use:

```text
Python
```

with:

```text
FastAPI
httpx
Pillow
Supabase client / Postgres
queue client
```

The web dashboard can remain TypeScript/Next.js on Vercel.

---

# 28. Redis / queue decision

This is where OpenReply matters.

OpenReply currently uses:

```text
BullMQ
Redis
Postgres
```

for its DM sending worker. Its README explicitly describes the web process receiving webhooks and a separate worker sending the private replies, with both using the same Postgres and Redis. citeturn0search1

Therefore OpenReply requires a Redis-compatible queue/cache in its current architecture.

We should **not force Supabase to replace Redis**.

Use:

```text
Supabase
→ Postgres + Storage

Redis-compatible service
→ BullMQ / OpenReply queue
```

Possible Redis provider choices:

- Upstash Redis
- Redis Cloud
- Render Key Value
- another Redis-compatible managed service

Render documents Key Value as a Redis-compatible service suitable for job queues and shared caches. citeturn0search12

---

# 29. Recommended final infrastructure

## Core

```text
Vercel
Supabase
Meta
OpenReply
Redis
```

## Optional

```text
Render
AWS Bedrock
Resend
```

But in practice:

```text
Vercel
   │
   ├── dashboard
   ├── API
   └── Meta webhook
   │
   ▼
Supabase
   ├── Postgres
   └── Storage
   │
   ▼
Render worker
   │
   └── Instagram publisher
```

and separately:

```text
Vercel / OpenReply web
        │
        ▼
      Redis
        │
        ▼
OpenReply worker
        │
        ▼
      Meta
```

---

# 30. OpenReply — what it already solves

Repository:

https://github.com/diwenne/openreply

OpenReply describes itself as an open-source ManyChat-style Instagram comment-to-DM automation system. Its documented core flow is:

```text
Instagram comment
       ↓
Meta webhook
       ↓
OpenReply
       ↓
keyword/campaign match
       ↓
queue
       ↓
background worker
       ↓
official Meta private reply
```

It explicitly states that it does not scrape Instagram, does not automate a browser, and does not require an Instagram password. citeturn0search1

It currently documents features including:

- keyword → DM
- optional public reply
- tracked links
- multiple link buttons
- per-post campaigns
- personalization
- multiple professional Instagram accounts
- campaign templates
- DM logs
- queue/worker architecture
- self-comment filtering

citeturn0search1

This is why OpenReply should be the foundation for Module 3 rather than us rewriting comment-to-DM from scratch.

---

# 31. OpenReply current stack

OpenReply currently documents:

```text
Next.js
React
Prisma
PostgreSQL
BullMQ
Redis
Auth.js
Resend
official Instagram API
```

and two runtime processes:

```text
web application
+
worker
```

The web application receives the webhook, while the worker actually sends the messages. citeturn0search1

The setup documentation also exposes environment variables for:

```text
INSTAGRAM_APP_SECRET
FACEBOOK_APP_SECRET
WEBHOOK_VERIFY_TOKEN
ENCRYPTION_KEY
```

and documents a comment polling reconciler as a backup for missed comments. citeturn0search10

---

# 32. OpenReply deployment adaptation

OpenReply's current README gives a reference deployment using:

```text
Vercel
+
Railway
+
Postgres
+
Redis
```

We do not have to copy that infrastructure literally.

For our architecture:

```text
OpenReply web
      ↓
Vercel

OpenReply worker
      ↓
Render

OpenReply Postgres
      ↓
Supabase

OpenReply Redis
      ↓
Upstash / Redis Cloud / Render Key Value
```

The code should be configured using the same connection/environment contracts expected by OpenReply.

Before deployment, verify the current OpenReply `docs/setup.md` because repository deployment instructions can change independently of this plan. citeturn0search10

---

# 33. The synchronisation problem

This is the most important custom integration.

Suppose:

```text
POST_001
```

is published.

Meta returns:

```text
instagram_media_id = 1784XXXXXXXX
```

The posting engine writes:

```text
posts
──────────────────────────
campaign_id: POST_001
instagram_media_id: 1784...
status: PUBLISHED
```

Then the DM campaign must know:

```text
Instagram Media ID
        ↓
POST_001
        ↓
DM campaign
```

---

# 34. Synchronisation strategy

## Best architecture

Use the shared Supabase database as the system-of-record.

```text
Posting Engine
       │
       ▼
Supabase
       │
       ├── post
       ├── media
       └── campaign
       │
       ▼
OpenReply / bridge
```

The publisher does:

```text
publish Instagram post
       ↓
save media ID
       ↓
create/update campaign
       ↓
campaign becomes ACTIVE
```

---

# 35. Do not activate the DM campaign before publishing

Bad:

```text
campaign created
      ↓
publishing fails
      ↓
DM campaign still active
```

Good:

```text
POST_001
   ↓
publish succeeds
   ↓
Media ID saved
   ↓
campaign registered
   ↓
DM campaign ACTIVE
```

This prevents a campaign from pointing at a post that does not exist.

---

# 36. Recommended sync state machine

```text
POST_CREATED
      ↓
PUBLISHING
      ↓
PUBLISHED
      ↓
DM_SYNC_PENDING
      ↓
DM_SYNCING
      ↓
DM_SYNCED
```

Failure:

```text
DM_SYNC_FAILED
```

can be retried without republishing the Instagram post.

This is important because:

```text
Instagram post = already exists
DM sync = failed
```

must not result in:

```text
Instagram post duplicated
```

---

# 37. Bridge API

If modifying OpenReply directly is undesirable, create a tiny bridge API.

Example:

```text
POST /api/internal/published-post
```

Payload:

```json
{
  "campaign_id": "POST_001",
  "instagram_media_id": "1784XXXXXXXX",
  "trigger_keywords": [
    "INFO",
    "LINK"
  ],
  "dm_message": "Hey! Here's the link you asked for 👇",
  "destination_url": "https://example.com/product"
}
```

The bridge then creates/updates the appropriate OpenReply campaign.

---

# 38. Alternative: shared database integration

If OpenReply's database schema is stable enough and we are comfortable coupling to it:

```text
Posting Engine
      ↓
Supabase
      ↓
OpenReply
```

But this creates tighter coupling to OpenReply's internal Prisma schema.

Therefore the preferred approach is:

```text
Posting Engine
      ↓
our own campaign table
      ↓
bridge/API adapter
      ↓
OpenReply
```

This gives us an abstraction boundary.

---

# 39. Comment-to-DM end-to-end flow

Example:

```text
POST_024
```

contains:

```text
1.jpg
2.jpg
3.jpg
caption.md
```

Campaign:

```text
keyword:
INFO

message:
Hey! Here's the link you asked for 👇

URL:
https://example.com/product-24
```

Post gets published:

```text
POST_024
        ↓
Instagram Media ID:
1784XXXXXXXX
```

User comments:

```text
INFO
```

Meta webhook:

```text
comment_id
media_id
commenter
comment_text
```

OpenReply:

```text
media ID
   ↓
campaign lookup
   ↓
keyword match
   ↓
queue
   ↓
worker
   ↓
private reply
```

User receives:

```text
Hey! Here's the link you asked for 👇
```

---

# 40. Why media ID is the right bridge

Do not try to bridge using:

```text
caption
folder name
post timestamp
image filename
```

Those are not reliable identifiers.

Use:

```text
Instagram Media ID
```

and maintain our own:

```text
campaign_id
```

Relationship:

```text
campaign_id
      ↕
instagram_media_id
```

---

# 41. Webhook architecture

The DM engine needs a public HTTPS webhook.

```text
Instagram / Meta
       │
       ▼
https://your-domain.com/api/webhooks/instagram
       │
       ▼
Vercel / OpenReply web
       │
       ▼
validate event
       │
       ▼
store event
       │
       ▼
queue job
       │
       ▼
worker
```

The webhook endpoint should respond quickly.

Do not perform a long AI generation or API retry sequence inside the initial webhook request.

---

# 42. Webhook event handling

Use:

```text
receive
 ↓
validate
 ↓
persist
 ↓
enqueue
 ↓
return
```

not:

```text
receive
 ↓
generate AI
 ↓
call Meta
 ↓
wait
 ↓
retry
 ↓
return
```

The latter is fragile.

---

# 43. Comment processing

A comment should be processed approximately as:

```text
Webhook event
     ↓
Is event valid?
     ↓
Is it a comment event?
     ↓
Which Instagram account?
     ↓
Which Media ID?
     ↓
Which campaign?
     ↓
Is campaign enabled?
     ↓
Does keyword match?
     ↓
Has this comment already been processed?
     ↓
Queue DM
```

---

# 44. Keyword matching

V1 can use simple matching:

```text
INFO
LINK
PRICE
DETAILS
```

Support:

```text
"info"
"INFO"
"Info"
```

through case normalisation.

Later we can support:

```text
whole-word
partial
regex
multiple trigger groups
```

OpenReply already documents whole-word/partial keyword options. citeturn0search1

---

# 45. Do not use Bedrock for simple keyword matching

This is important.

Do not do:

```text
comment
 ↓
LLM
 ↓
"does this mean INFO?"
```

for:

```text
INFO
LINK
PRICE
```

Just use deterministic code.

AI should be reserved for things like:

```text
complex conversational DM
natural-language intent
personalised answers
```

if we actually need those later.

---

# 46. DM response design

V1:

```text
trigger keyword
      ↓
fixed response
      ↓
link
```

Example:

```text
INFO
```

→

```text
Hey! Here's the link you asked for 👇
https://example.com/product
```

This is safer and more predictable than generating every DM with an LLM.

---

# 47. Future AI DM layer

Only later:

```text
Comment
   ↓
deterministic campaign
   ↓
AI response generation
   ↓
policy/format validation
   ↓
Meta private reply
```

Bedrock can be added here if we genuinely need dynamic conversations.

But this is not part of the first version.

---

# 48. Idempotency — posting

The publisher must never blindly process:

```text
POST_001/
```

every time it sees it.

Before publishing:

```text
lookup POST_001
       ↓
status = PUBLISHED?
       │
      YES
       ↓
skip
```

If the worker crashes halfway through, the state machine should tell us where it stopped.

---

# 49. Idempotency — comments

The DM system must not send two messages because Meta delivered the same event twice.

Store:

```text
comment_id
```

and make it unique.

Flow:

```text
comment event
      ↓
comment ID exists?
   ┌──┴──┐
  YES    NO
   │      │
 ignore  process
          │
          ▼
       mark/record
```

OpenReply already has webhook/event logging and DM logs, which can help here. citeturn0search10

---

# 50. Error handling

## Meta API errors

Handle:

```text
HTTP errors
permission errors
expired tokens
invalid media
container errors
rate limits
temporary failures
```

Do not blindly retry every error.

Classify:

```text
retryable
non-retryable
authentication
validation
```

---

# 51. Retry policy

Example:

```text
Attempt 1
   ↓
30 seconds

Attempt 2
   ↓
2 minutes

Attempt 3
   ↓
10 minutes

Attempt 4
   ↓
manual review
```

Use exponential backoff with jitter in the real implementation.

---

# 52. Token handling

Meta access tokens are sensitive.

Never store them:

```text
inside the image folder
inside caption.md
inside Git
inside frontend JavaScript
```

Use:

```text
Vercel environment variables
Render environment variables
Supabase secrets / server-side storage
```

OpenReply already encrypts sensitive account credentials and documents an `ENCRYPTION_KEY`; preserve that architecture rather than inventing a second token system. citeturn0search10

---

# 53. Account requirements

OpenReply's current README says the connected Instagram account must be a **Business or Creator** account rather than a personal account. citeturn0search1

Before production, verify the exact current Meta account requirements and permissions in Meta's own developer documentation because Meta can change API versions, login flows, permissions and review requirements.

---

# 54. Meta permission research rule

Do not copy permissions from an old YouTube video or stale GitHub tutorial.

Before going live, verify:

```text
Current Graph API version
Current Instagram Login flow
Current publishing permissions
Current comment webhook subscriptions
Current private reply/messaging permissions
Current app-review requirements
Current rate limits
Current professional-account requirements
```

Meta's documentation is authoritative.

GitHub repositories are implementation references.

---

# 55. Repository map

## REQUIRED — DM engine

### OpenReply

https://github.com/diwenne/openreply

Use for:

```text
comment webhook
keyword campaigns
private replies
DM logs
queue
worker
account management
```

Status:

**Core dependency for Module 3.**

---

# 56. REQUIRED — Meta publishing reference

### Meta / Facebook Samples

https://github.com/fbsamples/reels_publishing_apis

Use as a Meta-maintained implementation reference for content publishing.

The repository's current README documents carousel publishing through:

```text
item containers
      ↓
carousel container
      ↓
media_publish
```

and a maximum of 10 media items. citeturn0search6

We should implement our own minimal publisher rather than making the entire sample repository our application.

---

# 57. OPTIONAL — InstaAutomate

https://github.com/abhbaty/instautomate

Use only as a reference/alternative.

Potentially useful for:

```text
comment webhooks
keyword automation
private replies
deduplication
deployment ideas
```

Do not run OpenReply and InstaAutomate simultaneously against the same account.

---

# 58. OPTIONAL — Instagram Graph API libraries

Any third-party API wrapper should be treated as a convenience layer, not as the source of truth.

The safest implementation for the publisher is often:

```text
Python
+
httpx
+
Meta REST API
```

rather than relying on a wrapper that might lag behind the current Graph API version.

---

# 59. Repository verification policy

Before adopting a repo, verify:

```text
last meaningful commit
open issues
Meta API version
official API endpoints used
authentication flow
licence
deployment assumptions
environment variables
dependency health
```

Most importantly:

> **Does it call the official Meta Graph/Instagram API, or does it automate the Instagram website?**

If the latter, reject it.

---

# 60. V1 project structure

Recommended posting repository:

```text
instagram-publisher/
│
├── app/
│   ├── main.py
│   ├── config.py
│   ├── scanner.py
│   ├── validator.py
│   ├── storage.py
│   ├── meta_client.py
│   ├── containers.py
│   ├── publisher.py
│   ├── database.py
│   ├── jobs.py
│   └── bridge.py
│
├── posts/
│   └── POST_001/
│       ├── 1.jpg
│       ├── 2.jpg
│       └── caption.md
│
├── tests/
│   ├── test_scanner.py
│   ├── test_validator.py
│   ├── test_sorting.py
│   ├── test_meta_flow.py
│   └── test_idempotency.py
│
├── Dockerfile
├── requirements.txt
└── README.md
```

---

# 61. Recommended dashboard

Vercel-hosted dashboard:

```text
Dashboard
│
├── Posts
│   ├── Draft
│   ├── Publishing
│   ├── Published
│   └── Failed
│
├── Campaigns
│   ├── Active
│   ├── Paused
│   └── Failed sync
│
├── DM Logs
│
└── Settings
    ├── Instagram account
    ├── Default caption settings
    └── API status
```

V1 can be much smaller.

---

# 62. First UI we actually need

Do not build a massive dashboard immediately.

V1 only needs:

```text
POSTS

POST_001
4 images
Caption ready
[Publish]

POST_002
6 images
Caption ready
[Publish]

POST_003
3 images
Published ✓
Instagram Media ID: ...
```

Then:

```text
CAMPAIGN

POST_003

Trigger:
[ INFO ]

DM:
[ Hey! Here's your link 👇 ]

Link:
[ https://... ]

[ Enable ]
```

---

# 63. Full V1 flow

```text
USER
 │
 │ creates
 ▼
POST_001/
├── 1.jpg
├── 2.jpg
├── 3.jpg
└── caption.md
 │
 ▼
Vercel / publisher
 │
 ▼
Supabase Storage
 │
 ▼
Meta child containers
 │
 ▼
Meta carousel container
 │
 ▼
Meta media_publish
 │
 ▼
Instagram Media ID
 │
 ▼
Supabase
 │
 ▼
Campaign registered
 │
 ▼
Instagram
 │
 │ user comments INFO
 ▼
Meta webhook
 │
 ▼
OpenReply
 │
 ▼
keyword match
 │
 ▼
Redis/BullMQ
 │
 ▼
OpenReply worker
 │
 ▼
Meta private reply
 │
 ▼
USER GETS LINK
```

---

# 64. Failure scenario: posting fails

```text
POST_001
    ↓
Meta error
    ↓
status = FAILED
```

No DM campaign should be activated.

The user can:

```text
Retry
```

without creating a new campaign.

---

# 65. Failure scenario: DM synchronisation fails

```text
Instagram publish succeeds
        ↓
Media ID saved
        ↓
DM sync fails
        ↓
status = DM_SYNC_FAILED
```

Retry only:

```text
campaign registration
```

Do NOT republish the Instagram post.

---

# 66. Failure scenario: worker restarts

If worker dies after:

```text
child containers created
```

it reads the database and continues/reconciles from the recorded state.

Do not assume:

```text
worker restarted = start from zero
```

---

# 67. Failure scenario: webhook duplicate

```text
same comment_id
       ↓
database unique check
       ↓
already processed
       ↓
ignore
```

No second DM.

---

# 68. Phase-by-phase implementation plan

## Phase 1 — Meta account setup

Tasks:

- [ ] Meta developer account
- [ ] Meta application
- [ ] Professional Instagram account
- [ ] Connect account
- [ ] Verify current API/login flow
- [ ] Verify current publishing permissions
- [ ] Verify current comment webhook permissions
- [ ] Verify current private reply permissions
- [ ] Create development/test account
- [ ] Test authentication

Acceptance:

```text
Server can authenticate against the intended Instagram account.
```

---

# 69. Phase 2 — One-image publisher

Do not start with carousels.

Build:

```text
image.jpg
caption.md
     ↓
Meta
     ↓
Instagram image post
```

Acceptance:

> One image publishes successfully through the official Meta API.

---

# 70. Phase 3 — Carousel publisher

Implement:

```text
1.jpg
2.jpg
3.jpg
     ↓
child containers
     ↓
carousel
     ↓
publish
```

Acceptance:

> Images appear in exactly the intended order.

---

# 71. Phase 4 — Supabase Storage

Implement:

```text
local file
   ↓
Supabase Storage
   ↓
HTTPS URL
```

Acceptance:

> Meta can retrieve every media asset required by the publishing flow.

---

# 72. Phase 5 — Folder ingestion

Implement:

```text
POST_001/
├── 1.jpg
├── 2.jpg
└── caption.md
```

Acceptance:

> Dropping the folder into the configured input mechanism creates exactly one publish job.

---

# 73. Phase 6 — Database/idempotency

Add:

```text
posts
post_media
```

Acceptance:

> Restarting the worker does not duplicate an already published post.

---

# 74. Phase 7 — Vercel dashboard

Add:

```text
Posts
Publish status
Errors
Instagram Media ID
```

Acceptance:

> User can see exactly what happened to every folder.

---

# 75. Phase 8 — OpenReply

Clone:

```text
https://github.com/diwenne/openreply
```

Follow its current setup guide.

Deploy:

```text
web
worker
Postgres
Redis
```

Adapt the infrastructure:

```text
web → Vercel
Postgres → Supabase
worker → Render
Redis → managed Redis
```

Acceptance:

```text
Test comment
   ↓
OpenReply
   ↓
private reply
```

---

# 76. Phase 9 — Synchronisation

Implement:

```text
Instagram Media ID
      ↓
campaign
```

Acceptance:

> A published post can be associated with exactly one intended DM campaign.

---

# 77. Phase 10 — Automatic campaign creation

Once manual campaign linking works:

```text
publish
   ↓
save media ID
   ↓
create campaign
   ↓
activate
```

Acceptance:

> User does not manually configure the DM campaign after every post.

---

# 78. Phase 11 — End-to-end test

Test:

```text
POST_001/
├── 1.jpg
├── 2.jpg
├── 3.jpg
└── caption.md
```

Expected:

```text
Instagram carousel published
        ↓
campaign registered
        ↓
user comments INFO
        ↓
private DM sent
        ↓
user receives link
```

If this works, the core system is done.

---

# 79. Production hardening

After V1 works:

- [ ] structured logging
- [ ] error dashboard
- [ ] retry queue
- [ ] API rate-limit handling
- [ ] token refresh/expiry handling
- [ ] webhook signature verification
- [ ] event deduplication
- [ ] database constraints
- [ ] campaign enable/disable
- [ ] manual retry
- [ ] worker health check
- [ ] monitoring
- [ ] alerts
- [ ] backups
- [ ] audit logs

---

# 80. Testing matrix

## Content

- [ ] 2-image carousel
- [ ] 3-image carousel
- [ ] 10-image carousel
- [ ] 11-image rejection
- [ ] missing image
- [ ] duplicate image filename
- [ ] missing caption
- [ ] empty caption
- [ ] invalid image
- [ ] PNG input
- [ ] numeric ordering
- [ ] filename ordering

## Publishing

- [ ] authentication failure
- [ ] invalid token
- [ ] media URL unavailable
- [ ] child container processing
- [ ] child container error
- [ ] carousel error
- [ ] publish error
- [ ] duplicate publish attempt
- [ ] worker restart
- [ ] retry

## DM

- [ ] `INFO`
- [ ] `info`
- [ ] unrelated comment
- [ ] duplicate webhook
- [ ] same user twice
- [ ] campaign disabled
- [ ] wrong post
- [ ] DM API failure
- [ ] queue failure
- [ ] worker restart

## Synchronisation

- [ ] publish → campaign
- [ ] publish fails → no campaign
- [ ] campaign sync fails → retry only sync
- [ ] duplicate sync
- [ ] webhook arrives during sync
- [ ] post exists but campaign is pending

---

# 81. Cost architecture

The project is intentionally designed so the expensive services are optional.

## Base

```text
Vercel
Supabase
Meta
OpenReply
Redis
```

## AI

```text
AWS Bedrock
```

only when AI generation is actually being used.

## Worker

```text
Render
```

when persistent workers are needed.

We should avoid adding AWS S3 because Supabase Storage already covers the object-storage requirement.

We should avoid adding a separate database because Supabase Postgres covers the application database.

---

# 82. What each service owns

## Vercel

Owns:

```text
UI
API
OAuth callback
webhooks
```

Does NOT own:

```text
long-running publishing worker
Redis queue
Instagram credentials in frontend
```

---

## Supabase

Owns:

```text
Postgres
media storage
post state
campaign state
event logs
```

---

## Bedrock

Owns:

```text
caption generation
future AI content intelligence
future optional conversational generation
```

Does NOT own:

```text
Instagram publishing
webhook handling
DM sending
```

---

## Meta

Owns:

```text
Instagram authentication
publishing
comments
webhooks
private replies
Instagram media IDs
```

---

## OpenReply

Owns:

```text
comment campaigns
keyword matching
DM queue
DM worker
DM logs
```

---

## Redis

Owns:

```text
job queue
worker coordination
temporary queue state
```

---

## Render

Owns:

```text
persistent background worker
```

and nothing else unless we later choose to move more infrastructure there.

---

# 83. The simplest possible final stack

If we strip everything down:

```text
             CONTENT
                │
                ▼
          Vercel Dashboard
                │
                ▼
             Supabase
          ┌─────┴─────┐
          │           │
       Storage      Postgres
          │           │
          └─────┬─────┘
                │
                ▼
          Posting Worker
                │
                ▼
          Official Meta API
                │
                ▼
            Instagram
                │
             comment
                │
                ▼
          Meta Webhook
                │
                ▼
             OpenReply
                │
              Redis
                │
                ▼
          OpenReply Worker
                │
                ▼
          Official Meta API
                │
                ▼
             USER DM
```

This is the architecture to target.

---

# 84. What we should build first

Do **not** start with AI.

Do **not** start with the dashboard.

Do **not** start by modifying OpenReply.

Start here:

```text
LOCAL FOLDER
    ↓
SUPABASE STORAGE
    ↓
META API
    ↓
ONE IMAGE POST
```

Then:

```text
LOCAL FOLDER
    ↓
SUPABASE STORAGE
    ↓
META API
    ↓
CAROUSEL
```

Then:

```text
CAROUSEL
    ↓
MEDIA ID
    ↓
SUPABASE
```

Then bring in:

```text
OPENREPLY
```

Then bridge:

```text
MEDIA ID
    ↓
CAMPAIGN
```

Then automate the campaign creation.

That order prevents us from debugging four systems simultaneously.

---

# 85. Final architecture decision

## V1

```text
Content:
manual folder

AI:
none required

Frontend:
Vercel

Database:
Supabase Postgres

Media:
Supabase Storage

Publisher:
custom Python service

Publisher worker:
Render

Instagram:
official Meta API

DM:
OpenReply

DM queue:
Redis-compatible service

DM worker:
Render

AI:
AWS Bedrock — optional
```

## V2

```text
Content Engine
    ↓
Bedrock
    ↓
folder generation
    ↓
automatic publishing
    ↓
automatic campaign registration
    ↓
OpenReply
```

---

# 86. Repository list — final

### Core

**OpenReply**  
https://github.com/diwenne/openreply

Purpose:

```text
Instagram comment → keyword → private DM
```

### Meta reference

**Meta/Facebook Samples — Reels & Content Publishing API**  
https://github.com/fbsamples/reels_publishing_apis

Purpose:

```text
official publishing API reference
carousel flow
Meta implementation examples
```

### Alternative DM reference

**InstaAutomate**  
https://github.com/abhbaty/instautomate

Purpose:

```text
alternative Meta comment/DM implementation
```

### Optional Meta API reference

**meta-mcp-server content-publishing documentation**  
https://github.com/oliverames/meta-mcp-server/blob/main/docs/instagram-api/content-publishing.md

Purpose:

```text
human-readable REST/API flow reference
container status
carousel requests
```

Use this as a secondary reference, not as an authority over Meta documentation.

---

# 87. Official service documentation

### Supabase

Storage:
https://supabase.com/docs/guides/storage

Database:
https://supabase.com/docs/guides/database/overview

Storage access control:
https://supabase.com/docs/guides/storage/security/access-control

Supabase Storage supports files/folders/buckets and is integrated with its Postgres-backed access-control model. citeturn0search2turn0search3turn0search7turn0search13

### AWS Bedrock

Models:
https://docs.aws.amazon.com/bedrock/latest/userguide/models.html

Agents:
https://docs.aws.amazon.com/bedrock/latest/userguide/agents.html

For this project, use Bedrock model inference; do not make Bedrock Agents Classic a dependency. AWS currently says Agents Classic is in maintenance mode and closed to new customers from 30 July 2026. citeturn0search4turn0search9

### Render

Background workers:
https://render.com/docs/background-workers

Service types:
https://render.com/docs/service-types

Render explicitly positions background workers for continuous asynchronous jobs such as media processing and third-party API calls. citeturn0search0turn0search12

---

# 88. Final implementation checklist

## Infrastructure

- [ ] Supabase project
- [ ] Postgres schema
- [ ] Storage bucket
- [ ] Redis provider
- [ ] Vercel project
- [ ] Render worker
- [ ] Meta developer app

## Instagram publisher

- [ ] Meta authentication
- [ ] one-image publishing
- [ ] media hosting
- [ ] child containers
- [ ] container polling
- [ ] carousel container
- [ ] media publish
- [ ] Media ID persistence
- [ ] retries
- [ ] idempotency

## OpenReply

- [ ] clone repo
- [ ] verify current setup docs
- [ ] Vercel web deployment
- [ ] Postgres connection
- [ ] Redis connection
- [ ] worker deployment
- [ ] Meta webhook
- [ ] test comment
- [ ] test private reply

## Bridge

- [ ] campaign table
- [ ] Media ID mapping
- [ ] campaign registration
- [ ] sync state
- [ ] retry sync
- [ ] duplicate prevention

## AI

- [ ] Bedrock account/permissions
- [ ] model selection
- [ ] caption prompt
- [ ] generate `caption.md`
- [ ] optional campaign generation

---

# 89. The actual end state

The finished system should feel like this:

```text
YOU

POST_027/
├── 1.jpg
├── 2.jpg
├── 3.jpg
├── 4.jpg
└── caption.md

                    ↓

             [SYSTEM DOES IT]

                    ↓

Instagram:
4-image carousel published

                    ↓

Campaign:
POST_027 → INFO

                    ↓

Someone comments:

"INFO"

                    ↓

OpenReply:

keyword matched

                    ↓

User receives:

"Hey! Here's the link you asked for 👇
https://..."

                    ↓

DONE
```

The user should not have to think about:

```text
container IDs
Media IDs
webhooks
Redis
workers
Meta tokens
polling
retries
campaign synchronisation
```

Those are implementation details.

---

# 90. Build priority

The exact order is:

```text
PRIORITY 1
Meta authentication
        ↓
PRIORITY 2
one-image publisher
        ↓
PRIORITY 3
carousel publisher
        ↓
PRIORITY 4
Supabase Storage
        ↓
PRIORITY 5
folder ingestion
        ↓
PRIORITY 6
Postgres + idempotency
        ↓
PRIORITY 7
Vercel dashboard
        ↓
PRIORITY 8
OpenReply standalone
        ↓
PRIORITY 9
comment → DM
        ↓
PRIORITY 10
Media ID ↔ campaign bridge
        ↓
PRIORITY 11
automatic campaign registration
        ↓
PRIORITY 12
Bedrock content generation
        ↓
PRIORITY 13
production hardening
```

**Do not move Bedrock ahead of the publishing pipeline.**

**Do not modify OpenReply until its standalone comment-to-DM flow works.**

**Do not automate campaign creation until manual campaign linking works.**

That gives us three independently testable systems and one small integration layer instead of one giant ball of spaghetti.

---

# 91. Research notes / facts to re-verify before production

Because Meta changes APIs and permissions, the following must be checked against current Meta developer documentation immediately before deployment:

- exact Graph API version
- exact Instagram Login/authentication flow
- exact publishing permissions
- exact webhook fields/subscriptions
- exact private-reply permissions
- current professional-account requirements
- current publishing limits
- current media requirements
- current container status fields
- current token expiry/refresh behaviour
- current app-review requirements

The repositories are useful implementation references, but **Meta's current developer documentation is the final authority**.

The architecture itself should not depend on undocumented Instagram behaviour.

---

# 92. Final decision

The project should use:

```text
                 ┌──────────────┐
                 │    VERCEL    │
                 │ UI + API     │
                 │ Meta webhook │
                 └──────┬───────┘
                        │
                        ▼
                 ┌──────────────┐
                 │   SUPABASE   │
                 │              │
                 │ PostgreSQL   │
                 │ Storage      │
                 └──────┬───────┘
                        │
               ┌────────┴────────┐
               ▼                 ▼
       POSTING WORKER       OPENREPLY
          RENDER             │
               │             │
               │          REDIS
               │             │
               │          WORKER
               │             │
               └──────┬──────┘
                      ▼
                 META API
                      │
                      ▼
                  INSTAGRAM

                  + BEDROCK
              only where AI is needed
```

This is the target architecture.

It is deliberately boring, modular, official-API-only, and easy to replace piece-by-piece if one provider becomes annoying later.
