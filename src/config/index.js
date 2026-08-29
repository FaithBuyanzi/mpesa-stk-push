// ============================================================
// CONFIGURATION
// ============================================================
//
// Central place for every env-derived value and Safaricom endpoint
// URL, so route modules never rebuild them ad-hoc.
//

const PORT = process.env.PORT || 3000;

const MPESA_BASE_URL =
  process.env.MPESA_BASE_URL || "https://api.safaricom.co.ke";

const MPESA_OAUTH_URL =
  `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;

const C2B_REGISTER_URL =
  `${MPESA_BASE_URL}/mpesa/c2b/v2/registerurl`;

const ACCOUNT_BALANCE_URL =
  `${MPESA_BASE_URL}/mpesa/accountbalance/v1/query`;

const PULL_REGISTER_URL =
  `${MPESA_BASE_URL}/pulltransactions/v1/register`;

const PULL_QUERY_URL =
  `${MPESA_BASE_URL}/pulltransactions/v1/query`;

// Confirmed with the account owner: this is the app's "own" shortcode
// Safaricom authorizes it for. PARTY_B (4363881, the Till customers pay
// to directly) is only used as the STK Push payment destination, not for
// C2B registration - trying to register against PARTY_B was rejected by
// Safaricom with "400.003.02 Kindly use your own ShortCode". Updated from
// 4363819 to 4363839 after Safaricom reassigned the shortcode.
//
// The Pull Transactions API registers/queries against this same shortcode:
// it sits on top of the same C2B transactions Safaricom already routes
// through that code.
const OWN_SHORTCODE = 4363839;

// Every outbound Safaricom call uses the same timeout.
const MPESA_HTTP_TIMEOUT = 30000;

module.exports = {
  PORT,
  MPESA_BASE_URL,
  MPESA_OAUTH_URL,
  C2B_REGISTER_URL,
  ACCOUNT_BALANCE_URL,
  PULL_REGISTER_URL,
  PULL_QUERY_URL,
  OWN_SHORTCODE,
  MPESA_HTTP_TIMEOUT,
};
