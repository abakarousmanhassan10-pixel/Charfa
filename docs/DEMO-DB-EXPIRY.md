# The free demo database expires: back it up and move it

`touma-db` (Render Postgres, **free plan**) was created on 2026-11-13 and **expires on 2026-12-13**: Render deletes a free database 30 days after its creation, with all its data (accounts, businesses, campaigns). A new free database has the same 30-day life. For a database that lasts, use a paid plan (about 6 USD/month).

The database is reachable only from inside Render (its IP allow list is empty): this is the secure default. To back it up you must allow your own address for a few minutes.

## 1. Back up (before 2026-12-10, leave a margin)
You need a computer with the PostgreSQL 16 client tools (`pg_dump`, `pg_restore`, `psql`) and this repository.
1. Find your public IP address (search "what is my IP").
2. Render dashboard → `touma-db` → **Networking** → add your IP address (`x.x.x.x/32`) to the inbound allow list.
3. `touma-db` → **Connect** → copy the **External Database URL**. Treat it as a secret.
4. Run, from a folder outside the repository:
   ```bash
   DATABASE_URL_EXTERNAL='<the external URL>' ./infrastructure/scripts/backup-demo-db.sh ~/touma-backups
   ```
   It prints the file name, its size and the number of tables saved. The file contains user accounts and password hashes: it is created readable by you only and the script refuses to write it inside a git repository. **Never commit it, never share it.**
5. **Remove your IP** from the allow list (Networking) when done.

## 2. Create the new database and restore
1. Render → **New** → **Postgres** → name `touma-db-2` (same region: Frankfurt; version 16; free or paid). Add your IP to its allow list.
2. Restore into the new, empty database (use its External Database URL):
   ```bash
   TARGET_DATABASE_URL='<new external URL>' ./infrastructure/scripts/restore-demo-db.sh ~/touma-backups/touma-demo-<date>.dump
   ```
   It refuses a database that already has TOUMA tables and prints the number of users and migrations restored.
3. On `touma-api` → Environment, change `DATABASE_URL` to the **Internal Database URL** of `touma-db-2`. Save: Render redeploys (about 3 minutes). The API applies any missing migrations at start.
4. Check https://touma-api.onrender.com/api/v1/health/ready (`database: up`) and sign in at https://touma-web.onrender.com/login with an existing account.
5. Remove your IP from the new database's allow list. Delete `touma-db` once everything works.

## What is NOT in the database
- Uploaded files: they are in memory today and are lost at every restart (see [DEMO-HOSTING.md](DEMO-HOSTING.md) for persistent storage).
- Redis (`touma-redis`): queues and rate limits only, nothing to back up.

## If you do not need the demo data
Skip the backup: create the new database, set `DATABASE_URL`, redeploy. The migrations rebuild the empty schema and the seed adds the plans. Accounts must then be created again.
