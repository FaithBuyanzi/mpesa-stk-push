const express = require("express");
const axios = require("axios");

const { admin, db } = require("../../firebase");
const { C2B_REGISTER_URL, OWN_SHORTCODE, MPESA_HTTP_TIMEOUT } = require("../config");
const { getMpesaAccessToken } = require("../services/mpesaAuth");
const { findInvoiceForC2B } = require("../services/invoiceMatcher");
const { recordMpesaPayment } = require("../services/paymentRecorder");
const { parseMpesaTimestamp } = require("../utils/mpesaDates");

const router = express.Router();

// ============================================================
// C2B V2 - REGISTER VALIDATION + CONFIRMATION URLS
// ============================================================
//
// This endpoint is called by YOU.
//
// It tells Safaricom:
// "Send C2B payment notifications to these URLs."
//
// You only need to register the URLs when necessary.
// Do NOT call this every time a customer pays.
//

router.post(
  "/api/c2b/register",
  async (req, res) => {
    try {
      console.log(
        "========== C2B V2 URL REGISTRATION =========="
      );

      // See OWN_SHORTCODE in src/config for why this is not PARTY_B.
      const shortCode = OWN_SHORTCODE;

      const validationURL =
        process.env.C2B_VALIDATION_URL;

      const confirmationURL =
        process.env.C2B_CONFIRMATION_URL;

      if (!shortCode) {
        return res.status(500).json({
          success: false,
          error: "SHORTCODE is not configured",
        });
      }

      if (!validationURL) {
        return res.status(500).json({
          success: false,
          error:
            "C2B_VALIDATION_URL is not configured",
        });
      }

      if (!confirmationURL) {
        return res.status(500).json({
          success: false,
          error:
            "C2B_CONFIRMATION_URL is not configured",
        });
      }

      console.log("ShortCode:", shortCode);
      console.log(
        "ValidationURL:",
        validationURL
      );
      console.log(
        "ConfirmationURL:",
        confirmationURL
      );

      // Get production OAuth token
      const accessToken =
        await getMpesaAccessToken();

      // C2B V2 registration payload
      const payload = {
        ShortCode: shortCode,

        // If validation endpoint is unavailable,
        // Safaricom completes the transaction.
        ResponseType: "Completed",

        ConfirmationURL:
          confirmationURL,

        ValidationURL:
          validationURL,
      };

      console.log(
        "C2B Registration Payload:",
        payload
      );

      const response =
        await axios.post(
          C2B_REGISTER_URL,
          payload,
          {
            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json",
            },

            timeout: MPESA_HTTP_TIMEOUT,
          }
        );

      console.log(
        "C2B Registration Response:",
        response.data
      );

      res.json({
        success: true,

        message:
          "C2B URLs registration request completed",

        data: response.data,
      });
    } catch (err) {
      console.error(
        "❌ C2B registration error:"
      );

      console.error(
        err.response?.data ||
        err.message
      );

      res.status(
        err.response?.status || 500
      ).json({
        success: false,

        error:
          err.response?.data ||
          err.message,
      });
    }
  }
);


// ============================================================
// C2B VALIDATION CALLBACK
// ============================================================
//
// Safaricom calls this BEFORE completing the C2B transaction
// when external validation is enabled.
//
// URL:
// /api/c2b/validation
//

router.post(
  "/api/c2b/validation",
  async (req, res) => {
    try {
      console.log(
        "========== C2B VALIDATION =========="
      );

      console.log(
        "C2B Validation Payload:",
        JSON.stringify(
          req.body,
          null,
          2
        )
      );

      const {
        TransactionType,
        TransID,
        TransTime,
        TransAmount,
        BusinessShortCode,
        BillRefNumber,
        InvoiceNumber,
        MSISDN,
        FirstName,
        MiddleName,
        LastName,
      } = req.body;

      console.log(
        "Transaction Type:",
        TransactionType
      );

      console.log(
        "Transaction ID:",
        TransID
      );

      console.log(
        "Amount:",
        TransAmount
      );

      console.log(
        "Business ShortCode:",
        BusinessShortCode
      );

      console.log(
        "Bill Reference:",
        BillRefNumber
      );

      console.log(
        "Invoice Number:",
        InvoiceNumber
      );

      console.log(
        "Phone:",
        MSISDN
      );

      console.log(
        "Customer:",
        `${FirstName || ""} ${
          MiddleName || ""
        } ${LastName || ""}`.trim()
      );

      // --------------------------------------------------------
      // IMPORTANT:
      //
      // For now we ACCEPT the transaction.
      //
      // If later you want to reject payments for invalid
      // invoices/customers, this is where that logic goes.
      // --------------------------------------------------------

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    } catch (err) {
      console.error(
        "C2B validation error:",
        err
      );

      // Because ResponseType is "Completed", Safaricom's
      // configured fallback behavior is completion if the
      // validation endpoint cannot be reached.
      //
      // We still return an accepted response when our server
      // successfully receives the request but encounters
      // an internal handling problem.
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }
  }
);


// ============================================================
// C2B CONFIRMATION CALLBACK
// ============================================================
//
// Safaricom calls this AFTER a C2B transaction.
//
// This is the important endpoint for your Selete Agro system.
//
// URL:
// /api/c2b/confirmation
//

