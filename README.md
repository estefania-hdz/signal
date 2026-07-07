# Signal

Signal is a market-monitoring agent. You tell it what industry, niche, or specific companies you want to watch. Once a day (or on demand, for now), it searches the web, judges what it finds with real editorial criteria, and emails you a short, curated brief: 3 to 4 things that actually matter, never a wall of links.

It's built to work for very different people with the same three questions: a fintech CEO watching what competitors are shipping, a VC analyst scanning for new pre-seed startups in a niche, anyone who wants a sharp analyst's morning scan without hiring one.

## Why I built this

Most "AI newsletter" tools just forward everything they find. The interesting problem here isn't search, it's judgment: deciding what's actually worth someone's attention and discarding the rest. That's the part I wanted to prove I could build well, so the agent's instructions are explicit about it: pick at most 3-4 items, return fewer if that's all there genuinely is, never pad the list to hit a number.

## How it works

1. **Landing page** (`public/index.html`) collects an email, a free-text watch area ("AI enablement in fintech", "pre-seed agtech startups raising in EMEA"), optional specific companies to track (with autocomplete), and the kinds of signals that matter (launches, funding, hires, pricing, competitor moves, or your own).
2. **`server.js`** is a small Express app: it saves signups to Upstash Redis and exposes a "run now" endpoint for the MVP (no cron yet, see Limitations). It runs as a normal Node process locally or on Render, and as a Vercel serverless function via `api/index.js` + `vercel.json`.
3. **`src/agent.js`** does the actual work, in two separate Claude API calls:
   - **Research**: Claude searches the web (server-side `web_search` tool) and writes up plain-text findings, already filtered for genuine significance.
   - **Draft**: a second call, with no tools, turns those findings into a subject line, structured alerts, and a complete inline-CSS HTML email, using [structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) so parsing never breaks.
4. **`src/mailer.js`** sends the result via [Resend](https://resend.com), and optionally pings you by email whenever someone signs up, so you have a way to know the thing is actually being used.
5. **Confirmation before running.** Signup sends a one-click confirm link (24h expiry); `/api/run` refuses to run for an unconfirmed email. It's the cheapest real defense against someone spamming the "run now" button with a fake or someone else's address once real API credit is on the line.

## A real bug, and why the architecture is split in two

The first version made one API call: web search and structured JSON output together. It worked, but a routine test run took over 9 minutes. I isolated it by timing each piece in increasing combination (bare call, +thinking, +web search, +web search +structured output) and found the last combination alone added roughly 6x the latency of web search by itself, even on a trivial query. Splitting research and drafting into two calls fixed it. It's a small example of the kind of thing that doesn't show up until you actually run the thing and look at the numbers.

## Running it locally

```bash
npm install
cp .env.example .env   # then fill in your keys
npm start              # http://localhost:3002
```

Required: `ANTHROPIC_API_KEY`. Everything else in `.env.example` is optional and the app degrades gracefully without it:

| Variable | Without it |
|---|---|
| `RESEND_API_KEY` | Signal only generates the email HTML, nothing gets sent |
| `OWNER_EMAIL` | No signup notification emails |
| `MOCK_AGENT=true` | Skips the Anthropic API entirely and returns a canned result, useful for testing the rest of the pipeline (UI, signup, real email delivery) for free |

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are required, signups have nowhere to be saved without them. Get a free database at [upstash.com](https://upstash.com), or provision one from Vercel's "Storage" tab if deploying there.

## Deploying

**Vercel:** import the repo, it picks up `vercel.json` and `api/index.js` automatically. Provision an Upstash database from the "Storage" tab (fills in the `UPSTASH_*` env vars for you), then add `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, and `OWNER_EMAIL` yourself.

**Render (or anywhere that runs a normal Node process):** connect the repo as a Web Service, build command `npm install`, start command `npm start`, add the same env vars. No code changes needed either way.

## Known limitations

This is an MVP, built to prove the concept end to end, not a shipped product:

- **No scheduling yet.** "Run now" is a manual trigger. A real cron job (Vercel Cron, or a scheduled job elsewhere) is the obvious next step.
- **Confirmation, not full auth.** Email confirmation stops anonymous spam of the run endpoint, but there's no login or session, anyone with a confirmed inbox's cooperation (or access to it) can still trigger a run.
- **Real delivery is limited to one inbox for now.** Resend's shared sandbox sender (`onboarding@resend.dev`) can only send to the account owner's own verified address, and that includes confirmation emails. In practice, right now, only the owner's own signup can complete the confirm step. Sending to arbitrary subscribers needs a verified custom domain in Resend.
- **Company autocomplete** uses Clearbit's free suggest endpoint and Google's favicon service. Both are free and unauthenticated, so no key management, but also no SLA.

## Stack

Plain HTML/CSS/JS on the frontend (no build step), Node + Express on the backend, Upstash Redis for storage, the Claude API (`claude-opus-4-8`, adaptive thinking, server-side web search, structured outputs) for the actual agent, Resend for email.

---

Built by [Estefania Hernandez](https://www.linkedin.com/in/estefaniahdz/).
