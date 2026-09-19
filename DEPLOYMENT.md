# Deploying "Memory With a Receipt" to Render

This guide outlines how to deploy the **Memory With a Receipt** evidence-first AI decision-memory system on [Render](https://render.com).

---

## 1. Quick Setup Options

### Option A: Automatic via Render Blueprint (`render.yaml`)
1. Connect your GitHub repository to Render.
2. In the Render Dashboard, click **New +** -> **Blueprint**.
3. Select your repository. Render will automatically detect `render.yaml`.
4. Fill in the required secret environment variable `OPENAI_API_KEY` when prompted.
5. Click **Apply**.

### Option B: Manual Web Service Setup
1. In the Render Dashboard, click **New +** -> **Web Service**.
2. Connect your repository.
3. Configure the service settings:
   - **Name:** `memory-receipt` (or preferred name)
   - **Environment / Runtime:** `Node`
   - **Region:** Choose closest to your users (e.g. Frankfurt / Oregon / Ohio)
   - **Branch:** `main`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/api/health`

---

## 2. Environment Variables

Configure the following environment variables in the Render dashboard (**Environment** tab):

| Variable | Required | Default / Value | Description |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | Optional | `production` | Sets Node.js runtime to production mode |
| `OPENAI_API_KEY` | **Required** | *[Your OpenAI Key]* | Secret key for answer synthesis |
| `OPENAI_MODEL` | Optional | `gpt-4.1-mini` | Target OpenAI model |
| `PORT` | Optional | `process.env.PORT` | Injected automatically by Render (server binds to `0.0.0.0:PORT`) |
| `MAX_RETRIEVED_CHUNKS` | Optional | `8` | Candidate chunk retrieval limit |
| `MAX_EVIDENCE_CHARS` | Optional | `12000` | Maximum characters sent to OpenAI |
| `MAX_COMPLETION_TOKENS` | Optional | `700` | Answer completion token ceiling |

> [!WARNING]
> **Never commit `.env` or paste API keys into git.**
> `.env` files are ignored via `.gitignore`. Always configure secrets directly in Render's environment variable settings.

---

## 3. Prebuilt Demo Database & Seeding Strategy

The repository includes a versioned, pre-extracted SQLite database asset located at `seed/demo-seed.db`. This non-secret file contains:
- **45** indexed corpus documents (transcripts, emails, reports)
- **794** verified text chunks
- **794** 384-dimensional local MiniLM vector embeddings
- **768** extracted decision events (proposals, commitments, reversals, issues, status updates)
- Pre-built **FTS5** full-text search index

### How Seeding Works on Startup
- When `npm start` runs `src/server.js`, `ensureSeededDatabase()` checks if `data/memory.db` exists.
- If `data/memory.db` does **not** exist (such as on first boot), it copies `seed/demo-seed.db` to `data/memory.db`.
- If `data/memory.db` **already exists**, it is never overwritten, preserving any demo state (such as GDPR deletions or fresh question audit logs) during runtime.
- **No LLM event extraction or corpus ingestion is run during deployment build.**

---

## 4. Demo Runtime Limitations & Ephemeral Storage

- **Ephemeral Storage on Free Tier:**
  Standard Render free tier instances use ephemeral filesystems. Runtime changes made during live demos (e.g., executing a confirmed person deletion or recording question token usage) are preserved while the instance is running. If the instance restarts or is redeployed, the database resets to the pristine initial seed from `seed/demo-seed.db`.
- **Persistent Disk (Optional Upgrade):**
  For permanent persistence across redeployments, attach a Render Persistent Disk mounted at `/opt/render/project/src/data` (or set `DB_PATH=/var/data/memory.db` pointing to the mounted disk path).

---

## 5. Verification & Health Check

After deployment completes:
- **Health Check Endpoint:** `GET /api/health`
  - Returns `{"ok":true,"timestamp":"..."}` with HTTP 200 without making any OpenAI API calls.
- **Web UI:** Visit your Render URL (e.g. `https://memory-receipt.onrender.com`) to query decisions, inspect literal citations and Cytoscape graphs, view Data use disclosure metrics, and run GDPR deletion preview / Decision Blast Radius tests.
