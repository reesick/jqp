# Design System --- Linear-Inspired Instagram Automation Dashboard

## 1. Design Intent

Build a daily-driver Instagram automation dashboard inspired by the
**calm density and interaction quality of Linear**.

The product should feel:

-   Fast
-   Quiet
-   Dense, but never cluttered
-   Keyboard-friendly
-   Operational rather than "admin dashboard"
-   Premium and developer-tool-like
-   Focused on the next useful action

Do **not** copy Linear's branding, logo, illustrations, or exact UI. Use
its design principles as inspiration.

### Core principle

> Show me what matters now. Hide everything else until I need it.

The dashboard is for a solo operator who:

1.  Publishes Instagram carousel posts.
2.  Schedules upcoming content.
3.  Runs comment-to-DM automations.
4.  Checks failed/retrying automations.
5.  Opens logs only when something needs investigation.

------------------------------------------------------------------------

# 2. Visual Direction

## Overall style

**Dark, dense, restrained, Linear × Vercel × Raycast.**

Avoid the typical AI SaaS aesthetic:

-   No purple gradient backgrounds
-   No huge hero cards
-   No excessive rounded rectangles
-   No dashboard full of KPI cards
-   No oversized coloured status badges
-   No unnecessary charts

The interface should look like a serious tool that happens to be
pleasant to use.

------------------------------------------------------------------------

# 3. Colour Tokens

``` css
:root {
  --bg: #0A0A0A;
  --surface: #111111;
  --surface-raised: #151515;
  --surface-hover: #191919;
  --surface-active: #202020;

  --border: #262626;
  --border-subtle: #1C1C1C;

  --text-primary: #F5F5F5;
  --text-secondary: #A1A1A1;
  --text-muted: #666666;

  --accent: #8B5CF6;
  --accent-soft: #8B5CF61A;

  --success: #4ADE80;
  --warning: #FBBF24;
  --error: #F87171;
  --info: #60A5FA;
}
```

### Colour rules

Use neutral colours for 90%+ of the interface.

Colour should communicate:

-   `green` → healthy / published / completed
-   `yellow` → waiting / retrying / attention
-   `red` → failed / blocked
-   `blue` → informational
-   `purple` → primary interaction / selected state

Never colour an entire card based on its status.

Use a tiny icon, dot, or text accent instead.

------------------------------------------------------------------------

# 4. Typography

## Primary font

Use **Inter**.

``` css
font-family: Inter, ui-sans-serif, system-ui, sans-serif;
```

## Technical font

Use **JetBrains Mono** for:

-   timestamps
-   run IDs
-   logs
-   technical values
-   API/event information

``` css
font-family: "JetBrains Mono", monospace;
```

## Type scale

``` text
Page title       24px / 30px   600
Section title    13px / 18px   600
Body             14px / 20px   400
Secondary        13px / 18px   400
Caption          12px / 16px   400
Technical        12px / 16px   mono
```

Do not use enormous headings.

The interface is a tool, not a landing page.

------------------------------------------------------------------------

# 5. Spacing

Use a 4px base spacing system.

``` text
4px
8px
12px
16px
20px
24px
32px
40px
48px
```

Most UI elements should use:

-   8px internal gaps
-   12px component padding
-   16px section spacing
-   24px major section spacing
-   32px page-level spacing

Prefer whitespace between groups over padding inside every individual
component.

------------------------------------------------------------------------

# 6. Radius

Keep corners restrained.

``` text
Buttons:        6px
Inputs:         6px
Small cards:    8px
Panels:         8px
Modal:          10px
Media preview:  10px
```

Avoid 20--24px "soft SaaS" cards.

------------------------------------------------------------------------

# 7. Shadows

Use almost no shadows.

Preferred:

``` css
box-shadow: 0 0 0 1px var(--border);
```

For floating surfaces:

``` css
box-shadow:
  0 12px 32px rgba(0,0,0,.35),
  0 0 0 1px var(--border);
```

The UI should feel like it is built from surfaces, not floating glass
cards.

------------------------------------------------------------------------

# 8. Application Shell

Desktop layout:

``` text
┌─────────────────────────────────────────────────────────┐
│ Sidebar        │ Main Content                           │
│                │                                        │
│ ○ Account      │                                        │
│                │                                        │
│ Home           │                                        │
│ Calendar       │                                        │
│ Posts          │                                        │
│ Automations    │                                        │
│ Activity       │                                        │
│                │                                        │
│ ─────────────  │                                        │
│ Settings       │                                        │
│                │                                        │
│ ⌘K Search      │                                        │
└─────────────────────────────────────────────────────────┘
```

## Sidebar

Width:

``` text
220px expanded
56px collapsed
```

The sidebar should be visually quiet.

