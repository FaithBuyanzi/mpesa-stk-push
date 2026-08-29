const { db } = require("../../firebase");

// ============================================================
// C2B INVOICE MATCHING
// ============================================================
//
// A C2B (Till/Buy Goods) payment does NOT originate from an STK
// Push request, so there is no CheckoutRequestID to look up, and
// Safaricom does not reliably deliver a customer-entered
// account/reference for Buy Goods Till payments (BillRefNumber for
// Till is often just the payer's MSISDN or blank). So this reuses
// the exact same amount+name matching strategy the Flutter app
// already uses for Equity SMS reconciliation - see
// sms_payment_service.dart _matchInvoice / compute_isolates.dart
// matchInvoiceCompute, ported here 1:1 (same 0.01 balance-due
// tolerance, same Levenshtein-based name-similarity scoring, same
// 75-point strict threshold, same most-recent-invoice tie-break):
//
//   Rule 1: exact balance-due match against open (unpaid/
//      partiallyPaid) invoices -> disambiguate by name similarity.
//   Rule 2: no exact amount match (or amount match didn't clear the
//      name threshold) -> strict name-only match across ALL open
//      invoices.
//   Rule 3: nothing qualifies -> no match.
//
// Unlike the SMS flow, an unmatched C2B payment does NOT auto-create
// an invoice - it is saved in full to the `unmatched_payments`
// collection (the same shape as UnmatchedPayment.toFirestore() in
// lib/models/unmatched_payment.dart) for manual review, and no
// invoice is guessed.
//
const NAME_MATCH_MIN_SCORE = 75;

function normalizeNameForMatch(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ");
}

function levenshtein(s, t) {
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array(t.length + 1).fill(0);

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;

    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }

    [prev, curr] = [curr, prev];
  }

  return prev[t.length];
}

function tokenSimilarity(a, b) {
  if (a === b) return 100;

  if (a.includes(b) || b.includes(a)) {
    const shorterLen = Math.min(a.length, b.length);
    const longerLen = Math.max(a.length, b.length);
    return Math.round(55 + (shorterLen / longerLen) * 45);
  }

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);

  if (maxLen === 0) return 0;

  const similarity = (1 - dist / maxLen) * 100;
  return Math.round(Math.max(similarity, 0));
}

function nameSimilarity(a, b) {
  const tokensA = normalizeNameForMatch(a)
    .split(" ")
    .filter((t) => t.length >= 2);
  const tokensB = normalizeNameForMatch(b)
    .split(" ")
    .filter((t) => t.length >= 2);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  let total = 0;

  for (const tok of shorter) {
    let best = 0;

    for (const other of longer) {
      const score = tokenSimilarity(tok, other);
      if (score > best) best = score;
    }

    total += best;
  }

  return Math.round(total / shorter.length);
}

function pickBestNameMatch(paymentName, candidates, minScore) {
  if (!paymentName) return null;

  let bestScore = -1;
  let best = [];

  for (const c of candidates) {
    const score = nameSimilarity(paymentName, c.customerName || "");

    if (score > bestScore) {
      bestScore = score;
      best = [c];
    } else if (score === bestScore) {
      best.push(c);
    }
  }

  if (best.length === 0 || bestScore < minScore) return null;
  if (best.length === 1) return best[0];

  best.sort((a, b) => b.dateMillis - a.dateMillis);
  return best[0];
}

function matchInvoiceForPayment({ paymentName, paymentAmount, candidates }) {
  if (candidates.length === 0) return null;

  const exactAmountMatches = candidates.filter(
    (c) => Math.abs(c.balanceDue - paymentAmount) < 0.01
  );

  if (exactAmountMatches.length > 0) {
    const best = pickBestNameMatch(paymentName, exactAmountMatches, NAME_MATCH_MIN_SCORE);
    if (best) return best;
  }

  return pickBestNameMatch(paymentName, candidates, NAME_MATCH_MIN_SCORE);
}

async function findInvoiceForC2B({ amount, customerName }) {
  const openInvoices = await db
    .collection("invoices")
    .where("paymentStatus", "in", ["unpaid", "partiallyPaid"])
    .get();

  const candidates = openInvoices.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      doc,
      customerName: data.customerName || "",
      balanceDue:
        data.balanceDue != null
          ? data.balanceDue
          : (data.total || 0) - (data.amountPaid || 0),
      dateMillis: data.date ? data.date.toMillis() : 0,
    };
  });

  const matched = matchInvoiceForPayment({
    paymentName: customerName,
    paymentAmount: amount,
    candidates,
  });

  if (matched) {
    return { invoice: matched.doc, strategy: "sms_style_amount_and_name_match" };
  }

  return { invoice: null, strategy: "no_match" };
}

module.exports = {
  NAME_MATCH_MIN_SCORE,
  normalizeNameForMatch,
  levenshtein,
  tokenSimilarity,
  nameSimilarity,
  pickBestNameMatch,
  matchInvoiceForPayment,
  findInvoiceForC2B,
};
