# scuttlebutt-bot

A silly, early-2010s-style Bluesky bot. It remixes two academic
pirate-history books and Treasure Island into posts using a mix of
near-verbatim highlight quotes, a Markov chain, and cut-up sentence
splicing - no AI/LLM involved, just an old-fashioned bot.

This project lives in the same folder as its corpus source texts (an
Obsidian vault). That folder is **not** fully version-controlled -
`.gitignore` only tracks the bot's own code/config (see below), so the
source books, the PDF, and the (deliberately untouched) Anarchist
Cookbook folder never get committed or pushed anywhere.

## How it works

1. `scripts/build-corpus.js` reads the source `.md`/`.txt` texts in
   this same folder, cleans up noise (footnote markers, escaped
   markdown punctuation, Project Gutenberg license boilerplate), and
   builds `data/corpus.json`:
   - a backoff Markov word-chain model (order-3 falling back to
     order-2),
   - a large pool of clause-length phrase fragments for cut-up
     recombination,
   - a list of proper nouns/pirate names extracted heuristically
     (capitalized words that recur mid-sentence),
   - a pool of "highlight" sentences that mention rum/sodomy/the
     lash/pirate-tradition keywords or a recognized name - these are
     posted close to verbatim, since real lines from the books (especially
     Treasure Island's dialogue) are funnier than generated ones.
2. `src/generate.js` generates ~12 candidates per post (a mix of
   highlight quotes, Markov bursts, and cut-up splices), scores each
   one for pithiness/on-theme keywords/vivid vocabulary/glitches, and
   posts the best of the batch - an automatic stand-in for the human
   curation that bots like horse_ebooks secretly relied on.
3. `src/post.js` posts the generated text to Bluesky via the official
   `@atproto/api` SDK.
4. `.github/workflows/post.yml` runs `src/post.js` on a cron schedule
   via GitHub Actions - free, and runs even when your PC is off.

## One-time setup (you'll need to do these steps yourself)

1. **Create a Bluesky account** for the bot (or use an existing one)
   at bsky.app.
2. **Generate an app password**: Settings -> Privacy and Security ->
   App Passwords -> Add App Password. Use this, never your real
   account password.
3. Copy `.env.example` to `.env` and fill in your handle and app
   password (this file is gitignored, it never gets committed).
4. Install dependencies:
   ```bash
   npm install
   ```
5. Build the corpus (reads the `.md`/`.txt` files in this same
   folder by default; pass `--dir` to point elsewhere):
   ```bash
   npm run build-corpus
   ```
6. Try it locally without posting:
   ```bash
   npm run dry-run
   ```
7. When you're happy with the output, try a real post:
   ```bash
   npm run post
   ```

## Deploying for free, scheduled posting

1. Create a new GitHub repository and push this project to it.
2. In the repo's Settings -> Secrets and variables -> Actions, add
   two repository secrets: `BSKY_HANDLE` and `BSKY_APP_PASSWORD`.
3. That's it - the workflow in `.github/workflows/post.yml` will run
   on the cron schedule (default: every 4 hours) using GitHub's free
   Actions minutes. Edit the cron expression to change frequency, or
   trigger a manual run from the Actions tab (`workflow_dispatch`).

## Updating the corpus

If you edit or add source texts in this folder, just re-run
`npm run build-corpus` and commit the updated `data/corpus.json`.
