const admin = require("firebase-admin");

// Validate firebase-admin package loaded correctly
if (!admin || typeof admin.initializeApp !== 'function') {
  console.error("❌ Firebase Admin SDK failed to load properly");
  console.error("Please check that firebase-admin is installed correctly");
  process.exit(1);
}

// Validate FIREBASE_SERVICE_ACCOUNT environment variable exists
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT environment variable is not set");
  console.error("Please add it in your deployment platform (Render Dashboard → Environment)");
  console.error("The value should be the entire JSON content from your firebase-key.json file");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  console.log("✅ Firebase service account parsed successfully");
  console.log("   Project ID:", serviceAccount.project_id);
} catch (error) {
  console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT:", error.message);
  console.error("Make sure the environment variable contains valid JSON");
  console.error("Common issues:");
  console.error("  - JSON is not properly escaped");
  console.error("  - Missing quotes or commas");
  console.error("  - Newlines not converted to \\n");
  process.exit(1);
}

// Safely initialize Firebase (check if apps array exists)
if (!admin.apps || admin.apps.length === 0) {
  try {
    // Check if credential method is available
    if (!admin.credential || !admin.credential.cert) {
      throw new Error("admin.credential.cert is not available. firebase-admin package may not be loaded correctly.");
    }
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase initialized successfully");
  } catch (error) {
    console.error("❌ Failed to initialize Firebase:", error.message);
    console.error("\nTroubleshooting steps:");
    console.error("1. Verify firebase-admin is in package.json dependencies");
    console.error("2. Try deleting node_modules and running npm install again");
    console.error("3. Check for package installation errors in build logs");
    console.error("4. Try downgrading firebase-admin to version 11.11.0");
    process.exit(1);
  }
} else {
  console.log("✅ Firebase already initialized");
}

const db = admin.firestore();
console.log("✅ Firestore database instance created");

module.exports = { admin, db };
