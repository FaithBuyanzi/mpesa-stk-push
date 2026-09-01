// ============================================================
// MSISDN HASH DECODING
// ============================================================
//
// Safaricom stopped sending the payer's real number in C2B
// callbacks for organisations without approved data access.
// What arrives in MSISDN is a SHA-256 hash of the number - 64
// hex characters - which is useless for anything the farm
// actually wants to do with it (send a receipt, ring a customer
// back about an order).
//
// decodehash.com maintains a rainbow table of the whole Kenyan
// MSISDN space, which is feasible precisely because the input
// domain is tiny: an unsalted SHA-256 over ~100 million possible
// numbers is not a one-way function in any useful sense. Their
// free API turns a hash back into the number.
//
// Docs: https://www.decodehash.com/app/blogs/help-guide
//
//   Anonymous : GET /app/api/v1/decode-hash/free/{hash}       10/day
//   With key  : GET /app/api/v1/decode-hash/freemium/{hash}   50/day
//               Authorization: Bearer <key>
//
// Both tiers answer {"hash":"...","msisdn":"254700123456"} and
// 429 with a Retry-After header when the day's quota is gone.
//
// FIFTY A DAY IS THE WHOLE DESIGN CONSTRAINT. A busy till would
// burn that before lunch, so every decode is cached in Firestore
// under the hash and a repeat customer costs one lookup ever, not
// one per payment. The cache is keyed by hash rather than by
// transaction for exactly that reason.

const axios = require("axios");

const { admin, db } = require("../../firebase");

const DECODEHASH_BASE = "https://decodehash.com/app/api/v1/decode-hash";

// Their published limit, per day. Held here so the budget check
// below reads as what it is rather than a bare number.
const FREE_TIER_DAILY = 10;
const KEYED_TIER_DAILY = 50;

const HTTP_TIMEOUT = 15000;

// Where decoded numbers live. One document per hash, shared by
// every transaction that payer ever makes.
const CACHE_COLLECTION = "msisdn_hashes";

// One document, rewritten daily, holding how much of today's
// quota has been spent. Not for correctness - the API enforces
// its own limit - but so the server can stop asking once the
// quota is plainly gone instead of firing off dozens of requests
// that can only come back 429.
const BUDGET_DOC = "msisdn_hash_budget";

function apiKey() {
  return (process.env.DECODEHASH_API_KEY || "").trim();
}

// Off by default is the wrong default here: the hash is worthless
// without this, so decoding is on unless explicitly disabled.
function isEnabled() {
  return String(process.env.DECODEHASH_ENABLED || "true").toLowerCase() !==
    "false";
}

function dailyLimit() {
  return apiKey() ? KEYED_TIER_DAILY : FREE_TIER_DAILY;
}

// A Safaricom MSISDN hash is SHA-256 rendered as 64 lowercase hex
// characters. A real number is 12 digits starting 254. Anything
// else - empty, some future format - is left alone rather than
// guessed at.
function looksHashed(value) {
  return /^[0-9a-f]{64}$/i.test(String(value || "").trim());
}

function looksLikeMsisdn(value) {
  return /^254[0-9]{9}$/.test(String(value || "").trim());
}

// Normalises whatever the decoder or a human typed into the
// 2547XXXXXXXX form the rest of the system uses.
function normaliseMsisdn(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  if (!digits) return null;
  if (digits.startsWith("254")) return digits.length === 12 ? digits : null;
  // 07XXXXXXXX / 01XXXXXXXX
  if (digits.length === 10 && digits.startsWith("0")) return `254${digits.slice(1)}`;
  // 7XXXXXXXX / 1XXXXXXXX
  if (digits.length === 9) return `254${digits}`;
  return null;
}

function todayKey() {
  // Nairobi is UTC+3 with no daylight saving, so this is exact
  // rather than approximately right. The quota resets on their
  // clock, not ours, but a day boundary three hours out only ever
  // costs a handful of wasted requests once.
  const nairobi = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return nairobi.toISOString().slice(0, 10);
}

async function cachedMsisdn(hash) {
  try {
    const doc = await db.collection(CACHE_COLLECTION).doc(hash).get();
    if (!doc.exists) return null;
    const msisdn = doc.data().msisdn;
    return looksLikeMsisdn(msisdn) ? msisdn : null;
  } catch (err) {
    console.error("msisdn cache read failed:", err.message);
    return null;
  }
}

