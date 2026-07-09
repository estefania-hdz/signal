import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Constructed lazily so the server can boot and serve the landing page even
// before ANTHROPIC_API_KEY is set — it only throws once a scan is requested.
let client;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

// Research (search + filter) uses Sonnet: noticeably faster than Opus for
// this kind of tool-heavy, round-trip-bound work, which matters because
// Vercel's free tier kills a function after 60s. Drafting (the actual
// editorial judgment/writing) stays on Opus — it's fast regardless of model
// since it makes no tool calls, so there's no reason to trade quality there.
const RESEARCH_MODEL = "claude-sonnet-5";
const DRAFT_MODEL = "claude-opus-4-8";

const SIGNAL_LABELS = {
  product_launches: "new product launches",
  competitor_moves: "competitor moves",
  key_hires: "key hires",
  funding_news: "funding news",
  pricing_changes: "pricing changes",
};

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    email_subject: { type: "string" },
    alerts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          headline: { type: "string" },
          summary: { type: "string" },
          why_it_matters: { type: "string" },
          source_url: { type: "string" },
          category: { type: "string" },
        },
        required: ["headline", "summary", "why_it_matters", "source_url", "category"],
        additionalProperties: false,
      },
    },
    email_html: { type: "string" },
  },
  required: ["email_subject", "alerts", "email_html"],
  additionalProperties: false,
};

function watchAreaLines(user) {
  const signalLabels = (user.signals || [])
    .map((s) => (s === "other" ? user.otherSignal || "other" : SIGNAL_LABELS[s] || s))
    .join(", ");

  const companyNames = (user.companiesToTrack || []).map((c) => c.name).filter(Boolean);
  const companiesLine = companyNames.length
    ? `\nPay special attention to these companies, without ignoring the rest of the space: ${companyNames.join(", ")}.`
    : "";

  return { signalLabels, companiesLine };
}

// Phase 1: research. Uses the web_search tool, no output schema — combining
// a server tool with a strict json_schema in the same call is dramatically
// slower (measured ~6x) than either alone, so drafting is a separate call.
function buildResearchSystemPrompt(user) {
  const { signalLabels, companiesLine } = watchAreaLines(user);

  return `You are Signal, a market-monitoring analyst working on behalf of one subscriber.

Subscriber's watch area: ${user.industry}${companiesLine}
Signal types they care about: ${signalLabels || "anything notable in their space"}

Your job:
1. Search the web for developments in the watch area from roughly the last 7 days.
2. Judge each thing you find with real editorial judgment. Most of what you find is noise: routine blog posts, rehashed press releases, minor version bumps, content-marketing SEO bait. Discard all of that. Keep only what a sharp, busy operator in this exact space would actually want to know about today.
3. Pick at most 3-4 items: the genuinely significant ones. If you find fewer than 3 truly significant items, report fewer. Never pad the list with filler just to hit a number. If you find nothing genuinely significant, say so plainly.

If a search call ever errors or you run out of search budget partway through, that's not a failure: write up whatever genuinely significant findings you've already gathered from the searches that did succeed. Only say you found nothing if you truly found nothing worth reporting — never discard real findings you already have just because a later search didn't go through.

When you're done searching, write up your findings in plain text, one item at a time. For each item include: the headline, a 2-3 sentence summary, why it specifically matters to this subscriber given their watch area, its category, and the exact source URL you found it at.

Only report things you actually found via search just now. Never invent a source URL — every URL must come from a page you searched.`;
}

// Phase 2: drafting. No tools — just turns the research findings into the
// final structured output (subject, alerts, HTML email).
const DRAFTING_SYSTEM_PROMPT = `You are Signal's editor. You'll be given a researcher's findings about market signals for one subscriber. Turn them into the final deliverable:

1. Write a short curated brief in the style of a well-loved indie newsletter (think Jack & Jill): warm, direct, human, a little personality, zero corporate throat-clearing, no superlatives, no filler phrases like "in today's fast-paced world."
2. Keep every item the researcher kept — don't drop items or add new ones. If the researcher found nothing significant, produce an empty alerts array and a short, honest email saying so.
3. Produce a complete, email-client-safe HTML email (inline CSS only, no external stylesheets, a simple single-column layout that works in Gmail/Outlook/Apple Mail) containing the brief, addressed to the subscriber. Keep it short: this is meant to be read in under a minute, not a report.

Only use facts and URLs from the findings you're given. Never invent anything not present there.`;

