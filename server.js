require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { admin, db } = require("./firebase");
const { stkPush, stkQuery } = require("./mpesa");

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = process.env.PORT || 3000;

const MPESA_BASE_URL =
  process.env.MPESA_BASE_URL || "https://api.safaricom.co.ke";

const MPESA_OAUTH_URL =
  `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`;

const C2B_REGISTER_URL =
  `${MPESA_BASE_URL}/mpesa/c2b/v2/registerurl`;


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${req.path}`
  );
  next();
});


// ============================================================
// HEALTH CHECK
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
  });
});


// ============================================================
// TEST FIRESTORE CONNECTION
// ============================================================

app.get("/test-firestore", async (req, res) => {
  try {
    const docRef = await db.collection("test").add({
      message: "Hello from Render!",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      documentId: docRef.id,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// ============================================================
// VALIDATE STK PUSH INPUT
// ============================================================

function validatePaymentRequest(req, res, next) {
  const { phone, amount } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      error: "Phone number and amount are required",
    });
  }

  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "Amount must be a positive number",
    });
  }

  // Match Flutter app validation:
  // 2547XXXXXXXX or 2541XXXXXXXX
  const phoneRegex = /^254(7|1)[0-9]{8}$/;

  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number. Use format: 254712345678",
    });
  }

  next();
}


// ============================================================
// STK PUSH
// ============================================================

app.post(
  "/api/mpesa/pay",
  validatePaymentRequest,
  async (req, res) => {
    try {
      const {
        phone,
        amount,
        invoiceId,
        recordedByUid,
      } = req.body;

      console.log("========== STK PUSH ==========");
      console.log("Phone:", phone);
      console.log("Amount:", amount);
      console.log("Invoice ID:", invoiceId);
      console.log("Recorded By UID:", recordedByUid);

      console.log("========== MPESA CONFIG ==========");
      console.log("BASE_URL:", process.env.BASE_URL);
      console.log("SHORTCODE:", process.env.SHORTCODE);
      console.log("CALLBACK_URL:", process.env.CALLBACK_URL);
      console.log(
        "TransactionType:",
        "CustomerBuyGoodsOnline"
      );

      // Generate meaningful account reference
      const accountReference = invoiceId
        ? `INV-${invoiceId}`
        : "SELE-AGRO";

      const description = invoiceId
        ? `Payment for invoice ${invoiceId}`
        : "Selete Agro payment";

      const result = await stkPush({
        phone,
        amount,
        accountReference,
        description,
      });

      // Store transaction with invoice linkage
      const transactionData = {
        status: "pending",
        phone,
        amount: parseFloat(amount),
        checkoutRequestID: result.CheckoutRequestID,
        merchantRequestID: result.MerchantRequestID,
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      if (invoiceId) {
        transactionData.invoiceId = invoiceId;
      }

      if (recordedByUid) {
        transactionData.recordedByUid = recordedByUid;
      }

      await db
        .collection("transactions")
        .doc(result.CheckoutRequestID)
        .set(transactionData);

      console.log(
        "Transaction created:",
        result.CheckoutRequestID
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (err) {
      console.error(
        "STK Push error:",
        err.response?.data || err.message
      );

      res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  }
);


// ============================================================
// QUERY STK TRANSACTION STATUS
// ============================================================

app.post("/api/mpesa/query", async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;

    if (!checkoutRequestId) {
      return res.status(400).json({
        success: false,
        error: "checkoutRequestId is required",
      });
    }

    console.log(
      "========== QUERY TRANSACTION =========="
    );

    console.log(
      "CheckoutRequestID:",
      checkoutRequestId
    );

    const result = await stkQuery(checkoutRequestId);

    console.log("Query result:", result);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error(
      "Query error:",
      err.response?.data || err.message
    );

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// ============================================================
// AUTO-RECORD STK PAYMENT TO INVOICE
// ============================================================

// Safaricom's STK callback never hands us the free-text SMS a
// customer receives - only structured fields (amount, receipt,
// phone, transaction date). Build a confirmation-style message
// out of those real fields instead of just echoing the receipt.
function formatMpesaTransactionDate(transactionDate) {
  const str = String(transactionDate || "");

  if (str.length !== 14) {
    return null;
  }

  const day = str.slice(6, 8);
  const month = str.slice(4, 6);
  const year = str.slice(0, 4);
  const hour24 = parseInt(str.slice(8, 10), 10);
  const minute = str.slice(10, 12);

  const meridiem = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${day}/${month}/${year} ${hour12}:${minute} ${meridiem}`;
}

