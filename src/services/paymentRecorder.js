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

        // The id of the reconciliation document written just above.
        //
        // Without it the app cannot tell that these two records are one
        // payment, and the invoice screen draws both: the entry as a plain
        // line, and the reconciliation again underneath carrying the
        // edit/delete menu. One payment, two rows, only one of them
        // actionable. See _PaymentHistoryCard in
        // lib/screens/sales/invoice_detail_screen.dart.
        sourceId: reconciliationRef.id,
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
        reconciliationId: reconciliationRef.id,
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
// ATTRIBUTING THE TILL PAYMENT ITSELF
// ============================================================
//
// Recording the payment on the invoice is only half of a match. The
// c2b_transactions document also has to say where the money went, because
// that is what the app reads to decide whether a Till payment still needs
// a sale recorded against it.
//
// It used to write only `matched` and `matchedInvoiceId`. The app reads
// `allocations` — the same field the in-app matching screens write — so an
// auto-matched payment showed "No sale recorded for this money" on a
// payment that was, in fact, already on an invoice. Anyone acting on that
// screen would have raised a second invoice for money already collected.
//
// Returns the fields to merge into the c2b_transactions document.
function tillPaymentMatchFields({ invoice, amount, strategy, result, source }) {
  const recorded = !!(result && result.recorded);

  if (!recorded) {
    // Matched to an invoice but nothing was written to it — a duplicate
    // receipt, or the invoice vanished. The money is still unattributed,
    // and the app should keep offering it for manual matching.
    return { matched: false, matchedInvoiceId: invoice.id, matchStrategy: strategy };
  }

  return {
    matched: true,
    matchedInvoiceId: invoice.id,
    matchStrategy: strategy,

    // Same shape as PaymentAllocation.toMap() in
    // lib/models/till_payment.dart. A single-invoice split: auto-matching
    // only ever puts the whole payment on one invoice.
    allocations: [
      {
        invoiceId: invoice.id,
        invoiceNumber: result.invoiceNumber || "",
        amount,
      },
    ],
    allocatedAmount: amount,

    matchedAt: admin.firestore.FieldValue.serverTimestamp(),
    matchedByUid: "system",
    matchedByName:
      source === "pull"
        ? "M-Pesa Auto-Match (Pull API Recovery)"
        : "M-Pesa Auto-Match (Till/C2B)",
  };
}

module.exports = { recordMpesaPayment, tillPaymentMatchFields };
