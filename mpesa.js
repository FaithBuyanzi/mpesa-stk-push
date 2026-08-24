// mpesa.js
const axios = require("axios");

// Step 3: Get access token
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString("base64");

  const response = await axios.get(
    `${process.env.BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );

  return response.data.access_token;
}

// Step 4: Generate password + timestamp
//
// Safaricom validates this Timestamp against its own East Africa Time
// clock (UTC+3, no DST) when it independently recomputes the Password to
// authenticate the request. The host server (Render) runs in UTC, so
// building the timestamp from the server's local/UTC clock silently
// produces a Password Safaricom rejects - the initial STK push call still
// returns ResponseCode 0 (the request is well-formed), but the push is
// never actually generated, and a follow-up query returns ResultCode 4999
// "Wrong credentials". Shifting by +3h before formatting fixes this
// regardless of the underlying server's timezone.
function generatePassword() {
  const eatNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const timestamp = eatNow
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14); // format: YYYYMMDDHHmmss, East Africa Time

  const password = Buffer.from(
    `${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`
  ).toString("base64");

  return { password, timestamp };
}

// Step 5: Send the STK Push request
async function stkPush({ phone, amount, accountReference, description }) {
  const token = await getAccessToken();
  const { password, timestamp } = generatePassword();

  const payload = {
    BusinessShortCode: process.env.SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerBuyGoodsOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: process.env.PARTY_B,
    PhoneNumber: phone,
    CallBackURL: process.env.CALLBACK_URL,
    AccountReference: accountReference,
    TransactionDesc: description,
  };

  const response = await axios.post(
    `${process.env.BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return response.data;
}

// Step 8 (optional): Query transaction status
async function stkQuery(checkoutRequestID) {
  const token = await getAccessToken();
  const { password, timestamp } = generatePassword();

  const payload = {
    BusinessShortCode: process.env.SHORTCODE,
    Password: password,
    Timestamp: timestamp,
    CheckoutRequestID: checkoutRequestID,
  };

  const response = await axios.post(
    `${process.env.BASE_URL}/mpesa/stkpushquery/v1/query`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return response.data;
}

module.exports = { getAccessToken, generatePassword, stkPush, stkQuery };