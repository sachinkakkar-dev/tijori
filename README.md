# Tijori server

A small relay that knows about **families, invites and roles** — the authority Mosquitto couldn't be. It authenticates with **Google OAuth**, enforces **invite-only** membership and roles, and does **store-and-forward** of each member's *encrypted* portfolio object. The family master key never reaches the server, and **everything written to disk is encrypted at rest**.

```
client (index.html)  --HTTPS/WSS-->  nginx  -->  node server.js  -->  db.enc (encrypted)
        |                                                                  ^
        | encrypts portfolio with the family master key (server can't read it)
```

## 1. Google OAuth client

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type **Web application**.
3. **Authorized JavaScript origins**: the origin that serves `index.html`, e.g. `https://relay.gurutribe.in`.
4. Copy the **Client ID**. It goes in two places: the server's `GOOGLE_CLIENT_ID` and the client's `CONFIG.GOOGLE_CLIENT_ID`.

(No client secret is needed — the browser uses Google Identity Services to get an ID token, and the server only *verifies* it.)

## 2. Install & configure

```bash
cd tijori-server
npm install
cp .env.example .env
# edit .env: set GOOGLE_CLIENT_ID and a strong SERVER_ENC_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # make a SERVER_ENC_KEY
```

Keep `SERVER_ENC_KEY` safe and backed up — it decrypts the on-disk database. Lose it and the data is unrecoverable.

## 3. Run

```bash
node --env-file=.env server.js        # Node 20+ reads .env directly
# or: npm install dotenv && npm start
```

Keep it alive with systemd or pm2:

```bash
sudo npm i -g pm2
pm2 start server.js --name tijori --update-env
pm2 save
```

## 4. Put it behind nginx (HTTPS + WSS)

The browser needs HTTPS (for Google sign-in and Web Crypto) and WSS (for live updates). Reuse the cert you already issued for `relay.gurutribe.in`:

```nginx
server {
    listen 443 ssl;
    server_name relay.gurutribe.in;
    ssl_certificate     /etc/letsencrypt/live/relay.gurutribe.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.gurutribe.in/privkey.pem;

    # serve the client
    root /var/www/tijori;          # put index.html here
    index index.html;

    # API
    location /api/ {
        proxy_pass http://127.0.0.1:8090;
        proxy_set_header Host $host;
    }

    # WebSocket
    location /ws {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

Then in `index.html` set `CONFIG.API = "https://relay.gurutribe.in"` and `CONFIG.WS = "wss://relay.gurutribe.in/ws"`.

## What the server enforces

- **Identity is real** — every request carries a Google ID token, verified server-side. No passwords, no per-user provisioning.
- **Invite-only** — you only see/open a family if your Google account is a member. The creator is always `maintainer`; everyone else joins via an invite addressed to their email.
- **Roles** — `maintainer` can publish and invite; `viewer`/`custodian` are read-only (the server refuses their writes). Custodian *amount-hiding* is still applied client-side (see note below).
- **Version check** — a published object is rejected if its version isn't newer than the stored one.
- **Encrypted at rest** — the entire DB file is AES-256-GCM encrypted; portfolio bodies are *additionally* end-to-end encrypted with the family master key, so the server can enforce membership without ever seeing amounts.

## Honest limitations

- **The family keys are shared out-of-band.** The server never receives them. There are **two passphrases**: a *details key* (account numbers, property, paper locations — everyone gets it) and a *values key* (amounts — only maintainers and viewers get it). A **custodian is simply never told the values key**, so amount ciphertext is undecryptable to them — not UI-masked. Hand both keys to people directly; the server only stores opaque blobs and can't read either half.
- **Rotation is manual.** If someone with the values key leaves, change the values passphrase, re-share it with those who should keep it, and have maintainers re-publish.
- **Single-file store** is fine for family scale; swap `store.js` for SQLite if you outgrow it.
