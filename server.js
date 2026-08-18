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

async function autoRecordPayment(
  txData,
  amount,
  receipt
) {
  if (!txData.invoiceId) {
    console.log(
      "No invoiceId linked to transaction - skipping auto-record"
    );

    return;
  }

  try {
    const invoiceRef = db
      .collection("invoices")
      .doc(txData.invoiceId);

    // Firestore transaction prevents double-counting
    // when Safaricom retries a callback.
    await db.runTransaction(async (transaction) => {
      const invoiceDoc =
        await transaction.get(invoiceRef);

      if (!invoiceDoc.exists) {
        console.error(
          "Invoice not found:",
          txData.invoiceId
        );

        return;
      }

      const invoiceData = invoiceDoc.data();

      const currentAmountPaid =
        invoiceData.amountPaid || 0;

      const newAmountPaid =
        currentAmountPaid + amount;

      const total = invoiceData.total;

      let paymentStatus = "unpaid";

      if (newAmountPaid >= total) {
        paymentStatus = "paid";
      } else if (newAmountPaid > 0) {
        paymentStatus = "partially_paid";
      }

      // Create reconciliation record
      const reconciliationRef = db
        .collection("payment_reconciliations")
        .doc();

      transaction.set(reconciliationRef, {
        invoiceId: txData.invoiceId,
        invoiceNumber: invoiceData.invoiceNumber,
        customerName: invoiceData.customerName,

        paymentMethod: "mpesa",

        amount: amount,

        referenceCode: receipt,

        message: `M-Pesa STK Push - ${receipt}`,

        depositDate:
          admin.firestore.FieldValue.serverTimestamp(),

        reconciled: true,

        reconciledByUid: "system",
        reconciledByName:
          "M-Pesa Auto-Reconciliation",

        reconciledAt:
          admin.firestore.FieldValue.serverTimestamp(),

        recordedByUid: "system",
        recordedByName: "M-Pesa STK Push",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update invoice
      const existingPayments =
        invoiceData.payments || [];

      const newPayment = {
        reference: receipt,
        amount: amount,
        date: new Date(),
        paymentMethod: "mpesa",
      };

      transaction.update(invoiceRef, {
        amountPaid: newAmountPaid,

        paymentStatus: paymentStatus,

        mpesaReceiptNumber: receipt,

        mpesaCheckoutRequestId:
          txData.checkoutRequestID,

        paymentDate:
          admin.firestore.FieldValue.serverTimestamp(),

        payments: [
          ...existingPayments,
          newPayment,
        ],

        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log(
        "✅ Auto-recorded payment for invoice:",
        txData.invoiceId
      );

      console.log(
        "   Amount: KSh",
        amount
      );

      console.log(
        "   New amount paid: KSh",
        newAmountPaid
      );

      console.log(
        "   Status:",
        paymentStatus
      );
    });
  } catch (err) {
    console.error(
      "Error auto-recording payment:",
      err
    );
  }
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

      // Validate phone
      if (
        phone &&
        txData.phone &&
        phone !== txData.phone
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

      console.log(
        "✅ STK Payment successful:",
        receipt
      );

      console.log(
        "   Invoice ID:",
        txData.invoiceId || "N/A"
      );

      await autoRecordPayment(
        txData,
        callbackAmount || txData.amount,
        receipt
      );
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

      console.log(
        "❌ STK Payment failed:",
        ResultDesc
      );
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

      const shortCode =
        process.env.SHORTCODE;

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
    try {
      console.log(
        "========== C2B CONFIRMATION =========="
      );

      console.log(
        "C2B Confirmation Payload:",
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
        OrgAccountBalance,
        ThirdPartyTransID,
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
        "M-PESA Receipt:",
        TransID
      );

      console.log(
        "Amount:",
        TransAmount
      );

      console.log(
        "Bill Reference:",
        BillRefNumber
      );

      console.log(
        "Phone:",
        MSISDN
      );

      console.log(
        "Transaction Time:",
        TransTime
      );

      console.log(
        "Customer:",
        `${FirstName || ""} ${
          MiddleName || ""
        } ${LastName || ""}`.trim()
      );


      // --------------------------------------------------------
      // BASIC VALIDATION
      // --------------------------------------------------------

      if (!TransID) {
        console.error(
          "C2B confirmation missing TransID"
        );

        return res.json({
          ResultCode: 1,
          ResultDesc:
            "Missing transaction ID",
        });
      }

      if (!TransAmount) {
        console.error(
          "C2B confirmation missing TransAmount"
        );

        return res.json({
          ResultCode: 1,
          ResultDesc:
            "Missing transaction amount",
        });
      }


      // --------------------------------------------------------
      // DUPLICATE CHECK
      // --------------------------------------------------------
      //
      // Safaricom may retry callbacks.
      // We don't want the same payment saved twice.
      //

      const existingPayment =
        await db
          .collection("c2b_transactions")
          .doc(TransID)
          .get();

      if (existingPayment.exists) {
        console.log(
          "⚠️ C2B transaction already exists:",
          TransID
        );

        return res.json({
          ResultCode: 0,
          ResultDesc: "Accepted",
        });
      }


      // --------------------------------------------------------
      // SAVE C2B TRANSACTION TO FIRESTORE
      // --------------------------------------------------------

      const c2bTransaction = {
        transactionType:
          TransactionType || "Pay Bill",

        mpesaReceiptNumber:
          TransID,

        transactionId:
          TransID,

        transactionTime:
          TransTime || null,

        amount:
          parseFloat(TransAmount),

        businessShortCode:
          BusinessShortCode ||
          process.env.SHORTCODE,

        billRefNumber:
          BillRefNumber || "",

        invoiceNumber:
          InvoiceNumber || "",

        organizationAccountBalance:
          OrgAccountBalance || "",

        thirdPartyTransactionId:
          ThirdPartyTransID || "",

        phone:
          MSISDN || "",

        firstName:
          FirstName || "",

        middleName:
          MiddleName || "",

        lastName:
          LastName || "",

        customerName:
          `${FirstName || ""} ${
            MiddleName || ""
          } ${LastName || ""}`.trim(),

        paymentMethod:
          "mpesa_c2b",

        source:
          "Safaricom C2B v2",

        status:
          "confirmed",

        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),

        receivedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };


      await db
        .collection("c2b_transactions")
        .doc(TransID)
        .set(c2bTransaction);


      console.log(
        "✅ C2B TRANSACTION SAVED TO FIRESTORE"
      );

      console.log(
        "   M-PESA Code:",
        TransID
      );

      console.log(
        "   Amount: KSh",
        TransAmount
      );

      console.log(
        "   Phone:",
        MSISDN
      );

      console.log(
        "   Reference:",
        BillRefNumber
      );


      // --------------------------------------------------------
      // OPTIONAL INVOICE MATCHING
      // --------------------------------------------------------
      //
      // If BillRefNumber contains an invoice ID/reference,
      // you can later automatically link this payment to
      // your invoice.
      //
      // Example:
      //
      // INV-12345
      //
      // For now we only save the C2B transaction.
      // --------------------------------------------------------


      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });

    } catch (err) {
      console.error(
        "❌ C2B confirmation error:",
        err
      );

      return res.status(500).json({
        ResultCode: 1,
        ResultDesc: "Error",
      });
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