# Demo deployment

This profile is for a temporary customer evaluation environment. It uses isolated Docker volumes, exposes only the app port, and keeps MinIO private inside the Compose network. It is not a replacement for the HTTPS production profile.

1. Copy the example environment file and fill every `replace-with-*` value:

   ```bash
   cp deploy/.env.demo.example deploy/.env.demo
   ```

2. Set `PUBLIC_BASE_URL` to the server URL customers will open. For an IP-only demo, use `http://<server-ip>:3004`; for HTTPS behind a reverse proxy, set `COOKIE_SECURE=true` and `TRUST_PROXY=1`.

3. Validate and start:

   ```bash
   docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml config --quiet
   docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml up -d --build
   docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml ps
   ```

4. Open `PUBLIC_BASE_URL` and log in with `ADMIN_USERNAME` / `ADMIN_PASSWORD`. If `ALLOW_MOCK_FALLBACK=true`, the UI can be clicked through without provider keys, but generated media is placeholder output. Set it to `false` only after filling YUNWU and Seedance credentials.

5. Before sending the URL, verify the live process and the permission boundary:

   ```bash
   curl --fail "$PUBLIC_BASE_URL/api/live"
   docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml logs --tail=100 app
   ```

6. Stop and remove only the Demo containers when the evaluation ends. Keep the named volumes if you want to retain feedback assets and tasks:

   ```bash
   docker compose --env-file deploy/.env.demo -f deploy/compose.demo.yml down
   ```

Never commit `.env.demo`; it contains credentials. For a real customer-facing release, use `compose.production.yml` with DNS, HTTPS, non-demo credentials, `ALLOW_MOCK_FALLBACK=false`, and real provider keys.
