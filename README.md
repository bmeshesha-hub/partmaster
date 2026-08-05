# Partmaster

Partmaster is a static React dashboard for submitting parts and reviewing OEM
variants stored in the sibling `partmaster_data` GitHub repository. It reads and
writes JSON using the authenticated GitHub API, so there is no conventional
backend or database.

Use **Add part** to commit a new enrichment request to `data/input.json`. The
data repository workflow enriches it, moves it to `data/queue.json`, and the
**Review** screen lets a user select and approve the matching variant.

## Local development

1. Copy `.env.example` to `.env` and adjust the repository values if needed.
2. Run `npm install`.
3. Run `npm run dev`.
4. In Settings, add a fine-grained GitHub PAT with **Contents: Read and write**
   access to `partmaster_data`.

The PAT is saved in browser localStorage. This is appropriate only for a trusted
internal deployment: treat the static site and every dependency as security
sensitive, keep the token repository-scoped, and clear it on shared machines.

## GitHub Pages

In repository settings, set Pages **Source** to **GitHub Actions**. The included
workflow builds and publishes the `dist` artifact whenever `main` changes.

## Data consistency

An approval reads `queue.json` and `approved.json` at one branch commit, captures
both file SHAs, and writes both files in one new Git commit. A non-forced branch
update rejects a stale approval if another reviewer changed the data first.
