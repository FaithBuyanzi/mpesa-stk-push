const fs = require("fs");
const path = require("path");
const { X509Certificate, publicEncrypt, constants } = require("crypto");

// Builds the M-Pesa "SecurityCredential" field: the Initiator password,
// RSA-encrypted (PKCS1 padding) against Safaricom's public certificate,
// base64-encoded. Required for Initiator-based APIs (Account Balance,
// B2C, etc.) - separate from the OAuth consumer key/secret used
// elsewhere in this app.
//
// The certificate itself is Safaricom's PUBLIC certificate, not a
// secret - safe to commit to the repo. X509Certificate parses both PEM
// and DER, so the file's exact format doesn't matter.
function buildSecurityCredential(initiatorPassword) {
  if (!initiatorPassword) {
    throw new Error("initiatorPassword is required");
  }

  const certPath = process.env.MPESA_CERT_PATH
    ? path.resolve(process.env.MPESA_CERT_PATH)
    : path.join(__dirname, "certs", "ProductionCertificate.cer");

  if (!fs.existsSync(certPath)) {
    throw new Error(`M-Pesa certificate not found at ${certPath}`);
  }

  const certBuffer = fs.readFileSync(certPath);
  const cert = new X509Certificate(certBuffer);

  const encrypted = publicEncrypt(
    {
      key: cert.publicKey,
      padding: constants.RSA_PKCS1_PADDING,
    },
    Buffer.from(initiatorPassword, "utf8")
  );

  return encrypted.toString("base64");
}

module.exports = { buildSecurityCredential };
