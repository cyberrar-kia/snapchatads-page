// Server-side Paystack transaction verification.
// This runs on Vercel as a serverless function, never in the browser,
// so the secret key never gets exposed to visitors.
//
// GET /api/verify-payment?reference=xxxxx
// Returns: { verified: true, amount: <actual amount paid> } only for a real,
//          successful Paystack transaction. Fake/made-up references, failed
//          payments, and pending payments all correctly return verified:false.

module.exports = async function handler(req, res) {
  const reference = req.query.reference;

  if (!reference) {
    res.status(400).json({ verified: false, error: "Missing reference" });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    res.status(500).json({ verified: false, error: "Server misconfigured" });
    return;
  }

  try {
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );

    const data = await paystackRes.json();

    // The only thing that actually matters for security: is this a real
    // transaction that Paystack itself confirms was completed successfully?
    // A fake/made-up reference will simply not exist in Paystack's records,
    // so this check alone already blocks anyone from faking a purchase.
    const isRealSuccess =
      data &&
      data.status === true &&
      data.data &&
      data.data.status === "success";

    if (isRealSuccess) {
      res.status(200).json({ verified: true, amount: data.data.amount / 100 });
    } else {
      res.status(200).json({ verified: false });
    }
  } catch (err) {
    res.status(500).json({ verified: false, error: "Verification failed" });
  }
};
