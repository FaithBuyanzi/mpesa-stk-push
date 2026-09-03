// Required inside findInvoiceForC2B rather than at the top of the file, so
// that everything above it — the date window, the name scoring, the
// matching itself — can be imported and tested without Firebase
// credentials. That is the whole of the decision-making in here; only the
// one function that fetches candidates needs a database at all.
//
// See test/invoiceMatcher.test.js, which exists because of this.
function firestore() {
  return require("../../firebase").db;
}

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

// How far apart a payment and an invoice may be dated and still be taken
// for the same transaction. Must stay in step with kMatchWindowDays in
// lib/utils/payment_matching.dart, which is the same rule for the manual
// matching card in the app.
//
// This used to be missing here entirely, and the invoice date was read
// only as a tie-break for two candidates scoring the same on name. The
// effect was that the app refused a match more than a week apart while
// this quietly made it first: a Till payment arriving today could be
// attributed to an unpaid invoice from six months ago, and by the time
// anybody looked at the payment it was already spoken for. The window in
// the app was doing nothing except on the leftovers.
const MATCH_WINDOW_DAYS = 7;

// Whole days between two instants, ignoring the time of day.
//
// Compared as calendar dates, the same way daysBetweenDates does it in
// payment_matching.dart: a payment at 23:50 and an invoice raised at 00:10
// the next morning are one day apart, not zero.
function daysBetweenDates(a, b) {
  const dayA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const dayB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.abs(Math.round((dayA - dayB) / 86400000));
}

// Candidates dated within MATCH_WINDOW_DAYS of the payment.
//
// An invoice with no usable date is dropped rather than kept. Keeping it
// would mean a document the matcher cannot place in time is the one thing
// the window never applies to, which is exactly backwards — and every
// invoice the app writes carries a date, so this only ever catches
// something already wrong.
function withinWindow(candidates, paymentDate) {
  if (!(paymentDate instanceof Date) || Number.isNaN(paymentDate.getTime())) {
    // No usable payment date: match nothing automatically rather than
    // match everything. A payment left unattributed is a job for somebody;
    // a payment on the wrong invoice is a customer chasing a receipt for a
    // sale they have already paid for.
    return [];
  }
  return candidates.filter(
    (c) =>
      c.dateMillis > 0 &&
      daysBetweenDates(new Date(c.dateMillis), paymentDate) <=
        MATCH_WINDOW_DAYS
  );
}

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

// paymentDate is required. Called without one, nothing matches — see
// withinWindow. That is deliberate rather than defensive: an automatic
// matcher that falls back to "no date rule" the moment a caller forgets to
// pass a date is a matcher whose date rule is optional in practice.
function matchInvoiceForPayment({
  paymentName,
  paymentAmount,
  paymentDate,
  candidates,
}) {
  if (candidates.length === 0) return null;

  // Applied before amount and name, not after. An invoice from March whose
  // balance happens to equal today's payment is not a near-miss to be
  // scored — it is not a candidate at all.
  const inWindow = withinWindow(candidates, paymentDate);
  if (inWindow.length === 0) return null;

  const exactAmountMatches = inWindow.filter(
    (c) => Math.abs(c.balanceDue - paymentAmount) < 0.01
  );

  if (exactAmountMatches.length > 0) {
    const best = pickBestNameMatch(paymentName, exactAmountMatches, NAME_MATCH_MIN_SCORE);
    if (best) return best;
  }

  return pickBestNameMatch(paymentName, inWindow, NAME_MATCH_MIN_SCORE);
}

async function findInvoiceForC2B({ amount, customerName, paymentDate }) {
  const openInvoices = await firestore()
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
    paymentDate: paymentDate instanceof Date ? paymentDate : new Date(),
    candidates,
  });

  if (matched) {
    return { invoice: matched.doc, strategy: "sms_style_amount_and_name_match" };
  }

  return { invoice: null, strategy: "no_match" };
}

module.exports = {
  MATCH_WINDOW_DAYS,
  daysBetweenDates,
  withinWindow,
  NAME_MATCH_MIN_SCORE,
  normalizeNameForMatch,
  levenshtein,
  tokenSimilarity,
  nameSimilarity,
  pickBestNameMatch,
  matchInvoiceForPayment,
  findInvoiceForC2B,
};