function buildMpesaConfirmationMessage({
  receipt,
  amount,
  phone,
  transactionDate,
  invoiceNumber,
}) {
  const formattedDate = formatMpesaTransactionDate(transactionDate);
  const formattedAmount = Number(amount).toFixed(2);

  let message = `${receipt} Confirmed. Ksh${formattedAmount} received`;

  if (phone) {
    message += ` from ${phone}`;
  }

  if (formattedDate) {
    message += ` on ${formattedDate}`;
  }

  message += ".";

  if (invoiceNumber) {
    message += ` Applied to invoice ${invoiceNumber}.`;
  }

  return message;
}

// ============================================================
// SHARED PAYMENT RECORDING (used by BOTH the STK callback and
// the C2B confirmation handler)
// ============================================================
//
// IMPORTANT: paymentStatus values MUST match the Flutter
// PaymentStatus enum's .name exactly ("unpaid" / "partiallyPaid"
// / "paid"). This previously wrote "partially_paid" (snake_case),
// which the app's PaymentStatus.fromName() silently fails to
// match and falls back to "unpaid" - so a payment could be fully
// recorded (amountPaid updated, receipt saved) while the invoice
// still displayed as Unpaid in the app. That was a real,
// confirmed bug affecting every partially-paid STK/C2B payment.
//
async function recordMpesaPayment({
  invoiceId,
  amount,
  receipt,
  phone,
  transactionDate,
  source, // "stk" | "c2b"
  extra = {},
}) {
  if (!invoiceId) {
    console.log(
      "No invoiceId available - skipping invoice auto-record (payment is still saved in " +
        (source === "c2b" ? "c2b_transactions" : "transactions") +
        ")"
    );

    return { recorded: false, reason: "no_invoice_id" };
  }

  const invoiceRef = db.collection("invoices").doc(invoiceId);

  let outcome = { recorded: false, reason: "unknown" };

  try {
    // Firestore transaction prevents double-counting when Safaricom
    // retries a callback (re-reads the invoice fresh on every attempt).
    await db.runTransaction(async (transaction) => {
      const invoiceDoc = await transaction.get(invoiceRef);

      if (!invoiceDoc.exists) {
        console.error("Invoice not found:", invoiceId);
        outcome = { recorded: false, reason: "invoice_not_found" };
        return;
      }

      const invoiceData = invoiceDoc.data();
      const existingPayments = invoiceData.payments || [];

      // Idempotency guard #2: even if the STK/C2B-level dedupe check
      // was bypassed somehow, never apply the same M-Pesa receipt to
      // an invoice twice.
      const alreadyRecorded = existingPayments.some(
        (p) => p.reference === receipt
      );

      if (alreadyRecorded) {
        console.log(
          "Receipt already recorded on this invoice - skipping duplicate:",
          receipt
        );
        outcome = { recorded: false, reason: "duplicate_receipt" };
        return;
      }

      const currentAmountPaid = invoiceData.amountPaid || 0;
      const newAmountPaid = currentAmountPaid + amount;
      const total = invoiceData.total;

      let paymentStatus = "unpaid";

      if (newAmountPaid >= total) {
        paymentStatus = "paid";
      } else if (newAmountPaid > 0) {
        paymentStatus = "partiallyPaid";
      }

      // Create reconciliation record
      const reconciliationRef = db
        .collection("payment_reconciliations")
        .doc();

      transaction.set(reconciliationRef, {
        invoiceId,
        invoiceNumber: invoiceData.invoiceNumber,
        customerName: invoiceData.customerName,

        paymentMethod: "mpesa",
        amount,
        referenceCode: receipt,

        message: buildMpesaConfirmationMessage({
          receipt,
          amount,
          phone,
          transactionDate,
          invoiceNumber: invoiceData.invoiceNumber,
        }),

        depositDate: admin.firestore.FieldValue.serverTimestamp(),

        reconciled: true,
        reconciledByUid: "system",
        reconciledByName:
          source === "c2b"
            ? "M-Pesa Auto-Reconciliation (Till/C2B)"
            : "M-Pesa Auto-Reconciliation (STK Push)",
        reconciledAt: admin.firestore.FieldValue.serverTimestamp(),

        recordedByUid: "system",
        recordedByName:
          source === "c2b" ? "M-Pesa C2B" : "M-Pesa STK Push",

        source,
        ...extra,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const newPayment = {
        reference: receipt,
        amount,
        date: new Date(),
        paymentMethod: "mpesa",
      };

      transaction.update(invoiceRef, {
        amountPaid: newAmountPaid,
        paymentStatus,
        mpesaReceiptNumber: receipt,
        ...(extra.checkoutRequestID
          ? { mpesaCheckoutRequestId: extra.checkoutRequestID }
          : {}),
        paymentDate: admin.firestore.FieldValue.serverTimestamp(),
        payments: [...existingPayments, newPayment],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      outcome = {
        recorded: true,
        newAmountPaid,
        paymentStatus,
        invoiceNumber: invoiceData.invoiceNumber,
      };
    });

    if (outcome.recorded) {
      console.log("✅ Auto-recorded payment for invoice:", invoiceId);
      console.log("   Amount: KSh", amount);
      console.log("   New amount paid: KSh", outcome.newAmountPaid);
      console.log("   Status:", outcome.paymentStatus);
    }

    return outcome;
  } catch (err) {
    console.error("Error auto-recording payment:", err);
    return { recorded: false, reason: "error", error: err.message };
  }
}

// ============================================================
// C2B INVOICE MATCHING
// ============================================================
//
// A C2B (Till/Buy Goods) payment does NOT originate from an STK
// Push request, so there is no CheckoutRequestID to look up - the
// "transactions" collection (keyed by CheckoutRequestID) is not
// usable here. Safaricom also does not reliably deliver a
// customer-entered account/reference for Buy Goods Till payments
// the way it does for Paybill (BillRefNumber for Till is often
// just the payer's MSISDN or blank).
//
// Matching strategy, in order:
//   1. BillRefNumber looks like an explicit invoice reference
//      (e.g. "INV-<firestoreDocId>", matching the AccountReference
//      the app sends on STK Push) -> direct doc lookup, or exact
//      match against the invoice's invoiceNumber field.
//   2. Exact balance-due match against open (unpaid/partiallyPaid)
//      invoices - mirrors the amount-first matching strategy the
//      Flutter app already uses for Equity SMS reconciliation
//      (see sms_payment_service.dart _matchInvoice).
//   3. If more than one invoice has that exact balance due, narrow
//      by comparing the payer's MSISDN against the invoice's
//      customerPhone.
//   4. Otherwise: no confident match. The raw payment is still
//      saved (c2b_transactions) and a flagged, unreconciled
//      payment_reconciliations entry is created so it shows up in
//      the app's existing Reconciliation screen for manual review
//      - it is never silently dropped, and no invoice is guessed.
//
function normalizePhoneForMatch(phone) {
  if (!phone) return "";
  const digits = String(phone).replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

async function findInvoiceForC2B({ billRefNumber, amount, msisdn }) {
  const ref = (billRefNumber || "").trim();

  if (ref) {
    if (/^INV-/i.test(ref)) {
      const candidateId = ref.replace(/^INV-/i, "").trim();

      if (candidateId) {
        const doc = await db.collection("invoices").doc(candidateId).get();

        if (doc.exists) {
          return { invoice: doc, strategy: "billRefNumber_docId" };
        }
      }
    }

    const byNumber = await db
      .collection("invoices")
      .where("invoiceNumber", "==", ref)
      .limit(2)
      .get();

    if (byNumber.size === 1) {
      return { invoice: byNumber.docs[0], strategy: "billRefNumber_invoiceNumber" };
    }
  }

  const openInvoices = await db
    .collection("invoices")
    .where("paymentStatus", "in", ["unpaid", "partiallyPaid"])
    .get();

  const amountCandidates = openInvoices.docs.filter((doc) => {
    const data = doc.data();
    const balanceDue = (data.total || 0) - (data.amountPaid || 0);
    return Math.abs(balanceDue - amount) < 0.5;
  });

  if (amountCandidates.length === 1) {
    return { invoice: amountCandidates[0], strategy: "amount" };
  }

  if (amountCandidates.length > 1 && msisdn) {
    const normalizedMsisdn = normalizePhoneForMatch(msisdn);

    const phoneNarrowed = amountCandidates.filter((doc) => {
      const phone = doc.data().customerPhone;
      return phone && normalizePhoneForMatch(phone) === normalizedMsisdn;
    });

    if (phoneNarrowed.length === 1) {
      return { invoice: phoneNarrowed[0], strategy: "amount_and_phone" };
    }
  }

  return {
    invoice: null,
    strategy: amountCandidates.length > 1 ? "ambiguous" : "no_match",
  };
}


// ============================================================
// STK PUSH CALLBACK
// ============================================================
//
// IMPORTANT:
// This endpoint is ONLY for STK Push.
//
// URL:
// https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/callback
//
// Do NOT use this endpoint for C2B.
//

app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const callback =
      req.body.Body?.stkCallback;

    if (!callback) {
      console.error(
        "Invalid STK callback payload:",
        JSON.stringify(req.body)
      );

      return res.json({
        ResultCode: 1,
        ResultDesc: "Invalid STK callback payload",
      });
    }

    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
    } = callback;

    console.log("========== STK CALLBACK ==========");

    console.log(
      "CheckoutRequestID:",
      CheckoutRequestID
    );

    console.log(
      "ResultCode:",
      ResultCode
    );

    console.log(
      "ResultDesc:",
      ResultDesc
    );

    // Validate transaction exists
    const txDoc = await db
      .collection("transactions")
      .doc(CheckoutRequestID)
      .get();

    if (!txDoc.exists) {
      console.error(
        "Invalid CheckoutRequestID - transaction not found:",
        CheckoutRequestID
      );

      return res.json({
        ResultCode: 1,
        ResultDesc: "Invalid transaction",
      });
    }

    const txData = txDoc.data();

    console.log(
      "Transaction found - Invoice ID:",
      txData.invoiceId
    );

    // Idempotency check
    if (txData.status === "success") {
      console.log(
        "Transaction already processed - skipping duplicate callback"
      );

      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    if (ResultCode === 0) {
      // Guard against missing metadata
      if (
        !callback.CallbackMetadata ||
        !callback.CallbackMetadata.Item
      ) {
        console.error(
          "CallbackMetadata missing from successful callback"
        );

        return res.status(500).json({
          ResultCode: 1,
          ResultDesc: "Error",
        });
      }

      const items =
        callback.CallbackMetadata.Item;

      const amount = items.find(
        (i) => i.Name === "Amount"
      )?.Value;

      const receipt = items.find(
        (i) =>
          i.Name === "MpesaReceiptNumber"
      )?.Value;

      const phone = items.find(
        (i) => i.Name === "PhoneNumber"
      )?.Value;

      const transactionDate = items.find(
        (i) =>
          i.Name === "TransactionDate"
      )?.Value;

      const callbackAmount =
        parseFloat(amount);

      // Validate amount
      if (
        callbackAmount &&
        txData.amount &&
        callbackAmount !== txData.amount
      ) {
        console.error(
          "Amount mismatch - Expected:",
          txData.amount,
          "Got:",
          callbackAmount
        );
      }

      // Validate phone. Safaricom's callback returns PhoneNumber as a
      // number, while txData.phone was stored as the string from the
      // original request body - compare as strings so a genuinely
      // identical phone number never logs as a false "mismatch".
      if (
        phone &&
        txData.phone &&
        String(phone) !== String(txData.phone)
      ) {
        console.error(
          "Phone mismatch - Expected:",
          txData.phone,
          "Got:",
          phone
        );
      }

      await db
        .collection("transactions")
        .doc(CheckoutRequestID)
        .update({
          status: "success",

          amount:
            callbackAmount || txData.amount,

          receipt,

          phone:
            phone || txData.phone,

          transactionDate,

          completedAt:
            admin.firestore.FieldValue.serverTimestamp(),

          validated: true,
        });

      const finalAmount = callbackAmount || txData.amount;
      const finalPhone = phone || txData.phone;

      console.log("========== STK PAYMENT ==========");
      console.log("CheckoutRequestID:", CheckoutRequestID);
      console.log("Invoice:", txData.invoiceId || "N/A");
      console.log("Amount:", finalAmount);
      console.log("Phone:", finalPhone);
      console.log("M-PESA Receipt:", receipt);
      console.log("ResultCode:", ResultCode);

      // Respond to Safaricom immediately - it expects a fast ack and
      // will retry the callback if this handler is slow. The invoice
      // write (Firestore transaction + reconciliation record) is not
      // needed to acknowledge the callback, so it runs after we've
      // already responded.
      res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });

      recordMpesaPayment({
        invoiceId: txData.invoiceId,
        amount: finalAmount,
        receipt,
        phone: finalPhone,
        transactionDate,
        source: "stk",
        extra: { checkoutRequestID: CheckoutRequestID },
      }).catch((err) =>
        console.error("Error auto-recording STK payment:", err)
      );

      return;
    } else {
      await db
        .collection("transactions")
        .doc(CheckoutRequestID)
        .update({
          status: "failed",

          resultCode: ResultCode,

          resultDesc: ResultDesc,

          completedAt:
            admin.firestore.FieldValue.serverTimestamp(),
        });

      console.log("========== STK PAYMENT ==========");
      console.log("CheckoutRequestID:", CheckoutRequestID);
      console.log("Invoice:", txData.invoiceId || "N/A");
      console.log("Amount:", txData.amount);
      console.log("Phone:", txData.phone);
      console.log("M-PESA Receipt: N/A");
      console.log("ResultCode:", ResultCode, "-", ResultDesc);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (err) {
    console.error(
      "STK Callback error:",
      err
    );

    res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Error",
    });
  }
});


