'use strict';
/* Development only: run the shop with a FAKE Paytm so the whole pay flow can be tried locally.
   Open http://127.0.0.1:3099 to approve or fail payments by hand. No real money moves.
   Refuses to run in production. Usage: npm run dev:fakepay */
if (process.env.NODE_ENV === 'production') {
  console.error('dev-fake-paytm refuses to run with NODE_ENV=production.');
  process.exit(1);
}
const { startPaytmMock } = require('../test/paytmMock');

(async () => {
  const port = Number(process.env.PORT || 3000);
  const mock = await startPaytmMock({ port: 3099, webhookUrl: `http://127.0.0.1:${port}/api/payments/paytm/webhook` });
  Object.assign(process.env, {
    NODE_ENV: 'development',
    PAYTM_MID: mock.mid,
    PAYTM_MERCHANT_KEY: mock.key,
    PAYTM_HOST: mock.host
  });
  console.log(`\n  FAKE Paytm control page: ${mock.host}  (approve / fail payments here)\n`);
  require('../src/server').main();
})();
