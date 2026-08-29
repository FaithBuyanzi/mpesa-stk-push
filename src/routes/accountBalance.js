const express = require("express");
const axios = require("axios");

const { admin, db } = require("../../firebase");
const { buildSecurityCredential } = require("../../security_credential");
const { ACCOUNT_BALANCE_URL, MPESA_HTTP_TIMEOUT } = require("../config");
const { getMpesaAccessToken } = require("../services/mpesaAuth");

const router = express.Router();

// ============================================================
// ACCOUNT BALANCE API
// ============================================================
//
// Unlike STK Push and C2B, this uses Safaricom's Initiator-based
// security model (Initiator name/password) instead of just the OAuth
// consumer key/secret. The OAuth token itself IS reused from
// getMpesaAccessToken() above, same as C2B registration.
//
// SecurityCredential is the Initiator password RSA-encrypted against
// Safaricom's public certificate (certs/ProductionCertificate.cer),
// base64-encoded - built fresh per-request in security_credential.js.
//
// This is a two-step, ASYNC flow, same shape as STK Push:
//   1. POST here -> Safaricom immediately acknowledges the request
//      (this does NOT contain the balance).
//   2. The actual balance arrives later via a callback to
//      ACCOUNT_BALANCE_RESULT_URL (or ACCOUNT_BALANCE_TIMEOUT_URL if
//      it times out) - handled below and saved to Firestore.
//
// URL:
// POST /api/mpesa/account-balance
//

router.post("/api/mpesa/account-balance", async (req, res) => {
  try {
    console.log("========== ACCOUNT BALANCE REQUEST ==========");

    const initiatorName = process.env.INITIATOR_NAME;

    const partyA = process.env.ACCOUNT_BALANCE_SHORTCODE;

    const resultURL = process.env.ACCOUNT_BALANCE_RESULT_URL;
    const timeoutURL = process.env.ACCOUNT_BALANCE_TIMEOUT_URL;

    if (!initiatorName) {
      return res.status(500).json({
        success: false,
        error: "INITIATOR_NAME is not configured",
      });
    }

    if (!partyA) {
      return res.status(500).json({
        success: false,
        error: "ACCOUNT_BALANCE_SHORTCODE is not configured",
      });
    }

    if (!resultURL || !timeoutURL) {
      return res.status(500).json({
        success: false,
        error:
          "ACCOUNT_BALANCE_RESULT_URL and ACCOUNT_BALANCE_TIMEOUT_URL must both be configured",
      });
    }

    if (!process.env.INITIATOR_PASSWORD) {
      return res.status(500).json({
        success: false,
        error: "INITIATOR_PASSWORD is not configured",
      });
    }

    let securityCredential;
    try {
      securityCredential = buildSecurityCredential(
        process.env.INITIATOR_PASSWORD
      );
    } catch (credErr) {
      console.error("Failed to build SecurityCredential:", credErr.message);
      return res.status(500).json({
        success: false,
        error: `Failed to build SecurityCredential: ${credErr.message}`,
      });
    }

    const accessToken = await getMpesaAccessToken();

    const payload = {
      Initiator: initiatorName,
      SecurityCredential: securityCredential,
      CommandID: "AccountBalance",
      PartyA: partyA,
      IdentifierType: "2",
      Remarks: "Selete Agro account balance query",
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

    console.log("Account Balance accept response:", response.data);

    res.json({
      success: true,

      message:
        "Request accepted - the actual balance arrives asynchronously at ACCOUNT_BALANCE_RESULT_URL, not in this response",

      data: response.data,
    });
  } catch (err) {
    console.error(
      "❌ Account balance request error:"
    );

    console.error(
      err.response?.data || err.message
    );

    if (err.code === "ECONNABORTED") {
      return res.status(504).json({
        success: false,
        error: "Timed out waiting for Safaricom to accept the request",
      });
    }

    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});

// ============================================================
// ACCOUNT BALANCE RESULT CALLBACK
// ============================================================
//
// Safaricom calls this asynchronously with the actual balance once the
// request above has been processed.
//
// URL:
// /api/mpesa/account-balance/result
//

router.post("/api/mpesa/account-balance/result", async (req, res) => {
  try {
    console.log("========== ACCOUNT BALANCE RESULT ==========");

    console.log(JSON.stringify(req.body, null, 2));

    const result = req.body?.Result;

    if (result) {
      console.log("ResultCode:", result.ResultCode);
      console.log("ResultDesc:", result.ResultDesc);

      const params = result.ResultParameters?.ResultParameter || [];

      const record = {
        resultCode: result.ResultCode,
        resultDesc: result.ResultDesc,
        raw: result,
        receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // Per Safaricom's documented format, AccountBalance is several
      // accounts joined by "&", each account's own fields joined by
      // "|": Name|Currency|AvailableBalance|<further fields Safaricom's
      // docs don't fully define>. e.g.:
      //   "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility
      //    Account|KES|228037.00|228037.00|0.00|0.00"
      // Only name/currency/availableBalance are parsed out with
      // confidence; the remaining fields are kept as extraAmounts
      // rather than guessed at, since Safaricom's own docs are
      // ambiguous about what each one represents beyond "available".
      const balanceParam = params.find(
        (p) => p.Key === "AccountBalance"
      );

      const boCompletedParam = params.find(
        (p) => p.Key === "BOCompletedTime"
      );

      if (balanceParam) {
        record.accountBalanceRaw = balanceParam.Value;
        console.log("AccountBalance raw value:", balanceParam.Value);

        record.accounts = balanceParam.Value.split("&")
          .map((entry) => entry.split("|"))
          .filter((fields) => fields.length >= 3)
          .map((fields) => ({
            accountName: fields[0],
            currency: fields[1],
            availableBalance: parseFloat(fields[2]) || 0,
            extraAmounts: fields.slice(3).map((v) => parseFloat(v) || 0),
          }));

        console.log(
          "Parsed accounts:",
          record.accounts
            .map((a) => `${a.accountName}: ${a.availableBalance} ${a.currency}`)
            .join(", ")
        );
      }

      if (boCompletedParam) {
        record.boCompletedTime = boCompletedParam.Value;
      }

      await db
        .collection("mpesa_account_balance")
        .doc("latest")
        .set(record);

      console.log("✅ Account balance result saved to Firestore");
    } else {
      console.error(
        "Account balance result callback missing Result object"
      );
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (err) {
    console.error(
      "❌ Account balance result error:",
      err
    );

    res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Error",
    });
  }
});

// ============================================================
// ACCOUNT BALANCE TIMEOUT CALLBACK
// ============================================================
//
// Safaricom calls this instead of the result callback if the request
// times out on their end.
//
// URL:
// /api/mpesa/account-balance/timeout
//

router.post("/api/mpesa/account-balance/timeout", async (req, res) => {
  console.error("========== ACCOUNT BALANCE TIMEOUT ==========");
  console.error(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});

module.exports = router;
