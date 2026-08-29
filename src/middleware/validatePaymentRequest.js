// ============================================================
// VALIDATE STK PUSH INPUT
// ============================================================

function validatePaymentRequest(req, res, next) {
  const { phone, amount } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      error: "Phone number and amount are required",
    });
  }

  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "Amount must be a positive number",
    });
  }

  // Match Flutter app validation:
  // 2547XXXXXXXX or 2541XXXXXXXX
  const phoneRegex = /^254(7|1)[0-9]{8}$/;

  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number. Use format: 254712345678",
    });
  }

  next();
}

module.exports = validatePaymentRequest;
