// Recording the payer's number against the customer an invoice names.
//
// The app does this when somebody matches a Till payment by hand. Most
// Till payments are never matched by hand — this service matches them the
// moment Safaricom confirms them — so the same rules have to hold here.
//
// The reason this file exists at all is the duplication. `customerNameKey`
// and `normaliseKenyanMsisdn` are implemented twice, once in Dart
// (lib/utils/customer_names.dart) and once in JavaScript, because the two
// halves of the system cannot share code. If they ever disagree the lookup
// finds nobody and nothing anywhere reports a problem: numbers simply stop
// being recorded. So the cases below are deliberately the same ones as
// test/customer_names_test.dart on the Dart side, and a change to one that
// is not made to the other fails here.

const firebasePath = require.resolve("../firebase.js");

// Stubbed before the module loads: the real one goes looking for
// service-account credentials, and none of what is tested here touches
// Firestore.
require.cache[firebasePath] = {
  id: firebasePath,
  filename: firebasePath,
  loaded: true,
  exports: {
    admin: {},
    db: {
      collection() {
        throw new Error("the database is not available in this test");
      },
    },
  },
};

const {
  customerNameKey,
  normaliseKenyanMsisdn,
} = require("../src/services/customerDirectory");

let pass = 0;
let fail = 0;

function is(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log("  ok   " + label);
  } else {
    fail++;
    console.log(
      "  FAIL " + label + " -> got " + actual + ", wanted " + expected
    );
  }
}

console.log("the four ways this farm writes a number all agree");
is("0712345678", normaliseKenyanMsisdn("0712345678"), "254712345678");
is("712345678", normaliseKenyanMsisdn("712345678"), "254712345678");
is("254712345678", normaliseKenyanMsisdn("254712345678"), "254712345678");
is("+254712345678", normaliseKenyanMsisdn("+254712345678"), "254712345678");

console.log("typed-in punctuation is ignored");
is("spaces", normaliseKenyanMsisdn("+254 712 345 678"), "254712345678");
is("dashes", normaliseKenyanMsisdn("0712-345-678"), "254712345678");
is("brackets", normaliseKenyanMsisdn("(0712) 345678"), "254712345678");

console.log("the 011x range is a real prefix");
is("0110123456", normaliseKenyanMsisdn("0110123456"), "254110123456");

console.log("an undecoded Safaricom hash is not a number");
// Safaricom sends the MSISDN as an unsalted SHA-256 to shortcodes without
// approved data access. Stripping non-digits out of one produces something
// that looks like a number, which is exactly how a hash ends up in a phone
// field and then in an address book.
is("64 hex chars", normaliseKenyanMsisdn("a".repeat(64)), null);
is("64 digits", normaliseKenyanMsisdn("0".repeat(64)), null);

console.log("refuses rather than guesses");
is("null", normaliseKenyanMsisdn(null), null);
is("empty", normaliseKenyanMsisdn(""), null);
is("too short", normaliseKenyanMsisdn("12345"), null);
is("wrong prefix", normaliseKenyanMsisdn("0812345678"), null);
is("too long", normaliseKenyanMsisdn("07123456789"), null);
is("not a number at all", normaliseKenyanMsisdn("not a phone"), null);

console.log("two spellings of one person agree");
is(
  "capitals fold",
  customerNameKey("JOHN DOE"),
  customerNameKey("john doe")
);
is(
  "extra spaces fold",
  customerNameKey("  John   Doe "),
  customerNameKey("john doe")
);
is("the key itself", customerNameKey("JOHN DOE"), "john doe");

console.log("different people do not");
is(
  "Jane is not John",
  customerNameKey("John Doe") === customerNameKey("Jane Doe"),
  false
);

console.log("nothing to key on");
is("null", customerNameKey(null), "");
is("blank", customerNameKey("   "), "");

console.log("");
console.log(pass + " passed, " + fail + " failed");
if (fail > 0) process.exit(1);
