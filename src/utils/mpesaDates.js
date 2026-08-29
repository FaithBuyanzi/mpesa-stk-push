// ============================================================
// SAFARICOM TIMESTAMP HELPERS
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

module.exports = {
  formatMpesaTransactionDate,
  parseMpesaTimestamp,
  buildMpesaConfirmationMessage,
};