Do not give every navigation item a large background.

Active item:

``` text
background: #191919
color: #F5F5F5
```

Inactive:

``` text
color: #8A8A8A
```

Hover:

``` text
background: #151515
```

------------------------------------------------------------------------

# 9. Primary Navigation

``` text
Home
Calendar
Posts
Automations
Activity
```

Secondary:

``` text
Settings
Connections
```

Do not create navigation for every feature.

For example, do NOT create:

``` text
DMs
Comments
Instagram
Campaigns
Runs
Logs
Failures
Analytics
```

These belong inside the relevant primary areas.

------------------------------------------------------------------------

# 10. Command Palette

Global shortcut:

``` text
⌘K
```

Windows/Linux:

``` text
Ctrl+K
```

Opening it should feel like Raycast.

Example:

``` text
┌─────────────────────────────────────────┐
│ Search or run a command...              │
├─────────────────────────────────────────┤
│ Create carousel                         │
│ Schedule post                           │
│ Start comment → DM campaign              │
│ View failed runs                        │
│ Open calendar                           │
│ Search posts                            │
│ Settings                                │
└─────────────────────────────────────────┘
```

Commands should be contextual.

If the user is viewing a post:

``` text
Edit
Duplicate
Reschedule
Publish now
View on Instagram
View activity
Delete
```

------------------------------------------------------------------------

# 11. Home Screen

The Home screen is the most important screen.

It should feel like a **morning cockpit**, not an analytics dashboard.

## Top

``` text
Good morning, Sri

Wednesday, 30 September
Everything is running normally.
```

Keep this compact.

Do not use a giant welcome banner.

------------------------------------------------------------------------

# 12. Home Information Hierarchy

Order:

1.  Needs attention
2.  Next scheduled post
3.  Active automations
4.  Upcoming content
5.  Recent activity

The user should understand the state of their system within 5 seconds.

------------------------------------------------------------------------

# 13. Needs Attention

Only show this section when something actually needs attention.

Example:

``` text
NEEDS ATTENTION

⚠ Comment → DM
  2 messages failed
  Instagram rate limit

  [Retry]
```

If nothing is wrong:

``` text
✓ Everything is running normally
```

Do NOT show:

``` text
ERRORS: 0
FAILED: 0
WARNINGS: 0
```

That is dashboard noise.

------------------------------------------------------------------------

# 14. Next Scheduled Post

Show one primary upcoming post.

``` text
NEXT UP

┌─────────────────────────────────────────┐
│                                         │
│  [ Instagram carousel preview ]         │
│                                         │
│  New collection                         │
│  Today · 7:30 PM                        │
│                                         │
│  Scheduled                              │
└─────────────────────────────────────────┘
```

Actions:

``` text
Edit
Reschedule
Publish now
```

Keep secondary actions hidden until hover or `⌘K`.

------------------------------------------------------------------------

# 15. Automation Overview

Example:

``` text
AUTOMATIONS

Comment → DM              ● Running
Giveaway responses        ● Running
Lead capture              ● Paused
```

Each row should show:

``` text
Name
Status
Small useful metric
Last activity
```

Example:

``` text
Comment → DM
Running · 342 processed
Last activity 2 min ago
```

Avoid giant cards.

------------------------------------------------------------------------

# 16. Upcoming Content

Use compact rows or a horizontal strip.

``` text
UPCOMING

[IMG]  New collection      Today · 7:30 PM
[IMG]  Product carousel    Thu · 12:00 PM
[IMG]  Founder story       Fri · 6:30 PM
```

If visual planning becomes important, provide a dedicated Calendar page
inspired by Later.

------------------------------------------------------------------------

# 17. Activity Feed

Activity should read like a system timeline.

``` text
RECENT ACTIVITY

● 14:32   Carousel published
           New collection

● 14:18   Comment → DM
           124 messages sent

● 13:51   Campaign started
           Giveaway responses

● 12:42   DM retrying
           Instagram rate limit
```

Use tiny status indicators.

Do not turn each event into a card.

------------------------------------------------------------------------

# 18. Status System

Use four core states:

``` text
Queued
Running
Published / Completed
Failed
```

Optional:

``` text
Retrying
Paused
Cancelled
```

## Visual treatment

Use:

``` text
● Running
✓ Published
↻ Retrying
! Failed
○ Queued
Ⅱ Paused
```

Status text should usually be neutral.

Example:

``` text
● Running
```

rather than:

``` text
[ACTIVE]
```

Avoid large coloured pills unless the state needs to be immediately
scannable.

------------------------------------------------------------------------

# 19. Status Colour

``` text
Running     neutral / white dot
Queued      muted grey
Published   green
Retrying    yellow
Failed      red
Paused      muted grey
```

