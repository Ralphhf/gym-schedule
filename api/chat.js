// Vercel serverless function — AI coach chat + natural-language logging.
// Holds the Anthropic API key server-side; the browser never sees it.
//
// Env vars (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY  sk-ant-...           (Sensitive)
//   SYNC_PASSCODE      same passcode as cloud sync; sent as x-pass header (NOT sensitive)
//
// POST { messages:[{role,content}], context:{profile,goal,macros,exercises,today} }
//  -> { reply:"<assistant text>", actions:[{name, input}], usage:{...} }
//
// The model decides whether to chat or to call logging tools. We return the
// tool calls as `actions`; the BROWSER applies them to localStorage (that's where
// the user's data lives) and syncs. Single-turn: we never send tool_result back,
// so the client builds its own confirmation text — fast + deterministic.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001"; // fast + cheap; logging is easy tool-use
const ANTHROPIC_VERSION = "2023-06-01";

const TOOLS = [
  {
    name: "log_set",
    description:
      "Log one or more identical sets of a strength exercise the user just performed. " +
      "Use when they mention lifting a weight for reps (e.g. 'benched 185 for 5', " +
      "'3 sets of 10 at 50lb'). Match the exercise to one of the known exercise names " +
      "when possible; otherwise use the user's own wording, title-cased.",
    input_schema: {
      type: "object",
      properties: {
        exercise: { type: "string", description: "Exercise name (prefer a known name)" },
        weight: { type: "number", description: "Weight in lb (0 for bodyweight)" },
        reps: { type: "integer", description: "Reps per set" },
        sets: { type: "integer", description: "How many identical sets (default 1)" },
      },
      required: ["exercise", "weight", "reps"],
    },
  },
  {
    name: "add_calories",
    description:
      "Add calories the user just ate to today's running total. Estimate kcal from the " +
      "food described if they don't give a number (use sensible nutrition estimates). " +
      "Always include protein/carbs/fat grams when you can estimate them.",
    input_schema: {
      type: "object",
      properties: {
        kcal: { type: "integer", description: "Calories to add (your best estimate)" },
        food: { type: "string", description: "Short description of the food" },
        protein_g: { type: "integer", description: "Protein grams (estimate)" },
        carbs_g: { type: "integer", description: "Carb grams (estimate)" },
        fat_g: { type: "integer", description: "Fat grams (estimate)" },
      },
      required: ["kcal", "food"],
    },
  },
  {
    name: "remove_food",
    description:
      "Subtract food from today when the user says they did NOT eat something, ate less than " +
      "logged, or wants to undo/correct/remove a food entry. Estimate the kcal and " +
      "protein/carbs/fat to remove from the food described, the same way you estimate when adding. " +
      "If they want to wipe ALL of today's food (e.g. 'clear my food', 'start today over'), set clear:true.",
    input_schema: {
      type: "object",
      properties: {
        kcal: { type: "integer", description: "Calories to remove (your best estimate)" },
        food: { type: "string", description: "Short description of the food being removed" },
        protein_g: { type: "integer", description: "Protein grams to remove (estimate)" },
        carbs_g: { type: "integer", description: "Carb grams to remove (estimate)" },
        fat_g: { type: "integer", description: "Fat grams to remove (estimate)" },
        clear: { type: "boolean", description: "true = reset ALL of today's food/macros to zero" },
      },
    },
  },
  {
    name: "set_daily_check",
    description:
      "Mark a daily habit done (or undone) for today. Use for creatine and protein-goal checkboxes.",
    input_schema: {
      type: "object",
      properties: {
        item: { type: "string", enum: ["creatine", "protein"] },
        done: { type: "boolean", description: "true = checked, false = unchecked" },
      },
      required: ["item", "done"],
    },
  },
  {
    name: "set_bodyweight",
    description: "Record today's bodyweight and/or waist measurement when the user reports it.",
    input_schema: {
      type: "object",
      properties: {
        weight_lb: { type: "number", description: "Bodyweight in lb" },
        waist_in: { type: "number", description: "Waist in inches" },
      },
    },
  },
];

