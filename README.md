# Waste Management Tracking System for Local Bodies

Citizens report waste and sanitation problems. Complaints are saved in a database, the citizen gets a confirmation SMS, and the authority manages everything from a password-protected dashboard.

One Node.js app does all of it: website, database access, SMS and dashboard login.

```
server.js              the app
public/                the website pages
.env.example           settings (copied to .env on first start)
start-windows.bat      double-click to run on Windows
start-mac-linux.sh     run on Mac or Linux
```

## 1. Run it on your computer (localhost)

1. Install Node.js (LTS) from https://nodejs.org if you do not have it.
2. Unzip this folder.
3. Windows: double-click `start-windows.bat`. Mac/Linux: run `./start-mac-linux.sh`.
4. Open **http://localhost:3000**

On first start it creates a `.env` file and adds 22 sample complaints so the dashboard is not empty.
- Authority dashboard: click "Authority dashboard" and sign in with the `ADMIN_PASSWORD` from `.env` (default `admin123`).
- Complaints are stored in `data/complaints.json` while you run locally.
- Without an SMS provider the confirmation screen says "SMS not sent" and why. That is expected until step 2.

Localhost addresses only work on the computer running the app. To let others use it, do step 3.

## 2. Make the SMS real

An SMS can only be sent through a provider account. Choose one and put its details in `.env`:

- **Fast2SMS** (Indian): add a small balance, copy the API key.
  `SMS_PROVIDER=fast2sms` and `FAST2SMS_API_KEY=...`
- **Twilio**: copy the Account SID, Auth Token and your Twilio number.
  `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID=...`, `TWILIO_AUTH_TOKEN=...`, `TWILIO_FROM=+1...`
  A free trial can only text numbers you verified inside Twilio.

Restart the app, report an issue with your own mobile number, and check your phone.
India requires commercial SMS to use a registered sender ID and template (DLT). If the provider accepts the request but nothing arrives, ask the provider how to register yours.

## 3. Put it on the internet

You need two free accounts: **MongoDB Atlas** (permanent database) and **Render** (hosting).

**A. Database (MongoDB Atlas)**
1. Create a free cluster at https://www.mongodb.com/atlas.
2. Database Access: add a user with a password.
3. Network Access: allow access from anywhere (`0.0.0.0/0`), because Render's address changes.
4. Connect > Drivers: copy the connection string, for example `mongodb+srv://user:PASSWORD@cluster0.xxxx.mongodb.net/`.

**B. Hosting (Render)**
1. Upload this folder to a GitHub repository. The `.gitignore` keeps `.env` out.
2. On https://render.com choose New > Web Service and pick the repository.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add Environment Variables:
   - `MONGODB_URI` = your Atlas connection string
   - `ADMIN_PASSWORD` = a strong password (not `admin123`)
   - `SEED_SAMPLE` = `false`
   - `SMS_PROVIDER` and its keys (step 2)
   - `SITE_URL` and `ALLOWED_ORIGIN` = the address Render gives you, for example `https://waste-tracker.onrender.com`
5. Deploy. The address Render shows is your live website.

Without `MONGODB_URI` the app falls back to a local file, which Render erases whenever it restarts. Always set `MONGODB_URI` online.
Render's free plan sleeps when idle, so the first visit can take about 30 seconds. Open it before a demo.

## Getting it into Google search

Replace `https://YOUR-DOMAIN/` with your real address in `public/index.html`, `public/robots.txt` and `public/sitemap.xml`. Add the site in Google Search Console, submit `sitemap.xml` and request indexing. It can take days.

## What is protected

- The authority dashboard needs the password. Without `ADMIN_PASSWORD` the dashboard stays locked.
- Citizens' names and phone numbers are only returned to the signed-in authority. The public tracking page never shows them.
- Limits: 3 SMS per phone number per hour, 20 complaints per visitor per hour, 10 sign-in attempts per hour.
- The SMS text is built by the server from checked fields, so the site cannot be used to send arbitrary messages.

## Reports

The dashboard's "Download report (CSV)" button downloads every complaint (including names and phone numbers, so handle the file carefully). All complaints are stored in the database, in the `complaints` collection.

## Known limits

- Photo upload is not built; only the file name is recorded.
- One shared admin password; there are no separate officer accounts yet.
- The front end is plain HTML/CSS/JavaScript. React.js is listed as planned.
