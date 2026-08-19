# M-Pesa public certificate

Put Safaricom's **production** public certificate here as
`ProductionCertificate.cer` (or point `MPESA_CERT_PATH` at wherever you
put it instead).

This is **Safaricom's own public certificate** — it is not a secret and
is safe to commit to the repo. It is used to encrypt the
`SecurityCredential` field required by Initiator-based APIs (Account
Balance, B2C, Reversal). It is a different thing from your
`CONSUMER_KEY`/`CONSUMER_SECRET` OAuth credentials.

Download it from the Safaricom Daraja portal, under the Account
Balance or B2C API documentation for your app (Go-Live / production
apps get the production certificate; sandbox apps use a separate
sandbox certificate — don't mix them up, encrypting with the wrong one
will make every Account Balance request fail).
