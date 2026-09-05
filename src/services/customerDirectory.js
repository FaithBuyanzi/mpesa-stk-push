const { db } = require("../../firebase");

// ============================================================
// THE CUSTOMER DIRECTORY, FROM THE SERVER'S SIDE
// ============================================================
//
// The app fills in a customer's phone number when somebody matches a Till
// payment to an invoice by hand. Most Till payments are never matched by
// hand: this service matches them automatically the moment Safaricom
// confirms them, and the app never runs at all. So the same thing has to
// happen here, or the only customers who ever get a number on file are the
// ones whose payment the auto-matcher failed to place.
//
// Same rule as the app, and it is the important one: **fill a gap, never
// overwrite**. A number already on file may have been corrected by hand,
// and a customer paying from a borrowed handset must not rewrite their own
// number. And never create a customer — a C2B confirmation carries
// Safaricom's first name only ("JANET"), and creating a customer from that
// is how a directory fills with ghosts.

/// Matches `customerNameKey` in lib/utils/customer_names.dart. Both sides
/// have to agree or the lookup silently finds nobody.
function customerNameKey(raw) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/// Matches `normaliseKenyanMsisdn` in lib/utils/customer_names.dart.
/// Returns null for anything that is not a Kenyan mobile, including an
/// undecoded Safaricom MSISDN hash.
function normaliseKenyanMsisdn(raw) {
  const input = String(raw || "").trim();
  if (!input) return null;

  // 64 hex characters is Safaricom's hash, not a number. Stripping
  // non-digits out of one produces something that looks like a number.
  if (/^[0-9a-fA-F]{64}$/.test(input)) return null;

  let digits = input.replace(/[^0-9]/g, "");

  if (digits.length === 12 && digits.startsWith("254")) {
    digits = digits.slice(3);
  } else if (digits.length === 10 && digits.startsWith("0")) {
    digits = digits.slice(1);
  } else if (digits.length === 13 && digits.startsWith("0254")) {
    digits = digits.slice(4);
  }

  if (digits.length !== 9) return null;
  if (!digits.startsWith("7") && !digits.startsWith("1")) return null;

  return "254" + digits;
}

/**
 * Writes a payer's number onto the customer an invoice names, if that
 * customer has none.
 *
 * Never throws. Every caller is a payment handler where the money is
 * already banked and Safaricom already answered; an address-book write
 * must not be able to fail any of that.
 *
 * Returns one of: "filled", "already-had-one", "no-customer",
 * "no-phone", "no-name", "error".
 */
async function fillMissingCustomerPhone({ customerName, phone }) {
  const key = customerNameKey(customerName);
  if (!key) return "no-name";

  const normalised = normaliseKenyanMsisdn(phone);
  if (!normalised) return "no-phone";

  try {
    const snap = await db
      .collection("customers")
      .where("nameLower", "==", key)
      .limit(1)
      .get();

    if (snap.empty) return "no-customer";

    const doc = snap.docs[0];
    const existing = normaliseKenyanMsisdn((doc.data() || {}).phone);
    if (existing) return "already-had-one";

    await doc.ref.update({
      phone: normalised,
      updatedAt: new Date(),
    });
    return "filled";
  } catch (err) {
    console.error(
      "Could not record the payer's number on the customer:",
      err.message
    );
    return "error";
  }
}

/**
 * The same, starting from an invoice id — which is what the C2B handler
 * actually has once a match is made.
 */
async function fillCustomerPhoneFromInvoice({ invoiceId, phone }) {
  if (!invoiceId) return "no-name";
  if (!normaliseKenyanMsisdn(phone)) return "no-phone";

  try {
    const invoice = await db.collection("invoices").doc(invoiceId).get();
    if (!invoice.exists) return "no-customer";
    return await fillMissingCustomerPhone({
      customerName: (invoice.data() || {}).customerName,
      phone,
    });
  } catch (err) {
    console.error("Could not read the invoice for its customer:", err.message);
    return "error";
  }
}

module.exports = {
  customerNameKey,
  normaliseKenyanMsisdn,
  fillMissingCustomerPhone,
  fillCustomerPhoneFromInvoice,
};
