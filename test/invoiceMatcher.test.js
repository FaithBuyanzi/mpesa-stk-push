const m = require('../src/services/invoiceMatcher');
const day = (n) => new Date(2026, 8, n);
let pass = 0, fail = 0;
function is(label, actual, expected) {
  if (actual === expected) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + actual + ', wanted ' + expected); }
}

const inv = (id, dayN, name, bal) => ({
  id, doc: id, customerName: name, balanceDue: bal,
  dateMillis: day(dayN).getTime(),
});

console.log('days between calendar dates');
is('same day', m.daysBetweenDates(new Date(2026,8,10,23,50), new Date(2026,8,10,0,10)), 0);
is('across midnight is one day', m.daysBetweenDates(new Date(2026,8,10,23,50), new Date(2026,8,11,0,10)), 1);
is('a week', m.daysBetweenDates(day(3), day(10)), 7);
is('order does not matter', m.daysBetweenDates(day(10), day(3)), 7);

console.log('the window');
const pool = [inv('a', 10, 'JANE WANJIKU', 2500)];
is('exactly 7 days is in',  m.withinWindow(pool, day(17)).length, 1);
is('8 days is out',         m.withinWindow(pool, day(18)).length, 0);
is('7 days before is in',   m.withinWindow(pool, day(3)).length, 1);
is('8 days before is out',  m.withinWindow(pool, day(2)).length, 0);
is('no invoice date is out', m.withinWindow([{...pool[0], dateMillis: 0}], day(10)).length, 0);
is('no payment date matches nothing', m.withinWindow(pool, null).length, 0);

console.log('matching end to end');
const match = (candidates, date, name, amount) => (
  m.matchInvoiceForPayment({ paymentName: name, paymentAmount: amount, paymentDate: date, candidates }) || {}).id || null;

is('same-day exact amount + name matches',
   match([inv('a', 10, 'JANE WANJIKU', 2500)], day(10), 'JANE', 2500), 'a');
is('six months old does NOT match',
   match([inv('a', 10, 'JANE WANJIKU', 2500)], new Date(2027, 2, 10), 'JANE', 2500), null);
is('the old exact-amount invoice loses to the recent one',
   match([inv('old', 10, 'JANE WANJIKU', 2500), inv('new', 100, 'JANE WANJIKU', 9999)],
         day(100), 'JANE', 2500), 'new');
is('and when only the old one is in range, nothing matches',
   match([inv('old', 10, 'JANE WANJIKU', 2500)], day(100), 'JANE', 2500), null);
is('a wrong name in range still does not match',
   match([inv('a', 10, 'PETER OTIENO', 2500)], day(10), 'JANE', 2500), null);
is('missing payment date matches nothing',
   match([inv('a', 10, 'JANE WANJIKU', 2500)], undefined, 'JANE', 2500), null);

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