function buildSystem(ctx) {
  const c = ctx || {};
  const p = c.profile || {};
  const g = c.goal || {};
  const m = c.macros || {};
  const exList = Array.isArray(c.exercises) ? c.exercises.join(", ") : "";

  // STATIC block — cached across calls (instructions never change).
  const staticText = [
    "You are the user's personal fitness coach and logging assistant inside their gym web app.",
    "You have two jobs:",
    "1) LOG what they tell you by calling the right tool(s). Be decisive — if they say they",
    "   lifted, ate, took creatine, or weighed in, call the tool. Don't ask for confirmation.",
    "2) ANSWER training/nutrition questions using their profile below. Be concise, practical,",
    "   and encouraging. No medical claims; this is general fitness guidance.",
    "",
    "Logging rules:",
    "- Multiple sets at the same weight/reps → ONE log_set call with the `sets` count.",
    "- Different weights/reps → one log_set call each.",
    "- Food without a calorie number → estimate kcal AND protein/carbs/fat from typical values.",
    "- 'I didn't eat that' / 'remove the ...' / 'undo' / 'clear my food' → call remove_food",
    "  (estimate the same macros you would when adding; use clear:true to wipe the whole day).",
    "- Match exercises to a known name when the user is clearly referring to one.",
    "- You may both log AND say something (e.g. log a PR-worthy set and hype them up).",
    "- If a message has nothing to log and isn't a question, reply briefly and warmly.",
    "Keep replies short (1-3 sentences). The app shows its own ✅ confirmation for logged items,",
    "so don't repeat the raw numbers back robotically — add value or just acknowledge.",
  ].join("\n");

  // DYNAMIC block — the user's profile + today's state (changes between calls).
  const dynText = [
    "=== USER PROFILE ===",
    `Sex: ${p.sex || "?"}, Age: ${p.age || "?"}, Height: ${p.height_in || "?"} in, Weight: ${p.weight_lb || "?"} lb`,
    `Goal: ${g.name || "?"} — ${g.calories || "?"} kcal/day`,
    `Macro targets: protein ${m.protein_g ?? g.protein_g ?? "?"} g, carbs ${m.carbs_g ?? g.carbs_g ?? "?"} g, fat ${m.fat_g ?? g.fat_g ?? "?"} g`,
    "",
    "=== TODAY SO FAR ===",
    `Date: ${c.today?.date || "?"}`,
    `Calories logged today: ${c.today?.kcalToday ?? 0} kcal (${c.today?.kcalLeft ?? "?"} left to hit target)`,
    `Macros logged today: protein ${c.today?.proteinToday ?? 0} g (${c.today?.proteinLeft ?? "?"} left), carbs ${c.today?.carbsToday ?? 0} g (${c.today?.carbsLeft ?? "?"} left), fat ${c.today?.fatToday ?? 0} g (${c.today?.fatLeft ?? "?"} left)`,
    `Creatine taken: ${c.today?.creatine ? "yes" : "no"}; Protein goal checked: ${c.today?.protein ? "yes" : "no"}`,
    c.today?.setsSummary ? `Sets logged today: ${c.today.setsSummary}` : "No sets logged yet today.",
    "",
    exList ? "=== KNOWN EXERCISE NAMES (match to these when possible) ===\n" + exList : "",
  ].join("\n");

  return [
    { type: "text", text: staticText, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynText },
  ];
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pass");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const KEY = process.env.ANTHROPIC_API_KEY;
  const PASS = process.env.SYNC_PASSCODE;
  if (!KEY) return res.status(500).json({ error: "Server not configured. Set ANTHROPIC_API_KEY in Vercel." });
  if (PASS) {
    const sent = req.headers["x-pass"];
    if (!sent || sent !== PASS) return res.status(401).json({ error: "Bad or missing passcode." });
  }

  let body;
  try { body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {}; }
  catch { return res.status(400).json({ error: "Bad JSON body" }); }

  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length) return res.status(400).json({ error: "No messages" });

  const payload = {
    model: MODEL,
    max_tokens: 1024,
    system: buildSystem(body.context),
    tools: TOOLS,
    messages,
  };

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Anthropic error", detail: data });
    }
    let reply = "";
    const actions = [];
    for (const block of data.content || []) {
      if (block.type === "text") reply += block.text;
      else if (block.type === "tool_use") actions.push({ name: block.name, input: block.input || {} });
    }
    return res.status(200).json({ reply: reply.trim(), actions, usage: data.usage || null });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
};
