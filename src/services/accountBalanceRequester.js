const axios = require("axios");

const { buildSecurityCredential } = require("../../security_credential");
const { ACCOUNT_BALANCE_URL, MPESA_HTTP_TIMEOUT } = require("../config");
const { getMpesaAccessToken } = require("./mpesaAuth");

// ============================================================
// ASKING SAFARICOM FOR THE TILL BALANCE
// ============================================================
//
// The request itself, with no Express around it, so both callers can use
// it: POST /api/mpesa/account-balance (somebody pressing "check balance"
// in the app) and the C2B confirmation handler (a customer has just paid,
// so the number the app is showing is now out of date).
//
// This is only half of the exchange. Safaricom acknowledges the request
// and sends the actual balance later to ACCOUNT_BALANCE_RESULT_URL, which
// is what writes mpesa_account_balance/latest. So a `true` from here means
// "asked", never "the balance is now correct".

/**
 * Whether the Initiator credentials are configured at all.
 *
 * Checked before every automatic request, because the automatic caller has
 * nowhere to report a misconfiguration to. On a deployment without these
 * set, an unguarded call would log a stack trace on every single payment.
 */
function isConfigured() {
  return !!(
    process.env.INITIATOR_NAME &&
    process.env.INITIATOR_PASSWORD &&
    process.env.ACCOUNT_BALANCE_SHORTCODE &&
    process.env.ACCOUNT_BALANCE_RESULT_URL &&
    process.env.ACCOUNT_BALANCE_TIMEOUT_URL
  );
}

/**
 * Sends the AccountBalance query. Throws on anything that goes wrong, so
 * the route can turn it into a status code; automatic callers should use
 * requestAccountBalanceQuietly instead.
 */
async function requestAccountBalance(remarks) {
  const initiatorName = process.env.INITIATOR_NAME;
  const partyA = process.env.ACCOUNT_BALANCE_SHORTCODE;
  const resultURL = process.env.ACCOUNT_BALANCE_RESULT_URL;
  const timeoutURL = process.env.ACCOUNT_BALANCE_TIMEOUT_URL;

  if (!initiatorName) throw new Error("INITIATOR_NAME is not configured");
  if (!partyA) throw new Error("ACCOUNT_BALANCE_SHORTCODE is not configured");
  if (!resultURL || !timeoutURL) {
    throw new Error(
      "ACCOUNT_BALANCE_RESULT_URL and ACCOUNT_BALANCE_TIMEOUT_URL must both be configured"
    );
  }
  if (!process.env.INITIATOR_PASSWORD) {
    throw new Error("INITIATOR_PASSWORD is not configured");
  }

  const securityCredential = buildSecurityCredential(
    process.env.INITIATOR_PASSWORD
  );
  const accessToken = await getMpesaAccessToken();

  const payload = {
    Initiator: initiatorName,
    SecurityCredential: securityCredential,
    CommandID: "AccountBalance",
    PartyA: partyA,
    IdentifierType: "2",
    Remarks: remarks || "Selete Agro account balance query",
    QueueTimeOutURL: timeoutURL,
    ResultURL: resultURL,
  };

  // Never log SecurityCredential or the access token.
  console.log("PartyA:", partyA);
  console.log("Initiator:", initiatorName);
  console.log("ResultURL:", resultURL);
  console.log("QueueTimeOutURL:", timeoutURL);

  const response = await axios.post(ACCOUNT_BALANCE_URL, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    timeout: MPESA_HTTP_TIMEOUT,
  });

  return response.data;
}

// ------------------------------------------------------------
// The automatic caller
// ------------------------------------------------------------
//
// Every Till payment changes the balance, so every Till payment is a
// reason to go and read it — otherwise the figure on the dashboard is
// whatever it was the last time somebody thought to press the button, and
// a stale balance is worse than no balance because it looks current.
//
// Two things stop that becoming a request per payment. A Saturday morning
// can bring a dozen payments in a couple of minutes, and each answer only
// supersedes the one before it: the balance after the last of them is the
// only one anybody wants, and asking twelve times to find it out spends
// twelve calls against Safaricom's rate limits to learn one number. So
// there is a floor on how often this fires, and a request already in
// flight is not joined by a second one.
//
// The floor is deliberately shorter than it could be. The balance is
// wanted *soon* after money lands, not eventually, so a minute is the
// compromise: a burst produces one query, and a payment arriving a few
// minutes later still produces its own.

const MIN_INTERVAL_MS = 60 * 1000;

let lastRequestAt = 0;
let inFlight = false;

/**
 * Asks for the balance if it has not been asked for recently. Never
 * throws — the caller is a payment handler, and a payment must not fail
 * because a balance query did.
 *
 * Returns one of: "sent", "throttled", "in-flight", "not-configured",
 * "failed".
 */
async function requestAccountBalanceQuietly(remarks) {
  if (!isConfigured()) {
    // Not an error. A deployment that has not been given Initiator
    // credentials simply does not have this feature, and saying so once
    // per payment in the log would be noise, not information.
    return "not-configured";
  }

  if (inFlight) return "in-flight";

  const now = Date.now();
  if (now - lastRequestAt < MIN_INTERVAL_MS) return "throttled";

  inFlight = true;
  lastRequestAt = now;
  try {
    await requestAccountBalance(remarks);
    console.log("Balance query sent -", remarks || "no remarks");
    return "sent";
  } catch (err) {
    // Logged and swallowed. The balance being out of date is a display
    // problem; the payment it was triggered by is already banked.
    console.error(
      "Balance query failed (the payment is unaffected):",
      err.response?.data || err.message
    );
    // Not held against the floor: a failure that is retried a minute later
    // is better than one that locks the balance out for the rest of the
    // burst.
    lastRequestAt = 0;
    return "failed";
  } finally {
    inFlight = false;
  }
}

/** Test seam. Resets the throttle so a suite is not paced by real time. */
function _resetThrottle() {
  lastRequestAt = 0;
  inFlight = false;
}

module.exports = {
  isConfigured,
  requestAccountBalance,
  requestAccountBalanceQuietly,
  _resetThrottle,
};