Colour is secondary.

The icon + text must communicate the state even without colour.

------------------------------------------------------------------------

# 20. Posts Page

Default view:

``` text
POSTS

All     Scheduled     Published     Drafts

──────────────────────────────────────────

[IMG]  New collection
       Today · 7:30 PM
       ● Scheduled

[IMG]  Summer campaign
       Yesterday
       ✓ Published

[IMG]  Product drop
       Failed 2 min ago
       ! Failed
```

The post thumbnail should carry most of the visual interest.

------------------------------------------------------------------------

# 21. Calendar Page

Use a clean calendar inspired by Notion Calendar and Later.

Views:

``` text
Week
Month
Feed
```

Instagram content should be visual.

Prefer:

``` text
[thumbnail]
[thumbnail]
[thumbnail]
```

over blocks filled with text.

Drag-and-drop should reschedule content.

------------------------------------------------------------------------

# 22. Automation Page

The automation page should have two levels.

## Level 1 --- Overview

``` text
AUTOMATIONS

Comment → DM
● Running
342 processed today
Last run 2 min ago

────────────────────

Giveaway replies
● Running
128 processed today
```

## Level 2 --- Detail

``` text
Comment → DM

● Running

TRIGGER
Instagram comment contains:
"LINK"

ACTION
Send DM

ACTIVITY
342 processed
337 sent
3 skipped
2 failed
```

------------------------------------------------------------------------

# 23. Automation Logs

Never show raw logs on the main dashboard.

Progressive disclosure:

``` text
Campaign
  ↓
Run
  ↓
Event
  ↓
Technical details
```

Example:

``` text
Run #8F21A

✓ Comment detected
✓ Profile checked
✓ DM sent
✓ DM sent
! Instagram rate limit
↻ Retrying
```

Clicking an event can reveal:

``` text
Timestamp
Event type
Instagram object ID
Request ID
Error message
Retry count
```

Technical data belongs here, not on Home.

------------------------------------------------------------------------

# 24. Errors

Errors should explain:

1.  What happened
2.  Why it happened
3.  What the user can do

Bad:

``` text
Error 429
```

Good:

``` text
Instagram rate limit

2 DMs could not be sent.
We'll retry automatically in 10 minutes.

[Retry now]
```

If automatic retry is active:

``` text
↻ Retrying in 8 min
```

------------------------------------------------------------------------

# 25. Toasts

Toasts should be short-lived confirmations.

Good:

``` text
✓ Post scheduled
```

``` text
✓ Campaign paused
```

``` text
✓ Post published
```

For recoverable errors:

``` text
Couldn't publish post
[Retry]
```

Avoid:

``` text
SUCCESS!
Your post has successfully been scheduled for publication...
```

Keep toasts under two lines.

------------------------------------------------------------------------

# 26. Empty States

Empty states should be useful, not decorative.

## No posts

``` text
No posts yet.

Create your first carousel and schedule it.

[Create carousel]
```

## No automations

``` text
No automations yet.

Turn Instagram comments into automatic DMs.

[Create automation]
```

## No failures

Do not create an elaborate empty state.

Simply:

``` text
✓ No issues detected
```

This is preferable to a huge illustration saying "You're all caught up!"

------------------------------------------------------------------------

# 27. Loading States

Prefer skeletons that preserve the final layout.

Do not use a full-screen spinner.

Example:

``` text
Good morning, Sri

████████████████

┌─────────────────────────────┐
│ █████████                  │
│ █████████████              │
│ ███████                    │
└─────────────────────────────┘
```

Skeletons should be subtle:

``` text
background: #181818
```

Use shimmer sparingly.

For actions, prefer immediate optimistic UI:

``` text
Click "Pause"

→ row instantly becomes Paused
→ background request runs
→ rollback if request fails
```

------------------------------------------------------------------------

# 28. Motion

Motion should communicate state, not decorate the UI.

Use:

``` text
100–150ms
```

for:

-   hover
-   button state
-   sidebar expansion
-   menu opening

Use:

``` text
150–220ms
```

for:

-   modal
-   drawer
-   panel transitions

Avoid:

-   bouncing cards
-   excessive spring animations
-   animated gradients
-   constant pulsing
-   large page transitions

A running automation may have a very subtle animated indicator, but
don't make the entire dashboard move.

------------------------------------------------------------------------

# 29. Buttons

Primary:

``` text
background: #F5F5F5
color: #0A0A0A
```

Example:

``` text
+ Create carousel
```

Secondary:

``` text
background: #191919
border: #262626
color: #F5F5F5
```

Destructive:

Use red text/icon with restrained styling.

Do not make every action a filled button.

Prefer:

``` text
[Create carousel]
```

and secondary actions as text/icon actions.

