# Database design

Server: the configured Azure Cosmos DB MongoDB endpoint. Database: `auto_safety_report`. Each kind of application data has its own collection; login accounts use **`user`**.

| Collection | Important fields |
| --- | --- |
| user | _id=username, username, role, passwordHash, createdAt; residents also have incidentId, building, floor, room |
| incidents | _id=current, incidentId UUID, name, buildings, floors, rooms, status, createdAt, createdBy |
| safety_reports | _id=incidentId:username; incidentId, userId, username, building, floor, room, status, situation, location, contact, familyPhone, detailsSubmittedAt, notificationStatus, createdAt |
| disaster_maps | _id=current; sanitized PNG, imageId, name, blocks, annotations, phase, incidentId, revision, createdAt, updatedAt |
| found_items | _id UUID; incidentId, description, place, category, contact, photo JPEG data URL, createdBy, createdAt |

`backend/store.js` maps the API's logical `users` group to the physical `user` collection. Other groups use the collection names shown above. Documents use ordinary application IDs without recordType or recordId wrappers. A clear operation removes the active incident's records only; manager accounts remain. Future search features can add their own collections to this database.

Building indexes are zero-based (A=0), and floors and rooms are one-based. Single-building account names concatenate floor and two-digit room, e.g. floor 2 / room 4 → 204. Multiple buildings add a letter prefix, e.g. A-204. No-response units are derived from the layout rather than storing empty reports.

Passwords use Node scrypt with individual random salts. Sessions store token hashes, not the raw cookie. Manager passwords from `.env` seed only new accounts; changing those variables does not reset existing passwords.

Each collection's unique `_id` index enforces account identities, a single current incident, and one report per unit. Secondary incidentId indexes support incident cleanup.

Login sessions use SHA-256 token hashes in backend memory, with eight-hour expiration and immediate logout revocation. No sessions collection is used or created. Restarting the backend requires users to log in again. Clear Setup revokes resident sessions for the cleared incident while retaining manager sessions until they expire or log out.

## Safety report flow

A Safe / I need help button press immediately creates the report. `detailsSubmittedAt: null` means its optional form is unfinished, but the admin dashboard already counts its status. Blank optional fields remain empty strings in MongoDB and display as N/A in the admin interface. The help location is a separate field from the unit's registered building/floor/room.

The optional form submits once using PATCH. Status, user identity, incident identity, and createdAt remain locked; detailsSubmittedAt records completion. Matching retries are idempotent. Reloading or logging in again resumes the unfinished form. Reports created before this change lack detailsSubmittedAt and remain completed. No migration of existing records is required.

## Setup and clear consistency

Run one backend process against this database. The checkout's server lock prevents accidentally starting another backend from the same folder. A write queue serializes setup, clear, reporting, item saves, login-session creation, and logout.

Setup reserves the current incident with status provisioning, hashes/inserts accounts in batches, then marks it active. Requests cannot use a partially configured disaster. Failed setup rolls back its own records; startup recovers interrupted provisioning before login opens.

Clear marks the incident clearing, removes that incident's accounts, reports, and found items, then removes the incident record last and revokes its in-memory unit sessions. Interrupted clear finishes on startup. Manager accounts and manager sessions remain.

This is recoverable sequencing rather than a transaction. Do not run multiple backends against the same database or edit active records directly in Compass.

## Migration

Records from the previous `FYP-SafetySystem` collection have been copied and verified into the separate collections. Their original IDs, password hashes, relationship fields, timestamps, and photos are preserved. You have deleted `FYP-SafetySystem`; the application does not read, write, or recreate it. Historical migration utilities do not run on startup. They copy persistent system records only and skip old login sessions.

`npm run db:migrate-collections` inside backend performs this migration when the backend is stopped. It checks all destination identities before copying, refuses conflicting records, verifies every saved document, and retains the source. Repeating it immediately after migration does not duplicate records. If live data has changed since migration, it refuses to overwrite those changes.

The original local data files remain unchanged, with local connection settings privately saved in `backend/.env.local`. `npm run db:migrate-local` supports legacy separate local collections, legacy mixed records, and the current separate-collection format. Neither migration runs automatically during startup.

Existing unrelated Azure databases and collections are untouched. The frontend/backend stay on localhost, while Azure stores the system records. The backend requires internet access and does not fall back to a second database silently.

## Disaster map

One current map is saved in disaster_maps. Its sanitized PNG and vector annotations occupy one bounded document. Metadata endpoints omit image bytes; the image has an authenticated endpoint. Normalized coordinates keep drawings aligned across screen sizes. Revision checks reject stale edits with 409. Manager windows receive live update events and reload the latest map; periodic refresh also recovers missed events.

Each block stores a label, stable building index, floors, and units per floor. Counts and account generation sum each block independently. Renaming a map label does not change resident account IDs. Every initialized block retains a clickable marker. Drawing types are pen, rectangle, text/emoji, and block marker.

New maps begin as drafts. Initialization reserves a provisioning incident, creates accounts in batches, links the map, and activates the incident. Interrupted provisioning retains the draft map and removes partial accounts. Interrupted clearing removes the map and incident data. For existing incidents, map setup links to their existing layout and preserves accounts and reports. Only Super Admin can log in until the map is active and linked. Map writes require Super Admin; admins can read and open block overviews.

Building label size is independent of floor/unit layouts. Optional normalized marker w/h fields store the visible width/height with its centered x/y position. Existing markers without these fields retain their original automatic sizing. Resizing, including after initialization, uses the same autosave, revision checks, and live manager updates as other drawing edits.
