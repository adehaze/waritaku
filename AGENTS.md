## Development Rules
- **CRITICAL DATABASE RULE 1:** NEVER wipe, delete, or recreate any database (not the development `.wrangler` database, nor any carbon copy) under any circumstances, UNLESS the user explicitly types exactly: "Purge Development Database".
- **CRITICAL DATABASE RULE 2:** NEVER insert arbitrary or fake data into the database (no fake users, fake articles, fake categories, etc.). The database is a carbon copy of a real WordPress database. If data is missing, leave it empty or wait for the user to import it.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation Writing Rules
---
name: ste-writing
description: Rewrite prose (docs, READMEs, PR descriptions, error messages, release notes, comments — never code) into ASD-STE100 Simplified Technical English to remove "AI slop". Use when asked to make writing not sound like AI, make docs clear or plain, enforce a controlled writing style, or write technical documentation that reads human. Two modes — strict (procedures/safety) and STE-flavored (general prose).
---

# Documentation Writing Rules - ste-writing

Write prose in ASD-STE100 Simplified Technical English. This applies to documentation, READMEs, pull-request text, error messages, release notes, and comments. It does not apply to code, identifiers, or command syntax. It is not for marketing copy, essays, or anything that needs a voice — STE strips voice on purpose.

## Documentation Writing Rules - Rules

WORDS
- Use one name for one thing. Do not call the same item by two different names.
- Use the short common word: start (not begin/commence/initiate), use (not utilize/leverage), help (not facilitate), make sure (not ensure), before (not prior to), after (not subsequent to), about (not regarding/concerning), get (not obtain/acquire), show (not demonstrate), also (not additionally/furthermore/moreover).
- Give each word one meaning. "fall" means to move down, not to decrease.
- No marketing adjectives: seamless, robust, powerful, cutting-edge, effortless, world-class, next-generation, revolutionary.
- American spelling.

VERBS
- Active voice. "the parser reads the file", not "the file is read by the parser".
- Use a verb for an action. "analyze the log", not "perform an analysis of the log".
- No stacked auxiliaries. Not "it is important to note that this may help to improve". Write "this improves X".
- No "-ing" main verb where a simple tense works.

SENTENCES
- One instruction per sentence. Max 20 words (instruction), max 25 (descriptive).
- No contractions. Use articles: a, an, the, this, these.

PUNCTUATION
- No semicolons. Write two sentences. (Note: the em dash is not banned by STE, only the semicolon is — add "no em dash" yourself if you want it gone.)

STRUCTURE
- One topic per paragraph, max six sentences. For steps, use a numbered vertical list, one action per item, imperative form. Put a condition before its command.

Write only the requested text. No preamble, no summary, no closing remarks.

## Documentation Writing Rules - Modes

- **strict** — procedures, runbooks, safety text, error messages: apply every rule and both length caps.
- **STE-flavored** — general prose (READMEs, PR descriptions, docs): apply the sentence, paragraph, active-voice, and no-phrasal-verb discipline; relax the ~900-word dictionary lockdown so the text keeps enough range to read naturally.

## Documentation Writing Rules - Self-lint (run before returning text)

1. Any sentence over 20 words? Split it.
2. Any semicolon? Replace with a period.
3. Any contraction? Expand it.
4. Any passive voice with a known actor? Make it active.
5. Any "-ing" main verb, nominalization ("perform an analysis"), or phrasal verb ("spin up")? Replace with a plain verb.
6. Same thing named two ways? Pick one name.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Architectural Rules - No Hardcoding
- **CRITICAL CMS RULE:** Never hardcode collection slugs (rticles, pages), taxonomy slugs (categories, 	ags), or content field names (	itle, content, eaturedImageUrl) into frontend rendering logic, queries, or middleware.
- **Dynamic Schema Enforcement:** This is a Headless CMS with a dynamic Content Type Builder. Any bug fixes or new features must query the database schema or configuration settings dynamically. If you need to know what collection a page belongs to, look it up by ID/slug dynamically. If you need to render a title or excerpt, use dynamic field fallbacks or schema definitions, NOT hardcoded property names.
- **NEVER PATCH WITH HARDCODING:** If you encounter a bug, do not solve it by writing if (slug === 'categories'). Solve it by addressing the underlying dynamic routing logic.

## Architectural Rules - Schema Mapping Principle
- **UNACCEPTABLE (Goblin Tech):** Never try to guess or use regex/fallbacks to determine which dynamic field (e.g., ield_12345) represents the Title, Featured Image, or Excerpt in a collection. Never write logic that iterates over JSON keys hoping to find something named "image" or "title".
- **ACCEPTABLE:** The system must rely strictly on explicit Field Mappings defined in the collection's supports.mappings JSON configuration. If a collection needs to display a title or image on an archive card, it must look up the exact field key (e.g., mappings.titleField) assigned by the user in the Content Type Builder UI, and extract the data deterministically using that key.
- **Taxonomy Priority:** When resolving URLs for entries that belong to multiple taxonomies, never pick a taxonomy at random. The system MUST respect the explicit priority order defined in the supports.taxonomies array configured in the builder.

## Agent Behavioral Rules - Context & Focus
- **NEVER READ OLD LOGS:** Do not actively search for, grep, or read old .txt, .log, or deleted inspection files to try and guess what the user meant. If the user gives an instruction, take it at face value.
- **NO PAST CONTEXT OBSESSION:** Do not try to resurrect old context or derail the conversation by bringing up logs or issues that the user has already marked as solved or deleted. Focus ONLY on the active, current markdown plan.

- **DEPLOYMENT ASSUMPTION RULE:** The user commits and deploys through GitHub and Cloudflare, not from this local folder. Local git status will show uncommitted files even after the user deployed. When you cannot see the GitHub changes, ALWAYS assume the user already committed and deployed them. NEVER ask the user to prove it. NEVER suggest that a change might not be deployed. Look for a different cause.
- **D1 LIMIT RULE:** The user is on the D1 free tier and often exceeds the daily read limit. HTTP 500 errors with failed D1 queries are expected after the limit. Do not raise this again. The user already knows.
