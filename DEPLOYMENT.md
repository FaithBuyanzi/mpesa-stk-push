# Deployment Guide for Render

## Prerequisites

Before deploying to Render, ensure you have:

1. ✅ Firebase project created with Firestore enabled
2. ✅ Firebase service account key downloaded
3. ✅ M-Pesa Safaricom developer account credentials
4. ✅ GitHub repository with your code pushed

---

## Step 1: Prepare Firebase Service Account

### 1.1 Download Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Click the gear icon ⚙️ → **Project Settings**
4. Go to **Service Accounts** tab
5. Click **"Generate new private key"**
6. Save the JSON file (e.g., `firebase-key.json`)
7. **IMPORTANT**: Keep this file secure, never commit to Git

### 1.2 Format the Service Account for Environment Variable

You need to convert the JSON file to a single-line string for Render:

**Option A: Using Node.js (Recommended)**
```bash
node -e "console.log(JSON.stringify(require('./firebase-key.json')))"
```
Copy the output and paste it as the value for `FIREBASE_SERVICE_ACCOUNT`

**Option B: Manual Conversion**
1. Open `firebase-key.json` in a text editor
2. Remove all line breaks (make it one long line)
3. Escape any double quotes inside the JSON (replace `"` with `\"`)
4. Ensure newlines are represented as `\n`

**Example format:**
```
{"type":"service_account","project_id":"my-project","private_key_id":"abc123","private_key":"-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC7...\n-----END PRIVATE KEY-----\n","client_email":"firebase-adminsdk-xxxx@my-project.iam.gserviceaccount.com",...}
```

---

## Step 2: Deploy to Render

### 2.1 Create New Web Service

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository
4. Select the repository containing this code

### 2.2 Configure Service Settings

**Basic Settings:**
- **Name**: `mpesa-stk-push` (or your preferred name)
- **Region**: Choose closest to your users (e.g., Frankfurt for Kenya)
- **Branch**: `main` (or your default branch)
- **Runtime**: `Node`

**Build & Deploy:**
- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- **Plan**: Free (for testing) or Starter ($7/month for production)

### 2.3 Add Environment Variables

Click **"Environment"** tab and add the following:

#### Required Environment Variables:

**M-Pesa Credentials:**
```
Key: CONSUMER_KEY
Value: your_consumer_key_from_safaricom

Key: CONSUMER_SECRET
Value: your_consumer_secret_from_safaricom

Key: SHORTCODE
Value: 174379 (or your paybill number)

Key: PASSKEY
Value: your_passkey_from_safaricom

Key: BASE_URL
Value: https://sandbox.safaricom.co.ke (or https://api.safaricom.co.ke for production)

Key: CALLBACK_URL
Value: https://your-service-name.onrender.com/api/mpesa/callback
```

**Firebase Configuration:**
```
Key: FIREBASE_SERVICE_ACCOUNT
Value: [Paste the entire JSON string from Step 1.2 here]
```

**Server Configuration:**
```
Key: NODE_ENV
Value: production

Key: PORT
Value: 3000 (Render will override this automatically)
```

### 2.4 Deploy

1. Click **"Create Web Service"**
2. Wait for the build to complete (2-3 minutes)
3. Monitor the logs for any errors

---

## Step 3: Verify Deployment

### 3.1 Check Health Endpoint

Once deployed, test the health endpoint:

```bash
curl https://your-service-name.onrender.com/health
```

