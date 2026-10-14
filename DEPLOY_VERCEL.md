# Deploy from GitHub to Vercel

Repository: https://github.com/freedom-tech89/Assets-Managment-and-Review-System

## Part A. Put the code in the GitHub repository

Use option 1 if Claude has been given push access to the repository. Otherwise use option 2.

**Option 1: Claude pushes it.** Give Claude access, then ask Claude to push:
1. Go to https://claude.ai/connect-github and connect the GitHub account that owns the repository
   (freedom-tech89), or an account with write access to it.
2. When GitHub asks where to install the Claude app, choose **freedom-tech89** and select
   **Assets-Managment-and-Review-System** (or all repositories).
3. Tell Claude in the thread "access is ready". Claude pushes the code to the `main` branch.

**Option 2: upload it yourself in the browser.**
1. Download `upload-details-app-github.zip` and unzip it on your computer. You get the folders `api`,
   `lib`, `public` and `tests`, plus files such as `package.json`, `vercel.json` and `server.js`.
2. Open the repository on github.com and click **Add file → Upload files**.
3. Select everything inside the unzipped folder (the files and folders, not the outer folder) and
   drag it all onto the page. Make sure hidden files such as `.gitignore` and `.env.example` come too.
   On Windows, turn on View → Hidden items first. Both files are optional.
4. Write a message such as "Add multi asset app" and click **Commit changes**.
5. Check that the repository's front page shows `package.json` and `vercel.json` at the top level.
   They must not be inside a sub-folder.

## Part B. Create the Vercel project from GitHub

1. Sign in at https://vercel.com and click **Add New… → Project**.
2. Under **Import Git Repository**, click **Install** or **Adjust GitHub App Permissions** if the
   repository is not listed, and allow Vercel to see **Assets-Managment-and-Review-System**.
3. Click **Import** next to the repository.
4. On the configure screen:
   - **Framework Preset:** Other
   - **Root Directory:** `./` (leave as is)
   - **Build and Output Settings:** leave the defaults. `vercel.json` already sets the output folder to
     `public`.
5. Open **Environment Variables** on the same screen and add:
   - `ADMIN_PASSWORD`: the password you will sign in with
   - `SESSION_SECRET`: any long random text (optional; it keeps people signed in across redeploys)
6. Click **Deploy**. The first deploy finishes, but the app still needs a database (Part C).

## Part C. Add the database

1. In the new Vercel project, open the **Storage** tab and click **Create Database**.
2. Choose **Neon (Serverless Postgres)**, pick a region near you (for example Mumbai or Singapore),
   and create it.
3. When asked, connect it to this project for all environments (Production, Preview, Development).
   Vercel adds `DATABASE_URL` for you. The tables are created automatically on first use.
4. Open **Deployments**, click **⋯** next to the latest one, and choose **Redeploy** so the database
   and password take effect.

## Part D. Check it works

1. Open the site address Vercel shows (for example `https://assets-managment-and-review-system.vercel.app`).
2. Sign in with your `ADMIN_PASSWORD`.
3. Go to **Admin Panel**, choose **Client Wise**, type a client name, pick an AUM or SIP file in the
   matrix and click **Upload All**. The "Uploaded successfully" popup should appear.
4. Open **Dashboard** and **SIPs** to see the data. Click any SIP to see its details.

## Updating later

Every change committed to the `main` branch on GitHub deploys automatically. You don't need to upload a
zip again. The database and settings stay as they are.

## If something goes wrong

- **"This deployment has no ADMIN_PASSWORD set yet"**: add `ADMIN_PASSWORD` in Settings →
  Environment Variables, then redeploy.
- **"DATABASE_URL is not set"**: do Part C, then redeploy.
- **Sign in says "Please log in." again**: make sure the repository has the latest `vercel.json`.
  It must contain `/api/index?__path=$1`.
- **404 on the home page**: `package.json` and `vercel.json` must be at the top level of the
  repository, not inside a sub-folder.
- **Upload rejected as too large**: each file can be up to 4 MB, which is Vercel's limit.
