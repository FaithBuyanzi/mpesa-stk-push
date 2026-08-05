require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { admin, db } = require("./firebase");
const { stkPush, stkQuery } = require("./mpesa");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
  });
});

// Test Firestore connection
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

// Validate input
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

  // Match Flutter app validation: 2547 or 2541 prefix, 12 digits total
  const phoneRegex = /^254(7|1)[0-9]{8}$/;

  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number. Use format: 254712345678",
    });
  }

  next();
}

// STK Push
app.post("/api/mpesa/pay", validatePaymentRequest, async (req, res) => {
  try {
    const { phone, amount, invoiceId, recordedByUid } = req.body;

    console.log("========== STK PUSH ==========");
    console.log("Phone:", phone);
    console.log("Amount:", amount);
    console.log("Invoice ID:", invoiceId);
    console.log("Recorded By UID:", recordedByUid);

    // Generate meaningful account reference
    const accountReference = invoiceId ? `INV-${invoiceId}` : 'SELE-AGRO';
    const description = invoiceId 
      ? `Payment for invoice ${invoiceId}` 
      : 'Selete Agro payment';

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
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Add invoiceId if provided
    if (invoiceId) {
      transactionData.invoiceId = invoiceId;
    }

    // Add recordedByUid if provided (for Firestore read access control)
    if (recordedByUid) {
      transactionData.recordedByUid = recordedByUid;
    }

    await db.collection("transactions").doc(result.CheckoutRequestID).set(transactionData);

    console.log("Transaction created:", result.CheckoutRequestID);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error("STK Push error:", err.response?.data || err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Query transaction status
app.post("/api/mpesa/query", async (req, res) => {
  try {
    const { checkoutRequestId } = req.body;

    if (!checkoutRequestId) {
      return res.status(400).json({
        success: false,
        error: "checkoutRequestId is required",
      });
    }

    console.log("========== QUERY TRANSACTION ==========");
    console.log("CheckoutRequestID:", checkoutRequestId);

    const result = await stkQuery(checkoutRequestId);

    console.log("Query result:", result);

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error("Query error:", err.response?.data || err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Auto-record payment to invoice
async function autoRecordPayment(txData, amount, receipt) {
  if (!txData.invoiceId) {
    console.log("No invoiceId linked to transaction - skipping auto-record");
    return;
  }

  try {
    const invoiceRef = db.collection("invoices").doc(txData.invoiceId);

    // Use a Firestore transaction for atomic read-modify-write
    // to prevent double-counting on concurrent callbacks
    await db.runTransaction(async (transaction) => {
      const invoiceDoc = await transaction.get(invoiceRef);

      if (!invoiceDoc.exists) {
        console.error("Invoice not found:", txData.invoiceId);
        return;
      }

      const invoiceData = invoiceDoc.data();
      const currentAmountPaid = invoiceData.amountPaid || 0;
      const newAmountPaid = currentAmountPaid + amount;
      const total = invoiceData.total;

      // Determine new payment status
      let paymentStatus = "unpaid";
      if (newAmountPaid >= total) {
        paymentStatus = "paid";
      } else if (newAmountPaid > 0) {
        paymentStatus = "partially_paid";
      }

      // Create payment reconciliation record
      const reconciliationRef = db.collection("payment_reconciliations").doc();
      transaction.set(reconciliationRef, {
        invoiceId: txData.invoiceId,
        invoiceNumber: invoiceData.invoiceNumber,
        customerName: invoiceData.customerName,
        paymentMethod: "mpesa",
        amount: amount,
        referenceCode: receipt,
        message: `M-Pesa STK Push - ${receipt}`,
        depositDate: admin.firestore.FieldValue.serverTimestamp(),
        reconciled: true, // Auto-reconciled (callback is proof)
        reconciledByUid: "system",
        reconciledByName: "M-Pesa Auto-Reconciliation",
        reconciledAt: admin.firestore.FieldValue.serverTimestamp(),
        recordedByUid: "system",
        recordedByName: "M-Pesa STK Push",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update invoice - also add to payments array and set mpesaCheckoutRequestId
      const existingPayments = invoiceData.payments || [];
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
        mpesaCheckoutRequestId: txData.checkoutRequestID,
        paymentDate: admin.firestore.FieldValue.serverTimestamp(),
        payments: [...existingPayments, newPayment],
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("✅ Auto-recorded payment for invoice:", txData.invoiceId);
      console.log("   Amount: KSh", amount);
      console.log("   New amount paid: KSh", newAmountPaid);
      console.log("   Status:", paymentStatus);
    });
  } catch (err) {
    console.error("Error auto-recording payment:", err);
  }
}

// Safaricom callback
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const callback = req.body.Body.stkCallback;

    const {
      CheckoutRequestID,
      ResultCode,
      ResultDesc,
    } = callback;

    console.log("========== CALLBACK ==========");
    console.log("CheckoutRequestID:", CheckoutRequestID);
    console.log("ResultCode:", ResultCode);
    console.log("ResultDesc:", ResultDesc);

    // Validate transaction exists
    const txDoc = await db.collection("transactions").doc(CheckoutRequestID).get();
    
    if (!txDoc.exists) {
      console.error("Invalid CheckoutRequestID - transaction not found:", CheckoutRequestID);
      return res.json({
        ResultCode: 1,
        ResultDesc: "Invalid transaction",
      });
    }

    const txData = txDoc.data();
    console.log("Transaction found - Invoice ID:", txData.invoiceId);

    // Idempotency check - prevent duplicate processing on callback retries
    if (txData.status === "success") {
      console.log("Transaction already processed - skipping duplicate callback");
      return res.json({
        ResultCode: 0,
        ResultDesc: "Accepted",
      });
    }

    if (ResultCode === 0) {
      // Guard against missing CallbackMetadata
      if (!callback.CallbackMetadata || !callback.CallbackMetadata.Item) {
        console.error("CallbackMetadata missing from successful callback");
        return res.status(500).json({
          ResultCode: 1,
          ResultDesc: "Error",
        });
      }

      const items = callback.CallbackMetadata.Item;

      const amount = items.find(i => i.Name === "Amount")?.Value;
      const receipt = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const phone = items.find(i => i.Name === "PhoneNumber")?.Value;
      const transactionDate = items.find(i => i.Name === "TransactionDate")?.Value;

      // Validate amount matches original request (compare as numbers)
      const callbackAmount = parseFloat(amount);
      if (callbackAmount && txData.amount && callbackAmount !== txData.amount) {
        console.error("Amount mismatch - Expected:", txData.amount, "Got:", callbackAmount);
      }

      // Validate phone matches
      if (phone && txData.phone && phone !== txData.phone) {
        console.error("Phone mismatch - Expected:", txData.phone, "Got:", phone);
      }

      await db.collection("transactions").doc(CheckoutRequestID).update({
        status: "success",
        amount: callbackAmount || txData.amount,
        receipt,
        phone: phone || txData.phone,
        transactionDate,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        validated: true,
      });

      console.log("✅ Payment successful:", receipt);
      console.log("   Invoice ID:", txData.invoiceId || "N/A");

      // Auto-record payment to invoice
      await autoRecordPayment(txData, callbackAmount || txData.amount, receipt);
    } else {
      await db.collection("transactions").doc(CheckoutRequestID).update({
        status: "failed",
        resultCode: ResultCode,
        resultDesc: ResultDesc,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("❌ Payment failed:", ResultDesc);
    }

    res.json({
      ResultCode: 0,
      ResultDesc: "Accepted",
    });
  } catch (err) {
    console.error("Callback error:", err);

    res.status(500).json({
      ResultCode: 1,
      ResultDesc: "Error",
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});