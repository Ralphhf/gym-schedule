// Vercel serverless function — builds an Instacart "shopping list" cart link.
// Receives { items: [{ name, quantity, unit, display_text }], title }
// Calls Instacart Developer Platform and returns { url }.
//
// Requires env var INSTACART_API_KEY (set in Vercel → Settings → Environment Variables).
// Docs: https://docs.instacart.com/developer_platform_api

const INSTACART_ENDPOINT =
  "https://connect.instacart.com/idp/v1/products/products_link";

module.exports = async function handler(req, res) {
  // CORS (same-origin in prod, but allow preflight just in case)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  const apiKey = process.env.INSTACART_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "INSTACART_API_KEY not set. Add it in Vercel → Settings → Environment Variables, then redeploy.",
    });
  }

  try {
    // Body may arrive parsed or as a string depending on runtime
    const body =
      typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0)
      return res.status(400).json({ error: "No items provided." });

    const line_items = items.map((it) => ({
      name: String(it.name || "").slice(0, 120),
      quantity: Number(it.quantity) > 0 ? Number(it.quantity) : 1,
      unit: it.unit || "each",
      display_text: it.display_text || it.name,
    }));

    const payload = {
      title: body.title || "My Gym Meal Plan",
      link_type: "shopping_list",
      expires_in: 7,
      instructions: [
        "Pick Walmart (or your preferred store) at the top, then review quantities before ordering.",
      ],
      line_items,
      landing_page_configuration: {
        partner_linkback_url: "https://gym-schedule-ralphhf.vercel.app",
        enable_pantry_items: true,
      },
    };

    const r = await fetch(INSTACART_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({
        error: "Instacart API error",
        detail: data,
      });
    }

    const url = data.products_link_url || data.url;
    if (!url)
      return res
        .status(502)
        .json({ error: "No link returned by Instacart", detail: data });

    return res.status(200).json({ url });
  } catch (err) {
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