// Mock mode: returns a canned result built from the user's own inputs
// instead of calling Claude, so the signup -> run -> preview -> send
// pipeline can be tested for free. Toggle with MOCK_AGENT=true in .env.
function buildMockResult(user) {
  const companyNames = (user.companiesToTrack || []).map((c) => c.name).filter(Boolean);
  const companiesText = companyNames.length ? companyNames.join(", ") : "no specific companies";
  const category = user.signals?.[0] === "other" ? user.otherSignal : user.signals?.[0];

  return {
    email_subject: `[MOCK] What's new in ${user.industry}`,
    alerts: [
      {
        headline: `Mock signal for "${user.industry}"`,
        summary:
          "This is placeholder content — mock mode skips the Anthropic API entirely, so you can test the rest of the pipeline (preview rendering, real email delivery) for free.",
        why_it_matters:
          "It proves signup, run, and send all work end-to-end without spending API credit.",
        source_url: "https://example.com/mock-source",
        category: category || "product_launches",
      },
    ],
    email_html: `<div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; background: #FAF6EE; padding: 32px 28px; color: #1c1b18;">
  <p style="font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #16504A; margin: 0 0 18px;">SIGNAL &middot; MOCK MODE</p>
  <h1 style="font-size: 20px; line-height: 1.3; margin: 0 0 16px; font-weight: normal;">What's new in ${user.industry}</h1>
  <p style="font-size: 14.5px; line-height: 1.6; color: #3a382f; margin: 0 0 16px;">This is a mock email — no call to Claude was made. It's here so you can confirm formatting and real delivery without spending API credit.</p>
  <p style="font-size: 13px; color: #6B6656; border-top: 1px solid #E3DBC7; padding-top: 14px;">Companies tracked: ${companiesText}</p>
</div>`,
    sourcesSearched: [],
    usage: { mock: true },
  };
}

/**
 * Phase 1: search and filter. Kept as its own function (rather than folded
 * into one long call) so it can run as a single, independently-timed step —
 * on Vercel's free tier a serverless function is killed after 60s, and
 * research + draft combined can run longer than that.
 * @returns {Promise<{ findingsText: string, sourcesSearched: object[] }>}
 */
export async function runResearchPhase(user) {
  const researchParams = {
    model: RESEARCH_MODEL,
    max_tokens: 4000,
    system: buildResearchSystemPrompt(user),
    thinking: { type: "adaptive" },
    tools: [
      {
        type: "web_search_20260209",
        name: "web_search",
        // Render has no serverless time ceiling, so this can be generous —
        // it was cut to 4 only to try to fit Vercel's 60s function limit.
        max_uses: 8,
      },
    ],
  };

  let researchMessages = [
    {
      role: "user",
      content: `Run today's scan for "${user.industry}". Search and filter hard.`,
    },
  ];

  let researchResponse = await streamToFinalMessage({
    ...researchParams,
    messages: researchMessages,
  });

  // Server-side web_search can hit its internal round limit (pause_turn).
  // Re-send to let it continue rather than treating that as done.
  let guard = 0;
  while (researchResponse.stop_reason === "pause_turn" && guard < 2) {
    researchMessages = [
      ...researchMessages,
      { role: "assistant", content: researchResponse.content },
    ];
    researchResponse = await streamToFinalMessage({
      ...researchParams,
      messages: researchMessages,
    });
    guard += 1;
  }

  const sourcesSearched = [];
  for (const block of researchResponse.content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.url) sourcesSearched.push({ url: result.url, title: result.title });
      }
    }
  }

  const findingsText = researchResponse.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();

  if (!findingsText) {
    throw new Error("The research step produced no findings text to draft from.");
  }

  return { findingsText, sourcesSearched };
}

/**
 * Phase 2: draft. No tools, so this alone is fast — safely under Vercel's
 * 60s limit even when phase 1 already used most of its own budget.
 * @returns {Promise<{ email_subject: string, alerts: object[], email_html: string }>}
 */
export async function runDraftPhase(user, findingsText) {
  const draftResponse = await streamToFinalMessage({
    model: DRAFT_MODEL,
    max_tokens: 4000,
    system: DRAFTING_SYSTEM_PROMPT,
    output_config: {
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: `Subscriber's watch area: ${user.industry}\n\nResearcher's findings:\n\n${findingsText}`,
      },
    ],
  });

  const textBlock = draftResponse.content.find((b) => b.type === "text");
  if (!textBlock) {
    throw new Error(
      `No text block in the drafting response. Full content: ${JSON.stringify(draftResponse.content, null, 2)}`
    );
  }

  return JSON.parse(textBlock.text);
}

/**
 * Runs both phases in one call. Fine for mock mode (instant) and for
 * platforms without a hard function-duration ceiling (local dev, Render) —
 * not used on Vercel for real (non-mock) runs, see src/queue.js.
 * @param {{ email: string, industry: string, signals: string[] }} user
 * @returns {Promise<{ email_subject: string, alerts: object[], email_html: string, sourcesSearched: object[] }>}
 */
export async function runAgentForUser(user) {
  if (process.env.MOCK_AGENT === "true") {
    return buildMockResult(user);
  }

  const { findingsText, sourcesSearched } = await runResearchPhase(user);
  const parsed = await runDraftPhase(user, findingsText);

  return { ...parsed, sourcesSearched };
}

async function streamToFinalMessage(params) {
  const stream = getClient().messages.stream(params);
  return stream.finalMessage();
}
