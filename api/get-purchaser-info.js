// Looks up the real buyer's email/phone from Paystack using the transaction
// reference, so the Pixel can pass real customer data for Manual Advanced
// Matching (fixing the "not set up" warning in Events Manager, and the low
// fbc match-quality coverage we found on Purchase events).
//
// This is purely additive: if the reference is fake/invalid, this just
// returns no data and the page carries on exactly as before, it never
// blocks the success page or the Purchase event from firing.
//
// GET /api/get-purchaser-info?reference=xxxxx

module.exports = async function handler(req, res) {
  const reference = req.query.reference;

  if (!reference) {
    res.status(400).json({ error: "Missing reference" });
    return;
  }

  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    // No key configured — fail quietly, the page doesn't depend on this.
    res.status(200).json({ found: false });
    return;
  }

  try {
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${secretKey}` } }
    );
    const data = await paystackRes.json();

    if (data && data.status === true && data.data) {
      const email = data.data.customer && data.data.customer.email;
      const phone =
        (data.data.customer && data.data.customer.phone) ||
        (data.data.metadata && data.data.metadata.phone) ||
        null;

      res.status(200).json({
        found: true,
        email: email || null,
        phone: phone || null,
      });
      return;
    }

    // Not a real/verifiable transaction — that's fine, just report not found.
    res.status(200).json({ found: false });
  } catch (err) {
    console.error("[advanced-matching][lookup-error]", err);
    res.status(200).json({ found: false });
  }
};
