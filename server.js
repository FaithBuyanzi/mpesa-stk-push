require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { admin, db } = require("./firebase");
const { stkPush, stkQuery } = require("./mpesa");
const { buildSecurityCredential } = require("./security_credential");

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

const ACCOUNT_BALANCE_URL =
  `${MPESA_BASE_URL}/mpesa/accountbalance/v1/query`;

const PULL_REGISTER_URL =
  `${MPESA_BASE_URL}/pulltransactions/v1/register`;

const PULL_QUERY_URL =
  `${MPESA_BASE_URL}/pulltransactions/v1/query`;


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

// Parses Safaricom's "YYYYMMDDHHmmss" transaction timestamps (TransTime,
// Pull API trxDate) into a real Date. Returns null if the string isn't in
// that shape, so callers can fall back to FieldValue.serverTimestamp().
function parseMpesaTimestamp(str) {
  const s = String(str || "");

  if (!/^\d{14}$/.test(s)) {
    return null;
  }

  const year = s.slice(0, 4);
  const month = s.slice(4, 6);
  const day = s.slice(6, 8);
  const hour = s.slice(8, 10);
  const minute = s.slice(10, 12);
  const second = s.slice(12, 14);

  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`);
  return isNaN(date.getTime()) ? null : date;
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
  source, // "stk" | "c2b" | "pull"
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
          source === "pull"
            ? "M-Pesa Auto-Reconciliation (Pull API Recovery)"
            : source === "c2b"
            ? "M-Pesa Auto-Reconciliation (Till/C2B)"
            : "M-Pesa Auto-Reconciliation (STK Push)",
        reconciledAt: admin.firestore.FieldValue.serverTimestamp(),

        recordedByUid: "system",
        recordedByName:
          source === "pull"
            ? "M-Pesa Pull API"
            : source === "c2b"
            ? "M-Pesa C2B"
            : "M-Pesa STK Push",

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
// Push request, so there is no CheckoutRequestID to look up, and
// Safaricom does not reliably deliver a customer-entered
// account/reference for Buy Goods Till payments (BillRefNumber for
// Till is often just the payer's MSISDN or blank). So this reuses
// the exact same amount+name matching strategy the Flutter app
// already uses for Equity SMS reconciliation - see
// sms_payment_service.dart _matchInvoice / compute_isolates.dart
// matchInvoiceCompute, ported here 1:1 (same 0.01 balance-due
// tolerance, same Levenshtein-based name-similarity scoring, same
// 75-point strict threshold, same most-recent-invoice tie-break):
//
//   Rule 1: exact balance-due match against open (unpaid/
//      partiallyPaid) invoices -> disambiguate by name similarity.
//   Rule 2: no exact amount match (or amount match didn't clear the
//      name threshold) -> strict name-only match across ALL open
//      invoices.
//   Rule 3: nothing qualifies -> no match.
//
// Unlike the SMS flow, an unmatched C2B payment does NOT auto-create
// an invoice - it is saved in full to the `unmatched_payments`
// collection (the same shape as UnmatchedPayment.toFirestore() in
// lib/models/unmatched_payment.dart) for manual review, and no
// invoice is guessed.
//
const NAME_MATCH_MIN_SCORE = 75;

function normalizeNameForMatch(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ");
}

function levenshtein(s, t) {
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  let curr = new Array(t.length + 1).fill(0);

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;

    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }

    [prev, curr] = [curr, prev];
  }

  return prev[t.length];
}

function tokenSimilarity(a, b) {
  if (a === b) return 100;

  if (a.includes(b) || b.includes(a)) {
    const shorterLen = Math.min(a.length, b.length);
    const longerLen = Math.max(a.length, b.length);
    return Math.round(55 + (shorterLen / longerLen) * 45);
  }

  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);

  if (maxLen === 0) return 0;

  const similarity = (1 - dist / maxLen) * 100;
  return Math.round(Math.max(similarity, 0));
}

function nameSimilarity(a, b) {
  const tokensA = normalizeNameForMatch(a)
    .split(" ")
    .filter((t) => t.length >= 2);
  const tokensB = normalizeNameForMatch(b)
    .split(" ")
    .filter((t) => t.length >= 2);

  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  let total = 0;

  for (const tok of shorter) {
    let best = 0;

    for (const other of longer) {
      const score = tokenSimilarity(tok, other);
      if (score > best) best = score;
    }

    total += best;
  }

  return Math.round(total / shorter.length);
}

function pickBestNameMatch(paymentName, candidates, minScore) {
  if (!paymentName) return null;

  let bestScore = -1;
  let best = [];

  for (const c of candidates) {
    const score = nameSimilarity(paymentName, c.customerName || "");

    if (score > bestScore) {
      bestScore = score;
      best = [c];
    } else if (score === bestScore) {
      best.push(c);
    }
  }

  if (best.length === 0 || bestScore < minScore) return null;
  if (best.length === 1) return best[0];

  best.sort((a, b) => b.dateMillis - a.dateMillis);
  return best[0];
}

function matchInvoiceForPayment({ paymentName, paymentAmount, candidates }) {
  if (candidates.length === 0) return null;

  const exactAmountMatches = candidates.filter(
    (c) => Math.abs(c.balanceDue - paymentAmount) < 0.01
  );

  if (exactAmountMatches.length > 0) {
    const best = pickBestNameMatch(paymentName, exactAmountMatches, NAME_MATCH_MIN_SCORE);
    if (best) return best;
  }

  return pickBestNameMatch(paymentName, candidates, NAME_MATCH_MIN_SCORE);
}

async function findInvoiceForC2B({ amount, customerName }) {
  const openInvoices = await db
    .collection("invoices")
    .where("paymentStatus", "in", ["unpaid", "partiallyPaid"])
    .get();

  const candidates = openInvoices.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      doc,
      customerName: data.customerName || "",
      balanceDue:
        data.balanceDue != null
          ? data.balanceDue
          : (data.total || 0) - (data.amountPaid || 0),
      dateMillis: data.date ? data.date.toMillis() : 0,
    };
  });

  const matched = matchInvoiceForPayment({
    paymentName: customerName,
    paymentAmount: amount,
    candidates,
  });

  if (matched) {
    return { invoice: matched.doc, strategy: "sms_style_amount_and_name_match" };
  }

  return { invoice: null, strategy: "no_match" };
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

      // Confirmed with the account owner: this is the app's "own"
      // shortcode Safaricom authorizes it for. PARTY_B (4363881, the
      // Till customers pay to directly) is only used as the STK Push
      // payment destination, not for C2B registration - trying to
      // register against PARTY_B was rejected by Safaricom with
      // "400.003.02 Kindly use your own ShortCode". Updated from
      // 4363819 to 4363839 after Safaricom reassigned the shortcode.
      const shortCode =
        4363839;

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

app.post("/api/mpesa/pull/register", async (req, res) => {
  try {
    console.log("========== PULL TRANSACTIONS - REGISTER ==========");

    const shortCode = 4363839;
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
      timeout: 30000,
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

app.get("/api/mpesa/pull/query", async (req, res) => {
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

    const shortCode = 4363839;
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
      timeout: 30000,
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

app.post("/api/mpesa/pull/callback", (req, res) => {
  console.log("========== PULL TRANSACTIONS - CALLBACK ==========");
  console.log(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});


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

app.post("/api/mpesa/account-balance", async (req, res) => {
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

      timeout: 30000,
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

app.post("/api/mpesa/account-balance/result", async (req, res) => {
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

app.post("/api/mpesa/account-balance/timeout", async (req, res) => {
  console.error("========== ACCOUNT BALANCE TIMEOUT ==========");
  console.error(JSON.stringify(req.body, null, 2));

  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted",
  });
});


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