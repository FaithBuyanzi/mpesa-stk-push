// security_credential.js
//
// Builds the "SecurityCredential" field required by Safaricom's
// Initiator-based APIs (Account Balance, B2C, Reversal, etc). This is
// NOT the same thing as the CONSUMER_KEY/CONSUMER_SECRET OAuth
// credentials used by STK Push and C2B - it's a separate mechanism:
//
//   SecurityCredential = base64( RSA_PKCS1_encrypt(InitiatorPassword,
//                                                    SafaricomPublicCert) )
//
// The Initiator name/password are configured for your app on the
// Daraja portal (separate from your OAuth consumer key/secret), and
// the public certificate is Safaricom's own certificate (NOT secret -
// safe to keep in the repo), published on the Daraja portal under the
// Account Balance / B2C / Reversal API documentation. Safaricom
// specifically requires PKCS1 v1.5 padding here (not OAEP) - this
// matches their official PHP/Java sample code.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function buildSecurityCredential() {
  const password = process.env.INITIATOR_PASSWORD;

  if (!password) {
    throw new Error(
      "INITIATOR_PASSWORD is not configured. This is the password for " +
        "the Initiator name set up on the Daraja portal for Account " +
        "Balance/B2C-type APIs - it is NOT your CONSUMER_SECRET."
    );
  }

  const certPath =
    process.env.MPESA_CERT_PATH ||
    path.join(__dirname, "certs", "ProductionCertificate.cer");

  if (!fs.existsSync(certPath)) {
    throw new Error(
      `M-Pesa public certificate not found at "${certPath}". Download ` +
        "the production certificate from the Safaricom Daraja portal " +
        "(Account Balance / B2C API documentation) and place it there, " +
        "or point MPESA_CERT_PATH at wherever you've stored it. This " +
        "file is Safaricom's own public certificate - it is not secret " +
        "and is safe to commit."
    );
  }

  // Safaricom distributes this certificate as either PEM (text,
  // "-----BEGIN CERTIFICATE-----...") or DER (raw binary) depending on
  // where you download it from. Read it as raw bytes and let
  // X509Certificate figure out which one it is - it accepts both -
  // rather than assuming one and failing obscurely if it's the other.
  let publicKey;
  try {
    const certBytes = fs.readFileSync(certPath);
    publicKey = new crypto.X509Certificate(certBytes).publicKey;
  } catch (err) {
    throw new Error(
      `Could not read "${certPath}" as an X.509 certificate (PEM or ` +
        `DER): ${err.message}. Make sure it's the certificate file ` +
        "itself, not something else saved with a .cer extension."
    );
  }

  const encrypted = crypto.publicEncrypt(
    {
      key: publicKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(password, "utf8")
  );

  return encrypted.toString("base64");
}

module.exports = { buildSecurityCredential };
