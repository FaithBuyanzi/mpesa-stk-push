// Attributing a Till payment to the invoice its money is actually on.
//
// The bug this exists for: an STK Push to the Till reaches the server
// twice. The STK callback records the payment against the invoice the push
// was raised for; Safaricom then sends a C2B confirmation for the same
// money, and the C2B handler went looking for an invoice by amount and
// name as though nothing had happened. Two ways that ends badly, and both
// were seen:
//
//   * it lands on a different invoice and records the payment a second
//     time, crediting a customer with money they never sent; or
//   * it lands on the right invoice, the per-invoice duplicate guard
//     refuses the write, and the refusal was reported as "unmatched" — so
//     a payment sitting on an invoice showed "No sale recorded for this
//     money", inviting somebody to raise a second invoice for it.
//
// tillPaymentMatchFields decides which of those the Till payment is told,
// so it is the piece worth pinning.

const firebasePath = require.resolve('../firebase.js');

// Stubbed before paymentRecorder is loaded: requiring the real one would
// go looking for service-account credentials, and none of what is tested
// here touches Firestore.
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    admin: {
      firestore: {
        FieldValue: { serverTimestamp: () => '<server-timestamp>' },
      },
    },
    db: {
      collection() {
        throw new Error('the database is not available in this test');
      },
    },
  },
};

const { tillPaymentMatchFields } = require('../src/services/paymentRecorder');

let pass = 0;
let fail = 0;

function is(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log('  FAIL ' + label + ' -> got ' + actual + ', wanted ' + expected);
  }
}

const invoice = { id: 'inv-1' };

console.log('a payment that was written to the invoice');
{
  const fields = tillPaymentMatchFields({
    invoice,
    amount: 1500,
    strategy: 'name+amount',
    result: { recorded: true, invoiceNumber: 'INV-001' },
    source: 'c2b',
  });
  is('is matched', fields.matched, true);
  is('names the invoice', fields.matchedInvoiceId, 'inv-1');
  is('allocates the whole amount', fields.allocatedAmount, 1500);
  is('writes one allocation', fields.allocations.length, 1);
  is('carrying the invoice number', fields.allocations[0].invoiceNumber, 'INV-001');
  is('and the invoice id', fields.allocations[0].invoiceId, 'inv-1');
}

console.log('a payment the STK callback already recorded');
{
  // What the C2B handler now passes when it finds an STK Push owning the
  // receipt. Nothing was written by this pass, and that is correct — the
  // money is already on the invoice.
  const fields = tillPaymentMatchFields({
    invoice: { id: 'inv-7' },
    amount: 2400,
    strategy: 'stk_push',
    result: {
      recorded: false,
      reason: 'already_recorded',
      invoiceId: 'inv-7',
      invoiceNumber: 'INV-007',
    },
    source: 'c2b',
  });
  is('is still a match', fields.matched, true);
  is('names the invoice holding the money', fields.matchedInvoiceId, 'inv-7');
  is('and allocates it, so the app stops asking', fields.allocatedAmount, 2400);
  is('with the invoice number on the allocation',
     fields.allocations[0].invoiceNumber, 'INV-007');
}

console.log('the receipt is on a different invoice than this pass aimed at');
{
  // The C2B matcher guessed inv-2; the money was already banked on inv-9.
  // Saying "matched to inv-2" would point every screen at the wrong sale.
  const fields = tillPaymentMatchFields({
    invoice: { id: 'inv-2' },
    amount: 800,
    strategy: 'name+amount',
    result: {
      recorded: false,
      reason: 'already_recorded',
      invoiceId: 'inv-9',
      invoiceNumber: 'INV-009',
    },
    source: 'c2b',
  });
  is('follows the money, not the guess', fields.matchedInvoiceId, 'inv-9');
  is('and allocates against that one', fields.allocations[0].invoiceId, 'inv-9');
}

console.log('the per-invoice duplicate guard refused the write');
{
  const fields = tillPaymentMatchFields({
    invoice,
    amount: 500,
    strategy: 'name+amount',
    result: { recorded: false, reason: 'duplicate_receipt' },
    source: 'c2b',
  });
  // The receipt is on that invoice already. This is the case that used to
  // read as "No sale recorded for this money".
  is('is a match', fields.matched, true);
  is('on the invoice that has it', fields.matchedInvoiceId, 'inv-1');
}

console.log('nothing was written and the money really is loose');
{
  const gone = tillPaymentMatchFields({
    invoice,
    amount: 500,
    strategy: 'name+amount',
    result: { recorded: false, reason: 'invoice_not_found' },
    source: 'c2b',
  });
  is('stays unmatched', gone.matched, false);
  is('with no allocation', gone.allocations, undefined);

  const failed = tillPaymentMatchFields({
    invoice,
    amount: 500,
    strategy: 'name+amount',
    result: { recorded: false, reason: 'error', error: 'boom' },
    source: 'c2b',
  });
  is('a failed write stays unmatched too', failed.matched, false);
}

console.log('who did the matching');
{
  const c2b = tillPaymentMatchFields({
    invoice,
    amount: 100,
    strategy: 'name+amount',
    result: { recorded: true, invoiceNumber: 'INV-001' },
    source: 'c2b',
  });
  const pull = tillPaymentMatchFields({
    invoice,
    amount: 100,
    strategy: 'name+amount',
    result: { recorded: true, invoiceNumber: 'INV-001' },
    source: 'pull',
  });
  is('a Till confirmation says so', c2b.matchedByName, 'M-Pesa Auto-Match (Till/C2B)');
  is('a Pull API recovery says so', pull.matchedByName,
     'M-Pesa Auto-Match (Pull API Recovery)');
}

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
