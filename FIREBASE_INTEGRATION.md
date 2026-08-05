# Firebase Integration Audit & Implementation Report

## Current State Analysis

### ✅ What's Working
- M-Pesa STK Push backend is functional
- Safaricom sandbox integration tested and working
- Callback endpoint receives payment results
- All data currently logged to Render console only

### ❌ What's Missing
- No persistent storage for transactions
- No notification system for payment status
- No way to track payment history
- Callback data lost if Render logs scroll away

---

## Integration Requirements

### What You Need from Firebase

#### 1. **Firebase Service Account Key** (Required)
- Go to Firebase Console → Project Settings → Service Accounts
- Generate private key (JSON file)
- This gives your backend admin access to Firebase

#### 2. **Firestore Database** (Required)
- Create Cloud Firestore in Firebase Console
- This is where payment transactions will be stored

#### 3. **Firebase Cloud Messaging (FCM)** (Optional but Recommended)
- For sending push notifications to Flutter app
- Requires FCM token from Flutter app

---

## Implementation Plan

### Phase 1: Database Structure Design

#### Collection: `transactions`
```
Document ID: Auto-generated or CheckoutRequestID
Fields:
- checkoutRequestID: string (unique)
- merchantRequestID: string
- phoneNumber: string
- amount: number
- mpesaReceiptNumber: string (if successful)
- status: string ("pending" | "success" | "failed")
- resultCode: number
- resultDesc: string
- timestamp: timestamp
- createdAt: timestamp
```

#### Collection: `payments` (Optional - for real-time updates)
```
Document ID: Auto-generated
Fields:
- checkoutRequestID: string
- userId: string (from Flutter app - optional)
- status: string
- amount: number
- timestamp: timestamp
```

---

## Step-by-Step Implementation Guide

### Step 1: Get Firebase Service Account Key

1. Go to https://console.firebase.google.com
2. Select your project
3. Click gear icon → Project Settings
4. Go to **Service Accounts** tab
5. Click **"Generate new private key"**
6. Save the JSON file as `firebase-key.json`
7. **IMPORTANT**: Keep this file secret, never commit to Git

---

### Step 2: Update .gitignore (Already Done)
```
"firebase-key.json" is already in .gitignore ✅
```

---

### Step 3: Install Firebase Admin SDK (Already Done)
```bash
npm install firebase-admin  ✅ Already installed
```

---

### Step 4: Update server.js to Use Firebase

**You need to add this code to server.js:**

```javascript
// Add at top of server.js
const admin = require("firebase-admin");
const serviceAccount = require("./firebase-key.json");

// Initialize Firebase (add after require statements)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
```

---

### Step 5: Update Callback to Save to Firestore

**Replace the current callback handler with:**

```javascript
// Receive the payment result from Safaricom
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    const { CheckoutRequestID, ResultCode, ResultDesc } = callbackData;

    // Prepare transaction data
    const transactionData = {
      checkoutRequestID: CheckoutRequestID,
      resultCode: ResultCode,
      resultDesc: ResultDesc,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (ResultCode === 0) {
      // Payment successful
      const items = callbackData.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === "Amount")?.Value;
      const mpesaReceiptNumber = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const phoneNumber = items.find(i => i.Name === "PhoneNumber")?.Value;

      transactionData.amount = amount;
      transactionData.mpesaReceiptNumber = mpesaReceiptNumber;
      transactionData.phoneNumber = phoneNumber;
      transactionData.status = "success";

      console.log("Payment success:", transactionData);

      // TODO: Send FCM notification to user's device
      await sendPaymentNotification(phoneNumber, amount, mpesaReceiptNumber);

    } else {
      // Payment failed
      transactionData.status = "failed";
      console.log("Payment failed:", ResultDesc);
    }

    // Save to Firestore
    await db.collection("transactions").doc(CheckoutRequestID).set(transactionData);

    // Respond to Safaricom
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (error) {
    console.error("Callback error:", error);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});
```

---

### Step 6: Add FCM Notification Function

**Add this function to server.js:**

```javascript
// Send FCM notification on successful payment
async function sendPaymentNotification(phoneNumber, amount, receiptNumber) {
  try {
    // TODO: Get FCM token from your database using phoneNumber
    // const userDoc = await db.collection("users").doc(phoneNumber).get();
    // const fcmToken = userDoc.data().fcmToken;

    // For now, just log it
    console.log(`FCM Notification: Payment of KES ${amount} successful. Receipt: ${receiptNumber}`);
    
    // When you have FCM token:
    // const message = {
    //   notification: {
    //     title: "Payment Successful",
    //     body: `You paid KES ${amount}. Receipt: ${receiptNumber}`,
    //   },
    //   token: fcmToken,
    // };
    // 
    // await admin.messaging().send(message);
    
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}
```

