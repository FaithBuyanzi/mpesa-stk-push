const express = require("express");
const axios = require("axios");

const { admin, db } = require("../../firebase");
const {
  PULL_REGISTER_URL,
  PULL_QUERY_URL,
  OWN_SHORTCODE,
  MPESA_HTTP_TIMEOUT,
} = require("../config");
const { getMpesaAccessToken } = require("../services/mpesaAuth");
const { findInvoiceForC2B } = require("../services/invoiceMatcher");
const { recordMpesaPayment } = require("../services/paymentRecorder");
const { parseMpesaTimestamp } = require("../utils/mpesaDates");

const router = express.Router();

// ============================================================
// PULL TRANSACTIONS API - REGISTER (reconciliation, C2B only)
// ============================================================
//
// One-time registration (per Safaricom docs) that lets us later query
// all C2B transactions on our ShortCode from the last 48 hours - used
// to recover any C2B confirmations that Safaricom's real-time
// callback (/api/c2b/confirmation) failed to deliver, e.g. during our
// own downtime.
//
// Registers against the same "own" ShortCode used for C2B v2 above
// (4363839), not PARTY_B/the Till - the Pull API sits on top of the
// same C2B transactions Safaricom already routes through that code.
//
// URL:
// POST /api/mpesa/pull/register
//

router.post("/api/mpesa/pull/register", async (req, res) => {
  try {
    console.log("========== PULL TRANSACTIONS - REGISTER ==========");

    const shortCode = OWN_SHORTCODE;
    const nominatedNumber = process.env.PULL_NOMINATED_NUMBER;
    const callbackURL = process.env.PULL_CALLBACK_URL;

    if (!nominatedNumber) {
      return res.status(500).json({
        success: false,
        error: "PULL_NOMINATED_NUMBER is not configured",
      });
    }

    if (!callbackURL) {
      return res.status(500).json({
        success: false,
        error: "PULL_CALLBACK_URL is not configured",
      });
    }

    console.log("ShortCode:", shortCode);
    console.log("NominatedNumber:", nominatedNumber);
    console.log("CallBackURL:", callbackURL);

    const accessToken = await getMpesaAccessToken();

    const payload = {
      ShortCode: shortCode,
      RequestType: "Pull",
      NominatedNumber: nominatedNumber,
      CallBackURL: callbackURL,
    };

    const response = await axios.post(PULL_REGISTER_URL, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: MPESA_HTTP_TIMEOUT,
    });

    console.log("Pull registration response:", response.data);

    // 1000 = registered successfully, 1001 = already registered - both
    // mean the ShortCode is now set up for pulling, so both are treated
    // as success by the caller (this endpoint is meant to be safe to
    // call more than once).
    res.json({
      success: true,
      message:
        response.data?.ResponseDescription ||
        "Pull registration request completed",
      data: response.data,
    });
  } catch (err) {
    console.error("❌ Pull registration error:");
    console.error(err.response?.data || err.message);

    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});


// ============================================================
// PULL TRANSACTIONS API - QUERY (reconciliation)
// ============================================================
//
// Fetches C2B transactions Safaricom processed on our ShortCode within
// a given window (max 48 hours back, per Safaricom) and recovers any
// that never reached /api/c2b/confirmation. Reuses the exact same
// c2b_transactions doc-ID-by-TransID dedupe as the live confirmation
// callback (see findInvoiceForC2B/recordMpesaPayment above), so a
// transaction that already arrived via the real-time callback is left
// untouched - only genuinely missed ones get inserted and matched here.
//
// URL:
// GET /api/mpesa/pull/query?startDate=2024-01-01 00:00:00&endDate=2024-01-02 00:00:00&offset=0
//

