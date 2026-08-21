// Server-side Paystack transaction verification.
// This runs on Vercel as a serverless function, never in the browser,
// so the secret key never gets exposed to visitors.
//
// GET /api/verify-payment?reference=xxxxx
// Returns: { verified: true, amount: 15000 } on a real, successful payment
//          { verified: false } for anything else (fake, failed, pending, wrong amount)

const EXPECTED_AMOUNT_KOBO = 1500000; // ₦15,000 in kobo

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

    const isRealSuccess =
      data &&
      data.status === true &&
      data.data &&
      data.data.status === "success" &&
      data.data.amount === EXPECTED_AMOUNT_KOBO;

    if (isRealSuccess) {
      res.status(200).json({ verified: true, amount: data.data.amount / 100 });
    } else {
      res.status(200).json({ verified: false });
    }
  } catch (err) {
    res.status(500).json({ verified: false, error: "Verification failed" });
  }
};