router.post(
  "/api/c2b/confirmation",
  async (req, res) => {
    let responded = false;

    try {
      const {
        TransactionType,
        TransID,
        TransTime,
        TransAmount,
        BusinessShortCode,
        BillRefNumber,
        InvoiceNumber,
        OrgAccountBalance,
        ThirdPartyTransID,
        MSISDN,
        FirstName,
        MiddleName,
        LastName,
      } = req.body;

      const customerName = `${FirstName || ""} ${
        MiddleName || ""
      } ${LastName || ""}`.trim();

      console.log("========== C2B PAYMENT ==========");
      console.log("TransID:", TransID);
      console.log("TransTime:", TransTime);
      console.log("Amount:", TransAmount);
      console.log("MSISDN:", MSISDN);
      console.log("BillRefNumber:", BillRefNumber);
      console.log("BusinessShortCode:", BusinessShortCode);

      // --------------------------------------------------------
      // BASIC VALIDATION
      // --------------------------------------------------------
      //
      // NOTE: this is the CONFIRMATION callback - Safaricom has
      // already completed the transaction by the time it calls
      // this endpoint. A non-zero ResultCode here does NOT reverse
      // the payment; it only tells Safaricom our system didn't
      // acknowledge it, which just causes pointless retries. So we
      // always return ResultCode 0 from this endpoint and instead
      // rely on our own logs/Firestore records to flag problems.
      //
      if (!TransID || !TransAmount) {
        console.error(
          "C2B confirmation missing TransID or TransAmount - cannot process, but acknowledging so Safaricom does not retry indefinitely"
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted",
        });
      }

      const amount = parseFloat(TransAmount);
      const c2bRef = db.collection("c2b_transactions").doc(TransID);

      // --------------------------------------------------------
      // ATOMIC DUPLICATE CHECK
      // --------------------------------------------------------
      //
      // Safaricom may retry this callback. .create() fails with
      // ALREADY_EXISTS if the doc is already there, so this is a
      // single atomic check-and-write instead of a get() + set()
      // (which has a race window between the two calls).
      //
      try {
        await c2bRef.create({
          transactionType: TransactionType || "Pay Bill",
          mpesaReceiptNumber: TransID,
          transactionId: TransID,
          transactionTime: TransTime || null,
          amount,
          // Fallback only - Safaricom always sends this in practice.
          businessShortCode:
            BusinessShortCode ||
            process.env.C2B_SHORTCODE ||
            process.env.SHORTCODE,
          billRefNumber: BillRefNumber || "",
          invoiceNumber: InvoiceNumber || "",
          organizationAccountBalance: OrgAccountBalance || "",
          thirdPartyTransactionId: ThirdPartyTransID || "",
          phone: MSISDN || "",
          firstName: FirstName || "",
          middleName: MiddleName || "",
          lastName: LastName || "",
          customerName,
          paymentMethod: "mpesa_c2b",
          source: "Safaricom C2B v2",
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
          console.log(
            "⚠️ C2B transaction already exists - duplicate callback:",
            TransID
          );

          return res.json({
            ResultCode: 0,
            ResultDesc: "Accepted",
          });
        }

        throw err;
      }

      // Respond to Safaricom immediately once the payment is durably
      // saved - invoice matching/recording continues below without
      // making Safaricom wait for it.
      res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
      responded = true;

      (async () => {
        let firestoreResult = "unknown";
        let matchedInvoiceId = null;

        try {
          const { invoice, strategy } = await findInvoiceForC2B({
            amount,
            customerName,
          });

          if (invoice) {
            matchedInvoiceId = invoice.id;

            const result = await recordMpesaPayment({
              invoiceId: invoice.id,
              amount,
              receipt: TransID,
              phone: MSISDN,
              transactionDate: TransTime,
              source: "c2b",
              extra: {
                transId: TransID,
                billRefNumber: BillRefNumber || "",
                businessShortCode:
                  BusinessShortCode || process.env.SHORTCODE,
              },
            });

            await c2bRef.update({
              matched: !!result.recorded,
              matchedInvoiceId: invoice.id,
              matchStrategy: strategy,
            });

            firestoreResult = result.recorded
              ? `matched invoice ${invoice.id} via ${strategy}, invoice updated`
              : `matched invoice ${invoice.id} via ${strategy}, but not recorded (${result.reason})`;
          } else {
            await c2bRef.update({ matched: false, matchStrategy: strategy });

            // No confident invoice match (same amount+name logic as the
            // SMS flow) - unlike the SMS flow, this does NOT auto-create
            // an invoice. The full payment is saved to unmatched_payments
            // (same shape as UnmatchedPayment.toFirestore() in
            // lib/models/unmatched_payment.dart) for manual review.
            await db.collection("unmatched_payments").add({
              rawSms: `C2B Till payment - TransID: ${TransID}, BusinessShortCode: ${
                BusinessShortCode || process.env.SHORTCODE || ""
              }, BillRef: ${BillRefNumber || "none"}`,
              customerName: customerName || null,
              customerPhone: MSISDN || null,
              amount,
              reference: TransID,
              transactionDate: admin.firestore.Timestamp.fromDate(
                parseMpesaTimestamp(TransTime) || new Date()
              ),
              reason: `No matching open invoice found (${strategy})`,
              resolved: false,
              resolvedAt: null,
              resolvedByUid: null,
              resolvedByName: null,
              matchedInvoiceId: null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            firestoreResult = `unmatched (${strategy}) - saved to unmatched_payments for manual review`;
          }
        } catch (err) {
          console.error("❌ C2B async matching/recording error:", err);
          firestoreResult = `error: ${err.message}`;

          try {
            await c2bRef.update({
              matched: false,
              matchStrategy: "error",
              processingError: err.message,
            });
          } catch (_) {}
        }

        console.log("========== C2B PAYMENT ==========");
        console.log("TransID:", TransID);
        console.log("Invoice/Reference:", matchedInvoiceId || "none");
        console.log("Firestore result:", firestoreResult);
      })();
    } catch (err) {
      console.error("❌ C2B confirmation error:", err);

      if (!responded) {
        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted",
        });
      }
    }
  }
);

module.exports = router;
