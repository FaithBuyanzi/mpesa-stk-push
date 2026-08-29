const express = require("express");

const { admin, db } = require("../../firebase");
const { stkPush, stkQuery } = require("../../mpesa");
const validatePaymentRequest = require("../middleware/validatePaymentRequest");
const { recordMpesaPayment } = require("../services/paymentRecorder");

const router = express.Router();

// ============================================================
// STK PUSH
// ============================================================

router.post(
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

router.post("/api/mpesa/query", async (req, res) => {
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
// STK PUSH CALLBACK
// ============================================================
//
// IMPORTANT:
// This endpoint is ONLY for STK Push.
//
// URL:
// <PUBLIC_BASE_URL>/api/mpesa/callback  (whatever CALLBACK_URL is set to)
//
// Do NOT use this endpoint for C2B.
//

router.post("/api/mpesa/callback", async (req, res) => {
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

module.exports = router;
