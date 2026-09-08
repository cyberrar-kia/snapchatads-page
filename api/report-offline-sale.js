// Reports a sale that happened OUTSIDE the tracked on-page funnel
// (a DM/WhatsApp-closed deal, paid directly rather than through the
// Paystack link) to Meta's Conversions API, so it feeds Meta's learning
// system even though no ad click can be attributed.
//
// IMPORTANT: only use this for sales that did NOT go through the real
// Paystack link + thank-you.html page. If a sale already went through
// that flow, the Pixel already reported it — reporting it again here
// would double-count it.
//
// POST /api/report-offline-sale
// Body: { email?: string, phone?: string, value: number, note?: string }
// At least one of email or phone is required so Meta can attempt to
// match this event to a real person. Both hashed with SHA-256 before
// being sent, as Meta's Conversions API requires.

const crypto = require("crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function normalizePhone(phone) {
  // Strips everything but digits. If it looks like a local Nigerian
  // number (starts with 0), swaps the leading 0 for the country code.
  let digits = phone.replace(/\D/g, "");
  if (digits.startsWith("0")) {
    digits = "234" + digits.slice(1);
  }
  return digits;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const accessToken = process.env.META_CAPI_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(500).json({ error: "CAPI not configured yet — add META_CAPI_ACCESS_TOKEN" });
    return;
  }

  const { email, phone, value, note } = req.body || {};

  if (!email && !phone) {
    res.status(400).json({ error: "Provide at least an email or a phone number" });
    return;
  }
  if (!value || isNaN(Number(value))) {
    res.status(400).json({ error: "Provide a valid sale value" });
    return;
  }

  const userData = {};
  if (email) userData.em = [hash(normalizeEmail(email))];
  if (phone) userData.ph = [hash(normalizePhone(phone))];

  const eventPayload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: "offline_" + crypto.randomBytes(8).toString("hex"),
        action_source: "business_messaging",
        user_data: userData,
        custom_data: {
          value: Number(value),
          currency: "NGN",
        },
      },
    ],
  };

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/1389338596469852/events?access_token=${accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventPayload),
      }
    );

    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("[capi][error]", metaData);
      res.status(502).json({ error: "Meta rejected the event", detail: metaData });
      return;
    }

    console.log("[capi][sent]", { value, note, metaData });
    res.status(200).json({ success: true, meta: metaData });
  } catch (err) {
    console.error("[capi][network-error]", err);
    res.status(500).json({ error: "Failed to reach Meta" });
  }
};