---

### Step 7: Update .env.example for Firebase

Add to `.env.example`:
```env
# Firebase Configuration (optional - for notifications)
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_CLIENT_EMAIL=your-service-account-email
FIREBE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

**Note**: Using `firebase-key.json` file is easier than environment variables for service account.

---

### Step 8: Update Flutter App to Send FCM Token

**In your Flutter app, add this:**

```dart
import 'package:firebase_messaging/firebase_messaging.dart';

// Get FCM token
Future<String?> getFCMToken() async {
  FirebaseMessaging messaging = FirebaseMessaging.instance;
  String? token = await messaging.getToken();
  
  // Save this token to Firestore with user's phone number
  // So backend can send notifications
  return token;
}

// Listen for incoming notifications
FirebaseMessaging.onMessage.listen((RemoteMessage message) {
  print('Received notification: ${message.notification?.title}');
  // Show payment success dialog
});
```

---

### Step 9: Store FCM Token in Firestore

```dart
// In Flutter app, when user logs in or enters phone number
Future<void> saveFCMToken(String phoneNumber, String fcmToken) async {
  await FirebaseFirestore.instance
    .collection('users')
    .doc(phoneNumber)
    .set({
      'phoneNumber': phoneNumber,
      'fcmToken': fcmToken,
      'updatedAt': FieldValue.serverTimestamp(),
    }, SetOptions(merge: true));
}
```

---

## Complete Updated server.js

```javascript
// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { stkPush } = require("./mpesa");

// Initialize Firebase
const serviceAccount = require("./firebase-key.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Validation
function validatePaymentRequest(req, res, next) {
  const { phone, amount } = req.body;
  if (!phone || !amount) {
    return res.status(400).json({
      success: false,
      error: "Phone number and amount are required"
    });
  }
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({
      success: false,
      error: "Amount must be a positive number"
    });
  }
  const phoneRegex = /^254[0-9]{9}$/;
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number. Use format: 254712345678"
    });
  }
  next();
}