router.get("/api/mpesa/pull/query", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const offset = req.query.offset || "0";

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error:
          "startDate and endDate query params are required (format: YYYY-MM-DD HH:mm:ss)",
      });
    }

    console.log("========== PULL TRANSACTIONS - QUERY ==========");
    console.log("StartDate:", startDate);
    console.log("EndDate:", endDate);
    console.log("Offset:", offset);

    const shortCode = OWN_SHORTCODE;
    const accessToken = await getMpesaAccessToken();

    const payload = {
      ShortCode: shortCode,
      StartDate: startDate,
      EndDate: endDate,
      OffSetValue: String(offset),
    };

    // Safaricom's Pull Query endpoint is documented as GET but expects a
    // JSON request body - axios supports this on a GET request via `data`.
    const response = await axios({
      method: "get",
      url: PULL_QUERY_URL,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      data: payload,
      timeout: MPESA_HTTP_TIMEOUT,
    });

    const responseCode = response.data?.ResponseCode;

    // Safaricom nests results as an array of arrays; flatten defensively.
    // A missing/empty Response means no transactions for the window
    // (ResponseCode 1001).
    const rawTransactions = (response.data?.Response || []).flat();

    console.log(
      `Pull query returned ${rawTransactions.length} transaction(s), ResponseCode ${responseCode}`
    );

    const recovered = [];
    const alreadyKnown = [];
    const errors = [];

    for (const t of rawTransactions) {
      const transactionId = t.transactionId;

      if (!transactionId) continue;

      const amount = parseFloat(t.amount) || 0;
      const c2bRef = db.collection("c2b_transactions").doc(transactionId);

      try {
        await c2bRef.create({
          transactionType: t.transactiontype || "Pay Bill",
          mpesaReceiptNumber: transactionId,
          transactionId,
          transactionTime: t.trxDate || null,
          amount,
          businessShortCode: shortCode,
          billRefNumber: t.billreference || "",
          invoiceNumber: "",
          organizationAccountBalance: "",
          thirdPartyTransactionId: "",
          phone: t.msisdn ? String(t.msisdn) : "",
          firstName: "",
          middleName: "",
          lastName: "",
          customerName: t.sender || "",
          paymentMethod: "mpesa_c2b",
          source: "Safaricom Pull API (recovered)",
          status: "confirmed",
          matched: false,
          matchedInvoiceId: null,
          matchStrategy: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        const alreadyExists =
          err.code === 6 || // gRPC ALREADY_EXISTS status code
          /already exists/i.test(err.message || "");

        if (alreadyExists) {
          alreadyKnown.push(transactionId);
          continue;
        }

        console.error(
          "Error saving pulled transaction:",
          transactionId,
          err.message
        );
        errors.push({ transactionId, error: err.message });
        continue;
      }

      recovered.push(transactionId);

      try {
        const { invoice, strategy } = await findInvoiceForC2B({
          amount,
          customerName: t.sender || "",
        });

        if (invoice) {
          const result = await recordMpesaPayment({
            invoiceId: invoice.id,
            amount,
            receipt: transactionId,
            phone: t.msisdn,
            transactionDate: t.trxDate,
            source: "pull",
            extra: {
              transId: transactionId,
              billRefNumber: t.billreference || "",
              businessShortCode: shortCode,
            },
          });

          await c2bRef.update({
            matched: !!result.recorded,
            matchedInvoiceId: invoice.id,
            matchStrategy: strategy,
          });
        } else {
          await c2bRef.update({ matched: false, matchStrategy: strategy });

          // Same pattern as the live C2B confirmation handler: never
          // silently drop a recovered payment that couldn't be matched,
          // and never auto-create an invoice for it either - save the
          // full payment to unmatched_payments for manual review.
          await db.collection("unmatched_payments").add({
            rawSms: `Pull-recovered C2B payment - TransID: ${transactionId}, BusinessShortCode: ${shortCode}, BillRef: ${
              t.billreference || "none"
            }`,
            customerName: t.sender || null,
            customerPhone: t.msisdn ? String(t.msisdn) : null,
            amount,
            reference: transactionId,
            transactionDate: admin.firestore.Timestamp.fromDate(
              parseMpesaTimestamp(t.trxDate) || new Date()
            ),
            reason: `No matching open invoice found (${strategy})`,
            resolved: false,
            resolvedAt: null,
            resolvedByUid: null,
            resolvedByName: null,
            matchedInvoiceId: null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      } catch (err) {
        console.error(
          "Error matching/recording pulled transaction:",
          transactionId,
          err
        );
        errors.push({ transactionId, error: err.message });
      }
    }

    console.log(
      `Pull query: ${recovered.length} recovered, ${alreadyKnown.length} already known, ${errors.length} errors`
    );

    res.json({
      success: true,
      responseCode,
      responseMessage: response.data?.ResponseMessage,
      totalFetched: rawTransactions.length,
      recoveredCount: recovered.length,
      alreadyKnownCount: alreadyKnown.length,
      recoveredTransactionIds: recovered,
      errors,
    });
  } catch (err) {
    console.error("❌ Pull query error:");
    console.error(err.response?.data || err.message);

    res.status(err.response?.status || 500).json({
      success: false,
      error: err.response?.data || err.message,
    });
  }
});


// ============================================================
// PULL TRANSACTIONS API - CALLBACK
// ============================================================
//
// CallBackURL is a required field at registration time, but this
// integration always fetches transactions synchronously via the
// /api/mpesa/pull/query response above rather than waiting on a push.
// This endpoint just logs and acknowledges whatever Safaricom sends
// here so registration/delivery never fails for a missing endpoint.
//
// URL:
// POST /api/mpesa/pull/callback
//

router.post("/api/mpesa/pull/callback", (req, res) => {
  console.log("========== PULL TRANSACTIONS - CALLBACK ==========");
  console.log(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});

module.exports = router;
