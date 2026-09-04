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

  // ----------------------------------------------------------
  // HAS THIS RECEIPT ALREADY BEEN BANKED, ANYWHERE?
  // ----------------------------------------------------------
  //
  // The per-invoice guard inside the transaction below only asks whether
  // *this* invoice already carries the receipt. That is not the question
  // when the same money reaches us twice down two different paths, which
  // is exactly what happens on every STK Push to the Till: Safaricom sends
  // the STK callback AND a C2B confirmation for the one payment. The STK
  // callback records it against the invoice it was raised for; the C2B
  // handler then goes looking for an invoice by amount and name, and any
  // invoice it lands on other than that one gets credited with money the
  // customer never sent it.
  //
  // A reconciliation document is written for every recorded payment and
  // carries the receipt in a queryable field, so it is the one place that
  // can answer "is this receipt already on some invoice" cheaply.
  const alreadyBanked = await findReconciliationByReceipt(receipt);

  if (alreadyBanked) {
    console.log(
      "Receipt " +
        receipt +
        " is already recorded on invoice " +
        alreadyBanked.invoiceId +
        " - not recording it a second time (source: " +
        source +
        ")"
    );

    return {
      recorded: false,
      reason: "already_recorded",
      invoiceId: alreadyBanked.invoiceId,
      invoiceNumber: alreadyBanked.invoiceNumber || "",
      reconciliationId: alreadyBanked.id,
    };
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
// WHERE HAS THIS RECEIPT ALREADY LANDED?
// ============================================================

// The reconciliation record for `receipt`, if the money is already on an
// invoice. Null when it is genuinely new.
async function findReconciliationByReceipt(receipt) {
  if (!receipt) return null;

  try {
    const snap = await db
      .collection("payment_reconciliations")
      .where("referenceCode", "==", receipt)
      .limit(1)
      .get();

    if (snap.empty) return null;

    const doc = snap.docs[0];
    return { id: doc.id, ...doc.data() };
  } catch (err) {
    // A failure here must not stop a payment being recorded. The
    // per-invoice guard inside the transaction still stands; this is the
    // wider net, and a torn net is better than no payment at all.
    console.error(
      "Could not check for an existing reconciliation:",
      err.message
    );
    return null;
  }
}

// The STK Push this Till receipt came from, if it came from one.
//
// An STK Push is raised from inside the app against a known invoice, so
// when one owns the receipt there is nothing left to work out: the money's
// destination was decided before the customer entered their PIN. Matching
// it again by amount and name can only ever disagree with that.
//
// Safaricom sends the two callbacks for the same payment within moments of
// each other and in no guaranteed order, so this waits a little for the STK
// side to land rather than concluding on the first look that no STK exists.
// The wait costs nothing anybody is waiting on - the C2B handler has
// already acknowledged Safaricom by the time this runs.
//
// Four looks over six seconds is the compromise. Every ordinary walk-in
// Till payment pays the full six, because for those there is no STK to
// find; making it longer would delay their matching for nothing. Making it
// shorter risks the C2B side matching first and putting the money on an
// invoice the push was never for - which the global receipt guard in
// recordMpesaPayment then makes permanent, because it stops the STK
// callback correcting it.
async function findStkTransactionByReceipt(
  receipt,
  { attempts = 4, delayMs = 2000 } = {}
) {
  if (!receipt) return null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const snap = await db
        .collection("transactions")
        .where("receipt", "==", receipt)
        .limit(1)
        .get();

      if (!snap.empty) {
        const doc = snap.docs[0];
        return { id: doc.id, ...doc.data() };
      }
    } catch (err) {
      console.error("Could not look up the STK transaction:", err.message);
      return null;
    }

    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return null;
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
  const reason = (result && result.reason) || "";

  // "Already there" is a match, not a failure. Both reasons below mean the
  // money is sitting on an invoice right now - the receipt was recorded by
  // the STK callback, or by an earlier run of this very handler. Reporting
  // that as unmatched is what made a payment that was already on an invoice
  // show "No sale recorded for this money", and invited somebody to raise a
  // second invoice for money already collected.
  const alreadyThere =
    reason === "already_recorded" || reason === "duplicate_receipt";

  const recorded = !!(result && result.recorded);

  if (!recorded && !alreadyThere) {
    // Matched to an invoice but nothing was written to it - the invoice
    // vanished, or the write failed. The money really is unattributed, and
    // the app should keep offering it for manual matching.
    return { matched: false, matchedInvoiceId: invoice.id, matchStrategy: strategy };
  }

  // When the money turned out to be on a different invoice than this pass
  // was aiming at, say where it actually is.
  const invoiceId = (!recorded && result.invoiceId) || invoice.id;

  return {
    matched: true,
    matchedInvoiceId: invoiceId,
    matchStrategy: strategy,

    // Same shape as PaymentAllocation.toMap() in
    // lib/models/till_payment.dart. A single-invoice split: auto-matching
    // only ever puts the whole payment on one invoice.
    allocations: [
      {
        invoiceId,
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

module.exports = {
  recordMpesaPayment,
  tillPaymentMatchFields,
  findReconciliationByReceipt,
  findStkTransactionByReceipt,
};
