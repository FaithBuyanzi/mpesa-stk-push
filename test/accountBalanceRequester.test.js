// Checking the Till balance every time a customer pays — without asking
// Safaricom a dozen times for the same number.
//
// A Saturday morning brings payments in bursts. Each one changes the
// balance, so each one is a reason to go and read it; but each answer only
// supersedes the one before it, and the balance after the last payment in
// a burst is the only figure anyone wants. Asking once per payment spends
// a dozen calls against Safaricom's rate limits to learn one number, and
// the rate limit being hit is not a thing this code would find out about
// until the balance stopped updating at all.
//
// The other half of it matters just as much: this is called from the C2B
// confirmation handler, where the payment is already banked and Safaricom
// has already been answered. Nothing it does may throw.

const Module = require('module');

// How many times the real HTTP call would have been made.
let posts = 0;
// What the next post does, so a failure can be tested as easily as a
// success.
let nextPost = async () => ({ data: { ResponseCode: '0' } });

// Intercepted at the loader rather than through require.cache, because
// this repo's node_modules is not installed in every checkout and
// require.resolve('axios') would fail before a single assertion ran. The
// three things stubbed are the three that would leave the machine: the
// HTTP client, the RSA credential (which reads Safaricom's certificate off
// disk) and the OAuth token fetch.
const stubs = {
  axios: {
    post: async () => {
      posts++;
      return nextPost();
    },
  },
  security_credential: {
    buildSecurityCredential: () => '<encrypted>',
  },
  mpesaAuth: {
    getMpesaAccessToken: async () => '<token>',
  },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'axios') return stubs.axios;
  if (request.endsWith('security_credential')) return stubs.security_credential;
  if (request.endsWith('mpesaAuth')) return stubs.mpesaAuth;
  return realLoad.apply(this, arguments);
};

const requester = require('../src/services/accountBalanceRequester');

Module._load = realLoad;


let pass = 0;
let fail = 0;

function is(label, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log('  ok   ' + label);
  } else {
    fail++;
    console.log(
      '  FAIL ' + label + ' -> got ' + actual + ', wanted ' + expected
    );
  }
}

const configured = {
  INITIATOR_NAME: 'selete',
  INITIATOR_PASSWORD: 'not-a-real-password',
  ACCOUNT_BALANCE_SHORTCODE: '123456',
  ACCOUNT_BALANCE_RESULT_URL: 'https://example.test/result',
  ACCOUNT_BALANCE_TIMEOUT_URL: 'https://example.test/timeout',
};

function configure(values) {
  for (const key of Object.keys(configured)) delete process.env[key];
  for (const [key, value] of Object.entries(values || {})) {
    process.env[key] = value;
  }
}

function reset() {
  posts = 0;
  nextPost = async () => ({ data: { ResponseCode: '0' } });
  requester._resetThrottle();
}

async function main() {
  // ------------------------------------------------------------
  console.log('a deployment with no Initiator credentials');
  configure({});
  reset();

  is('is not configured', requester.isConfigured(), false);
  is(
    'says so rather than throwing',
    await requester.requestAccountBalanceQuietly('first payment'),
    'not-configured'
  );
  is('and asks Safaricom nothing', posts, 0);

  // ------------------------------------------------------------
  console.log('half-configured is not configured');
  configure({ ...configured, ACCOUNT_BALANCE_RESULT_URL: undefined });
  delete process.env.ACCOUNT_BALANCE_RESULT_URL;
  reset();

  is('missing one URL is enough', requester.isConfigured(), false);

  // ------------------------------------------------------------
  console.log('the first payment of the morning');
  configure(configured);
  reset();

  is(
    'asks for the balance',
    await requester.requestAccountBalanceQuietly('payment 1'),
    'sent'
  );
  is('once', posts, 1);

  // ------------------------------------------------------------
  console.log('the rest of the burst');

  is(
    'the second payment is throttled',
    await requester.requestAccountBalanceQuietly('payment 2'),
    'throttled'
  );
  is(
    'and so is the third',
    await requester.requestAccountBalanceQuietly('payment 3'),
    'throttled'
  );
  is('Safaricom was still only asked once', posts, 1);

  // ------------------------------------------------------------
  console.log('payments arriving at the same instant');
  reset();

  // Both start before either finishes — the shape of two C2B callbacks
  // landing together, which is exactly when a throttle on elapsed time
  // alone would let both through.
  const [a, b] = await Promise.all([
    requester.requestAccountBalanceQuietly('payment a'),
    requester.requestAccountBalanceQuietly('payment b'),
  ]);

  is('one of them goes', a, 'sent');
  is('the other finds it already in flight', b, 'in-flight');
  is('one request between them', posts, 1);

  // ------------------------------------------------------------
  console.log('when Safaricom refuses');
  reset();
  nextPost = async () => {
    const err = new Error('rate limited');
    err.response = { data: { errorMessage: 'rate limited' } };
    throw err;
  };

  is(
    'the failure is swallowed, not thrown',
    await requester.requestAccountBalanceQuietly('payment 1'),
    'failed'
  );

  // A failure that locked the balance out for the rest of the burst would
  // turn one refused request into a minute of not knowing.
  nextPost = async () => ({ data: { ResponseCode: '0' } });
  is(
    'and does not hold the next payment back',
    await requester.requestAccountBalanceQuietly('payment 2'),
    'sent'
  );
  is('so the balance is still asked for', posts, 2);

  // ------------------------------------------------------------
  console.log('the route still gets its errors');
  reset();
  configure({});

  let threw = false;
  try {
    await requester.requestAccountBalance('by hand');
  } catch (_) {
    threw = true;
  }
  is('requestAccountBalance throws on a bad config', threw, true);

  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
