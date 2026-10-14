# Upload Details

A full-stack multi asset back office for investment data (MF, Stocks, PMS, AIF, Bonds, LAS, Other):

- **Admin Panel** (password protected):
  - **Upload Type**: **Client Wise** (files for one client; enter the Client Name) or **Platform Wise**
    (bulk files covering many clients).
  - **Upload matrix**: every platform is listed under its category, each with an **AUM file** and a
    **SIP file** slot (Excel or PDF). Add more platforms with **+ Add platform**.
  - **Upload All** reads and saves every chosen file, then shows a popup listing what was added. Data
    that is not in the database yet is added with its date; data that is already there is never changed or
    deleted: the new file is stored as the next version (v2, v3, ...) and the dashboards use the latest
    version of each client + platform + category. The exact same file twice is skipped.
  - **Update history** lists every upload with its version, date and whether it is the version in use.
    Removing the version in use brings the previous one back.
- **Dashboard**: totals (AUM, invested, gain, XIRR, monthly SIP, loans), a card per category, platform
  cards and recent updates → category or platform dashboards (clients, split, history) → **Client
  Dashboard** (category & platform table with versions, asset allocation, scheme-wise details, SIP
  details, update history). Every dashboard can download an Excel report.
- **SIPs**: the SIPs page lists every live SIP (or all SIPs). Clicking any SIP, there or on a client page,
  opens its details: amount, frequency, monthly equivalent, SIP day, installments so far and left, next
  installment, amount invested through the SIP, folio, dates, source file and version, the client's current
  holding in that scheme, how the SIP changed across uploads, and the client's other SIPs.
- LAS (loans against securities) is shown on its own and is never added to AUM.
- Everything uploaded (the original files and the rows read from them) is stored in PostgreSQL.

## Deploy on Vercel

1. **Upload the project.** Drop `upload-details-app.zip` (or this folder) onto your Vercel project, or
   import it from a GitHub repository. Framework preset: **Other**. No build command is needed.
2. **Add the database.** In the Vercel project open **Storage → Create Database → Neon (Postgres)**, create
   it and connect it to this project. Vercel adds `DATABASE_URL` for you. Tables are created automatically
   on first use.
3. **Set the admin password.** In **Settings → Environment Variables** add `ADMIN_PASSWORD` (pick a strong
   one). Optionally add `SESSION_SECRET` (any long random text).
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the new settings take effect, then open the site and sign in.

Until steps 2–3 are done the site shows a sign-in page explaining what is missing.

Limits on Vercel: each uploaded file can be up to **4 MB** (Vercel's request size limit).

## Run locally

Needs Node.js 18 or newer.

```
npm install
npm start
```

Open http://localhost:3000 and sign in with the password `admin` (set `ADMIN_PASSWORD` to change it).
Without `DATABASE_URL` the app uses a built-in local PostgreSQL database stored in `./data`, so nothing
else needs installing. Set `DATABASE_URL` to use your own PostgreSQL server instead.

`npm test` runs the API tests (login, AUM + SIP uploads, versioning, duplicates, dashboards, export, delete).

Upgrading from the earlier version: the database is upgraded automatically on first start. Earlier
uploads are kept and appear under the **Other** category.

## How files are read

Files are read in the browser when they are uploaded (`public/js/extract.js`): every sheet or PDF page is
scanned for a table, and the platform's column names are matched to standard fields. AUM files give
holdings ("Units", "Qty", "Balance Units" all become Quantity, and so on); SIP files give SIP registrations
(SIP amount, frequency, SIP day, start/end date, status), with a monthly equivalent worked out from the
frequency and "live" from the status or end date. Client names in bulk files come from a client column
("Client Name", "Investor Name", optional "PAN"/"Client Code") or heading lines like
`Investor: Ravi Kumar  PAN: ABCDE1234F`; rows with no client show as "Unassigned". Locked PDFs can be opened
with their password, which is never stored or sent to the server. The "data as of" date comes from the
file (or the date entered in the Admin Panel, or today).

If a platform's file reads nothing, add its column names to `AUM_SYNONYMS` or `SIP_SYNONYMS` in
`public/js/extract.js`. Scanned (image-only) PDFs contain no text and can't be read.

## Excel reports

Summary (totals, by category, platform, asset class, and by client for multi-client reports), Client
Summary (multi-client reports), Holdings, Loans (LAS), SIPs, Source Files (with version and date).

## Project layout

```
api/index.js        Vercel serverless function (routes every /api/* request to lib/api.js)
lib/api.js          API: login, uploads, dashboards, export
lib/db.js           PostgreSQL connection and tables (PGlite locally when no DATABASE_URL)
lib/auth.js         admin password and signed session cookie
server.js           local server (npm start)
public/             the web page: index.html, css/, js/ (admin, dashboards, file reading, Excel reports), lib/ (SheetJS, ExcelJS, PDF.js)
tests/api.test.js   API tests
vercel.json         Vercel routing and security headers
```
