const express = require("express");
const axios = require("axios");

const { admin, db } = require("../../firebase");
const { C2B_REGISTER_URL, OWN_SHORTCODE, MPESA_HTTP_TIMEOUT } = require("../config");
const { getMpesaAccessToken } = require("../services/mpesaAuth");
const { findInvoiceForC2B } = require("../services/invoiceMatcher");
const {
  recordMpesaPayment,
  tillPaymentMatchFields,
  findStkTransactionByReceipt,
} = require("../services/paymentRecorder");
const { resolveMsisdn, looksHashed } = require("../services/msisdnDecoder");
const {
  requestAccountBalanceQuietly,
} = require("../services/accountBalanceRequester");
const {
  fillCustomerPhoneFromInvoice,
} = require("../services/customerDirectory");
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
      // HASHED MSISDN
      // --------------------------------------------------------
      //
      // Safaricom sends a SHA-256 of the payer's number rather
      // than the number itself. Storing that in `phone` would put
      // 64 hex characters where the app expects something it can
      // text, so the hash goes in its own field and `phone` is
      // left empty until it is decoded. Decoding is a third-party
      // HTTP call and does not belong in front of the response to
      // Safaricom - it happens in the async block below, a moment
      // later, and updates this document in place.
      //
      const phoneIsHashed = looksHashed(MSISDN);

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
          phone: phoneIsHashed ? "" : MSISDN || "",
          phoneHash: phoneIsHashed ? String(MSISDN).toLowerCase() : "",
          phoneDecoded: !phoneIsHashed && !!MSISDN,
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

      // The Till has more money in it than it did a second ago, so
      // whatever balance the app is showing is now wrong. Asking here
      // rather than waiting for somebody to press "check balance" is the
      // difference between a figure that is current and one that is
      // whatever it was the last time anyone thought about it — and a stale
      // balance is worse than none, because it looks current.
      //
      // Deliberately not awaited and deliberately unable to throw: the
      // payment is already saved, Safaricom is already answered, and the
      // balance is a display concern. Bursts are collapsed inside
      // requestAccountBalanceQuietly — see the reasoning there.
      requestAccountBalanceQuietly(
        "Balance after Till payment " + TransID
      ).then((outcome) => {
        if (outcome !== "sent") {
          console.log("Balance check after " + TransID + ": " + outcome);
        }
      });

      (async () => {
        let firestoreResult = "unknown";
        let matchedInvoiceId = null;
        let phone = phoneIsHashed ? null : MSISDN || null;

        // ------------------------------------------------------
        // WAS THIS AN STK PUSH?
        // ------------------------------------------------------
        //
        // A Buy Goods payment made through an STK Push reaches us twice:
        // once as the STK callback, which records it against the invoice
        // the push was raised for, and once here. There is nothing for
        // this handler to work out about such a payment - the invoice was
        // chosen by the person who sent the push, and re-deriving it from
        // the amount and the payer's name can only ever disagree with
        // that. What is left to do is say on the Till payment where the
        // money went, so it stops reading as "no sale recorded", and let
        // the thank-you go out.
        //
        // See findStkTransactionByReceipt for why this is allowed to wait.
        const stk = await findStkTransactionByReceipt(TransID);

        if (stk && stk.phone) {
          // The STK side holds the payer's real number. Taking it saves a
          // decodehash call against a daily quota, and, more to the point,
          // guarantees the thank-you can be sent even on a day the quota
          // is spent.
          phone = String(stk.phone);
          try {
            await c2bRef.update({ phone, phoneDecoded: true });
          } catch (err) {
            console.error(
              "Could not copy the STK phone onto the Till payment:",
              err.message
            );
          }
        }

        if (stk && stk.invoiceId) {
          matchedInvoiceId = stk.invoiceId;

          try {
            const invoiceSnap = await db
              .collection("invoices")
              .doc(stk.invoiceId)
              .get();

            const invoiceNumber = invoiceSnap.exists
              ? invoiceSnap.data().invoiceNumber || ""
              : "";

            await c2bRef.update({
              ...tillPaymentMatchFields({
                invoice: { id: stk.invoiceId },
                amount,
                strategy: "stk_push",
                // The STK callback did the recording. Saying so here is
                // what makes tillPaymentMatchFields attribute the money
                // rather than reporting it unmatched.
                result: {
                  recorded: false,
                  reason: "already_recorded",
                  invoiceId: stk.invoiceId,
                  invoiceNumber,
                },
                source: "c2b",
              }),
              stkCheckoutRequestId: stk.id || null,
              // Overrides the auto-match wording: nothing was matched
              // here, and saying so keeps somebody from looking for a
              // matching rule that was never applied.
              matchedByName: "M-Pesa STK Push",
            });

            // The push went to a number somebody typed for this
            // customer, and it worked. If that customer has no number on
            // file, this is the best evidence there will ever be for one.
            await fillCustomerPhoneFromInvoice({
              invoiceId: stk.invoiceId,
              phone,
            });

            firestoreResult =
              "STK Push payment - already recorded on invoice " +
              stk.invoiceId +
              " by the STK callback, attributed here without re-matching";
          } catch (err) {
            console.error("Could not attribute the STK Till payment:", err);
            firestoreResult = "error: " + err.message;
          }

          console.log("========== C2B PAYMENT ==========");
          console.log("TransID:", TransID);
          console.log("Invoice/Reference:", matchedInvoiceId);
          console.log("Firestore result:", firestoreResult);
          return;
        }

        // An STK Push raised without an invoice behind it leaves the money
        // genuinely unattributed - nothing was recorded anywhere - so it
        // carries on through the ordinary matching below.

        // Done before matching so everything written below - the
        // invoice payment record, the unmatched_payments row - gets
        // the real number rather than the hash. A failure here is
        // ordinary: the daily decode quota can be spent, or the
        // number may not be in their table. Nothing downstream
        // depends on knowing it.
        if (phoneIsHashed && !phone) {
          try {
            phone = await resolveMsisdn(MSISDN);
            await c2bRef.update({
              phone: phone || "",
              phoneDecoded: !!phone,
            });
            console.log(
              phone
                ? "Payer MSISDN decoded from hash"
                : "Payer MSISDN could not be decoded - left blank"
            );
          } catch (err) {
            console.error("MSISDN decode failed:", err.message);
          }
        }

        try {
          const { invoice, strategy } = await findInvoiceForC2B({
            amount,
            customerName,
            // Safaricom's own time for the transaction, not the moment
            // this callback happened to arrive. A confirmation delayed by
            // a retry or an outage can turn up days late, and dating the
            // match from arrival would quietly widen the window by
            // exactly the length of the outage.
            paymentDate: parseMpesaTimestamp(TransTime) || new Date(),
          });

          if (invoice) {
            matchedInvoiceId = invoice.id;

            const result = await recordMpesaPayment({
              invoiceId: invoice.id,
              amount,
              receipt: TransID,
              phone: phone,
              transactionDate: TransTime,
              source: "c2b",
              extra: {
                transId: TransID,
                billRefNumber: BillRefNumber || "",
                businessShortCode:
                  BusinessShortCode || process.env.SHORTCODE,
              },
            });

            await c2bRef.update(
              tillPaymentMatchFields({
                invoice,
                amount,
                strategy,
                result,
                source: "c2b",
              })
            );

            // Matching is the moment this number and this customer are
            // asserted to be the same person. Until now the system knew a
            // payment came from 2547XXXXXXXX and, separately, that an
            // invoice was for Jane Wanjiku.
            //
            // Only fills a gap, never creates a customer, and cannot throw
            // - see customerDirectory.js. The money is already on the
            // invoice by this point either way.
            await fillCustomerPhoneFromInvoice({
              invoiceId: invoice.id,
              phone,
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
              customerPhone: phone || null,
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
