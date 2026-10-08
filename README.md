# Auto Safety Report System · 報平安

This is the first working localhost version of your FYP, built from the latest interface prototype and the draft report. The two separate code projects are **frontend/** (Vue 3 + Vite) and **backend/** (Node.js + Express + MongoDB). Supporting files, the local database, and its portable server are all inside this folder.

## Start from two VS Code terminals

Open this project folder in VS Code. Use one terminal for each process.

**Terminal 1 — Backend API**

```sh
cd ~/Desktop/FYP_coding_system/backend
node server.js
```

The backend automatically starts the bundled local MongoDB server when `MONGODB_URI` points to localhost and no server is running. It reuses an already-running local MongoDB without taking ownership of it. For a remote URI, it connects directly to that server and does not start local MongoDB.

**Terminal 2 — Vue frontend**

```sh
cd ~/Desktop/FYP_coding_system/frontend
npm run dev
```

Open **http://localhost:5173**. Keep both terminals running. Press **Control+C** in each terminal to stop its process. MongoDB started by the backend is stopped with it; the files in `data/mongodb/` remain saved.

If you previously used `start.command`, stop that launcher first with Control+C. Otherwise the existing backend/frontend will occupy the same ports.

### One-time Node.js setup

Node.js and npm have now been installed through Homebrew on this Mac. Reopen VS Code's terminals if they were opened before installation. For a new Mac, install a supported Node.js version (22.12 or newer), including npm. With Homebrew, the terminal command is:

```sh
brew install node
node --version
npm --version
```

Dependencies are already installed in both project folders. On a fresh copy, run `npm install` once in each folder. If the portable MongoDB binary is missing, run `node scripts/setup.mjs` from the project root to prepare it.

The original `start.command` launcher remains available as an optional convenience.

| Role | Account name | Password |
| --- | --- | --- |
| Super Admin | `superadmin` | `superadmin` |
| Admin | `admin` | `admin` |
| Resident, one building | e.g. `204` | `204` |
| Resident, multiple buildings | e.g. `A-204` | `A-204` |

Resident accounts exist only after disaster setup. These predictable passwords follow your prototype for localhost testing; they must be replaced with a safer account-issuance process before a real deployment.

## Try the complete flow

1. Sign in as Super Admin or Admin. With no active disaster, you reach **Set the disaster scale**.
2. Enter a disaster name and the number of buildings, floors, and rooms. The default 1 × 20 × 8 creates 160 resident accounts.
3. The **Safety Overview** shows building tabs, floor rows, room columns, status totals, and urgent help requests. Use **Unit accounts** to download a CSV of generated accounts and their initial passwords.
4. Log out, then sign in as a generated unit, such as `204`. The first page has two large buttons: **Safe** and **I need help**. Clicking either immediately saves the status to the admin overview. The next page asks for optional details: a family WhatsApp number for Safe; situation, current location, and contact for Help. Submit with every field blank if needed. The confirmation includes a link to call 999. If you leave after the button press, your status remains saved, and the unfinished form resumes on your return. The selected status is locked; details can be finalized once.
5. Sign in as a responder again. The submitted unit is green or red. Select it to read the report and reporting time. Missing details display as **N/A**. While open, the overview refreshes every five seconds.
6. Any signed-in role can open **Lost & Found**. Submit a real photo, description, place, category, and finder contact through **I Found Something**. Browse **Show all items**, search keywords, and open an item’s details.
7. **Clear Setup** is available only to Super Admin. It asks you to type `CLEAR` and permanently deletes the active disaster’s unit accounts, safety reports, and found items. Admin and Super Admin accounts remain for the next setup.

## Open the data in MongoDB Compass

The application is now configured to save data on your restored **Azure Cosmos DB MongoDB endpoint**. Its destination is:

- Database: **auto_safety_report**
- Login account collection: **user**

Open Compass, connect with the same private URI saved in **backend/.env**, refresh the database list, and open `auto_safety_report` → `user`. Compass is the viewer; Azure provides the database storage. The credential remains on the backend and is never sent to Vue.

Each kind of system data has a separate collection:

| Collection | Stored data |
| --- | --- |
| `user` | Manager and generated unit accounts; passwords are hashed |
| `incidents` | Disaster layout, name, and setup state |
| `safety_reports` | Safe/help status, contacts, situation, and reporting time |
| `found_items` | Item details and the resized JPEG photo |

The records previously stored together in `FYP-SafetySystem` have been migrated into these collections with their original application IDs and relationships. You have deleted `FYP-SafetySystem`; the application does not read, write, or recreate it. Future search features can use additional collections in this same database.

Original local copies remain in **data/mongodb/**, and local connection settings are preserved privately in **backend/.env.local**. Your unrelated Azure databases and collections are not used by this application.

The frontend and backend still run on localhost; only database storage is remote. The backend requires internet access to save and retrieve records. If the cloud database cannot be reached, the app reports the error rather than switching silently to local storage.

## What is implemented and deferred

Implemented: role-based login/logout, login sessions held in backend memory, one active disaster, account generation, safety reports, report locking, responder status grid and help details, Lost & Found uploads/browsing/keyword search/details, separate database collections, and Super Admin clear.

Deferred as requested: WhatsApp sending, AI/photo similarity search, image embeddings, Atlas Vector Search, and publishing. Family phone numbers are optional for now and saved if provided. Safe reports have `notificationStatus: "disabled"`, and the screen explicitly states that no WhatsApp message is sent. AI search is marked unavailable; found-item photo uploads work normally.

## Edit the code

Open this whole folder in Visual Studio Code.

| File | Purpose |
| --- | --- |
| `frontend/src/App.vue` | All screens, forms, navigation, and calls to the API |
| `frontend/src/style.css` | Prototype-based navy/teal design and responsive layouts |
| `frontend/vite.config.js` | Frontend port and local API proxy |
| `backend/app.js` | Express API routes, permissions, validation, and report rules |
| `backend/db.js` | Database connection, collection/index creation, manager seeding, and recovery |
| `backend/store.js` | Maps API record groups to separate collections (accounts use user) |
| `backend/sessions.js` | In-memory login sessions, expiration, and logout revocation |
| `backend/lib.js` | Password hashing and validation helpers |
| `backend/server.js` | Server startup and shutdown |
| `backend/.env` | Private database and local server settings |
| `scripts/dev.mjs` | Starts and stops the three local processes |

The frontend runs on port **5173**, the backend on **3001**, and local MongoDB on **27017**. All servers bind to **127.0.0.1**. The frontend calls `/api` through Vite’s proxy; it never connects to MongoDB directly.

You can run `npm run dev` from the project root after installing Node.js 22.12+ or Node.js 24. The Mac launchers also support the bundled Node runtime available on this machine.

If dependencies need reinstalling, double-click **setup.command**, or run:

```sh
npm install --prefix backend
npm install --prefix frontend
npm run dev
```

The setup launcher uses npm when available, or the bundled pnpm on this Mac. Each project includes a pnpm lockfile. Its portable MongoDB installer is for Apple Silicon Macs; other platforms need their own MongoDB Community installation.

## Verification

The frontend production build, 13 API/storage/startup tests, and browser flows for the two-step safety page passed. Browser checks cover mobile and desktop, immediate button saves, admin auto-refresh, blank submissions, optional contact/location details, N/A displays, closing after one click, and resuming unfinished reports. The tests use a separate temporary MongoDB process and database, never the configured application database. They cover authentication, permissions, origin checks, duplicate setup/report requests, real photo validation, searching, persistence, logout revocation, Clear Setup, and recovery from an interrupted setup or clear. Browser checks additionally exercise the actual Vue screens.

Run tests with `npm test` from the root, or `npm test` inside backend. Build the frontend with `npm run build` from the root. A read-only database check is available with `npm --prefix backend run db:check`.

See **docs/API.md** for endpoints and **docs/DATABASE.md** for record formats and recovery behavior.

Technology references: [Vue quick start](https://vuejs.org/guide/quick-start.html), [MongoDB Node driver](https://www.mongodb.com/docs/drivers/node/current/get-started/), [MongoDB Community on macOS](https://www.mongodb.com/docs/v8.0/tutorial/install-mongodb-on-os-x/), and [Cosmos DB MongoDB error codes](https://learn.microsoft.com/en-us/azure/cosmos-db/mongodb/error-codes-solutions).

## Database settings

The private `backend/.env` contains:

```env
MONGODB_URI="your Azure connection string"
MONGODB_DB=auto_safety_report
```

The actual URI is already configured. Do not replace it with the example placeholder. To change a connection later, stop the backend, edit that private file, then run `node server.js` again. The connection selects the server; `MONGODB_DB` selects the database. Collection names are defined in `backend/store.js`.

Login sessions live in backend memory for eight hours and are revoked immediately on logout. No sessions collection is used or created in MongoDB. Restarting the backend requires every user to log in again; saved accounts, setups, reports, and photos remain in MongoDB.

A one-time migration utility is available with `npm run db:migrate-local` inside backend. It reads the saved local configuration and the current cloud configuration, copies records that are missing in the destination, and never deletes the local source or overwrites differing cloud records. Stop the backend before a migration to avoid changing the source while it is being copied. Normal startup does not rerun migration.

To migrate an older single-collection copy, stop the backend and run `npm run db:migrate-collections` inside backend. It verifies copied records, retains the source, and refuses to overwrite conflicts. This migration has already been completed for the configured Azure database.

The browser test runner is **browser-test/flow.mjs**. After `npm run build` in frontend, run it with `node browser-test/flow.mjs` from the project root on this Mac. It uses the bundled Playwright runtime and Google Chrome, starts isolated temporary MongoDB data, and closes all test servers afterward. Screenshots are saved under **test-results/**. It never reads the application connection string or uses the Azure database.
