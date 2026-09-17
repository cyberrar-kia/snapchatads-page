// Paystack calls this directly, server-to-server, the instant a payment
// succeeds — completely independent of whether the buyer's own browser
// ever loads thank-you.html. This fixes the real gap we found: some
// buyers close the tab right after Paystack's own success screen, before
// the redirect back to our site ever fires, meaning the client-side Pixel
// never runs on their device at all.
//
// Uses the SAME event_id as the client-side Pixel call (purchase_<reference>)
// so Meta's deduplication merges the two into exactly one Purchase if both
// happen to fire, instead of double-counting a single real sale.

const crypto = require("crypto");

function hash(value) {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "234" + digits.slice(1);
  return digits;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("Method not allowed");
    return;
  }

  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
  const metaToken = process.env.META_CAPI_ACCESS_TOKEN;

  if (!paystackSecret) {
    console.error("[webhook] PAYSTACK_SECRET_KEY not set");
    res.status(500).send("Not configured");
    return;
  }

  // Verify this request genuinely came from Paystack, not someone
  // pretending to, before trusting anything in the body.
  const rawBody = JSON.stringify(req.body);
  const expectedSignature = crypto
    .createHmac("sha512", paystackSecret)
    .update(rawBody)
    .digest("hex");
  const receivedSignature = req.headers["x-paystack-signature"];

  if (expectedSignature !== receivedSignature) {
    console.error("[webhook] Invalid Paystack signature — ignoring request");
    res.status(401).send("Invalid signature");
    return;
  }

  const event = req.body;

  if (!event || event.event !== "charge.success") {
    // Not a successful payment event, nothing to do, but acknowledge
    // receipt so Paystack doesn't keep retrying.
    res.status(200).send("Ignored");
    return;
  }

  const data = event.data || {};
  const reference = data.reference;
  const amountKobo = data.amount;
  const email = data.customer && data.customer.email;
  const phone =
    (data.customer && data.customer.phone) ||
    (data.metadata && data.metadata.phone) ||
    null;

  if (!reference) {
    res.status(200).send("Missing reference, ignored");
    return;
  }

  if (!metaToken) {
    console.error("[webhook] META_CAPI_ACCESS_TOKEN not set yet — payment confirmed but not reported to Meta");
    res.status(200).send("Payment noted, Meta reporting not configured yet");
    return;
  }

  const userData = {};
  if (email) userData.em = [hash(email)];
  if (phone) userData.ph = [hash(normalizePhone(phone))];

  const eventPayload = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: "purchase_" + reference, // must match the client-side event_id for correct dedup
        action_source: "website",
        user_data: userData,
        custom_data: {
          value: amountKobo ? amountKobo / 100 : 15000,
          currency: "NGN",
        },
      },
    ],
  };

  try {
    const metaRes = await fetch(
      `https://graph.facebook.com/v21.0/1389338596469852/events?access_token=${metaToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(eventPayload),
      }
    );
    const metaData = await metaRes.json();

    if (!metaRes.ok) {
      console.error("[webhook][meta-error]", metaData);
    } else {
      console.log("[webhook][sent]", { reference, metaData });
    }
  } catch (err) {
    console.error("[webhook][meta-network-error]", err);
  }

  // Always 200 back to Paystack once we've genuinely processed it,
  // so it doesn't keep retrying a request we've already handled.
  res.status(200).send("OK");
};
