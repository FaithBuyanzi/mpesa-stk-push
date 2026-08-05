# Testing Your Deployed Service

## Windows Command Prompt (cmd.exe)

### Test 1: Health Check
```cmd
curl https://mpesa-stk-push-yb9i.onrender.com/health
```

### Test 2: Firebase Connection
```cmd
curl https://mpesa-stk-push-yb9i.onrender.com/test-firestore
```

### Test 3: M-Pesa Payment (Single Line for Windows)
```cmd
curl -X POST https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/pay -H "Content-Type: application/json" -d "{\"phone\":\"254712345678\",\"amount\":1}"
```

**OR use PowerShell (better for complex commands):**
```powershell
Invoke-RestMethod -Uri "https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/pay" -Method POST -ContentType "application/json" -Body '{"phone":"254712345678","amount":1}'
```

---

## Linux/Mac Terminal

### Test 1: Health Check
```bash
curl https://mpesa-stk-push-yb9i.onrender.com/health
```

### Test 2: Firebase Connection
```bash
curl https://mpesa-stk-push-yb9i.onrender.com/test-firestore
```

### Test 3: M-Pesa Payment
```bash
curl -X POST https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/pay \
  -H "Content-Type: application/json" \
  -d '{"phone":"254712345678","amount":1}'
```

---

## Expected Responses

### Health Check (Should work ✅)
```json
{"status":"OK","timestamp":"2026-07-31T08:49:41.264Z"}
```

### Firebase Test (Should work ✅)
```json
{"success":true,"documentId":"ouADSgdTqU9hoFTBdkoR"}
```

### M-Pesa Payment (May fail ❌ - see troubleshooting below)
**Success:**
```json
{
  "success": true,
  "data": {
    "MerchantRequestID": "12345-67890-12345",
    "CheckoutRequestID": "ws_CO_15012024000000000000001",
    "ResponseCode": "0",
    "ResponseDescription": "Success. Request accepted for processing"
  }
}
```

**Error (if M-Pesa vars not set):**
```json
{
  "success": false,
  "error": "CONSUMER_KEY is not defined"
}
```

---

## Troubleshooting: "Internal Server Error"

If you get `Internal Server Error` when testing `/api/mpesa/pay`, check Render logs:

### Step 1: Check Render Logs
1. Go to https://dashboard.render.com
2. Click on your service: `mpesa-stk-push`
3. Click **"Logs"** tab
4. Look for error messages when you make the payment request

### Step 2: Verify M-Pesa Environment Variables

The most common cause is **missing M-Pesa credentials** in Render.

**Required in Render Dashboard → Environment:**

```env
# M-Pesa API Credentials (from Safaricom Developer Portal)
CONSUMER_KEY=your_actual_consumer_key
CONSUMER_SECRET=your_actual_consumer_secret

# M-Pesa Configuration
SHORTCODE=174379
PASSKEY=your_actual_passkey

# Safaricom API Endpoint
BASE_URL=https://sandbox.safaricom.co.ke

# Callback URL (must be publicly accessible HTTPS endpoint)
CALLBACK_URL=https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/callback

# Firebase (should already be set ✅)
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}

# Server
NODE_ENV=production
```

### Step 3: Get M-Pesa Credentials

If you don't have M-Pesa credentials yet:

1. Go to https://developer.safaricom.co.ke
2. Create an account or log in
3. Create a new app
4. Copy:
   - **Consumer Key**
   - **Consumer Secret**
   - **Passkey** (for your shortcode)
5. Add these to Render environment variables

### Step 4: Common Errors and Solutions

**Error: "CONSUMER_KEY is not defined"**
- **Fix**: Add `CONSUMER_KEY` to Render environment variables

**Error: "CONSUMER_SECRET is not defined"**
- **Fix**: Add `CONSUMER_SECRET` to Render environment variables

**Error: "PASSKEY is not defined"**
- **Fix**: Add `PASSKEY` to Render environment variables

**Error: "Cannot read properties of undefined (reading 'data')"**
- **Fix**: Check that `BASE_URL` is correct (sandbox vs production)

**Error: "Invalid phone number"**
- **Fix**: Use format `254712345678` (no spaces, starts with 254)

---

## Testing Without Real M-Pesa Credentials

If you want to test the endpoint structure without real M-Pesa credentials, you can temporarily modify the code to return mock data. But for production, you need real credentials.

---

## Verify All Environment Variables Are Set

Run this in Render Dashboard → Your Service → **Logs**:

Look for these logs when the server starts:
- ✅ Firebase service account parsed successfully
- ✅ Firebase initialized successfully
- ✅ Firestore database instance created
- ✅ Server running on port 10000

If you see errors about missing environment variables, add them in Render Dashboard → Environment.

---

## Quick Checklist

- [ ] Firebase service account is set (✅ Already working)
- [ ] CONSUMER_KEY is set in Render
- [ ] CONSUMER_SECRET is set in Render
- [ ] PASSKEY is set in Render
- [ ] SHORTCODE is set in Render (default: 174379)
- [ ] BASE_URL is set in Render (sandbox: https://sandbox.safaricom.co.ke)
- [ ] CALLBACK_URL is set in Render (https://mpesa-stk-push-yb9i.onrender.com/api/mpesa/callback)
- [ ] Safaricom Developer Portal callback URL matches

---

## Next Steps After M-Pesa Works

1. **Test with real phone number** in Safaricom sandbox
2. **Check Firebase Console** for transaction records
3. **Update Flutter app** with production API URL
4. **Switch to production** when ready (update BASE_URL, credentials, etc.)

---

## Support

If you're still getting errors:
1. Check Render logs for specific error messages
2. Verify all environment variables are set correctly
3. Test M-Pesa credentials with Safaricom API directly
4. Ensure your Safaricom app is in "Sandbox" mode for testing