async function cacheMsisdn(hash, msisdn) {
  try {
    await db.collection(CACHE_COLLECTION).doc(hash).set(
      {
        hash,
        msisdn,
        decodedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    // A failed cache write costs one extra API call next time.
    // Not worth failing the payment path over.
    console.error("msisdn cache write failed:", err.message);
  }
}

// Returns false once today's quota looks spent. Best-effort: a
// concurrent callback can push it one over, which the API will
// reject on its own.
async function withinBudget() {
  const ref = db.collection("config").doc(BUDGET_DOC);
  try {
    const doc = await ref.get();
    const data = doc.exists ? doc.data() : {};
    if (data.day !== todayKey()) return true;
    return (data.used || 0) < dailyLimit();
  } catch (err) {
    // Cannot tell - try the call. Being wrong costs one 429.
    console.error("msisdn budget read failed:", err.message);
    return true;
  }
}

async function spendBudget(exhausted) {
  const ref = db.collection("config").doc(BUDGET_DOC);
  try {
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(ref);
      const data = doc.exists ? doc.data() : {};
      const sameDay = data.day === todayKey();
      tx.set(
        ref,
        {
          day: todayKey(),
          used: exhausted ? dailyLimit() : (sameDay ? data.used || 0 : 0) + 1,
          limit: dailyLimit(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });
  } catch (err) {
    console.error("msisdn budget write failed:", err.message);
  }
}

// ============================================================
// THE ONE FUNCTION CALLERS WANT
// ============================================================
//
// Give it whatever Safaricom put in MSISDN. Get back a real
// 2547XXXXXXXX number, or null.
//
// Null is an ordinary outcome, not an error: the quota can be
// spent, the number can be one their table does not hold, the
// service can be down. Every caller has to cope with not knowing
// the number, because that is also what happens on a plain
// Safaricom outage. Nothing here throws.
//
async function resolveMsisdn(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;

  // Already a real number - Safaricom still sends these for
  // shortcodes with data access approved, and for STK Push.
  if (looksLikeMsisdn(value)) return value;

  const normalised = normaliseMsisdn(value);
  if (normalised) return normalised;

  if (!looksHashed(value)) return null;

  const hash = value.toLowerCase();

  const cached = await cachedMsisdn(hash);
  if (cached) {
    console.log("MSISDN hash resolved from cache");
    return cached;
  }

  if (!isEnabled()) {
    console.log("MSISDN decoding disabled (DECODEHASH_ENABLED=false)");
    return null;
  }

  if (!(await withinBudget())) {
    console.warn(
      `⚠️ decodehash daily quota (${dailyLimit()}) looks spent - not calling`
    );
    return null;
  }

  const key = apiKey();
  const url = key
    ? `${DECODEHASH_BASE}/freemium/${hash}`
    : `${DECODEHASH_BASE}/free/${hash}`;

  try {
    const response = await axios.get(url, {
      timeout: HTTP_TIMEOUT,
      headers: {
        Accept: "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
    });

    const remaining = response.headers["x-ratelimit-remaining"];
    if (remaining !== undefined) {
      console.log(`decodehash quota remaining: ${remaining}`);
    }

    const msisdn = normaliseMsisdn(response.data && response.data.msisdn);
    if (!msisdn) {
      console.warn("decodehash returned no usable msisdn:", response.data);
      await spendBudget(false);
      return null;
    }

    await Promise.all([cacheMsisdn(hash, msisdn), spendBudget(false)]);
    return msisdn;
  } catch (err) {
    const status = err.response && err.response.status;

    if (status === 429) {
      const retryAfter = err.response.headers["retry-after"];
      console.warn(
        `⚠️ decodehash rate limited${
          retryAfter ? ` - retry after ${retryAfter}s` : ""
        }. Set DECODEHASH_API_KEY for ${KEYED_TIER_DAILY}/day.`
      );
      // Stop asking for the rest of the day rather than 429ing on
      // every payment that arrives.
      await spendBudget(true);
      return null;
    }

    console.error(
      "decodehash lookup failed:",
      status || "",
      (err.response && err.response.data) || err.message
    );
    return null;
  }
}

module.exports = {
  resolveMsisdn,
  looksHashed,
  looksLikeMsisdn,
  normaliseMsisdn,
  CACHE_COLLECTION,
};
