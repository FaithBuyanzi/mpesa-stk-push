const { admin, db } = require("../../firebase");
const { buildMpesaConfirmationMessage } = require("../utils/mpesaDates");

// ============================================================
// SHARED PAYMENT RECORDING (used by the STK callback, the C2B
// confirmation handler AND the Pull API recovery query)
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

module.exports = { recordMpesaPayment };
