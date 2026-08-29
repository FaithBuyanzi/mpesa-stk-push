const express = require("express");
const cors = require("cors");

const requestLogger = require("./middleware/requestLogger");

const healthRoutes = require("./routes/health");
const stkRoutes = require("./routes/stk");
const c2bRoutes = require("./routes/c2b");
const pullRoutes = require("./routes/pull");
const accountBalanceRoutes = require("./routes/accountBalance");

// ============================================================
// EXPRESS APP
// ============================================================
//
// Builds and returns the configured app WITHOUT starting a listener,
// so server.js owns process startup and the app stays importable for
// tests/tooling.
//
// Routers declare their own full paths (e.g. "/api/mpesa/pay") rather
// than being mounted under a prefix - the endpoints are split across
// two different prefixes (/api/mpesa and /api/c2b) and Safaricom is
// configured against these exact URLs, so keeping them literal makes
// every route greppable by the URL registered on the Daraja portal.
//
function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);

  app.use(healthRoutes);
  app.use(stkRoutes);
  app.use(c2bRoutes);
  app.use(pullRoutes);
  app.use(accountBalanceRoutes);

  return app;
}

module.exports = createApp;
