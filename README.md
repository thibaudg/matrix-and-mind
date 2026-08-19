# Matrix & Mind

A private, mobile-first web app with two tools: an **Eisenhower priority matrix** and a **CBT-style positive-thinking thought record**. Static front end (no build step) backed by **Supabase** for accounts and storage, hosted free on **GitHub Pages**.

---

## What's in here

| File | What it is |
|---|---|
| `index.html` | Markup + login screen |
| `styles.css` | The pastel-card design system |
| `app.js` | All logic + Supabase calls |
| `config.js` | **You edit this** — your Supabase URL + anon key |
| `schema.sql` | Run once in Supabase to create the tables + security |
| `vendor/supabase.js` | The Supabase client library, bundled in (no CDN needed) |
| `manifest.webmanifest`, `icon.svg` | "Add to Home Screen" support |

---

## One-time setup (~15 minutes)

### 1. Create the Supabase project
1. Go to https://supabase.com, sign in, **New project**. Pick a name, a strong database password, and the region closest to you.
2. Wait for it to finish provisioning.

### 2. Create the database tables
1. In the project, open **SQL Editor** → **New query**.
2. Paste the entire contents of `schema.sql` and click **Run**. You should see "Success."

### 3. Turn off email confirmation (recommended for a personal tool)
1. **Authentication** → **Sign In / Providers** → **Email**: make sure Email is enabled.
2. **Authentication** → **Providers / Settings**: turn **"Confirm email"** off, and Save.
   *(If you'd rather keep it on, that's fine — after signing up you'll get a confirmation email; click the link, then sign in. Also add your site URL under **Authentication → URL Configuration**.)*

### 4. Copy your keys into `config.js`
1. **Project Settings** → **API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `config.js` and paste them in:
   ```js
   window.SUPABASE_URL = "https://xxxxxxxx.supabase.co";
   window.SUPABASE_ANON_KEY = "eyJhbGci...";
   ```
   The anon key is meant to live in client code — your data is protected by the row-level-security rules from `schema.sql`, not by hiding this key.

### 5. Put it on GitHub Pages
1. Create a new GitHub repo (e.g. `matrix-and-mind`) — public is simplest and safe here.
2. Push these files to it:
   ```bash
   git init
   git add .
   git commit -m "Matrix & Mind"
   git branch -M main
   git remote add origin https://github.com/<your-username>/matrix-and-mind.git
   git push -u origin main
   ```
3. On GitHub: **Settings** → **Pages** → **Source: Deploy from a branch** → branch `main`, folder `/ (root)` → **Save**.
4. After a minute your app is live at `https://<your-username>.github.io/matrix-and-mind/`.
5. *(If you kept email confirmation on)* add that URL under **Supabase → Authentication → URL Configuration → Site URL**.

### 6. Try it
Open the URL, **Create an account**, add a matrix, reload — your data should still be there and is visible only to you.

---

## Add it to your phone
Open the live URL in Safari (iOS) or Chrome (Android) → Share → **Add to Home Screen**. It launches full-screen with its own icon, so it feels like a native app.

---

## Local preview (optional)
Open a local server from this folder:
```bash
python3 -m http.server 8000
```
then visit http://localhost:8000. The app and the Supabase library are all local; only sign-in/data calls reach Supabase's servers, so your keys in `config.js` need to be filled in for login to work.

---

## Notes
- Every future `git push` to `main` redeploys automatically.
- Data model: two tables, `matrices` and `sessions`, one row per record, with the task/thought lists stored as JSON. Counts (`open/done`, `thoughts/kept`) are computed in the browser.
- No secrets live in this repo — safe to keep public.
