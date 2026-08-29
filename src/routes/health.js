const express = require("express");

const { admin, db } = require("../../firebase");

const router = express.Router();

// ============================================================
// HEALTH CHECK
// ============================================================

router.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
  });
});


// ============================================================
// TEST FIRESTORE CONNECTION
// ============================================================

router.get("/test-firestore", async (req, res) => {
  try {
    const docRef = await db.collection("test").add({
      message: "Hello from Render!",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      documentId: docRef.id,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
