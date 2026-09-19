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
//
// This same handler also grants the buyer their portal access for the
// Snapchat Ads course — see grantPortalAccess() below. That call goes to
// thefoundingcohort.com, a completely separate product/backend, so it's
// wrapped in its own try/catch and never allowed to affect the Meta
// reporting above it or the 200 response Paystack expects back.

const crypto = require("crypto");

// The Snapchat Ads course's row id in the founding-cohort portal's
// `courses` table — fixed, not something this repo can look up itself.
const SNAPCHAT_COURSE_ID = "79820a3e-3a74-44db-b834-0abc9c485a7d";
const GRANT_ACCESS_URL = "https://thefoundingcohort.com/api/internal/grant-course-access";

function hash(value) {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function normalizePhone(phone) {
  let digits = String(phone).replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "234" + digits.slice(1);
  return digits;
}

// Creates (or reuses) the buyer's portal account, enrolls them in ONLY
// the Snapchat Ads course, and sends them the regular "here's your
// email + password" access email — all handled on the founding-cohort
// side by the exact same logic real course purchases there already use,
// so behavior (account matching, welcome email wording, idempotency on
// the Paystack reference) stays identical across both products.
async function grantPortalAccess(reference, email, firstName, lastName, amountKobo) {
  const secret = process.env.INTERNAL_ACCESS_SECRET;
  if (!secret) {
    console.error("[webhook][access] INTERNAL_ACCESS_SECRET not set — skipping access grant");
    return;
  }
  if (!email) {
    console.error("[webhook][access] No customer email on", reference, "— skipping access grant");
    return;
  }

  try {
    const res = await fetch(GRANT_ACCESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": secret,
      },
      body: JSON.stringify({
        course_id: SNAPCHAT_COURSE_ID,
        reference,
        email,
        first_name: firstName,
        last_name: lastName,
        amount_kobo: amountKobo,
      }),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || result.granted === false) {
      console.error("[webhook][access] Grant failed for", reference, ":", result);
    } else {
      console.log("[webhook][access] Portal access granted for", email, reference);
    }
  } catch (err) {
    console.error("[webhook][access] Network error granting access for", reference, err);
  }
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
  const firstName = (data.customer && data.customer.first_name) || "";
  const lastName = (data.customer && data.customer.last_name) || "";
  const phone =
    (data.customer && data.customer.phone) ||
    (data.metadata && data.metadata.phone) ||
    null;

  if (!reference) {
    res.status(200).send("Missing reference, ignored");
    return;
  }

  // Grant portal access first — this is the actual product the buyer
  // paid for. Meta reporting below is analytics on top of that, not a
  // reason to hold up or risk the access grant.
  await grantPortalAccess(reference, email, firstName, lastName, amountKobo);

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