// ============================================================
// GET SAFARICOM PRODUCTION ACCESS TOKEN
// ============================================================

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

      timeout: 30000,
    }
  );

  if (!response.data?.access_token) {
    throw new Error(
      "Safaricom did not return an access token"
    );
  }

  return response.data.access_token;
}


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

app.post(
  "/api/c2b/register",
  async (req, res) => {
    try {
      console.log(
        "========== C2B V2 URL REGISTRATION =========="
      );

      // IMPORTANT: C2B validation/confirmation fires based on which
      // shortcode the money actually lands on. For a Buy Goods Till,
      // that's PARTY_B (the till number customers pay to directly) -
      // NOT SHORTCODE, which is the separate "Lipa Na M-Pesa Online"
      // shortcode used only for STK Push password/auth. Registering
      // against SHORTCODE means Safaricom never calls our validation/
      // confirmation URLs for a real Till payment. C2B_SHORTCODE lets
      // this be overridden explicitly if the two are ever the same
      // shortcode (Paybill-style setups) or the till changes.
      const shortCode =
        process.env.C2B_SHORTCODE || process.env.PARTY_B;

      const validationURL =
        process.env.C2B_VALIDATION_URL;

      const confirmationURL =
        process.env.C2B_CONFIRMATION_URL;

      if (!shortCode) {
        return res.status(500).json({
          success: false,
          error:
            "C2B_SHORTCODE/PARTY_B is not configured - this must be the actual Till number customers pay to",
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

            timeout: 30000,
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

app.post(
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

app.post(
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
          // Defaults to the Till (PARTY_B), not the STK-only SHORTCODE,
          // since that's what a real C2B payment actually landed on.
          businessShortCode:
            BusinessShortCode ||
            process.env.C2B_SHORTCODE ||
            process.env.PARTY_B,
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
            billRefNumber: BillRefNumber,
            amount,
            msisdn: MSISDN,
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

            // Never silently drop an unmatched payment: flag it in the
            // same payment_reconciliations collection the app's existing
            // Reconciliation screen already displays, so staff can find
            // and manually link it to the right invoice.
            await db.collection("payment_reconciliations").add({
              invoiceId: "",
              invoiceNumber: "UNMATCHED",
              customerName: customerName || "Unknown",
              paymentMethod: "mpesa",
              amount,
              referenceCode: TransID,
              message: `Unmatched Till/C2B payment (${strategy}). BillRef: ${
                BillRefNumber || "N/A"
              }, Phone: ${MSISDN || "N/A"}.`,
              depositDate: admin.firestore.FieldValue.serverTimestamp(),
              reconciled: false,
              flagged: true,
              reviewNote:
                "Auto-received C2B/Till payment could not be matched to an invoice automatically. Please match manually.",
              recordedByUid: "system",
              recordedByName: "M-Pesa C2B",
              source: "c2b",
              transId: TransID,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            firestoreResult = `unmatched (${strategy}) - flagged in payment_reconciliations for manual review`;
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


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      "Environment:",
      process.env.NODE_ENV || "production"
    );

    console.log(
      "C2B Register URL:",
      C2B_REGISTER_URL
    );

    console.log(
      "C2B Validation URL:",
      process.env.C2B_VALIDATION_URL
    );

    console.log(
      "C2B Confirmation URL:",
      process.env.C2B_CONFIRMATION_URL
    );
  }
);