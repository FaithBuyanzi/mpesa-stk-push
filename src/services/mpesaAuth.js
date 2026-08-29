const axios = require("axios");

const { MPESA_OAUTH_URL, MPESA_HTTP_TIMEOUT } = require("../config");

// ============================================================
// GET SAFARICOM PRODUCTION ACCESS TOKEN
// ============================================================
//
// Shared by every OAuth-based Daraja call in this app (C2B
// registration, Pull Transactions, Account Balance). STK Push has its
// own token helper in mpesa.js because it authenticates against
// BASE_URL rather than MPESA_BASE_URL.
//
async function getMpesaAccessToken() {
  if (
    !process.env.CONSUMER_KEY ||
    !process.env.CONSUMER_SECRET
  ) {
    throw new Error(
      "CONSUMER_KEY and CONSUMER_SECRET are not configured"
    );
  }

  const credentials = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    MPESA_OAUTH_URL,
    {
      headers: {
        Authorization: `Basic ${credentials}`,
      },

      timeout: MPESA_HTTP_TIMEOUT,
    }
  );

  if (!response.data?.access_token) {
    throw new Error(
      "Safaricom did not return an access token"
    );
  }

  return response.data.access_token;
}

module.exports = { getMpesaAccessToken };
