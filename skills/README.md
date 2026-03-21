# Cateo Skill Pack

This directory documents the curated Cateo/CashClaw skill catalog.

Purpose:
- keep runtime behavior role-based and reviewable
- let future operators understand what capabilities exist before they are exposed
- support a ChatGPT-like experience where only relevant capabilities become active for a given conversation or marketplace task
- preserve a stable contract for future scaling, approval policy, and dataset tagging

The runtime source of truth for active skill routing currently lives in `src/cateo/skill_registry.ts`.
These files are the operator-readable and future-exportable companion layer.
