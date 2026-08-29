# Deploying the M-Pesa Backend to AWS EC2

Replaces the Render deployment described in `DEPLOYMENT.md`.

**Why this matters more than a normal Node deploy:** Safaricom pushes payment
confirmations to this server. If the server is unreachable when a customer pays,
that payment is silently lost until someone runs the Pull API recovery endpoint.
So HTTPS, a fixed IP, auto-restart and boot-persistence are not optional
niceties here — they are the whole point of moving off Render's free tier.

---

## What you need before starting

| Thing | Why |
|---|---|
| AWS account | To create the instance |
| A domain name (or subdomain) | Safaricom callbacks require **HTTPS with a valid certificate**. You cannot use a bare EC2 IP or the `*.compute.amazonaws.com` hostname — Let's Encrypt will not issue a cert for those. |
| Your Firebase service account JSON | For `FIREBASE_SERVICE_ACCOUNT` |
| Your Daraja production credentials | Consumer key/secret, passkey, initiator password |
| Access to the Daraja portal | To re-point the callback URLs at the new host |

If you don't own a domain yet, buy one (Namecheap / Route 53 / Truehost) before
you start — everything after Step 6 depends on it.

---

## Step 1 — Launch the EC2 instance

AWS Console → EC2 → **Launch instance**

| Setting | Value |
|---|---|
| Name | `selete-agro-backend` |
| AMI | **Ubuntu Server 24.04 LTS**. Match the architecture to the instance: **Arm64** for any `t4g.*`, **64-bit x86** for `t3.*`. Picking the wrong one is the most common first-attempt mistake. |
| Instance type | **`t4g.micro`** (2 vCPU, 1 GB) — what this guide is tuned for. The app idles at ~67 MB RSS and the dependency tree is pure JS with no native modules to compile on ARM, so 1 GB is comfortable. `t4g.nano` (512 MB) also works but needs tighter limits — see [sizing](#sizing-and-memory-tuning). |
| Key pair | Create a new one, download the `.pem`, keep it safe — you cannot re-download it |
| Storage | 12 GB gp3. `node_modules` is 77 MB and a base Ubuntu install is ~2.6 GB, so this leaves ample room for the swap file and logs. |

**Network settings → Edit**, create a security group with these inbound rules:

| Type | Port | Source | Why |
|---|---|---|---|
| SSH | 22 | **My IP** | Admin access. Do NOT use 0.0.0.0/0. |
| HTTP | 80 | 0.0.0.0/0 | Let's Encrypt validation + redirect to HTTPS |
| HTTPS | 443 | 0.0.0.0/0 | Safaricom callbacks + your Flutter app |

> Safaricom's callback servers come from a range they don't publish reliably, so
> 443 must stay open to the world. Leave port 3000 **closed** — Caddy proxies to
> it over localhost.

Launch it.

---

## Step 2 — Attach an Elastic IP (do not skip)

A default EC2 public IP **changes every time the instance stops and starts**.
Your DNS record and Safaricom's registered URLs would break silently.

EC2 → **Elastic IPs** → Allocate Elastic IP address → Allocate → select it →
**Actions → Associate Elastic IP address** → choose your instance → Associate.

Note the IP. It's `<ELASTIC_IP>` below.

---

## Step 3 — Point your domain at the instance

In your DNS provider, create an **A record**:

```
Type:  A
Name:  api            (gives you api.yourdomain.com)
Value: <ELASTIC_IP>
TTL:   300
```

Verify it resolves before continuing — Caddy's certificate request will fail
otherwise:

```bash
dig +short api.yourdomain.com
# must print <ELASTIC_IP>
```

DNS can take 5–30 minutes. Wait for it.

---

## Step 4 — Connect

```bash
chmod 400 selete-agro-key.pem
ssh -i selete-agro-key.pem ubuntu@<ELASTIC_IP>
```

On Windows, the same command works in PowerShell (OpenSSH ships with Windows
11). If `chmod` isn't available, right-click the `.pem` → Properties → Security
→ disable inheritance and grant only your own user read access.

---

## Step 5 — Prepare the server

### 5a. Swap — do this FIRST on anything under 2 GB

Before installing anything. `npm ci` is the most memory-hungry thing that will
ever run on this box: on 512 MB it gets OOM-killed outright, and on 1 GB it can
still spike close enough to the ceiling to be worth insuring against. An
interrupted install leaves a corrupt `node_modules` that fails later with errors
looking nothing like "out of memory".

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Only swap under real pressure - EBS-backed swap is slow
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

free -h    # confirm 2.0Gi swap
```

Swap here is an **OOM safety net, not extra RAM**. If the app is actively
swapping in steady state, the instance is too small — check with `vmstat 1`
(the `si`/`so` columns should sit at 0).

### 5b. Packages

```bash
sudo apt update && sudo apt upgrade -y

# Node.js 20 LTS (package.json requires >=18). NodeSource ships arm64.
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

node -v    # expect v20.x
npm -v
uname -m   # aarch64 on t4g, x86_64 on t3
```

Enable the host firewall as a second layer behind the security group:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw --force enable
```

---

## Step 6 — Deploy the code

```bash
sudo mkdir -p /var/www
sudo chown ubuntu:ubuntu /var/www
cd /var/www

git clone https://github.com/FaithBuyanzi/mpesa-stk-push.git selete-agro-backend
cd selete-agro-backend

npm ci --omit=dev
```

Use `npm ci`, not `npm install` — it installs the exact versions pinned in
`package-lock.json`, which is what you want on a payment server.

---

## Step 7 — Create the `.env` file

```bash
nano /var/www/selete-agro-backend/.env
```

Paste this, replacing every placeholder and every `api.yourdomain.com`:

```ini
# ---- Daraja OAuth ----
CONSUMER_KEY=your_production_consumer_key
CONSUMER_SECRET=your_production_consumer_secret

# ---- Lipa na M-Pesa / Buy Goods Till ----
SHORTCODE=your_buy_goods_till_number
PASSKEY=your_till_passkey
PARTY_B=4363881

# ---- Safaricom endpoints ----
BASE_URL=https://api.safaricom.co.ke
MPESA_BASE_URL=https://api.safaricom.co.ke

# ---- Callback URLs (ALL must point at your new EC2 domain) ----
CALLBACK_URL=https://api.yourdomain.com/api/mpesa/callback
C2B_VALIDATION_URL=https://api.yourdomain.com/api/c2b/validation
C2B_CONFIRMATION_URL=https://api.yourdomain.com/api/c2b/confirmation
PULL_CALLBACK_URL=https://api.yourdomain.com/api/mpesa/pull/callback
ACCOUNT_BALANCE_RESULT_URL=https://api.yourdomain.com/api/mpesa/account-balance/result
ACCOUNT_BALANCE_TIMEOUT_URL=https://api.yourdomain.com/api/mpesa/account-balance/timeout

# ---- Account Balance (Initiator credentials) ----
INITIATOR_NAME=your_initiator_name
INITIATOR_PASSWORD=your_initiator_password
ACCOUNT_BALANCE_SHORTCODE=your_account_balance_shortcode
MPESA_CERT_PATH=

# ---- Pull Transactions API ----
PULL_NOMINATED_NUMBER=2547XXXXXXXX

# ---- Firebase (entire service-account JSON on ONE line) ----
FIREBASE_SERVICE_ACCOUNT={"type":"service_account","project_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\nXXX\n-----END PRIVATE KEY-----\n","client_email":"..."}

# ---- Server ----
PORT=3000
NODE_ENV=production
```

Save with `Ctrl+O`, `Enter`, `Ctrl+X`, then lock the file down — it holds your
Firebase private key and M-Pesa secrets:

```bash
chmod 600 /var/www/selete-agro-backend/.env
```

> **Generating the one-line `FIREBASE_SERVICE_ACCOUNT`:** on your local machine
> run `node -e "console.log(JSON.stringify(require('./firebase-key.json')))"`
> and paste the output. The `\n` escapes inside `private_key` must survive
> verbatim — don't let an editor reformat them.

Smoke-test before wiring up the proxy:

```bash
cd /var/www/selete-agro-backend
node server.js
```

You should see the Firebase init lines and `Server running on port 3000`.
`Ctrl+C` to stop.

---

## Step 8 — Run it under systemd (restarts + survives reboots)

Use **systemd, not PM2**. PM2 runs a supervisor daemon that costs 30–50 MB of
resident memory to do a job systemd already does natively. systemd gives you
auto-restart, boot persistence, log management and memory caps for free, with no
extra process to supervise the supervisor.

```bash
sudo nano /etc/systemd/system/selete-agro.service
```

```ini
[Unit]
Description=Selete Agro M-Pesa backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu

# server.js calls dotenv.config(), which reads .env from the working directory.
# Deliberately NOT using systemd's EnvironmentFile= here: systemd applies its
# own C-style escape processing, which mangles the \n sequences inside the
# FIREBASE_SERVICE_ACCOUNT private key and produces an unusable credential.
# Letting dotenv parse the file keeps it byte-for-byte.
WorkingDirectory=/var/www/selete-agro-backend

# Cap V8's heap. Without this Node sizes old-space from total system memory
# and will happily grow into swap before garbage collecting. 384 MB is ~20x the
# app's measured 17 MB heap - generous headroom, while still leaving room for
# the OS page cache on a 1 GB box. Use 192 on a 512 MB instance.
ExecStart=/usr/bin/node --max-old-space-size=384 server.js

Restart=always
RestartSec=5

# Hard ceiling. If the app ever leaks, systemd kills and restarts it instead
# of letting the OOM killer pick a victim (which might be caddy or sshd).
# Sits above the heap cap to allow for non-heap RSS. Use 300M on 512 MB.
MemoryMax=512M

StandardOutput=journal
StandardError=journal
SyslogIdentifier=selete-agro

[Install]
WantedBy=multi-user.target
```

> The app loads `.env` itself via `dotenv`, relative to `WorkingDirectory`. So
> the `.env` from Step 7 works unchanged — including the single-line
> `FIREBASE_SERVICE_ACCOUNT` JSON with its `\n` escapes intact.

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now selete-agro

sudo systemctl status selete-agro
curl http://localhost:3000/health
```

Cap the journal so logs can't fill the disk:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=14day\n' \
  | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo systemctl restart systemd-journald
```

---

## Step 9 — Caddy reverse proxy (with automatic HTTPS)

Caddy provisions and renews the Let's Encrypt certificate itself, so it replaces
both the reverse proxy **and** certbot. No snapd, no renewal timer to verify, no
separate TLS step. It costs ~10 MB more resident memory than nginx — irrelevant
on 1 GB, and worth it for having one moving part instead of three.

Install from Caddy's official apt repo (arm64 is supported):

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list

sudo apt update && sudo apt install -y caddy
```

Write the config:

```bash
sudo nano /etc/caddy/Caddyfile
```

Replace the entire file with this — yes, this is the whole thing:

```caddyfile
{
    # Let's Encrypt sends expiry warnings here. Use a real address.
    email you@yourdomain.com
}

api.yourdomain.com {
    reverse_proxy 127.0.0.1:3000 {
        # Safaricom retries slow callbacks - give the app room to respond
        transport http {
            read_timeout 60s
        }
    }

    encode gzip
}
```

Access logs go to journald by default, which is where `journalctl -u caddy`
reads from and which Step 8 already size-capped — so there is nothing else to
configure.

> **Don't add a `log { output file ... }` block without creating the directory
> first.** Caddy runs as the unprivileged `caddy` user; if `/var/log/caddy`
> doesn't exist or isn't writable by it, `systemctl reload caddy` fails with
> `setting up custom log 'log0': opening log writer`. If you do want a separate
> access-log file:
> ```bash
> sudo mkdir -p /var/log/caddy
> sudo chown caddy:caddy /var/log/caddy
> ```

Caddy sets `X-Forwarded-For`, `X-Forwarded-Proto` and `Host` on proxied requests
by default, and redirects HTTP → HTTPS automatically. There is nothing to add
for either.

Validate and load:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy
```

On first load Caddy contacts Let's Encrypt and provisions the certificate. That
needs **port 80 reachable from the internet** and the A record from Step 3
already resolving. Watch it happen:

```bash
journalctl -u caddy -f
```

Look for `certificate obtained successfully`. If it fails, the message names the
reason — almost always DNS not yet propagated or port 80 blocked in the security
group.

Verify from **outside** the server — your own laptop, not the instance:

```bash
curl https://api.yourdomain.com/health
```

It must return `{"status":"OK","timestamp":"..."}` with no certificate warning.

---

## Step 10 — Confirm renewal is handled

Nothing to configure — Caddy renews automatically, in-process, roughly 30 days
before expiry. This step is just knowing how to check it.

```bash
# Certificates and their expiry, as Caddy sees them
sudo ls -la /var/lib/caddy/.local/share/caddy/certificates/

# Renewal activity appears in the service log
journalctl -u caddy | grep -i 'certificate\|renew'
```

The one failure mode to know about: renewal needs port 80 to stay open. If you
ever tighten the security group to 443-only, renewals will start failing
silently ~60 days later. Leave 80 open.

---

## Step 11 — Re-point Safaricom at the new host

**This is the step people forget, and it's the one that loses money.** Until you
do it, Safaricom is still posting confirmations to the old Render URL.

Register the C2B validation/confirmation URLs:

```bash
curl -X POST https://api.yourdomain.com/api/c2b/register
```

Re-register the Pull Transactions API:

```bash
curl -X POST https://api.yourdomain.com/api/mpesa/pull/register
```

`ResponseCode 1001` from the Pull register means "already registered" — that is
success, not an error.

Then in the **Daraja portal**, update the STK Push callback URL for your app to
`https://api.yourdomain.com/api/mpesa/callback`.

---

## Step 12 — Verify end to end

```bash
# 1. Health
curl https://api.yourdomain.com/health

# 2. Firestore connectivity (writes a doc to the `test` collection)
curl https://api.yourdomain.com/test-firestore

# 3. Real STK push to your own phone (KSh 1)
curl -X POST https://api.yourdomain.com/api/mpesa/pay \
  -H "Content-Type: application/json" \
  -d '{"phone":"2547XXXXXXXX","amount":1}'
```

Watch the callback land:

```bash
journalctl -u selete-agro -f
```

You want `========== STK CALLBACK ==========` followed by
`========== STK PAYMENT ==========`. If the push arrives on the phone but the
callback never logs, the problem is DNS / TLS / security group — not the app.

Then make a **real Till payment** from a phone to confirm the C2B path, and
check that `c2b_transactions` gets a new document in Firestore.

---

## Step 13 — Point the Flutter app at the new backend

Update the base URL in the Flutter app from the Render host to
`https://api.yourdomain.com` and ship a new build.

---

## Step 14 — Retire the Render leftovers

Once real payments are confirmed landing on EC2:

1. **Delete `.github/workflows/keep-alive.yml`.** It exists only to stop
   Render's free tier from sleeping. EC2 doesn't sleep, and the workflow would
   keep pinging a dead host every 10 minutes forever.
   ```bash
   git rm .github/workflows/keep-alive.yml
   ```
2. Suspend or delete the Render service so it can't receive stray callbacks.
3. Update `DEPLOYMENT.md` and `DEPLOYMENT_INSTRUCTIONS.md`, which still describe
   the Render flow.

---

## Redeploying after a code change

```bash
cd /var/www/selete-agro-backend
git pull
npm ci --omit=dev
sudo systemctl restart selete-agro
journalctl -u selete-agro -n 30 --no-pager
```

`.env` is gitignored, so it survives a `git pull` untouched. Note that
`systemctl restart` — not `reload` — is required after changing `.env`, since
dotenv reads it once at process start.

---

## Operations cheat-sheet

```bash
sudo systemctl status selete-agro       # is it running?
journalctl -u selete-agro -f            # live logs
sudo systemctl restart selete-agro      # restart
systemd-cgtop                           # per-service CPU / memory
sudo systemctl reload caddy             # after editing /etc/caddy/Caddyfile
journalctl -u caddy -f                  # proxy + TLS renewal logs
df -h                                   # disk
free -h                                 # memory + swap
vmstat 1                                # si/so columns = active swapping
```


### Sizing and memory tuning

Measured footprint of this app:

| | |
|---|---|
| Node baseline | 46 MB RSS |
| App loaded and listening | **67 MB RSS** (17 MB heap used) |
| Under Firestore/gRPC load | ~100–150 MB expected |
| `node_modules` on disk | 77 MB |

Budget on **t4g.micro (1 GB)**: Ubuntu ~150 MB + caddy ~25 MB + app ~150 MB peak
≈ **315 MB**, leaving roughly 700 MB free for the OS page cache and headroom.
That is a comfortable margin, not a tight one — this is the recommended size.

Tuning values by instance:

| | `t4g.nano` (512 MB) | `t4g.micro` (1 GB) |
|---|---|---|
| `--max-old-space-size` | 192 | **384** |
| `MemoryMax` | 300M | **512M** |
| Swap | Mandatory | Recommended |
| Remove snapd | Yes | Worthwhile (~80 MB) |

What eats headroom on either size:

- **PM2** (30–50 MB) — use systemd instead, per Step 8.
- **snapd** (~80 MB) — nothing in this guide needs it (Caddy comes from apt and
  handles TLS itself). If snapd is present and you use no snaps, reclaim it:
  ```bash
  sudo systemctl disable --now snapd.service snapd.socket snapd.seeded.service
  # or remove entirely: sudo apt purge -y snapd
  ```
- **`npm ci` without swap** — the peak memory event on the box. Step 5a.
- **Unbounded V8 heap** — Node sizes old-space from *total system* memory and
  will grow into swap before collecting. The `--max-old-space-size` above caps
  it. Note this is a *ceiling*, not a reservation: the app still runs at its
  measured ~17 MB heap and only grows if something genuinely needs the space.

Check what's actually resident:

```bash
ps -eo rss,comm --sort=-rss | head -12   # top consumers, KB
systemctl status selete-agro | grep Memory
free -h
```

CPU is not a concern at either size — 2 burstable vCPUs are far more than these
callback volumes need. If you ever do outgrow 1 GB, the symptom to watch for is
sustained swap activity in `vmstat 1`, not CPU.

### Recovering payments missed during downtime

If the server was down or unreachable, C2B confirmations Safaricom tried to
deliver are gone from the callback path. Recover them (max 48 hours back):

```bash
curl -G https://api.yourdomain.com/api/mpesa/pull/query \
  --data-urlencode "startDate=2026-08-29 00:00:00" \
  --data-urlencode "endDate=2026-08-29 23:59:59" \
  --data-urlencode "offset=0"
```

Already-known transactions are skipped by TransID, so this is safe to re-run.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `curl` from outside times out | Security group missing 80/443, or `ufw` blocking. Check both. |
| Caddy cannot obtain a certificate | A record not propagated, or port 80 closed. Run `dig +short api.yourdomain.com`, then `journalctl -u caddy -n 50` for the actual reason. |
| `systemctl reload caddy` fails, `opening log writer` | A `log { output file ... }` block pointing at a directory the `caddy` user can't write. Drop the block (journald is the default) or `sudo mkdir -p /var/log/caddy && sudo chown caddy:caddy /var/log/caddy`. The old config keeps serving — a failed reload is not an outage. |
| `systemctl reload caddy` fails for any other reason | `sudo caddy validate --config /etc/caddy/Caddyfile` names the line. Caddy swaps configs atomically, so the running site is unaffected until a reload succeeds. |
| App exits on boot with a Firebase error | `FIREBASE_SERVICE_ACCOUNT` is malformed — usually the `\n` inside `private_key` got mangled. Regenerate it. |
| STK push returns ResponseCode 0 but no prompt; query says `4999` | Wrong credentials. `mpesa.js` already forces EAT (UTC+3) for the password timestamp, so this is a `SHORTCODE`/`PASSKEY` mismatch — the passkey must belong to that till. |
| Callbacks never arrive | Safaricom is still pointed at the old Render URL. Redo Step 11. |
| `502 Bad Gateway` from Caddy | The Node process is down: `sudo systemctl status selete-agro`, `journalctl -u selete-agro -n 50`. |
| Instance IP changed after a reboot | You skipped the Elastic IP (Step 2). |

---

## Cost note

`t4g.micro` on-demand runs roughly **$6/month** plus about $1 for the 12 GB
volume. Graviton (`t4g.*`) is cheaper than the equivalent `t3.*` for the same
memory, which is a second reason to stay on ARM here.

An Elastic IP is free **while attached to a running instance** — you get billed
for it while the instance is stopped, so release it if you ever tear the
instance down.
