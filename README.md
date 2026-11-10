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
| Super Admin | `superadmin1` | `superadmin1` |
| Super Admin | `superadmin2` | `superadmin2` |
| Admin | `admin1` | `admin1` |
| Admin | `admin2` | `admin2` |
| Resident, named block | e.g. `A-204` or `D-204` | Same as account name |
| Older preserved single-building setup | e.g. `204` | `204` |

The four manager accounts are created on startup. To update an existing database immediately, run `npm run db:setup-managers` in `backend`; this privately backs up and retires the original `superadmin` and `admin` logins. Existing numbered accounts keep their password hashes.

Resident accounts exist only after disaster setup. These predictable passwords follow your prototype for localhost testing; they must be replaced with a safer account-issuance process before a real deployment.

## Try the complete flow

1. Start backend and frontend in the two VS Code terminals, then open http://localhost:5173. Before a map is initialized, only **superadmin1** and **superadmin2** can log in (passwords match the account names). Admin and resident logins remain blocked.
2. Super Admin uploads a **PNG map up to 4 MB**. Use your own image, or **backend/test/fixtures/disaster-map.png** copied from your attachment.
3. Select **Building block**, then click the map. Set the block label, floors, and units per floor. Repeat for each building; counts can differ. Use Pen with color/width, Boundary, and Text / emoji for annotations. Select / move repositions drawings and labels. Select a building label and drag its corner handle, or use the sidebar Block width / Block height controls, to grow or shrink its visible size. Resizing preserves floors and units and works after initialization. The selected label also has a **Label font size (px)** control (8–72 px); clear it to return to automatic sizing. Font changes autosave and appear in the admin view; Delete selected removes mistakes; Undo reverses the last edit. Drawings save automatically.
4. Wait for **All changes saved**, then select **Initialize**. Accounts use each block's own layout. Account prefixes follow the block label: Block D → D-204, Block A → A-204, regardless of placement order. The block dialog previews its first account; custom labels have a unique A–Z account prefix. The Unit accounts download lists account names and initial passwords.
5. Admin and Super Admin enter the **disaster map**. Click a map label or building shortcut to see only that block's counts, help requests, floors, and units. **Back to disaster map** returns to the map.
6. Only Super Admin has **Edit map**. After initialization, edit drawings, labels, sizes, notes, or emoji locally, then click **Save** to update the disaster map. **Unsaved changes** remain private to that editor; viewing the map, leaving through navigation, logging out, or reloading discards them. Other manager windows update after a successful Save. A failed save keeps the edits for Retry save; a revision conflict requires reloading the latest saved map. Label descriptions and positions can change after initialization; account prefixes, floor/unit counts, and building count stay fixed to preserve existing accounts and reports. Clear Setup is required to create a different unit layout.
7. For a disaster from the previous version, Super Admin uploads a map and places its existing blocks. Initialization preserves old accounts, passwords, reports, and found items. Other roles can log in once the map is initialized.
8. Residents retain the two-button **Safe / I need help** flow. Help next shows four illustrated injury choices with short descriptions. Select any number; each tap saves immediately, then **Continue** opens optional details. Both steps can be left blank. Status saves immediately before injury selection or optional details; empty details show **N/A** to responders. Confirmations include **Call 999**.
9. Lost & Found uploads, keywords, and item details remain available. WhatsApp notifications are available after Super Admin links the sender during initialization. AI search is deferred.
10. **Clear Setup** requires typing CLEAR, logs out the WhatsApp sender, and removes the map and incident accounts, reports, and found items. Manager accounts remain.

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
| `disaster_maps` | PNG map, block layouts, annotations, initialization state, edit revision |
| `floor_searches` | Per-floor search status, inaccessible reasons, responder, timestamp, revision |
| `whatsapp_replies` | Replies sent from the inbox and private responder attribution |

The records previously stored together in `FYP-SafetySystem` have been migrated into these collections with their original application IDs and relationships. You have deleted `FYP-SafetySystem`; the application does not read, write, or recreate it. Future search features can use additional collections in this same database.