------------------------------------------------------------------------

# 30. Keyboard Shortcuts

Core shortcuts:

``` text
⌘K        Command palette
C         Create carousel
A         Create automation
G then H  Home
G then C  Calendar
G then P  Posts
G then A  Automations
/         Search
Esc       Close modal/panel
```

Show shortcuts inside command menus and tooltips.

Do not require users to memorise them.

------------------------------------------------------------------------

# 31. Responsive / Mobile

Desktop is the primary experience.

Mobile should not simply shrink the desktop UI.

Mobile navigation:

``` text
Home
Calendar
Posts
Automations
```

Use a bottom navigation bar.

Hide the sidebar.

Command palette becomes a search/action sheet.

Post creation should be optimised for vertical media previews.

Automation logs should become a full-screen drill-down.

------------------------------------------------------------------------

# 32. Accessibility

Requirements:

-   Minimum 4.5:1 text contrast
-   Never communicate status through colour alone
-   Keyboard navigation everywhere
-   Visible focus state
-   Buttons must have accessible labels
-   `Esc` closes overlays
-   Reduced-motion support
-   Loading states must not trap keyboard focus

------------------------------------------------------------------------

# 33. Component Principles

Prefer reusable primitives:

``` text
Button
IconButton
Input
Select
Dropdown
CommandMenu
Modal
Drawer
Tooltip
Toast
StatusIndicator
ActivityRow
PostRow
PostPreview
AutomationRow
SectionHeader
EmptyState
Skeleton
```

Do not create bespoke components for every screen.

------------------------------------------------------------------------

# 34. Data Density Rules

A screen should prioritise:

``` text
1. What needs attention?
2. What happens next?
3. What is currently running?
4. What happened recently?
5. Everything else.
```

Do not expose every available metric.

A solo operator does not need an enterprise monitoring centre.

------------------------------------------------------------------------

# 35. The "All Good" State

The default Home state should feel calm.

Example:

``` text
Good morning, Sri

✓ Everything is running normally


NEXT UP
[Carousel]
Today · 7:30 PM


AUTOMATIONS
● Comment → DM       Running
● Giveaway replies   Running


RECENT ACTIVITY
● Carousel published
● 24 DMs sent
● Campaign started
```

The absence of problems should be communicated quietly.

Do not celebrate normal operation with giant green UI.

------------------------------------------------------------------------

# 36. The "Something Is Wrong" State

Only the affected area should change.

``` text
Good morning, Sri

⚠ 1 thing needs your attention


NEEDS ATTENTION

Comment → DM
2 DMs failed

Instagram rate limit

[Retry]


NEXT UP
...
```

Everything else remains visually normal.

This prevents the entire interface from feeling broken because of one
failed operation.

------------------------------------------------------------------------

# 37. Core UX Loop

The product should optimise for this loop:

``` text
OPEN
  ↓
UNDERSTAND STATE
  ↓
SEE NEXT POST
  ↓
CHECK AUTOMATIONS
  ↓
FIX EXCEPTION
  ↓
LEAVE
```

Target time:

**under 30 seconds for a normal morning check.**

------------------------------------------------------------------------

# 38. Anti-Patterns

Never build:

``` text
❌ 12 KPI cards
❌ Giant "Welcome to your dashboard" hero
❌ Purple gradient everywhere
❌ Huge coloured status badges
❌ Full-screen loading spinner
❌ Every action as a button
❌ Raw technical logs on Home
❌ Excessive shadows
❌ 20px+ rounded cards everywhere
❌ Charts without a decision attached
❌ Notifications for every successful automation
❌ "Everything is amazing!" messaging
```

------------------------------------------------------------------------

# 39. Reference Products

Use these as behavioural references:

-   Linear --- information density, keyboard UX, command menu
-   Vercel --- deployment/status model
-   Raycast --- command-driven interaction
-   Stripe --- operational dashboard hierarchy
-   Notion Calendar --- calm scheduling UI
-   Buffer --- social-media Home workflow
-   Later --- visual Instagram planning
-   Typefully --- creator-first experience
-   Resend --- logs and progressive disclosure
-   Cal.com --- status/navigation organisation
-   Arc --- contextual sidebar
-   Superhuman --- keyboard-first workflows

Do not copy their branding or exact visual identity.

------------------------------------------------------------------------

# 40. Final Design Test

Before shipping a screen, ask:

### Can I understand what is happening in 5 seconds?

### Can I fix the most important problem in 2 clicks?

### Is the next scheduled post obvious?

### Can I tell whether the automations are healthy without reading logs?

### Does colour communicate something meaningful?

### Could I remove 20% of the UI without losing functionality?

### Does this look like a tool someone would willingly open every morning?

If the answer to the last question is no, simplify it.
