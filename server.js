require("dotenv").config();

const createApp = require("./src/app");
const { PORT, C2B_REGISTER_URL } = require("./src/config");

// ============================================================
// START SERVER
// ============================================================
//
// Entry point only. Routing lives in src/routes/*, shared business
// logic in src/services/*, and every env-derived value in src/config.
//

const app = createApp();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${PORT}`
    );

    console.log(
      "Environment:",
      process.env.NODE_ENV || "production"
    );

    console.log(
      "C2B Register URL:",
      C2B_REGISTER_URL
    );

    console.log(
      "C2B Validation URL:",
      process.env.C2B_VALIDATION_URL
    );

    console.log(
      "C2B Confirmation URL:",
      process.env.C2B_CONFIRMATION_URL
    );
  }
);