// STK Push endpoint
app.post("/api/mpesa/pay", validatePaymentRequest, async (req, res) => {
  try {
    console.log("=================================");
    console.log("STK PUSH REQUEST RECEIVED");
    console.log("Time:", new Date());
    console.log("Body:", req.body);
    console.log("=================================");
    
    const { phone, amount } = req.body;

    // Save pending transaction to Firestore
    const pendingRef = await db.collection("transactions").add({
      phoneNumber: phone,
      amount: amount,
      status: "pending",
      resultCode: null,
      resultDesc: null,
      mpesaReceiptNumber: null,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const result = await stkPush({
      phone,
      amount,
      accountReference: "Order1234",
      description: "Payment for goods",
    });

    // Update with MerchantRequestID and CheckoutRequestID
    await pendingRef.update({
      merchantRequestID: result.MerchantRequestID,
      checkoutRequestID: result.CheckoutRequestID,
    });

    res.json({ 
      success: true, 
      data: result,
      transactionId: pendingRef.id // Return Firestore document ID
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Callback endpoint - saves to Firestore
app.post("/api/mpesa/callback", async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    const { CheckoutRequestID, ResultCode, ResultDesc } = callbackData;

    // Prepare update data
    const updateData = {
      resultCode: ResultCode,
      resultDesc: ResultDesc,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (ResultCode === 0) {
      // Payment successful
      const items = callbackData.CallbackMetadata.Item;
      const amount = items.find(i => i.Name === "Amount")?.Value;
      const mpesaReceiptNumber = items.find(i => i.Name === "MpesaReceiptNumber")?.Value;
      const phoneNumber = items.find(i => i.Name === "PhoneNumber")?.Value;

      updateData.amount = amount;
      updateData.mpesaReceiptNumber = mpesaReceiptNumber;
      updateData.phoneNumber = phoneNumber;
      updateData.status = "success";

      console.log("✅ Payment success:", updateData);

      // Send notification (implement when you have FCM)
      await sendPaymentNotification(phoneNumber, amount, mpesaReceiptNumber);

    } else {
      // Payment failed
      updateData.status = "failed";
      console.log("❌ Payment failed:", ResultDesc);
    }

    // Update Firestore document
    await db.collection("transactions")
      .where("checkoutRequestID", "==", CheckoutRequestID)
      .get()
      .then(snapshot => {
        snapshot.forEach(doc => {
          doc.ref.update(updateData);
        });
      });

    res.json({ ResultCode: 0, ResultDesc: "Accepted" });

  } catch (error) {
    console.error("Callback error:", error);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// FCM notification function
async function sendPaymentNotification(phoneNumber, amount, receiptNumber) {
  try {
    // Get user's FCM token from Firestore
    const userDoc = await db.collection("users").doc(phoneNumber).get();
    
    if (userDoc.exists && userDoc.data().fcmToken) {
      const fcmToken = userDoc.data().fcmToken;

      const message = {
        notification: {
          title: "Payment Successful",
          body: `You paid KES ${amount}. Receipt: ${receiptNumber}`,
        },
        data: {
          type: "payment_success",
          amount: amount.toString(),
          receipt: receiptNumber,
          phone: phoneNumber,
        },
        token: fcmToken,
      };

      const response = await admin.messaging().send(message);
      console.log("FCM notification sent:", response);
    } else {
      console.log("No FCM token found for user:", phoneNumber);
    }
  } catch (error) {
    console.error("Error sending notification:", error);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
```

---

## Deployment Steps for Firebase Integration

### Step 1: Upload firebase-key.json to Render

1. **Locally secure your key**:
   - After downloading `firebase-key.json` from Firebase Console
   - Keep it safe and secure

2. **Upload to Render**:
   - Go to Render Dashboard → Your Service
   - Click **"Environment"** → **"Upload ZIP"**
   - Upload a ZIP containing `firebase-key.json`
   - OR use Render's persistent disk feature (paid plans only)

3. **Update server.js path**:
   ```javascript
   // If using Render's file system
   const serviceAccount = require("./firebase-key.json");
   
   // OR better: Use environment variable for JSON content
   const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
   ```

### Step 2: Better: Use Environment Variable for Firebase

Instead of uploading file, add this to Render Environment:

**Key**: `FIREBASE_SERVICE_ACCOUNT`  
**Value**: Paste entire JSON content from firebase-key.json as single-line string

Then in server.js:
```javascript
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
```

This is better because:
- No file management needed
- Works with Render's environment system
- Easier to update/rotate credentials

---

## Testing Firebase Integration

### Test 1: Verify Firestore Connection
```bash
# After deploying to Render
curl https://your-service.onrender.com/health
# Should connect successfully
```

### Test 2: Make Test Payment
```bash
curl -X POST https://your-service.onrender.com/api/mpesa/pay \
  -H "Content-Type: application/json" \
  -d "{\"phone\":\"254712345678\",\"amount\":1}"
```

### Test 3: Check Firestore
1. Go to Firebase Console → Firestore
2. Check `transactions` collection
3. You should see:
   - Document with `status: "pending"` (created during STK Push)
   - Document updated to `status: "success"` (after callback)
   - All payment details saved

---

## Flutter App Integration Complete Flow

### Flow Diagram
```
User taps "Pay with M-Pesa"
    ↓
Flutter sends POST to Render API
    ↓
Render creates pending transaction in Firestore
    ↓
Render calls Safaricom STK Push
    ↓
Safaricom sends STK Push to user's phone
    ↓
User enters PIN
    ↓
Safaricom calls Render callback
    ↓
Render updates Firestore (status: success)
    ↓
Render sends FCM notification
    ↓
User sees notification in Flutter app
    ↓
Flutter listens to Firestore for real-time updates
```

### Updated Flutter Code

```dart
// lib/services/mpesa_service.dart
import 'dart:convert';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:http/http.dart' as http;

class MpesaService {
  static const String baseUrl = 'https://mpesa-stk-push.onrender.com';
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;

  // Get FCM token and save to Firestore
  Future<void> setupFCM(String phoneNumber) async {
    FirebaseMessaging messaging = FirebaseMessaging.instance;
    String? token = await messaging.getToken();
    
    if (token != null) {
      await _firestore.collection('users').doc(phoneNumber).set({
        'phoneNumber': phoneNumber,
        'fcmToken': token,
        'updatedAt': FieldValue.serverTimestamp(),
      }, SetOptions(merge: true));
    }
  }

  // Listen for payment notifications
  Stream<DocumentSnapshot> listenToPaymentStatus(String checkoutRequestID) {
    return _firestore
      .collection('transactions')
      .doc(checkoutRequestID)
      .snapshots();
  }

  Future<Map<String, dynamic>> initiateSTKPush({
    required String phone,
    required double amount,
  }) async {
    try {
      final response = await http.post(
        Uri.parse('$baseUrl/api/mpesa/pay'),
        headers: {'Content-Type': 'application/json'},
        body: jsonEncode({'phone': phone, 'amount': amount}),
      );

      final data = jsonDecode(response.body);

      if (response.statusCode == 200 && data['success'] == true) {
        // Save FCM token for notifications
        await setupFCM(phone);
        
        // Listen for payment status updates
        final checkoutRequestID = data['data']['CheckoutRequestID'];
        listenToPaymentStatus(checkoutRequestID).listen((snapshot) {
          final data = snapshot.data();
          if (data != null && data['status'] == 'success') {
            // Show success dialog
            showPaymentSuccessDialog(data);
          }
        });

        return {
          'success': true,
          'data': data['data'],
        };
      } else {
        return {
          'success': false,
          'error': data['error'] ?? 'Payment failed',
        };
      }
    } catch (e) {
      return {
        'success': false,
        'error': 'Network error: $e',
      };
    }
  }

  void showPaymentSuccessDialog(Map<String, dynamic> data) {
    // Show dialog with payment details
    print('Payment successful!');
    print('Amount: ${data['amount']}');
    print('Receipt: ${data['mpesaReceiptNumber']}');
  }
}
```

---

## Benefits of This Integration

### ✅ Persistent Storage
- All transactions saved in Firestore
- Access payment history anytime
- Query by phone number, date range, status

### ✅ Real-time Updates
- Flutter app listens to Firestore changes
- Instant notification when payment completes
- No need to poll API

### ✅ Push Notifications
- User gets notified even if app is closed
- Works on Android, iOS, Web
- Customizable notification content

### ✅ Analytics & Reporting
- Track success/failure rates
- Monitor payment volumes
- Generate reports in Firebase Console

### ✅ Scalability
- Firestore auto-scales
- No database management needed
- Pay only for what you use

---

## Security Considerations

### ✅ Firestore Security Rules
Add rules in Firebase Console:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Only server can write transactions
    match /transactions/{document} {
      allow read: if true; // Or restrict to authenticated users
      allow write: if false; // Only backend (Render) can write
    }
    
    // Users can read/write their own data
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

### ✅ Backend Security
- Firebase service account key in environment variable
- Never expose key to client
- Use Render secrets management

---

## Cost Estimate

### Firebase (Free Tier - Spark Plan)
- Firestore: 1GB storage, 50K reads/day, 20K writes/day
- FCM: Unlimited notifications (free)
- **Cost**: $0/month (development)

### Firebase (Paid - Blaze Plan)
- Firestore: $0.18/GB storage, $0.06/100K reads
- FCM: Free
- **Estimated**: $5-20/month for production (depends on volume)

### Total with Render
- Render Free: $0 (development)
- Render Starter: $7/month (production)
- Firebase Free: $0
- **Total**: $7/month for complete production stack

---

## Troubleshooting

### Issue 1: "Permission denied" in Firestore
**Fix**: Check Security Rules - ensure backend has write access

### Issue 2: FCM notifications not received
**Fix**: 
- Check FCM token is valid
- Ensure user granted notification permissions
- Test with Firebase Console → Cloud Messaging

### Issue 3: Callback not updating Firestore
**Fix**:
- Check Firebase service account is valid
- Verify network connectivity from Render to Firebase
- Check Render logs for errors

---

## Next Steps

1. ✅ **Download firebase-key.json** from Firebase Console
2. ✅ **Add to .gitignore** (already done)
3. ✅ **Update server.js** with Firebase code (see above)
4. ✅ **Deploy to Render** with Firebase credentials
5. ✅ **Update Flutter app** to listen to Firestore
6. ✅ **Test end-to-end** payment flow
7. ✅ **Enable FCM notifications**

---

## Summary

Your backend will now:
1. ✅ Receive STK Push requests
2. ✅ Save to Firestore (not just logs)
3. ✅ Update transaction status on callback
4. ✅ Send push notifications to Flutter app
5. ✅ Provide real-time payment updates

This is production-ready architecture. Follow the steps above to implement Firebase integration.