**Expected Response:**
```json
{
  "status": "OK",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### 3.2 Check Render Logs

In Render Dashboard:
1. Go to your service → **Logs** tab
2. Look for these success messages:
   ```
   ✅ Firebase service account parsed successfully
      Project ID: your-project-id
   ✅ Firebase initialized successfully
   ✅ Firestore database instance created
   Server running on port 3000
   ```

### 3.3 Test Firebase Connection

Test the Firestore connection:

```bash
curl https://your-service-name.onrender.com/test-firestore
```

**Expected Response:**
```json
{
  "success": true,
  "documentId": "abc123xyz"
}
```

---

## Step 4: Configure Safaricom Callback URL

1. Go to [Safaricom Developer Portal](https://developer.safaricom.co.ke)
2. Navigate to your app settings
3. Update the **Callback URL** to:
   ```
   https://your-service-name.onrender.com/api/mpesa/callback
   ```
4. Save changes

---

## Step 5: Test Payment Flow

### 5.1 Initiate Test Payment

```bash
curl -X POST https://your-service-name.onrender.com/api/mpesa/pay \
  -H "Content-Type: application/json" \
  -d '{"phone":"254712345678","amount":1}'
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "MerchantRequestID": "12345-67890-12345",
    "CheckoutRequestID": "ws_CO_15012024000000000000001",
    "ResponseCode": "0",
    "ResponseDescription": "Success. Request accepted for processing",
    "CustomerMessage": "Success. Request accepted for processing"
  }
}
```

### 5.2 Verify in Firebase Console

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Firestore Database**
3. Check the `transactions` collection
4. You should see:
   - Document with `status: "pending"` (created during STK Push)
   - Document updated to `status: "success"` (after callback)

---

## Common Issues & Solutions

### Issue 1: "FIREBASE_SERVICE_ACCOUNT is not set"

**Solution:**
- Double-check that you added the environment variable in Render
- Ensure there are no extra spaces or quotes around the value
- The value should be a single-line JSON string

### Issue 2: "Failed to parse FIREBASE_SERVICE_ACCOUNT"

**Solution:**
- Validate your JSON using: https://jsonlint.com/
- Ensure all double quotes are escaped with backslash: `\"`
- Ensure newlines are converted to `\n`
- Use the Node.js command in Step 1.2 to generate the string

### Issue 3: "Permission denied" in Firestore

**Solution:**
- Check Firebase Security Rules
- Ensure your service account has proper permissions
- Verify the Firestore database is created in Firebase Console

### Issue 4: "Cannot read properties of undefined (reading 'length')"

**Solution:**
- This was the original error - it's now fixed in `firebase.js`
- Ensure you've pulled the latest code
- Redeploy the service

### Issue 5: M-Pesa callback not working

**Solution:**
- Ensure your Render service is running (not sleeping on free plan)
- Check that CALLBACK_URL is publicly accessible (HTTPS required)
- Verify the callback URL in Safaricom Developer Portal matches exactly
- Check Render logs for incoming callback requests

---

## Production Checklist

Before going live with real payments:

- [ ] Switch `BASE_URL` from sandbox to production: `https://api.safaricom.co.ke`
- [ ] Update `SHORTCODE` to your production paybill/till number
- [ ] Update `PASSKEY` to your production passkey
- [ ] Update `CONSUMER_KEY` and `CONSUMER_SECRET` to production credentials
- [ ] Update `CALLBACK_URL` to your production domain
- [ ] Upgrade Render plan to Starter ($7/month) to avoid sleeping
- [ ] Set up Firestore Security Rules (see FIREBASE_INTEGRATION.md)
- [ ] Test with real M-Pesa account in production mode
- [ ] Monitor Render logs and Firebase Console for errors
- [ ] Set up error alerting (optional)

---

## Monitoring & Maintenance

### Monitor These Metrics:

1. **Render Logs**: Check for errors and successful transactions
2. **Firebase Console**: Monitor Firestore reads/writes
3. **Safaricom Dashboard**: Track API usage and success rates
4. **Render Metrics**: Monitor CPU, memory, and response times

### Regular Maintenance:

- **Weekly**: Review failed transactions in Firestore
- **Monthly**: Check Firebase usage against free tier limits
- **Quarterly**: Rotate M-Pesa API credentials (security best practice)
- **As Needed**: Update dependencies with `npm update`

---

## Cost Estimate

### Render:
- **Free Plan**: $0/month (sleeps after 15 mins of inactivity)
- **Starter Plan**: $7/month (always on, recommended for production)

### Firebase (Spark Plan - Free):
- Firestore: 1GB storage, 50K reads/day, 20K writes/day
- FCM: Unlimited notifications
- **Cost**: $0/month

### Total Monthly Cost:
- **Development**: $0 (Render Free + Firebase Free)
- **Production**: $7/month (Render Starter + Firebase Free)

---

## Support

If you encounter issues:

1. Check Render logs first (most errors are logged there)
2. Verify all environment variables are set correctly
3. Test Firebase connection with `/test-firestore` endpoint
4. Check Firebase Console for Firestore errors
5. Review Safaricom API documentation for M-Pesa errors

---

## Next Steps After Deployment

1. ✅ Update Flutter app to use production API URL
2. ✅ Implement FCM notifications (see FIREBASE_INTEGRATION.md)
3. ✅ Add user authentication (optional)
4. ✅ Set up payment history screen in Flutter app
5. ✅ Configure custom domain (optional)
6. ✅ Set up monitoring and alerts (optional)