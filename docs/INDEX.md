# Docs index: which file to read for what

**New here? Read in this order:** `ARCHITECTURE.md` (the map), then `MORNING-CHECKLIST.md` (what is left), then `REMEDIATION-PLAN.md` (what to fix).

## Understand it
| Doc | Read it for |
|---|---|
| `ARCHITECTURE.md` | The whole system, diagram, where each piece runs |
| `../README.md` | Setup, daily use, scripts, troubleshooting |
| `LIVE.md` | Production URLs, deploy facts, build gotchas |

## Operate it
| Doc | Read it for |
|---|---|
| `MORNING-CHECKLIST.md` | Current state and what only you can do |
| `MONITORING.md` | System page, alerts, the scheduled monitor |
| `RECOVERY.md` | Backups and restore |
| `RATE-LIMITS.md` | Meta's limits and how the code behaves when throttled |
| `GCP-WORKER.md` | **Move the DM worker to a free Google Cloud e2-micro** (recommended) |
| `ORACLE-WORKER.md`, `RENDER-FREE.md` | Other hosts for the DM worker |

## Prepare content (for Claude)
| Doc | Read it for |
|---|---|
| `CLAUDE-CONTENT-GUIDE.md` | Post packaging, naming, human-sounding copy, safe storage, checklists |
| `CLAUDE-CODE.md` | The Claude Code tools and their safety rules |
| `REMOTE-ACCESS-PLAN.md` | Using it from outside the laptop (plan, not built) |

## Security, compliance, audits
| Doc | Read it for |
|---|---|
| `REMEDIATION-PLAN.md` | **What to fix, in order, and what to skip** |
| `AUDIT-2026-10-01.md` | Summary of the latest audits |
| `SECURITY-AUDIT.md`, `SECURITY-AUDIT-2.md` | Security findings |
| `SYSTEM-AUDIT.md` | Reliability findings (double-post paths, silent failures) |
| `COMPLIANCE.md`, `COMPLIANCE-AUDIT-2.md`, `DATA-PROTECTION.md` | Meta rules, data handling, gaps |

## Setup and history
| Doc | Read it for |
|---|---|
| `SETUP.md`, `LOCAL.md`, `DEPLOY.md`, `PRODUCTION.md` | First-time setup and deploy checklists (partly superseded by the files above) |
| `ADD-ACCOUNT.md` | Connecting an Instagram account |
| `TASKS.md`, `../instagram_automation_updated_plan-1.md` | Original build log and plan (historical) |
| `../DESIGN.md`, `design-reference/` | Dashboard design tokens |