Original local copies remain in **data/mongodb/**, and local connection settings are preserved privately in **backend/.env.local**. Your unrelated Azure databases and collections are not used by this application.

The frontend and backend still run on localhost; only database storage is remote. The backend requires internet access to save and retrieve records. If the cloud database cannot be reached, the app reports the error rather than switching silently to local storage.

## What is implemented and deferred

Implemented: role-based login/logout, login sessions held in backend memory, one active disaster, account generation, safety reports, report locking, responder status grid and help details, Lost & Found uploads/browsing/keyword search/details, separate database collections, and Super Admin clear.

WhatsApp safety notifications are implemented using whatsapp-web.js and a locally linked sender account. Family numbers remain optional. AI/photo similarity search, image embeddings, Atlas Vector Search, and publishing remain deferred; found-item photo uploads work normally.

## Edit the code

Open this whole folder in Visual Studio Code.

| File | Purpose |
| --- | --- |
| `frontend/src/App.vue` | All screens, forms, navigation, and calls to the API |
| `frontend/src/style.css` | Prototype-based navy/teal design and responsive layouts |
| `frontend/vite.config.js` | Frontend port and local API proxy |
| `frontend/src/MapEditor.vue` | Drawing tools, per-block setup, deletion, undo, draft autosave, and explicit Save for initialized maps |
| `frontend/src/FloorPlan.vue` | Responsive map with clickable building labels |
| `backend/maps.js` | PNG, drawing, and block layout validation |
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

The frontend production build, API/storage/startup/WhatsApp lifecycle tests, and browser flows passed. Browser checks cover PNG maps, unequal blocks, drawing tools, live updates, role restrictions, mobile and desktop, immediate button saves, admin auto-refresh, blank submissions, optional contact/location details, N/A displays, closing after one click, and resuming unfinished reports. The tests use a separate temporary MongoDB process and database, never the configured application database. They cover authentication, permissions, origin checks, duplicate setup/report requests, real photo validation, searching, persistence, logout revocation, Clear Setup, and recovery from an interrupted setup or clear. Browser checks additionally exercise the actual Vue screens.

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

Map edits use revision checks to prevent overwriting changes from another editor window. The latest PNG and annotations are saved in disaster_maps; no history collection or sessions collection is created.

## Desktop navigation and floor search progress

Desktop screens (900 px and wider) show Safety and Lost & Found in a vertical left sidebar. Phones retain the horizontal bottom navigation. The controls are available after a disaster is initialized.

On a block's Safety Overview, Admin or Super Admin can click **Clear** next to a floor after completing its search. The floor header turns dark grey and shows **✓ Cleared**; Safe and Needs help cells use muted shades while keeping their statuses and details. **Floors cleared** counts completed floors for the selected building. Inaccessible floors are counted separately and never as completed searches.

**Note / status** opens a floor editor. Select **Inaccessible — cannot search** and enter a short reason (up to 300 characters), such as fire-blocked stairs or collapsed access. The reason appears beside the floor, with an amber inaccessible marker. Select **Not yet searched / reopen** to correct or reopen a floor. Resident reports are never removed or changed by these actions.

Changes save in MongoDB floor_searches and push to other manager windows immediately. Reloading or a backend restart preserves progress. A stale edit returns a conflict instead of silently replacing a newer update; **Reload latest status** lets the responder review it. Normal residents cannot access floor-search APIs. Clear Setup removes the active incident's search progress together with its map and other incident records.

## Named block accounts

New setups always use the named block’s prefix, including a single named block. Placing Block D first does not make it Block A: D accounts belong to Block D, and A accounts belong to Block A. The map, unit grid, report filters, and account CSV use the same saved accountPrefix. An initialized block cannot be renamed to a different block letter.

On backend startup, older active maps are checked once. Before correcting order-based account/report associations, the backend writes a private recovery snapshot under `backend/.backups/`. Existing usernames retain their password hashes and reports; missing valid units are created, and unused accounts outside the corrected layout are removed after backup. Map geometry, drawings, photos, and floor-search notes stay attached to their original map blocks. If any saved report does not fit its named block’s layout, startup stops with a specific repair message and leaves the records for review. Older single-building accounts without prefixes remain valid.

## Injury reporting

Help residents can select **Wounds & bleeding**, **Fractures / dislocations**, **Burns / scalds**, and **Smoke inhalation**. Each button has a simple cartoon, a short English description, and a Traditional Chinese label. Multiple selections and deselection are supported; every tap saves to MongoDB immediately, before Continue or final Submit. Reloading resumes the current step. Continue without any selection is also allowed. The optional typing form remains available, with a Change injury selection button before final submission.

On each block's Safety Overview, **Reported injuries** appears between No response and Floors cleared. Its four counters update live for Admin and Super Admin, and selected icons appear in the relevant unit cells, urgent-help list, and unit details. Counts represent unit reports and may overlap across injury types. Saved Safe/Help statuses and floor search progress remain independent. Data uses new fields on safety_reports; no database reset or additional collection is needed.

## WhatsApp family notifications

Dependencies are already installed in backend with pnpm. For a fresh dependency install, use `npx --yes pnpm@11 install` in backend (do not mix npm install with its existing pnpm node_modules). Package scripts can still use npm run, and normal startup remains two terminals:

```bash
cd /Users/tamcalix/Desktop/FYP_coding_system/backend
node server.js
```

```bash
cd /Users/tamcalix/Desktop/FYP_coding_system/frontend
npm run dev
```

The private backend/.env now enables WHATSAPP_ENABLED=true and defaults local eight-digit family numbers to +852. Full international numbers with +country code also work. No API key is used. The backend waits while there is no initialized map. After Super Admin uploads, annotates, and initializes the map, the next page displays the WhatsApp QR. Use the sender phone's WhatsApp → Linked devices → Link a device to scan it. Initialization completes automatically when the sender is ready; Admin/resident logins remain blocked until then. The QR refreshes automatically and is served by an authenticated Super Admin-only endpoint. A private local copy at backend/.wwebjs_auth/link.png is removed after authentication or shutdown. Never upload or commit this image or the auth/cache folders. Both .wwebjs_auth/ and .wwebjs_cache/ are ignored at all folder levels.

Wait for **WhatsApp ready** in the backend terminal or **WhatsApp connected** in the webpage status bar. LocalAuth remembers the linked sender in an incident-specific profile under backend/.wwebjs_auth/ (older active setups retain their legacy profile); a separate client lock prevents the standalone checker and backend from opening that profile together. On disconnection, Super Admin can click the red WhatsApp sender box on the map or open WhatsApp Inbox to reach the QR page. Restarting the backend restores a completed active setup’s sender; an unfinished initialization resumes on the QR page after Super Admin signs in. Sender login data stays local; no MongoDB sessions collection is created.

Test with a fresh resident unit account: choose Safe, enter an agreed test recipient's WhatsApp number, and submit. The Safe button saves immediately. Submitting the optional phone form stores a durable notification job on the same safety_reports record. The queue sends a bilingual English/Traditional Chinese message with the unit account, disaster name, and original reporting time. The message describes a resident's self-report and does not assert that every household member is safe. Leaving the phone blank saves skipped; Help reports are not notified. Historical disabled reports are never automatically sent when the feature is enabled.

Residents see queued/sending/sent/failed/uncertain status on their Safe confirmation; responders see it in Safe unit details. Sent means the message was submitted to WhatsApp, not that the family received or read it. Lookup connection failures retry up to three times with a delay. An uncertain send or interrupted in-flight job is never automatically resent, because the first message might already have reached WhatsApp. Review with the recipient before any manual resend. Notification failure never rolls back the safety report. The Mac must remain awake, online, and running the backend. whatsapp-web.js is unofficial and can break or lead to account restrictions, so this is a prototype notification channel, not a guaranteed emergency service.

### Reply to families

Open **WhatsApp Inbox** from the envelope in the navigation. Admin and Super Admin can search by phone or unit and open any family chat that received an automatic safety message for the current disaster. The thread starts with that notification and loads the connected sender’s available WhatsApp history. Use **Load earlier messages** for long threads. The inbox sends text replies, and incoming media is shown as an attachment marker.

Replies use the linked system number. Super Admin sees **Replied by** under replies sent from the inbox. Admin and the family do not receive that attribution. If the sender disconnects, Admin sees a notice and Super Admin can reconnect from the QR page. The backend creates the reply collection on startup and removes the incident’s reply records with **Clear Setup**.

The standalone checker is optional and requires the backend to be stopped:

```bash
cd /Users/tamcalix/Desktop/FYP_coding_system/backend
npm run whatsapp:check
```

Without a recipient it only links/checks the account and sends nothing. An explicit recipient argument requests one test message per run:

```bash
npm run whatsapp:check -- +852YOUR_RECIPIENT_NUMBER
```

Replace the placeholder with the consenting recipient's actual number. Stop the checker with Control+C before restarting server.js. To disable messaging while keeping the safety system available, set WHATSAPP_ENABLED=false in backend/.env and restart. An optional WHATSAPP_CHROME_PATH can point to a locally installed Chrome executable if Puppeteer's downloaded browser cannot launch.

### Initialization and logout lifecycle

With WhatsApp enabled, map initialization creates unit accounts but saves setupComplete=false. Super Admin then sees the sender QR page; Admin/resident logins and the responder dashboard stay blocked until the backend confirms the correct incident’s sender is ready. The backend saves setupComplete=true and whatsappLinkedAt, then the Super Admin page automatically opens the disaster map. A later WhatsApp outage does not undo completed initialization or prevent emergency reporting.

Each new disaster has its own whatsappClientId. Clear Setup on the disaster map drains the notification worker, calls WhatsApp logout, removes that sender’s saved profile, then deletes disaster data. If logout cannot be confirmed, the data is preserved and the page reports an error for retry. The QR connection page has no Clear Setup button. The next disaster requires a fresh QR scan. Normal backend restarts preserve the sender login; signing out of the website does not disconnect it. Already initialized older disasters keep their current data and sender.

If linking stalls at **Account linked. Finishing connection…**, **Retry connection** restarts the sender while preserving its saved login and the map. Connection attempts time out after 90 seconds instead of waiting indefinitely. The transport replays a missed initial WhatsApp sync callback and retries transient iframe binding failures; it completes setup only after the library's messaging initialization finishes, never on authentication alone.

Current WhatsApp Web builds use a separate `/login/` page before authentication. That page has the pairing QR but does not expose `WAWebSocketModel`, which whatsapp-web.js 1.34.7 otherwise tries to access too early. The local client adapter publishes the page's complete QR payload, follows its refreshes, and waits for the authenticated app before running the library's normal messaging initialization. This path was checked using a real, empty Chrome profile, in addition to the isolated automated regression.

Logging out this linked device from the phone leaves the disaster initialized. Super Admin can use **Reconnect WhatsApp** to scan a fresh QR; the map, accounts, safety reports, and floor search progress remain saved, and resident reporting stays available. The adapter handles phone logout without deleting an open Chrome profile or running stale navigation callbacks. If a previous process left its WhatsApp browser behind, reconnect verifies that browser uses this exact managed profile and closes it before launching a replacement. Clear Setup can also clean up an already-unlinked sender without requiring a new phone login.

New notification messages start with **Auto Safety Report System**. A successfully sent Safe notification shows one confirmation sentence: **Notification sent to WhatsApp. Please keep calm and remain in a safe area.** Pending, failed, skipped, and uncertain states keep accurate wording rather than claiming a message was sent.
